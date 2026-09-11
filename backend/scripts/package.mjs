import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { zipSync } from "fflate";

if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Azure export requires Linux x64 Node 24.");
const files = {};
function collect(directory) {
  for (const entry of readdirSync(directory,{withFileTypes:true})) {
    const filename = join(directory,entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) collect(filename);
    else files[relative("/release",filename)] = new Uint8Array(readFileSync(filename));
  }
}
collect("/release");
files["package.json"] = new TextEncoder().encode(JSON.stringify({scripts:{start:"node backend/dist/server.js"},engines:{node:"24.x"}}));
const revision=process.env.RELEASE_REVISION;
if (!revision || revision.length>128 || !/^[a-zA-Z0-9._+-]+$/.test(revision)) throw new Error("A bounded non-secret RELEASE_REVISION is required.");
const sha256=bytes=>createHash("sha256").update(bytes).digest("hex");
files["release-manifest.json"]=new TextEncoder().encode(JSON.stringify({
  version:2,
  revision,
  platform:"linux",
  architecture:"x64",
  runtime:{name:"node",major:24},
}));
mkdirSync("/export",{recursive:true});
const archive=zipSync(files,{level:6});
writeFileSync("/export/agent-control-linux-x64.zip",archive);
writeFileSync("/export/agent-control-linux-x64.zip.sha256",`${sha256(archive)}  agent-control-linux-x64.zip\n`);