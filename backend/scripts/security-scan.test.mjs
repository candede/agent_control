import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectDependencies, parseReviewedLicense, scanRuntimeApplication, scanSources } from "./security-scan.mjs";

const roots=[];
function scratch() {
  const root=join(process.cwd(),"artifacts","test-scratch",`security-scan-${randomUUID()}`);
  mkdirSync(root,{recursive:true});
  roots.push(root);
  return root;
}
afterEach(()=>{ for(const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });

describe("security scanner fail-closed behavior",()=>{
  it("scans fixture files and permits only explicit synthetic assignments",()=>{
    const root=scratch();
    mkdirSync(join(root,"tests"),{recursive:true});
    writeFileSync(join(root,"tests","fixture.ts"),'const password="fixture-password-never-production-123";');
    expect(scanSources(root).scannedFiles).toBe(1);
    writeFileSync(join(root,"tests","fixture.ts"),'const client'+'Secret="synthetic-secret\\ninvalid";');
    expect(scanSources(root).scannedFiles).toBe(1);
    writeFileSync(join(root,"tests","fixture.ts"),'const pass'+'word="realisticProductionCredentialValue123";');
    expect(()=>scanSources(root)).toThrow("Potential embedded secret assignment");
  });

  it("rejects malformed metadata and every unknown license alternative",()=>{
    expect(()=>parseReviewedLicense("(MIT OR Unknown-1.0)")).toThrow("Unreviewed dependency license");
    expect(()=>parseReviewedLicense("MIT OR")).toThrow("Malformed dependency license");
    expect(parseReviewedLicense("(MPL-2.0 OR Apache-2.0)")).toEqual(["MPL-2.0","Apache-2.0"]);
    expect(parseReviewedLicense("MIT AND ISC")).toEqual(["MIT","ISC"]);
    const root=scratch();
    mkdirSync(join(root,"broken"),{recursive:true});
    writeFileSync(join(root,"broken","package.json"),"{not-json");
    expect(()=>inspectDependencies(root)).toThrow("Unreadable dependency metadata");
    const missing=scratch();
    mkdirSync(join(missing,"missing"),{recursive:true});
    expect(()=>inspectDependencies(missing)).toThrow("Unreadable dependency metadata");
  });

  it("rejects dynamic code in imported runtime modules, not only server.js",()=>{
    const root=scratch();
    writeFileSync(join(root,"server.js"),"export {};");
    writeFileSync(join(root,"imported.js"),"export const unsafe=eval('1');");
    expect(()=>scanRuntimeApplication(root)).toThrow("dynamic code execution");
  });
  it("scans shared TestSupport fixtures and rejects non-synthetic credentials there",()=>{
    const root=scratch(), path=join(root,"authFoundationTestSupport.ts");
    writeFileSync(path,'const client'+'Secret="synthetic-foundation-secret";');
    expect(scanSources(root).scannedFiles).toBe(1);
    writeFileSync(path,'const client'+'Secret="realisticProductionCredentialValue123";');
    expect(()=>scanSources(root)).toThrow("Potential embedded secret assignment");
  });
  it("scans the guarded installation fixture without accepting real credentials",()=>{
    const root=scratch();
    mkdirSync(join(root,"scripts"));
    const path=join(root,"scripts","fresh-installation.ps1");
    writeFileSync(path,'$client'+'Secret="synthetic-installation-client-secret"');
    expect(scanSources(root).scannedFiles).toBe(1);
    writeFileSync(path,'$client'+'Secret="realisticProductionCredentialValue123"');
    expect(()=>scanSources(root)).toThrow("Potential embedded secret assignment");
  });
  it("ignores the known package-manager cache directory, not broken packages",()=>{
    const root=scratch();
    for (const name of [".cache",".vite",".vite-temp"]) mkdirSync(join(root,name));
    mkdirSync(join(root,"package"));
    writeFileSync(join(root,"package","package.json"),JSON.stringify({name:"synthetic-package",version:"1.0.0",license:"MIT"}));
    expect([...inspectDependencies(root).keys()]).toEqual(["synthetic-package@1.0.0"]);
    mkdirSync(join(root,"broken"));
    expect(()=>inspectDependencies(root)).toThrow("Unreadable dependency metadata");
  });
});
