import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { unzipSync } from "fflate";

assert.equal(process.platform,"linux");
assert.equal(process.arch,"x64");
assert.equal(process.versions.node.split(".")[0],"24");
const directory=join(process.cwd(),"artifacts","test-scratch",`artifact-smoke-${randomUUID()}`);
mkdirSync(directory,{recursive:true});
const files=unzipSync(readFileSync("/export/agent-control-linux-x64.zip"));
const archive=readFileSync("/export/agent-control-linux-x64.zip");
const expectedArchive=readFileSync("/export/agent-control-linux-x64.zip.sha256","utf8").trim().split(/\s+/)[0];
assert.equal(createHash("sha256").update(archive).digest("hex"),expectedArchive);
const manifest=JSON.parse(Buffer.from(files["release-manifest.json"]).toString("utf8"));
assert.deepEqual(manifest,{version:2,revision:manifest.revision,platform:"linux",architecture:"x64",runtime:{name:"node",major:24}});
assert.match(manifest.revision,/^[a-zA-Z0-9._+-]{1,128}$/);
assert.ok(!("files" in manifest),"Release metadata must not contain per-file hashes");
const secrets=["PGPASSWORD_FILE","SESSION_SECRET_FILE"].map(key=>readFileSync(process.env[key],"utf8").trim()).filter(Boolean);
for (const [filename,bytes] of Object.entries(files)) {
  assert.ok(!filename.startsWith("/") && !filename.split("/").includes(".."));
  for (const secret of secrets) assert.ok(!Buffer.from(bytes).includes(secret),"Runtime secret was embedded in the ZIP.");
  const target=join(directory,filename);
  mkdirSync(dirname(target),{recursive:true}); writeFileSync(target,bytes);
}
const child=spawn(process.execPath,["backend/dist/server.js"],{cwd:directory,env:{...process.env,NODE_ENV:"production",PORT:"3001",FRONTEND_ORIGIN:"http://localhost:3001",REDIRECT_URI:"http://localhost:3001/api/auth/callback",SESSION_SECRET:"package-smoke-session-secret-at-least-32-characters"},stdio:["ignore","pipe","pipe"]});
let exited=false;
const exit=new Promise(resolve=>child.once("exit",code=>{exited=true;resolve(code);}));
try {
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error("Packaged runtime startup timed out.")),15000);
    child.once("error",error=>{clearTimeout(timeout);reject(error);});
    child.once("exit",()=>{clearTimeout(timeout);reject(new Error("Packaged runtime exited before listening."));});
    child.stdout.on("data",chunk=>{if(chunk.toString().includes('"event":"listening"')){clearTimeout(timeout);resolve();}});
  });
  const base="http://localhost:3001";
  assert.deepEqual(await (await fetch(`${base}/api/health`)).json(),{ok:true});
  assert.equal((await fetch(`${base}/api/ready`)).status,200);
  const html=await (await fetch(base)).text();
  const asset=html.match(/src="([^\"]+\.js)"/)?.[1]; assert.ok(asset);
  assert.equal((await fetch(`${base}${asset}`)).status,200);
  assert.equal((await fetch(`${base}/api/unknown`)).status,404);
  assert.equal((await fetch(`${base}/deep/link`)).status,200);
  console.log(JSON.stringify({event:"extracted_zip_runtime",outcome:"passed",platform:process.platform,architecture:process.arch,node:process.versions.node,secretScan:"passed"}));
} finally {
  if (!exited) child.kill("SIGTERM");
  const deadline=setTimeout(()=>child.kill("SIGKILL"),15000);
  const code=await exit;clearTimeout(deadline);
  rmSync(directory,{recursive:true,force:true});
  assert.equal(code,0,"Packaged runtime must shut down cleanly.");
}