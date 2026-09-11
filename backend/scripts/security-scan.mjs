import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const excluded=new Set([".git",".local",".azure","node_modules","dist","artifacts","coverage"]);
const sourceExtensions=new Set([".ts",".tsx",".js",".mjs",".json",".ps1",".yaml",".yml"]);
const forbiddenSecrets=[
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[opusr]_[A-Za-z0-9_]{32,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
];
const assignedSecret=/\b(?:client[_-]?secret|password)\s*[:=]\s*["']([^"']{24,})["']/ig;
const syntheticAssignmentPath=/(^|\/)(?:test|tests|__tests__|frontend\/browser)(\/|$)|\.test\.|backend\/scripts\/(?:testDatabase|cache-load|package-smoke|zip-runtime-smoke|restart-fixture)\.[^/]+$|scripts\/[^/]*(?:test|fixture|smoke)[^/]*\.[^/]+$/i;
const syntheticValue=/^[A-Za-z0-9_.:@/ +-]*(?:fixture|synthetic|example|never|test|smoke)[A-Za-z0-9_.:@/ +-]*$/i;
const allowedLicenses=new Set(["0BSD","Apache-2.0","BSD-2-Clause","BSD-3-Clause","CC0-1.0","CC-BY-4.0","ISC","MIT","MIT-0","MPL-2.0","Python-2.0","BlueOak-1.0.0"]);
const allowedExceptions=new Set();

export function scanSources(root) {
  let scannedFiles=0;
  let scannedBytes=0;
  function scan(directory) {
    for (const entry of readdirSync(directory,{withFileTypes:true})) {
      if (entry.isSymbolicLink() || excluded.has(entry.name)) continue;
      const filename=join(directory,entry.name);
      if (entry.isDirectory()) scan(filename);
      else if (sourceExtensions.has(extname(entry.name))) {
        const size=statSync(filename).size;
        const sourcePath=relative(root,filename);
        assert.ok(size<=5*1024*1024,`Source file exceeds scanner bound: ${sourcePath}`);
        const content=readFileSync(filename,"utf8");
        for (const pattern of forbiddenSecrets) assert.ok(!pattern.test(content),`Potential embedded secret: ${sourcePath}`);
        assignedSecret.lastIndex=0;
        for (const match of content.matchAll(assignedSecret)) {
          assert.ok(syntheticAssignmentPath.test(sourcePath) && syntheticValue.test(match[1]),
            `Potential embedded secret assignment: ${sourcePath}`);
        }
        scannedFiles+=1;
        scannedBytes+=size;
        assert.ok(scannedFiles<=5000 && scannedBytes<=100*1024*1024,"Static scan input exceeds its documented bound.");
      }
    }
  }
  scan(root);
  return {scannedFiles,scannedBytes};
}

export function parseReviewedLicense(expression) {
  assert.equal(typeof expression,"string","Dependency license expression must be a string.");
  const tokens=expression.match(/\(|\)|\bAND\b|\bOR\b|\bWITH\b|[A-Za-z0-9][A-Za-z0-9.-]*\+?/g) ?? [];
  assert.equal(tokens.join(""),expression.replace(/\s+/g,""),`Malformed dependency license expression: ${expression}`);
  let offset=0;
  const licenseIds=[];
  const primary=()=>{
    if (tokens[offset]==="(") {
      offset+=1;
      expressionNode();
      assert.equal(tokens[offset++],")",`Malformed dependency license expression: ${expression}`);
      return;
    }
    const token=tokens[offset++];
    assert.ok(token && !["AND","OR","WITH",")","("].includes(token),`Malformed dependency license expression: ${expression}`);
    licenseIds.push(token);
  };
  const withNode=()=>{
    primary();
    if (tokens[offset]==="WITH") {
      offset+=1;
      const exception=tokens[offset++];
      assert.ok(exception && allowedExceptions.has(exception),`Unreviewed dependency license exception ${exception ?? ""}: ${expression}`);
    }
  };
  const andNode=()=>{
    withNode();
    while(tokens[offset]==="AND") { offset+=1;withNode(); }
  };
  const expressionNode=()=>{
    andNode();
    while(tokens[offset]==="OR") { offset+=1;andNode(); }
  };
  expressionNode();
  assert.equal(offset,tokens.length,`Malformed dependency license expression: ${expression}`);
  assert.ok(licenseIds.length>0,`Missing dependency license expression.`);
  for (const id of licenseIds) assert.ok(allowedLicenses.has(id),`Unreviewed dependency license ${id}: ${expression}`);
  return licenseIds;
}

export function inspectDependencies(directory) {
  const packages=new Map();
  function inspect(current) {
    let entries;
    try { entries=readdirSync(current,{withFileTypes:true}); }
    catch (error) {
      if (error?.code==="ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name===".bin") continue;
      if (entry.name.startsWith("@")) {
        inspect(join(current,entry.name));
        continue;
      }
      const packageDirectory=join(current,entry.name);
      const packageFile=join(packageDirectory,"package.json");
      let metadata;
      try {
        metadata=JSON.parse(readFileSync(packageFile,"utf8"));
      } catch (error) {
        throw new Error(`Unreadable dependency metadata: ${packageFile}`,{cause:error});
      }
      if (metadata) {
        assert.ok(typeof metadata.name==="string" && metadata.name.length>0 && typeof metadata.version==="string" && metadata.version.length>0,
          `Invalid dependency identity metadata: ${packageFile}`);
        const expressions=typeof metadata.license==="string" ? [metadata.license]
          : Array.isArray(metadata.licenses) ? metadata.licenses.map(value=>value?.type) : [];
        assert.ok(expressions.length>0 && expressions.every(value=>typeof value==="string" && value.length>0),
          `Missing dependency license: ${metadata.name ?? entry.name}`);
        for (const license of expressions) parseReviewedLicense(license);
        packages.set(`${metadata.name}@${metadata.version}`,expressions.join(" AND "));
      }
      inspect(join(packageDirectory,"node_modules"));
    }
  }
  inspect(directory);
  return packages;
}

export function scanRuntimeApplication(directory) {
  let files=0;
  function inspect(current) {
    for (const entry of readdirSync(current,{withFileTypes:true})) {
      if (entry.isSymbolicLink()) continue;
      const filename=join(current,entry.name);
      if (entry.isDirectory()) inspect(filename);
      else if ([".js",".mjs",".cjs"].includes(extname(entry.name))) {
        const content=readFileSync(filename,"utf8");
        assert.ok(!content.includes("node:sqlite"),`Production runtime contains SQLite: ${filename}`);
        assert.ok(!/\beval\s*\(|new\s+Function\s*\(/.test(content),`Production runtime contains dynamic code execution: ${filename}`);
        files+=1;
      }
    }
  }
  inspect(directory);
  assert.ok(files>1,"Production application-tree scan did not cover imported runtime modules.");
  return files;
}

function main() {
  const root=process.cwd();
  const source=scanSources(root);
  const packages=inspectDependencies(join(root,"node_modules"));
  assert.ok(packages.size>0 && packages.size<=1000,"Dependency license inventory is empty or exceeds its bound.");

  const target=JSON.parse(readFileSync(join(root,"infra","production-target.example.json"),"utf8"));
  const expectedSecrets=[
    "agent-control-tenant-id","agent-control-client-id","agent-control-client-secret",
    "agent-control-session-secret","agent-control-postgres-admin-password","agent-control-postgres-app-password",
  ];
  assert.equal(target.contractVersion,2);
  assert.equal(target.isApproval,false);
  assert.deepEqual(target.preparedVaultContract.secretNames,expectedSecrets);
  assert.deepEqual(target.preparedVaultContract.runtimeConsumers,expectedSecrets.filter(name=>name!=="agent-control-postgres-admin-password"));
  assert.equal(target.preparedVaultContract.administratorPasswordRuntimeAccessible,false);
  assert.equal(target.preparedVaultContract.bootstrapSecretCleanupRequired,true);
  assert.deepEqual([target.resources.appServicePlan.sku,target.resources.appServicePlan.instanceCount,target.resources.postgresFlexibleServer.sku,
    target.resources.postgresFlexibleServer.tier,target.resources.postgresFlexibleServer.version,target.resources.postgresFlexibleServer.storageGiB,
    target.resources.postgresFlexibleServer.backupRetentionDays,target.resources.postgresFlexibleServer.applicationPoolMaximum],
  ["B1",1,"Standard_B1ms","Burstable",17,32,7,4]);
  assert.equal(target.resources.appService.nodeMajor,24);
  assert.equal(target.resources.appService.remoteBuildEnabled,false);
  assert.equal(target.resources.postgresFlexibleServer.highAvailability,false);
  assert.equal(target.resources.postgresFlexibleServer.replicas,0);
  const infrastructure=[readFileSync(join(root,"infra","main.bicep"),"utf8"),readFileSync(join(root,"infra","postgres.bicep"),"utf8"),
    readFileSync(join(root,"infra","key-vault-access.bicep"),"utf8")].join("\n");
  for (const forbidden of ["Microsoft.Web/staticSites","Microsoft.Compute/virtualMachines","Microsoft.ContainerRegistry/registries",
    "Microsoft.DocumentDB/databaseAccounts","Microsoft.Cache/Redis","Microsoft.Storage/storageAccounts/fileServices"]) {
    assert.ok(!infrastructure.includes(forbidden),`Forbidden production topology remains: ${forbidden}`);
  }
  assert.equal((infrastructure.match(/resource appService 'Microsoft\.Web\/sites@/g)??[]).length,1);
  assert.equal((infrastructure.match(/resource appServicePlan 'Microsoft\.Web\/serverfarms@/g)??[]).length,1);
  assert.equal((infrastructure.match(/resource server 'Microsoft\.DBforPostgreSQL\/flexibleServers@/g)??[]).length,1);
  const qualification=JSON.parse(readFileSync(join(root,"infra","qualification-targets.example.json"),"utf8"));
  assert.equal(qualification.isApproval,false);
  assert.ok(!JSON.stringify({target,qualification}).match(/(?:password|secretValue|connectionString)"\s*:/i),"Target examples contain a secret/connection value field.");

  const runtimeFiles=scanRuntimeApplication(join(root,"backend","dist"));
  console.log(JSON.stringify({event:"security_static_scan",outcome:"passed",...source,dependencyLicenses:packages.size,runtimeFiles}));
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main();
