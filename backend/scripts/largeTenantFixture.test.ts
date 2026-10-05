import { describe, expect, it, vi } from "vitest";
import { fixtureCommands, fixtureEnvironment, runFixtureCommand } from "./largeTenantFixture.js";
import { licensingGolden, officialGoldenCsvRows, selectionIdentity } from "./largeTenantFixtures.js";
import { OfficialReportImports } from "../src/db/officialReportImports.js";
import { LargeTenantUsersReports } from "../src/services/largeTenantUsersReports.js";
import { schemaRegistry } from "../src/services/officialReportFields.js";
import type { ReportUser } from "../src/types/officialReportData.js";
import { testDatabase } from "./testDatabase.js";
import { randomUUID } from "node:crypto";
import { isCopilotAppActivityFresh, isCopilotServiceActive } from "../src/types/copilotUsage.js";
import { existsSync, readFileSync } from "node:fs";
import { databaseSettings } from "../src/db/pool.js";
import { schemaFingerprint } from "../src/db/schema.js";
import { testSchemaTemplateIdentity } from "./testDatabaseTemplate.js";

describe("large tenant fixture and frozen semantic seeds", () => {
  it.each(["inventory-metadata", "cutover-ui-contract"])("points cleanup qualification at current frontend tests: %s", suite => {
    const files = fixtureCommands(suite).filter(command => command[1] === "test" && command[3] === "frontend")
      .flatMap(command => command.filter(value => /\.test\.tsx?$/.test(value)));
    expect(files).toContain("src/useOfficialUsageOverview.test.tsx");
    for (const file of files) expect(existsSync(new URL(`../../frontend/${file}`, import.meta.url)), file).toBe(true);
  });

  it("qualifies pending production contracts without launching a capacity workload or aggregate campaign", () => {
    expect(fixtureCommands("production-prerequisites")).toEqual([
      ["run","test","--workspace","backend","--","src/db/reportMembershipCounts.test.ts",
        "src/db/schema.test.ts","scripts/database.test.ts","scripts/backup.test.ts","scripts/largeTenantRestore.test.ts",
        "src/db/officialUsageHistorySelection.test.ts","src/services/largeTenantUsersReports.test.ts",
        "src/db/inventoryGenerations.test.ts","scripts/largeTenantCapacity.test.ts","scripts/largeTenantFixture.test.ts"],
      ["run","typecheck","--workspace","backend"],
    ]);
  });
  it("selects actual schema, cursor, termination and instrumentation root regressions before broad qualification", () => {
    expect(fixtureCommands("capacity-core")).toEqual([
      ["run","test","--workspace","backend","--","src/db/schema.test.ts","src/db/inventoryGenerations.test.ts",
        "src/db/dataGenerations.test.ts","src/db/dataRetention.test.ts","src/services/dataSelections.test.ts","src/db/childInsertFence.test.ts","src/db/reportMembershipCounts.test.ts",
        "scripts/largeTenantCapacity.test.ts","scripts/largeTenantFixture.test.ts"],
      ["run","typecheck","--workspace","backend"],
    ]);
  });
  it("repeats exactly the independent all software commands without claiming its separate auxiliary qualification", () => {
    expect(fixtureCommands("capacity-software")).toEqual(fixtureCommands("all"));
    expect(fixtureCommands("capacity-software")).toHaveLength(5);
    expect(fixtureCommands("capacity-software")[0]).toEqual(["run","test","--workspace","backend"]);
  });
  it("uses disk-backed checkpoint headroom only in the large fixture without changing ordinary memory or CPU defaults", () => {
    const ordinary = readFileSync(new URL("../../compose.yaml",import.meta.url),"utf8");
    const large = readFileSync(new URL("../../compose.large-tenant-test.yaml",import.meta.url),"utf8");
    expect(ordinary).toContain("max_wal_size=64MB");
    expect(large).toContain("shared_buffers=32MB");
    expect(large).toContain("min_wal_size=32MB");
    expect(large).toContain("max_wal_size=1GB");
    expect(large).not.toMatch(/(?:mem_limit|cpus|work_mem|maintenance_work_mem):/);
    expect(large).toContain("tmpfs: !reset []");
    expect(large).toContain("large-tenant-data:/var/lib/postgresql/data");
  });
  it("clones a sealed source-exact schema without sharing test rows, object grants or the uninitialized option", async () => {
    const first = await testDatabase();
    let second: Awaited<ReturnType<typeof testDatabase>> | undefined;
    let empty: Awaited<ReturnType<typeof testDatabase>> | undefined;
    try {
      const settings = (await first.operator.query(`SELECT name,setting,unit FROM pg_settings WHERE name IN
        ('shared_buffers','work_mem','maintenance_work_mem','min_wal_size','max_wal_size','checkpoint_timeout','checkpoint_completion_target')
        ORDER BY name`)).rows;
      process.stdout.write(JSON.stringify({ event: "test_postgres_checkpoint_settings",settings })+"\n");
      const identity = { ...selectionIdentity, tenantId: `template-isolation-${randomUUID()}` };
      await new LargeTenantUsersReports(first.runtime, "synthetic-template-schema-secret-32", 30).sources.ensureScope(identity, "delegated");
      second = await testDatabase();
      expect(second.name).not.toBe(first.name);
      expect((await second.runtime.query("SELECT count(*)::int AS n FROM data_scope_epochs WHERE tenant_id=$1", [identity.tenantId])).rows[0].n).toBe(0);
      expect((await second.runtime.query("SELECT fingerprint FROM app_schema WHERE singleton=true")).rows)
        .toEqual([{ fingerprint: schemaFingerprint }]);
      await expect(second.runtime.query("CREATE TABLE template_must_not_grant_ddl(id integer)")).rejects.toMatchObject({ code: "42501" });
      const template = testSchemaTemplateIdentity(String(databaseSettings().database));
      expect((await first.operator.query(`SELECT datallowconn,shobj_description(oid,'pg_database') AS marker
        FROM pg_database WHERE datname=$1`, [template.name])).rows).toEqual([{ datallowconn: false, marker: template.marker }]);
      empty = await testDatabase(false);
      expect((await empty.operator.query("SELECT to_regclass('public.app_schema') AS name")).rows[0].name).toBeNull();
    } finally {
      await empty?.close();
      await second?.close();
      await first.close();
    }
  });

  it("ends only the timed-out command's owned process group before the next aggregate step", () => {
    const result = { pid: 42, status: null, signal: "SIGTERM" as const,
      error: Object.assign(new Error("spawnSync npm ETIMEDOUT"), { code: "ETIMEDOUT" }),
      stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), output: [] };
    const execute = vi.fn(() => result), kill = vi.fn();
    expect(runFixtureCommand(["run", "test"], { CI: "1" }, execute, kill)).toBe(result);
    expect(execute).toHaveBeenCalledWith("npm", ["run", "test"], expect.objectContaining({
      timeout: 600_000, detached: true, cwd: "/app", env: { CI: "1" }, stdio: "inherit",
    }));
    expect(kill).toHaveBeenCalledExactlyOnceWith(-42, "SIGKILL");
    kill.mockClear();
    runFixtureCommand(["run", "test"], {}, () => ({ ...result, status: 0, signal: null, error: undefined }), kill);
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not continue after timeout cleanup loses ownership or cannot stop its process group", () => {
    const result = { pid: 42, status: null, signal: "SIGTERM" as const,
      error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
      stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), output: [] };
    expect(() => runFixtureCommand([], {}, () => result, () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); }))
      .not.toThrow();
    expect(() => runFixtureCommand([], {}, () => result, () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); }))
      .toThrow("fixture_timeout_process_group_cleanup");
    const kill = vi.fn();
    expect(() => runFixtureCommand([], {}, () => ({ ...result, pid: 0 }), kill)).toThrow("fixture_timeout_process_group_missing");
    expect(kill).not.toHaveBeenCalled();
  });

  it("preserves paid enabled/warning/partial versus inactive and unknown", () => {
    expect(licensingGolden.map(row => isCopilotServiceActive(row.state))).toEqual(licensingGolden.map(row => row.paid));
    expect(isCopilotAppActivityFresh(null, new Date("2026-01-04"))).toBe(false);
    expect(isCopilotAppActivityFresh("2026-01-01", new Date("2026-01-05T00:00:00Z"))).toBe(true);
    expect(isCopilotAppActivityFresh("2026-01-01", new Date("2026-01-06T00:00:00Z"))).toBe(false);
  });
  it("requires future suites to fail and preserves all five independent aggregate commands", () => {
    expect(fixtureCommands("all")).toHaveLength(5);
    expect(fixtureCommands("all")[0]).toEqual(["run", "test", "--workspace", "backend"]);
    expect(fixtureCommands("backend-shard-1")).toEqual([["run", "test", "--workspace", "backend", "--", "--shard=1/2"]]);
    expect(fixtureCommands("backend-shard-2")).toEqual([["run", "test", "--workspace", "backend", "--", "--shard=2/2"]]);
    const inventory = fixtureCommands("inventory");
    expect(inventory).toHaveLength(2);
    expect(inventory[0].slice(0, 5)).toEqual(["run", "test", "--workspace", "backend", "--"]);
    expect(inventory[0].slice(5)).toHaveLength(16);
    expect(inventory[0]).toContain("src/services/inventoryRuntime.test.ts");
    expect(inventory[0]).toContain("src/routes/largeTenantInventory.test.ts");
    expect(inventory[1].slice(0, 5)).toEqual(["run", "test", "--workspace", "frontend", "--"]);
    expect(inventory[1].slice(5)).toHaveLength(11);
    expect(inventory[1]).toContain("src/components/LargeTenantInventory.test.tsx");
    for (const suite of ["capacity", "browser", "fresh-installation", "restart"]) {
      expect(() => fixtureCommands(suite)).toThrow("not yet implemented");
    }
    expect(fixtureCommands("lifecycle")[0]).toContain("src/db/dataLifecycle.test.ts");
    expect(fixtureCommands("restore")[0]).toContain("scripts/largeTenantRestore.test.ts");
    expect(fixtureCommands("capacity-focused")[0]).toContain("scripts/largeTenantCapacity.test.ts");
    expect(fixtureCommands("capacity-focused")[0]).toEqual(expect.arrayContaining([
      "src/routes/largeTenantInventory.test.ts","src/db/powerPlatformInventory.test.ts","src/db/officialUsage.test.ts",
    ]));
    expect(fixtureCommands("user-sources-foundation")).toEqual([
      ["run", "test", "--workspace", "backend", "--", "src/services/largeTenantUserSources.test.ts",
        "src/db/dataSync.test.ts", "src/services/copilotUsageGraph.test.ts", "src/services/copilotUsage.test.ts",
        "src/services/copilotServicePlans.test.ts", "src/services/userSourceGraphFields.test.ts", "src/services/savedAgentPeople.test.ts"],
      ["run", "typecheck", "--workspace", "backend"],
    ]);
    expect(fixtureCommands("official-reports-foundation")).toEqual([
      ["run", "test", "--workspace", "backend", "--", "src/services/largeTenantUsersReports.test.ts",
        "src/db/officialUsageHistorySelection.test.ts", "src/db/officialUsage.test.ts", "src/db/officialUsageImports.test.ts",
        "src/db/officialUsageHistory.test.ts", "src/services/officialUsageParser.test.ts", "src/services/officialUsageViews.test.ts",
        "src/services/copilotUsage.test.ts", "src/services/agentUsage.test.ts"],
      ["run", "typecheck", "--workspace", "backend"],
    ]);
    expect(fixtureCommands("inventory-foundation")).toEqual([
      ["run", "test", "--workspace", "backend", "--", "src/db/inventoryGenerations.test.ts",
        "src/services/inventoryReconciliation.test.ts", "src/services/streamedInventory.test.ts",
        "src/db/packageInventoryPublication.test.ts", "src/db/packageInventoryAdmission.test.ts", "src/db/packageInventoryFilters.test.ts",
        "src/db/powerPlatformInventory.test.ts", "src/db/unifiedAgentRegistry.test.ts", "src/services/packageAgentIdentity.test.ts",
        "src/services/packageMutationState.test.ts", "src/services/packageControlProjection.test.ts",
        "src/services/powerPlatformResourceQuery.test.ts", "src/services/graphPackagePacing.test.ts", "src/services/graphPackageReadBudget.test.ts"],
      ["run", "typecheck", "--workspace", "backend"],
    ]);
  });
  it("freezes complete-set counts and unknown versus zero through native imports and selections", async () => {
    const fixture = await testDatabase();
    try {
      const rows = officialGoldenCsvRows(), imports = new OfficialReportImports(fixture.runtime);
      const reports = new LargeTenantUsersReports(fixture.runtime, "synthetic-fixture-golden-read-secret", 35);
      const bundleId = randomUUID(), identity = { ...selectionIdentity, tenantId: `fixture-golden-${randomUUID()}` };
      const date = (days: number) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const metadata = { reportingPeriod: { startDate: date(31), endDate: date(2), provenance: "operator_asserted" as const },
        sourceAsOf: { value: new Date(Date.now() - 86400000).toISOString(), provenance: "operator_asserted" as const } };
      async function* source(kind: keyof typeof rows) {
        yield Buffer.from(`${schemaRegistry[kind].headers.join(",")}\n${rows[kind].join("\n")}\n`);
      }
      for (const kind of ["agents", "users", "userAgents"] as const) await imports.stage(identity, { bundleId }, source(kind), metadata);
      await imports.acceptBundle(identity, bundleId, await imports.bundle(identity, bundleId));
      const aggregateSelection = await reports.capture(identity, "delegated", "official_agents");
      const aggregate = await reports.page(aggregateSelection.id, identity);
      expect(aggregate.reports.availability).toBe("active");
      expect(aggregate.reports.reportingPeriod?.days).toBe(30);
      expect(aggregate.reports.lineages.map(lineage => lineage.kind).sort()).toEqual(["agents", "userAgents", "users"]);
      expect(aggregate.summary).toMatchObject({ reportedResponses: 9, bridgeResponses: 9, userReportedResponses: 5,
        distinctActiveReportUsers: 2, activeUsersAreNonAdditive: true });
      const selected = await reports.capture(identity, "delegated", "official_users");
      const view = await reports.page<ReportUser>(selected.id, identity);
      expect(view.counts).toEqual({ total: 3, filtered: 3 });
      expect(view.reports.lineages.find(lineage => lineage.kind === "users")?.rowCount).toBe(2);
      expect(view.reports.lineages.find(lineage => lineage.kind === "userAgents")?.rowCount).toBe(2);
      expect(view.value.find(row => row.username === "unresolved-token")).toMatchObject({ missingUserReport: true, reviewCohort: "unknown", reportedResponses: null });
      expect(view.value.find(row => row.username === "zero@example.invalid")).toMatchObject({ missingUserReport: false, reportedResponses: 0 });
      const filtered = await reports.capture(identity, "delegated", "official_users", { search: "Exact" });
      expect((await reports.page(filtered.id, identity)).counts).toEqual({ total: 3, filtered: 1 });
      const incomplete = { ...identity, tenantId: `fixture-incomplete-${randomUUID()}` }, incompleteBundle = randomUUID();
      for (const kind of ["agents", "userAgents"] as const) {
        const preview = await imports.stage(incomplete, { bundleId: incompleteBundle }, source(kind), metadata);
        await imports.accept(incomplete, { stagingId: preview.id, revision: preview.revision,
          contentHash: preview.contentHash, expectedActiveRevision: preview.activeRevision });
      }
      const missing = await reports.capture(incomplete, "delegated", "official_users");
      const unavailable = await reports.page(missing.id, incomplete);
      expect(unavailable.reports.availability).toBe("incomplete");
      expect(unavailable.summary.userReportedResponses).toBeNull();
      expect(unavailable.value).toEqual([]);
    } finally { await fixture.close(); }
  });
  it("rejects application identities without exposing their values", () => {
    vi.stubEnv("TENANT_ID", "do-not-print");
    expect(() => fixtureEnvironment()).toThrow("large_tenant_fixture_identity_required");
    vi.unstubAllEnvs();
  });
  it("keeps synthetic isolation and disk-backed storage scoped to the override", () => {
    const wrapper = readFileSync(new URL("../../scripts/large-tenant-tests.ps1", import.meta.url), "utf8");
    expect(wrapper).toContain("RUN rm -rf /app/backend/src /app/backend/scripts /app/backend/dist /app/frontend/src");
    expect(wrapper).not.toContain("rm -rf /app/node_modules");
    const override = readFileSync(new URL("../../compose.large-tenant-test.yaml", import.meta.url), "utf8");
    expect(override).toContain("tmpfs: !reset []");
    expect(override).toContain("large-tenant-data:/var/lib/postgresql/data");
    expect(override).not.toContain("ports:");
    expect(override).not.toContain("secrets:");
    const gate = readFileSync(new URL("../../scripts/local-deployment.ps1", import.meta.url), "utf8");
    const capture = gate.indexOf("Write-FixtureDiagnostics $project $evidence -Final");
    expect(capture).toBeGreaterThan(0);
    expect(capture).toBeLessThan(gate.indexOf("Remove-OwnedFixture $compose $project"));
  });
});
