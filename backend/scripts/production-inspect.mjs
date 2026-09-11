import assert from "node:assert/strict";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const root="/app";
const forbiddenPath=/(^|\/)(?:backend\/scripts|uploads?|fixtures?|tests?|__tests__|\.env[^/]*|\.npmrc)(\/|$)|\.(?:sqlite|sqlite3|db|csv)$/i;
const textExtensions=new Set([".js",".json",".html",".css"]);
const secrets=(process.env.SECRET_SCAN_FILES ?? "").split(":").filter(Boolean).map(file=>readFileSync(file,"utf8").trim()).filter(Boolean);
let files=0;
let bytes=0;
let fixtureRejection=false;
function inspect(directory) {
  for (const entry of readdirSync(directory,{withFileTypes:true})) {
    const filename=join(directory,entry.name);
    const path=relative(root,filename);
    if (entry.isSymbolicLink()) {
      assert.ok(realpathSync(filename).startsWith(`${root}/`),`Production tree contains an external symbolic link: ${path}`);
      continue;
    }
    assert.ok(!forbiddenPath.test(path),`Production tree contains excluded content: ${path}`);
    assert.ok(!path.endsWith(".map") || path.startsWith("node_modules/"),`Production application contains a source map: ${path}`);
    if (entry.isDirectory()) inspect(filename);
    else {
      const size=statSync(filename).size;
      files+=1;bytes+=size;
      assert.ok(files<=20_000 && bytes<=256*1024*1024,"Production inspection exceeded its bound.");
      assert.ok(extname(path)!==".node","Production tree contains an unqualified native dependency.");
      if (textExtensions.has(extname(path)) && size<=5*1024*1024) {
        const content=readFileSync(filename);
        for (const secret of secrets) assert.ok(!content.includes(secret),`Production tree embeds a mounted secret: ${path}`);
        assert.ok(!content.includes("browser-fixture") && !content.includes("node:sqlite"),`Production tree contains fixture or SQLite runtime code: ${path}`);
        if (content.includes("Fixture authentication is forbidden")) fixtureRejection=true;
      }
    }
  }
}
inspect(root);
for (const dependency of ["vitest","typescript","tsx","@playwright"]) {
  try {
    const path=join(root,"node_modules",dependency);
    const metadata=statSync(path);
    if (!metadata.isDirectory() || readdirSync(path).length) assert.fail(`Production tree contains development dependency ${dependency}.`);
  }
  catch (error) { if (error?.code!=="ENOENT") throw error; }
}
assert.ok(fixtureRejection,"Production configuration does not fail closed against fixture authentication.");
console.log(JSON.stringify({event:"production_tree_inspection",outcome:"passed",files,bytes,secretsCompared:secrets.length}));
