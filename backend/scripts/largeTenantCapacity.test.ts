import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseGcNvp, requiredStages, MiB } from "./capacityTelemetry.js";
import { capacityBudgets } from "./large-tenant-capacity.js";
import { bindCapacityDatabase } from "./capacityDatabase.js";
import { capacityBrowserLaunchOptions,capacityBrowserOrigin } from "./capacityBrowserEnvironment.js";
import { BoundedPool } from "../src/db/boundedPool.js";
import { assertCapacityPublicationProgress,capacityBackgroundLoop,capacityBackgroundRetryable,capacityWithCleanup,capacitySelectionExpired } from "./capacityBackground.js";
import { capacityProvider, packageValue, nativeValue, fixtureTenant, officialLine, activityLine, fileBoundaryHeader, fileBoundaryLine } from "./capacityProvider.js";
import { parseReportUser } from "../src/services/userSourceGraphFields.js";
import { encodeBatch, dataLimits } from "../src/db/dataBounds.js";
import { checkpointQueries, observePeakMemory, observeQueryWork, observePublicationWork, measurePublication } from "../src/services/peakMemory.js";
import { canonicalRecord, packageInventoryRecord } from "../src/services/inventoryRecordProjection.js";
import { buildRecords } from "../src/services/inventoryComponent.js";
import { resolvePackageAgentLinks } from "../src/services/packageAgentIdentity.js";
import { testDatabase } from "./testDatabase.js";
import { inventoryBaseline, inventoryInput } from "./inventoryFixtures.js";
import { InventoryGenerations } from "../src/db/inventoryGenerations.js";
import { capacityOperation, physicalWork, physicalReadSnapshot, physicalReadDeltas, physicalReadMeasurement } from "./capacityPhysicalWork.js";
import type { CapacityTelemetry } from "./capacityTelemetry.js";
import { capacityInput } from "./capacityRuntime.js";
import { PowerPlatformResourceQueryClient } from "../src/services/powerPlatformResourceQuery.js";
import { projectPackageDetails, packageDetailRevision } from "../src/services/packageDetailProjection.js";
import { capacityHttpLoad, capacityReportIdentity } from "./capacityHttpLoad.js";
import type { ReportRow } from "../src/types/officialReportData.js";
import type pg from "pg";
import { LifecycleSlice } from "../src/db/lifecycleSlice.js";

describe("fixed-budget capacity instrumentation and workload", () => {
  it("rotates only expired invalidated capacity selections, never an early fence or another error",() => {
    expect(capacitySelectionExpired({ code: "selection_invalidated" },new Date(1000),1000)).toBe(true);
    expect(capacitySelectionExpired({ code: "selection_invalidated" },new Date(1001),1000)).toBe(false);
    expect(capacitySelectionExpired({ code: "selection_invalidated" },new Date(NaN),1000)).toBe(false);
    expect(capacitySelectionExpired({ code: "unauthorized" },new Date(0),1000)).toBe(false);
    expect(capacitySelectionExpired(null,new Date(0),1000)).toBe(false);
  });
  it("grants native secure-context APIs only to the isolated browser fixture's exact internal origin",() => {
    expect(capacityBrowserOrigin).toBe("http://test-db:8081");
    expect(capacityBrowserLaunchOptions({ AGENT_CONTROL_ISOLATED_TESTS: "1" })).toEqual({
      headless: true,args: ["--disable-dev-shm-usage","--unsafely-treat-insecure-origin-as-secure=http://test-db:8081"],
    });
    expect(() => capacityBrowserLaunchOptions({})).toThrow("capacity_browser_requires_isolated_fixture");
    expect(() => capacityBrowserLaunchOptions({ AGENT_CONTROL_ISOLATED_TESTS: "0" })).toThrow("capacity_browser_requires_isolated_fixture");
  });
  it("binds the actual app pool once before connection without changing its budget or the operator environment",async () => {
    const environment = { AGENT_CONTROL_ISOLATED_TESTS: "1",PGHOST: "test-postgres",
      PGDATABASE: `agentcontrol_test_${"a".repeat(32)}_control`,APP_PGPASSWORD: "synthetic-runtime" };
    const database = new BoundedPool({ host: environment.PGHOST,database: environment.PGDATABASE,
      user: "agentcontrol_admin",password: "synthetic-operator",max: 4,connectionTimeoutMillis: 5000,statement_timeout: 15000 });
    const name = `agentcontrol_test_${"b".repeat(32)}`;
    try {
      expect(bindCapacityDatabase(database,name,environment)).toBe(database);
      expect(database.options).toMatchObject({ host: "test-postgres",database: name,user: "agentcontrol_app",
        password: "synthetic-runtime",max: 4,connectionTimeoutMillis: 5000,statement_timeout: 15000 });
      expect(environment.PGDATABASE).toBe(`agentcontrol_test_${"a".repeat(32)}_control`);
      expect(database.totalCount).toBe(0);
      expect(() => bindCapacityDatabase(database,name,environment)).toThrow("capacity_database_binding");
    } finally { await database.end(); }
  });
  it.each(["host","target","control","isolation","password","pool","acquisition","statement","used"] as const)(
    "rejects an unsafe capacity app pool binding: %s",async fault => {
      const environment = { AGENT_CONTROL_ISOLATED_TESTS: "1",PGHOST: "test-postgres",
        PGDATABASE: `agentcontrol_test_${"a".repeat(32)}_control`,APP_PGPASSWORD: "synthetic-runtime" };
      const database = new BoundedPool({ host: environment.PGHOST,database: environment.PGDATABASE,
        max: 4,connectionTimeoutMillis: 5000,statement_timeout: 15000 });
      let name = `agentcontrol_test_${"b".repeat(32)}`;
      if (fault==="host") environment.PGHOST = "localhost";
      if (fault==="target") name = "agentcontrol";
      if (fault==="control") environment.PGDATABASE = "agentcontrol";
      if (fault==="isolation") environment.AGENT_CONTROL_ISOLATED_TESTS = "0";
      if (fault==="password") environment.APP_PGPASSWORD = "";
      if (fault==="pool") database.options.max = 5;
      if (fault==="acquisition") database.options.connectionTimeoutMillis = 5001;
      if (fault==="statement") database.options.statement_timeout = 15001;
      if (fault==="used") Object.defineProperty(database,"totalCount",{ get: () => 1,configurable: true });
      try { expect(() => bindCapacityDatabase(database,name,environment)).toThrow(/capacity_database_/); }
      finally {
        if (fault==="used") Reflect.deleteProperty(database,"totalCount");
        await database.end();
      }
    });
  it.each([false,true])("preserves real SIGTERM death after the worker telemetry receipt (write failure=%s)",writeFailure => {
    const source = `import {writeSync} from "node:fs";
      import {onCapacityWorkerTermination} from "./scripts/capacityTelemetry.ts";
      onCapacityWorkerTermination(()=>{writeSync(1,"TERMINAL_MEMORY_RECEIPT\\n");${writeFailure ? 'throw new Error("synthetic_telemetry_write_failure");' : ""}});
      setInterval(()=>{},10000);process.kill(process.pid,"SIGTERM");`;
    const child = spawnSync(process.execPath,["--max-old-space-size=768","--import","tsx","--input-type=module","-e",source],
      { cwd: process.cwd(),encoding: "utf8",timeout: 15_000,maxBuffer: 1_048_576,
        env: { PATH: process.env.PATH,HOME: process.cwd(),TMPDIR: process.cwd(),NPM_CONFIG_REGISTRY: "https://packagefeedproxy.microsoft.io/npm/" } });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBe("SIGTERM");
    expect(child.stdout).toContain("TERMINAL_MEMORY_RECEIPT");
  });
  it("checks the actual selected-report DTO without mistaking directory identity for an obsolete outer identity", () => {
    expect(capacityReportIdentity(0, { directory: { userPrincipalName: "user-000001@example.invalid" } } as ReportRow))
      .toBe("user-000001@example.invalid");
    expect(capacityReportIdentity(1, { username: "user-000002@example.invalid" } as ReportRow)).toBe("user-000002@example.invalid");
    expect(capacityReportIdentity(2, { agentId: "agent-000003" } as ReportRow)).toBe("agent-000003");
    expect(() => capacityReportIdentity(0, { identity: { userPrincipalName: "obsolete" } } as unknown as ReportRow))
      .toThrow("capacity_report_row_shape");
  });

  it("preserves bounded controller failures after the streaming response headers were sent",async () => {
    const server = capacityProvider();
    await new Promise<void>((resolve,reject) => { server.once("error",reject); server.listen(0,"127.0.0.1",resolve); });
    try {
      const address = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${address.port}/load`,{
        method: "POST",headers: { "content-type": "application/json" },body: "{}",
      });
      const value = await response.json();
      expect(response.status).toBe(200);
      expect(value.controllerError.name).toBe("AssertionError");
      expect(value.controllerError.message).toContain("input.cookie");
      expect(value.controllerError.message.length).toBeLessThanOrEqual(4096);
      expect(value.controllerError.stack.length).toBeLessThanOrEqual(8192);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it("requires explicit adversary profiles instead of colliding with ordinary churn versions",async () => {
    const server = capacityProvider();
    await new Promise<void>((resolve,reject) => { server.once("error",reject); server.listen(0,"127.0.0.1",resolve); });
    try {
      const address = server.address() as { port: number },url = new URL(`http://127.0.0.1:${address.port}/provider`);
      url.searchParams.set("count","1");
      url.searchParams.set("upstream","https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages/package-000000");
      for (const version of [30,40]) {
        url.searchParams.set("version",String(version));
        const value = await (await fetch(url)).json();
        expect(value.elementDetails).toEqual(packageValue(0).elementDetails);
        expect(value.longDescription).toBe(`Synthetic detail value ${version}`);
      }
      url.searchParams.set("version","30"); url.searchParams.set("identityProfile","merge-split");
      expect((await (await fetch(url)).json()).elementDetails).toEqual(packageValue(0,30,false,"merge-split").elementDetails);
      url.searchParams.set("identityProfile","sparse"); url.searchParams.set("children","10000");
      const deep = await (await fetch(url)).json();
      expect(deep.elementDetails).toHaveLength(1);
      expect(deep.elementDetails[0].elements).toHaveLength(10_000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it("keeps measured background pressure alive after recorded admission failures until real cancellation",async () => {
    const stop = new AbortController(),failures: unknown[] = [];
    const transient = Object.assign(new Error("serialized read"),{ code: "data_read_conflict" });
    let calls = 0;
    const result = await capacityBackgroundLoop({ signal: stop.signal,intervalMs: 0,
      rejected: error => failures.push(error),run: async () => {
        if (++calls===1) throw transient;
        if (calls===3) stop.abort();
      } });
    expect(result).toEqual({ attempts: 3,completed: 2,rejections: 1 });
    expect(failures).toEqual([transient]);
    expect(await capacityBackgroundLoop({ signal: stop.signal,intervalMs: 0,
      rejected: () => { throw new Error("must not run"); },run: async () => { throw new Error("must not run"); } }))
      .toEqual({ attempts: 0,completed: 0,rejections: 0 });
  });
  it("fails an incomplete churn attempt at the unchanged canonical progress deadline instead of running silently without publication",() => {
    expect(() => assertCapacityPublicationProgress(60_000)).not.toThrow();
    expect(() => assertCapacityPublicationProgress(60_001)).toThrow("capacity_canonical_publication_deadline");
    for (const value of [NaN,Infinity,-1]) expect(() => assertCapacityPublicationProgress(value)).toThrow("capacity_publication_clock_unavailable");
  });
  it("does not hide invariant failures behind retryable background cleanup errors",async () => {
    const invariant = new Error("pinned_value_changed"),cleanup = Object.assign(new Error("pool"),{ code: "data_acquisition_timeout" });
    let observed: unknown;
    try { await capacityWithCleanup(async () => { throw invariant; },async () => { throw cleanup; }); }
    catch (error) { observed = error; }
    expect(observed).toBeInstanceOf(AggregateError);
    expect((observed as AggregateError).errors).toEqual([invariant,cleanup]);
    expect(capacityBackgroundRetryable(observed)).toBe(false);
    expect(capacityBackgroundRetryable(new AggregateError([
      Object.assign(new Error("transaction timeout"),{ code: "25P04" }),new Error("Connection terminated unexpectedly"),
    ]))).toBe(true);
    await expect(capacityBackgroundLoop({ signal: new AbortController().signal,intervalMs: 0,
      rejected: () => {},run: async () => { throw invariant; } })).rejects.toBe(invariant);
  });
  it("limits report cleanup through the existing ordinal index before byte accounting",async () => {
    const calls: { sql: string;values: unknown[] }[] = [];
    const client = { query: async (sql: string,values: unknown[]) => {
      calls.push({ sql,values });
      return { rows: [{ rows: 25,charged_rows: 25,bytes: 16000,full: false }] };
    } } as unknown as pg.PoolClient;
    const slice = new LifecycleSlice(client,25,"report_staging");
    expect(await slice.change("staging","official_usage_staged_rows","target.staging_id=$3",undefined,["owned-stage"],"ordinal")).toBe(25);
    expect(calls[1].sql).toContain("ORDER BY target.ordinal LIMIT $1");
    expect(calls[1].sql).not.toContain("ORDER BY target.ctid LIMIT $1");
    expect(calls[1].values).toEqual([25,1_048_576-512,"owned-stage"]);
    expect(slice.rows).toBe(26); expect(slice.bytes).toBe(16512);
  });
  it("charges exact triggered cursor rewinds inside the original shared lifecycle budget",async () => {
    const calls: string[] = [];
    let baseRows = 1;
    let extra = { rows: "1",bytes: "200" };
    const client = { query: async (sql: string) => {
      calls.push(sql);
      if (sql.startsWith("SELECT current_setting")) return { rows: [extra] };
      if (sql.startsWith("WITH")) return { rows: [{ rows: 1,base_rows: baseRows,charged_rows: baseRows+1,bytes: 100,reserved_bytes: 350,full: false }] };
      return { rows: [] };
    } } as unknown as pg.PoolClient;
    const slice = new LifecycleSlice(client,250);
    expect(await slice.change("members","inventory_memberships","target.baseline_id=$3",undefined,["owned-baseline"])).toBe(1);
    expect(slice.rows).toBe(3);expect(slice.bytes).toBe(812);
    expect(calls.find(sql => sql.startsWith("WITH"))).toContain("row_number() OVER(PARTITION BY cursor_scope ORDER BY ctid)");
    expect(calls.find(sql => sql.startsWith("WITH"))).toContain("max(cursor_bytes) OVER(PARTITION BY cursor_scope)");
    baseRows = 2;
    const charged = new LifecycleSlice(client,250);
    expect(await charged.change("generations","data_generations","true","state='failed'",[],"ctid","reservation")).toBe(1);
    expect(charged.rows).toBe(4);
    expect(charged.bytes).toBe(812);
    extra = { rows: "2",bytes: "200" };
    await expect(new LifecycleSlice(client,250).change("members","inventory_memberships","true")).rejects.toThrow("lifecycle_cursor_budget");
    extra = { rows: "1",bytes: "300" };
    await expect(new LifecycleSlice(client,250).change("members","inventory_memberships","true")).rejects.toThrow("lifecycle_cursor_budget");
  });
  it("parses actual V8 nvp pre/post heap fields without substituting allocations", () => {
    expect(parseGcNvp("[7:0xabc] 123.5 ms: pause=1.0 gc=s total_size_before=42000000 total_size_after=19000000 allocated=90000000")).toEqual({
      pid: 7, isolate: "0xabc", at: 123.5, complete: true, before: 42000000, after: 19000000, allocated: 90000000,
    });
    expect(parseGcNvp("[7:0xabc] 123 ms: gc=s allocated=900")).toMatchObject({ complete: false });
    expect(parseGcNvp("[7:0xabc:0] 123 ms: gc=mc start_object_size=42000000 end_object_size=19000000 start_memory_size=99000000 allocated=90000000"))
      .toMatchObject({ before: 42000000, after: 19000000, allocated: 90000000, complete: true });
    expect(parseGcNvp("unrelated log")).toBeNull();
  });
  it("measures both sides of stringify while inputs and output are live", () => {
    const checkpoints: number[] = [];
    observePeakMemory(point => checkpoints.push(point.heapUsed));
    try { expect(encodeBatch([{ value: "synthetic" }]).bytes).toBeGreaterThan(0); }
    finally { observePeakMemory(); }
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints.every(Number.isSafeInteger)).toBe(true);
    expect(requiredStages).toContain("sql.result");
  });
  it("keeps rejected publication work separate from committed head-swap timing",async () => {
    const outcomes: { committed: boolean; milliseconds: number }[] = [];
    observePublicationWork(value => outcomes.push(value));
    try {
      expect(await measurePublication("test",async () => "published")).toBe("published");
      await expect(measurePublication("test",async () => { throw new Error("fenced"); })).rejects.toThrow("fenced");
      expect(outcomes.map(value => value.committed)).toEqual([true,false]);
      expect(outcomes.every(value => value.milliseconds>=0)).toBe(true);
    } finally { observePublicationWork(); }
  });
  it("retains exact batch admission boundaries and hard budgets", () => {
    expect(encodeBatch(new Array(250).fill(null))).toBeDefined();
    expect(() => encodeBatch(new Array(251).fill(null))).toThrow("data_batch_rows");
    expect(dataLimits).toMatchObject({ acquireMs: 5000, leaseMs: 60000, heartbeatMs: 20000, residualBytes: 262144 });
    expect(capacityBudgets.app).toEqual({ memory: 1536*MiB, cpus: 1.5, oldSpaceMiB: 768, pool: 4 });
    expect(capacityBudgets.postgres).toMatchObject({ memory: 1024*MiB, cpus: .5, sharedBuffers: "32MB", workMem: "4MB", statementMs: 15000 });
    const runner = readFileSync(new URL("../../scripts/large-tenant-capacity.py", import.meta.url), "utf8");
    expect(runner).toContain('"shared_buffers=32MB"');
    expect(runner).toContain('"work_mem=4MB"');
    expect(runner).toContain('64*1024**3');
    expect(runner).toContain('"internal": True');
    expect(runner).not.toContain('"ports"');
  });
  it("uses the derived canonical ceiling without widening native-source admission", () => {
    expect(capacityInput("capacity-contract", "inventory_canonical").jobKind).toBe("derived");
    expect(capacityInput("capacity-contract", "inventory_packages").jobKind).toBe("fixture");
    expect(capacityInput("capacity-contract", "inventory_canonical").reserveBytes).toBe(1024**3);
    expect(capacityInput("capacity-contract", "inventory_packages").reserveBytes).toBe(1024**3);
    expect(capacityInput("capacity-contract", "inventory_power_platform").reserveBytes).toBe(1024**3);
    expect(capacityInput("capacity-contract", "directory").reserveBytes).toBe(8*1024**3);
    const runtime = readFileSync(new URL("../src/services/inventoryRuntime.ts",import.meta.url),"utf8");
    expect([...runtime.matchAll(/reserveBytes:\s*1024\s*\*\*\s*3/g)]).toHaveLength(2);
    expect(dataLimits.sourceRows).toBe(100_000);
    expect(dataLimits.derivedRows).toBe(200_000);
  });
  it("generates overlapping IDs and sparse observed facts independently", () => {
    expect(packageValue(99999).id).toBe("package-099999");
    expect(packageValue(0, 1, true)).toMatchObject({ id: "package-000000", isBlocked: true });
    expect(officialLine("userAgents", 999999)).toContain("user-099999@example.invalid");
    expect(officialLine("userAgents", 0)).toContain("agent-000000");
    expect(officialLine("userAgents", 1)).toContain("agent-000001");
    expect(parseReportUser(activityLine(99999).trimEnd().split(",")).normalizedUserPrincipalName)
      .toBe("user-099999@example.invalid");
  });
  it("keeps the full sparse churn profile free of identity-conflict exceptions without weakening their guard",() => {
    const now = Date.now();
    const saved = (value: ReturnType<typeof packageValue>,version: number) => ({
      package: { ...value,longDescription: `Synthetic detail value ${version}`,identityDetailsCollected: true },
      observedAt: new Date(now).toISOString(),expiresAt: new Date(now+3600_000).toISOString(),
      catalogRevision: packageDetailRevision(value),
    });
    for (const index of [0,1,2,3,100,99999]) {
      const initial = packageValue(index,0,false,"sparse");
      expect(initial.elementDetails).toBeUndefined();
      expect(nativeValue(index,false,"sparse").properties).not.toHaveProperty("botId");
      const first = projectPackageDetails(initial,saved(initial,0),true,now);
      const changed = projectPackageDetails(first,saved(packageValue(index,11,false,"sparse"),11),false,now);
      expect(changed).toMatchObject({ longDescription: "Synthetic detail value 11",detailFreshness: { state: "fresh" } });
    }
    const conflict = packageValue(3),first = projectPackageDetails(conflict,saved(conflict,0),true,now);
    expect(projectPackageDetails(first,saved(packageValue(3,11),11),false,now))
      .toMatchObject({ longDescription: "Synthetic detail value 0",detailFreshness: { state: "invalidated" } });
  });
  it("preserves the two real identity links and ambiguous/conflicting evidence through provider normalization",async () => {
    const client = new PowerPlatformResourceQueryClient(async () => new Response(JSON.stringify({
      totalRecords: 4,count: 4,resultTruncated: 0,data: Array.from({ length: 4 },(_,i) => nativeValue(i)),
    })));
    const resources = [];
    for await (const page of client.pages("synthetic",["microsoft.copilotstudio/agents"],
      { expectedTenantId: fixtureTenant,visit: async () => {} })) resources.push(...page.records);
    const now = Date.now();
    const packages = Array.from({ length: 5 },(_,i) => {
      const detailed = packageValue(i),current = projectPackageDetails(detailed,undefined);
      return projectPackageDetails(current,{ package: { ...detailed,identityDetailsCollected: true },
        observedAt: new Date(now).toISOString(),expiresAt: new Date(now+3600_000).toISOString(),
        catalogRevision: packageDetailRevision(current) },false,now);
    });
    expect(packages.every(value => value.detailFreshness?.state==="fresh")).toBe(true);
    expect(resolvePackageAgentLinks(fixtureTenant,packages,resources).map(value => value.status))
      .toEqual(["matched","matched","ambiguous","conflicting","unmatched"]);
  });
  it("cancels controller work before issuing further requests after its owner disconnects",async () => {
    const cancelled = new AbortController();
    cancelled.abort(new Error("controller_owner_closed"));
    await expect(capacityHttpLoad({ action: "readers",cookie: "synthetic" },cancelled.signal))
      .rejects.toThrow("controller_owner_closed");
  });
  it("fills a valid 256-MiB report incrementally without exceeding field or row ceilings", () => {
    let bytes = Buffer.byteLength(fileBoundaryHeader);
    for (let i = 0; i < 200_000; i++) {
      const row = fileBoundaryLine(i);
      if (i===0 || i===199999) expect(row.split(",")[1].length).toBeLessThanOrEqual(512);
      bytes += Buffer.byteLength(row);
    }
    expect(bytes).toBe(256*MiB);
  });
  it("keeps dynamically loaded workloads independent of the top-level-await entry point", () => {
    const workload = readFileSync(new URL("./capacityWorkloads.ts", import.meta.url), "utf8");
    expect(workload).not.toMatch(/from ["']\.\/large-tenant-capacity\.js["']/);
    expect(workload).toContain('from "./capacityRuntime.js"');
  });
  it("does not multiply absent columns and false views into stored child facts, while retaining known zero", () => {
    const value = packageValue(10);
    const projected = packageInventoryRecord(value);
    expect(projected.facts.length).toBeLessThan(40);
    expect(projected.facts.filter(fact => fact.kind === "view").every(fact => fact.boolean_value === true)).toBe(true);
    const record = buildRecords([value], [], resolvePackageAgentLinks("", [value], []), null, null)[0];
    record.columns = { responses: 0, activeUsers: null };
    const facts = canonicalRecord(value.id, record).facts;
    expect(facts.find(fact => fact.kind === "column:responses")).toMatchObject({ number_value: 0 });
    expect(facts.find(fact => fact.kind === "column:activeUsers")).toBeUndefined();
  });
  it("executes a real warm synchronous retained-heap burst with probe-only GC", () => {
    const source = `import {transientHeapProbe} from "./scripts/capacityTelemetry.ts";
      console.log("PROBE_RECEIPT "+JSON.stringify(await transientHeapProbe()));`;
    const child = spawnSync(process.execPath, ["--max-old-space-size=768", "--expose-gc", "--trace-gc-nvp", "--import", "tsx",
      "--input-type=module", "-e", source], { encoding: "utf8", timeout: 10_000, maxBuffer: 2*MiB,
      env: { PATH: process.env.PATH, HOME: process.cwd(), TMPDIR: process.cwd(), NPM_CONFIG_REGISTRY: "https://packagefeedproxy.microsoft.io/npm/" } });
    expect(child.status, child.stderr).toBe(0);
    const receipt = JSON.parse(child.stdout.split("\n").find(line => line.startsWith("PROBE_RECEIPT "))!.slice(14));
    expect(receipt.retainedBytes).toBeGreaterThanOrEqual(32*MiB);
    expect(receipt.live).toBeGreaterThan(receipt.tripwire);
    expect(receipt.timerMaximum).toBeLessThan(receipt.tripwire);
    expect(child.stdout.split("\n").map(parseGcNvp).filter(value => value?.complete).length).toBeGreaterThan(0);
    // Duration is a host-capacity result, never converted into a fabricated passing receipt.
    expect(receipt.status).toBe(receipt.durationMs < 250 ? "passed" : "inconclusive");
    console.log("REAL_TRANSIENT_PROBE", receipt);
  });
  it("attributes real physical membership/content changes without retaining row payloads", async () => {
    const fixture = await testDatabase(), events: Record<string, string>[] = [];
    let observer: Awaited<ReturnType<typeof physicalWork>> | undefined;
    let closure: { sql: string;parameters?: unknown[] } | undefined;
    let changes: { sql: string;parameters?: unknown[] } | undefined;
    try {
      const writer = new InventoryGenerations(fixture.runtime);
      await inventoryBaseline(writer, "capacity-physical-contract", 10);
      observer = await physicalWork(fixture.runtime, { write: value => events.push(value as Record<string, string>) } as CapacityTelemetry);
      observePeakMemory(() => {});
      fixture.runtime.on("acquire",checkpointQueries);
      observeQueryWork(value => {
        if (value.sql.includes("UPDATE inventory_memberships m SET valid_to_revision")) closure = value;
        if (value.sql.includes("INSERT INTO inventory_changes(")) changes = value;
      });
      await capacityOperation("test-native", () => writer.execute(inventoryInput("capacity-physical-contract"),
        { domain: "packages", mode: "delta", channel: "detail", targets: ["package-000000"] },
        lease => writer.appendBounded(lease, [packageInventoryRecord({ id: "package-000000", displayName: "Changed", isBlocked: false })]),
        { authorize: async () => {} }));
      await observer.flush();
      expect(events.some(event => event.operation === "test-native" && event.relation === "inventory_memberships"
        && event.action === "UPDATE" && event.rows === "1")).toBe(true);
      expect(events.some(event => event.relation === "package_record_rows" && event.action === "INSERT")).toBe(true);
      expect(events.some(event => event.event==="physical-reads" && event.operation==="test-native"
        && Number(event.sequentialTuples)+Number(event.indexTuples)>0 && event.committed===true)).toBe(true);
      expect(closure).toBeDefined();
      observeQueryWork();
      const plan = (await fixture.runtime.query("EXPLAIN (FORMAT JSON) "+closure!.sql,closure!.parameters)).rows[0]["QUERY PLAN"][0].Plan;
      type PlanNode = { "Node Type": string;"Relation Name"?: string;"Index Cond"?: string;Plans?: PlanNode[] };
      const nodes: PlanNode[] = [];
      const visit = (node: PlanNode) => { nodes.push(node); for (const child of node.Plans ?? []) visit(child); };
      visit(plan);
      expect(nodes.some(node => node["Node Type"]==="Tid Scan" && node["Relation Name"]==="inventory_memberships")).toBe(true);
      for (const node of nodes.filter(node => node["Relation Name"]==="inventory_memberships" && node["Index Cond"])) {
        expect(node["Index Cond"]).toContain("baseline_id");
        expect(node["Index Cond"]).toContain("identity");
      }
      expect(changes?.sql).toContain("LIMIT 1 OFFSET 0");
      nodes.length = 0;
      visit((await fixture.runtime.query("EXPLAIN (FORMAT JSON) "+changes!.sql,changes!.parameters)).rows[0]["QUERY PLAN"][0].Plan);
      expect(nodes.some(node => node["Relation Name"]==="inventory_memberships" && node["Index Cond"]?.includes("identity"))).toBe(true);
    } finally {
      fixture.runtime.removeListener("acquire",checkpointQueries);
      observeQueryWork(); observePeakMemory();
      await observer?.close(); await fixture.close();
    }
  }, 30_000);
  it("subtracts PostgreSQL pending scans carried over from a previous committed transaction",async () => {
    const fixture = await testDatabase();
    try {
      await inventoryBaseline(new InventoryGenerations(fixture.runtime),"capacity-counter-carryover",10);
      const client = await fixture.operator.connect();
      try {
        const settings = "SET LOCAL enable_indexscan=off; SET LOCAL enable_indexonlyscan=off; SET LOCAL enable_bitmapscan=off;";
        await client.query(`BEGIN; ${settings} SELECT sum(length(display_name)) FROM package_record_rows; COMMIT; BEGIN; ${settings}`);
        const before = await physicalReadSnapshot(client);
        expect(Number(before.find(row => row.relname==="package_record_rows")?.returned)).toBeGreaterThanOrEqual(10);
        const measuredBefore = await physicalReadMeasurement(client, "counter-calibration");
        expect(measuredBefore.reads).toEqual(before);
        await client.query("SELECT sum(length(display_name)) FROM package_record_rows");
        const after = await physicalReadSnapshot(client);
        const measuredAfter = await physicalReadMeasurement(client, "counter-calibration", measuredBefore.lsn);
        expect(measuredAfter.reads).toEqual(after);
        expect(Number(measuredAfter.wal)).toBeGreaterThanOrEqual(0);
        expect(physicalReadDeltas(before,after).find(row => row.relname==="package_record_rows"))
          .toMatchObject({ scans: "1",returned: "10",fetched: "0" });
        expect(() => physicalReadDeltas(after,before)).toThrow("capacity_read_counter_reset");
        expect(() => physicalReadDeltas(after,[])).toThrow("capacity_read_counter_disappeared");
      } finally { await client.query("ROLLBACK"); client.release(); }
    } finally { await fixture.close(); }
  },30_000);
  it("enforces exact/+1 normalized plan, fact and page bounds without partial publication",async () => {
    const fixture = await testDatabase();
    try {
      const result = await (await import("./capacityWorkloads.js")).normalizedQuotaBoundaries(fixture.runtime);
      expect(result).toMatchObject({ planFacts: 1000,normalizedFacts: 10000,pageRows: 100,oldPublicationsPreserved: true });
    } finally { await fixture.close(); }
  },30_000);
});
