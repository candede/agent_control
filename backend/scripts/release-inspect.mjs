import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";

const filename = process.argv[2];
assert.ok(filename, "Release ZIP path is required.");
const archive = readFileSync(filename);
const sidecar = readFileSync(`${filename}.sha256`, "utf8").trim();
const checksum = sidecar.match(/^([a-f0-9]{64}) {2}agent-control-linux-x64\.zip$/)?.[1];
assert.ok(checksum, "Release checksum sidecar is invalid.");
assert.equal(createHash("sha256").update(archive).digest("hex"), checksum, "Release checksum mismatch.");
const files = unzipSync(archive);
const manifest = JSON.parse(strFromU8(files["release-manifest.json"]));
assert.deepEqual(manifest, {
  version: 2,
  revision: manifest.revision,
  platform: "linux",
  architecture: "x64",
  runtime: { name: "node", major: 24 },
});
assert.match(manifest.revision, /^[a-zA-Z0-9._+-]{1,128}$/);
const paths = Object.keys(files);
assert.ok(files["backend/dist/server.js"] && files["frontend/dist/index.html"] && files["package.json"]);
assert.ok(!paths.includes("frontend/dist/staticwebapp.config.json"));
assert.ok(!paths.some(path => /(^|\/)(\.env[^/]*|\.npmrc|secrets|test|tests|__tests__)(\/|$)|\.sqlite|backend\/scripts|\.test\.[jt]s$/.test(path)));
assert.ok(!paths.some(path => path.endsWith(".node")));
console.log(JSON.stringify({
  event: "release_metadata",
  outcome: "passed",
  revision: manifest.revision,
  sha256: checksum,
  bytes: archive.length,
  platform: manifest.platform,
  architecture: manifest.architecture,
  nodeMajor: manifest.runtime.major,
  fileCount: paths.length,
}));
