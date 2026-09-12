import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { getWorkbenchMetadata } from "../src/services/workbenchMetadata.js";

const base = process.argv[2] ?? "http://app:3001";
const health = await fetch(`${base}/api/health`);
assert.deepEqual(await health.json(),{ok:true});
assert.equal((await fetch(`${base}/api/ready`)).status,200);
const home = await fetch(base);
assert.equal(home.status,200);
const html = await home.text();
assert.match(html,/<div id="root"><\/div>/);
assert.match(home.headers.get("cache-control") ?? "", /no-store/);
assert.match(home.headers.get("content-security-policy") ?? "", /default-src 'self'/);
for (const view of getWorkbenchMetadata().views) {
  const response = await fetch(`${base}${view.path}`);
  assert.equal(response.status, 200, view.path);
  assert.equal(await response.text(), html, view.path);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/, view.path);
}
assert.equal(await (await fetch(`${base}/deep/link`)).text(),html);
for (const path of ["/api/unknown","/missing.js","/assets/missing.js"]) {
  const response = await fetch(`${base}${path}`);
  assert.equal(response.status,404,path);
  assert.ok(!response.headers.get("content-type")?.includes("text/html"));
}
assert.equal((await fetch(`${base}/api/auth/callback`)).status,400);
assert.equal((await fetch(`${base}/api/diagnostics`)).status,401);
const identity = await fetch(`${base}/api/me`, { headers: {
  "X-MS-CLIENT-PRINCIPAL": Buffer.from(JSON.stringify({ userId: "fixture", userRoles: ["AgentControl.Admin"] })).toString("base64"),
  "X-MS-CLIENT-PRINCIPAL-ID": "fixture",
} });
assert.equal(identity.status, 401, "Client-supplied identity headers must not authenticate");
assert.match(identity.headers.get("cache-control") ?? "", /no-store/);
const authStatus = await (await fetch(`${base}/api/auth/status`)).json() as { callback: string };
assert.equal(authStatus.callback, `${process.env.EXPECTED_ORIGIN ?? "http://localhost:3001"}/api/auth/callback`);
assert.equal((await fetch(`${base}/assets/%2e%2e%2fsecret`)).status,400);
const asset = html.match(/src="([^\"]+\.js)"/)?.[1];
assert.ok(asset);
const assetResponse=await fetch(`${base}${asset}`);
assert.equal(assetResponse.status,200);
assert.match(assetResponse.headers.get("cache-control") ?? "",/immutable/);
const assetText = await assetResponse.text();
assert.ok(assetText.length>1000);

const zip = process.argv[3];
if (zip) {
  const archive=readFileSync(zip);
  const sidecar=readFileSync(`${zip}.sha256`,"utf8").trim();
  const checksum=sidecar.match(/^([a-f0-9]{64}) {2}agent-control-linux-x64\.zip$/)?.[1];
  assert.ok(checksum,"Archive checksum sidecar has an invalid format");
  assert.equal(createHash("sha256").update(archive).digest("hex"),checksum,"Archive checksum mismatch");
  const files=unzipSync(archive);
  assert.ok(files["backend/dist/server.js"]);
  assert.ok(files["frontend/dist/index.html"]);
  assert.equal(strFromU8(files["frontend/dist/index.html"]), html, "Image and ZIP must serve the same HTML");
  assert.equal(strFromU8(files[`frontend/dist${asset}`]), assetText, "Image and ZIP must serve the same built application");
  assert.equal(JSON.parse(strFromU8(files["package.json"])).engines.node,"24.x");
  const manifest=JSON.parse(strFromU8(files["release-manifest.json"])) as {
    version:number;revision:string;platform:string;architecture:string;runtime:{name:string;major:number};files?:unknown
  };
  assert.equal(manifest.version,2);
  assert.match(manifest.revision,/^[a-zA-Z0-9._+-]{1,128}$/);
  assert.deepEqual([manifest.platform,manifest.architecture,manifest.runtime],["linux","x64",{name:"node",major:24}]);
  assert.ok(!("files" in manifest),"Release metadata must not contain per-file hashes");
  const paths=Object.keys(files);
  assert.ok(!paths.includes("frontend/dist/staticwebapp.config.json"),"ZIP contains the retired Static Web Apps transport configuration");
  assert.ok(!paths.some(path => /(^|\/)(\.env[^/]*|\.npmrc|secrets|test|tests|__tests__)(\/|$)|\.sqlite|backend\/scripts|\.test\.[jt]s$/.test(path)),"ZIP contains excluded files");
  assert.ok(!paths.some(path => path.endsWith(".node")),"Native dependency requires separate architecture qualification");
  for (const path of paths.filter(path => path.startsWith("backend/dist/") && path.endsWith(".js"))) assert.ok(!strFromU8(files[path]).includes("node:sqlite"));
}

if (process.env.CHECK_RUNTIME_DIR) {
  function inspect(directory: string) {
    for (const entry of readdirSync(directory,{withFileTypes:true})) {
      const filename=join(directory,entry.name);
      assert.ok(![".npmrc",".env","test","tests","__tests__"].includes(entry.name));
      if (entry.isDirectory()) inspect(filename);
      else if (filename.includes("backend/dist") && filename.endsWith(".js")) assert.ok(!readFileSync(filename,"utf8").includes("node:sqlite"));
    }
  }
  inspect(process.env.CHECK_RUNTIME_DIR);
}
console.log(JSON.stringify({event:"packaged_app_smoke",outcome:"passed",zipInspected:Boolean(zip)}));