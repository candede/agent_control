import { randomUUID, createHash } from "node:crypto";
import os from "node:os";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { testDatabase } from "./testDatabase.js";
import { generationInput } from "./largeTenantFixtures.js";
import { inventoryInput } from "./inventoryFixtures.js";
import { key, userId, officialLine } from "./capacityProvider.js";
import { InventoryGenerations } from "../src/db/inventoryGenerations.js";
import { UserSourceStages } from "../src/db/userSourceStages.js";
import { InventoryReconciliation } from "../src/services/inventoryReconciliation.js";
import { packageInventoryRecord, powerPlatformInventoryRecord } from "../src/services/inventoryRecordProjection.js";
import { OfficialReportImports } from "../src/db/officialReportImports.js";
import { schemaRegistry } from "../src/services/officialReportFields.js";
import { AgentDiscovery } from "../src/services/agentDiscovery.js";
import { reportIdentity } from "../src/services/reportIdentity.js";
import { observeTransactionStart } from "../src/services/peakMemory.js";
import { transaction } from "../src/db/pool.js";
import { discoveryQuerySettingsSql } from "../src/db/agentDiscoveryQueries.js";
import type { DiscoveryRequest } from "../src/types/agentDiscovery.js";
import type { AuthenticatedUser } from "../src/types/session.js";
import type pg from "pg";

it("measures four discovery query shapes at 100k people, 200k catalog and 1m edges", async () => {
  if (process.env.AGENT_CONTROL_ISOLATED_TESTS !== "1") throw new Error("Use the existing isolated mcp-agent-discovery-capacity suite.");
  const fixture = await testDatabase(), database = fixture.runtime, tenant = randomUUID(), principal = "discovery-capacity";
  const actor: AuthenticatedUser = { tenantId: tenant, homeAccountId: principal, localAccountId: userId(0),
    username: "user-000000@example.invalid", displayName: "Capacity", roles: ["AgentControl.Viewer"] };
  const identity = await reportIdentity(database, actor), stages = new InventoryGenerations(database);
  const checksum = createHash("sha256");
  const event = (value: object) => process.stdout.write(`${JSON.stringify({ event: "discovery_capacity", ...value })}\n`);
  try {
    const directory = new UserSourceStages(database);
    await directory.execute(generationInput({ scope: { ...generationInput().scope, tenantId: tenant },
      actorPrincipalId: principal, sessionEpoch: identity.sessionEpoch, reserveBytes: 512 * 1024 ** 2 }), async lease => {
      const query = await directory.query(lease, "discovery", "capacity");
      for (let offset = 0; offset < 100_000; offset += 250) {
        const values = Array.from({ length: 250 }, (_, j) => {
          const i = offset + j;
          return { serviceEvidenceVersion: 1 as const, identity: { objectId: userId(i), userPrincipalName: `user-${key(i)}@example.invalid`,
            displayName: `User ${key(i)}`, companyName: `Company ${i % 20}`, department: `Department ${Math.floor(i / 20) % 10}`,
            accountEnabled: true, userType: "Member", employeeType: null }, copilotServiceState: "unknown" as const, servicePlans: [] };
        });
        await directory.page(lease, query, String(offset), 250, 100_000);
        await directory.directory(lease, query, values);
      }
      await directory.finishQuery(lease, query);
    }, { beforePublish: async () => {} });
    event({ stage: "directory_published", people: 100_000 });
    const source = async (domain: "packages" | "power_platform") => {
      const input = inventoryInput(principal, domain);
      input.scope.tenantId = tenant; input.sessionEpoch = identity.sessionEpoch;
      input.reserveBytes = 1024 ** 3;
      const intent = { domain, mode: "baseline" as const, channel: "catalog" as const,
        ...(domain === "power_platform" ? { resourceTypes: ["microsoft.copilotstudio/agents"] as const, roleScope: "full" as const } : {}) };
      return stages.execute(input, intent, async lease => {
        for (let offset = 0; offset < 100_000; offset += 250) {
          const values = Array.from({ length: 250 }, (_, j) => {
            const i = offset + j;
            const description = i % 1000 === 0 ? "Review business requirements documents and identify missing acceptance criteria."
              : "Summarize saved quarterly business information for planning.";
            const value = domain === "packages" ? packageInventoryRecord({
              id: `package-${key(i)}`, displayName: `Business task ${key(i)}`, isBlocked: false, type: "lob", ownerId: userId(i),
              longDescription: description, availableTo: "none", deployedTo: "none",
            }) : powerPlatformInventoryRecord({ sourceSystem: "power_platform", nativeId: `native-${key(i)}`, tenantId: tenant,
              type: "microsoft.copilotstudio/agents", displayName: `Private task ${key(i)}`, createdBy: userId(i),
              createdAt: null, creatorType: "unknown", agentKind: "copilot_studio_agent", lifecycle: i % 2 ? "draft" : "published",
              environmentId: null, authoringTool: null, location: null, lastPublishedAt: null,
              identityConfidence: "exact_native", identifiers: [], provenance: {}, unknownFieldCount: 0,
              details: { ownerId: userId(i), description } });
            checksum.update(`${domain}:${value.identity}\n`); return value;
          });
          await stages.visit(lease, String(offset));
          await stages.appendBounded(lease, values);
          await stages.acceptPage(lease, { token: String(offset), nextToken: offset + 250 < 100_000 ? String(offset + 250) : null,
            records: values, rawCount: 250, expectedCount: 100_000, page: offset / 250 + 1,
            ...(domain === "power_platform" ? { omittedFieldCount: 0 } : {}) }, 250);
        }
      }, { authorize: async () => {} });
    };
    const packages = await source("packages"), native = await source("power_platform");
    const reconciliation = new InventoryReconciliation(database), input = inventoryInput(principal, "canonical");
    input.scope.tenantId = tenant; input.sessionEpoch = identity.sessionEpoch; input.reserveBytes = 1024 ** 3;
    await reconciliation.request(input, [packages, native]);
    const canonical = await reconciliation.runNext(input, async () => {});
    expect(canonical).not.toBeNull();
    const actual = (await database.query("SELECT row_count::integer AS count FROM inventory_roots WHERE baseline_id=$1", [canonical!.baselineId])).rows[0].count;
    expect(actual).toBe(200_000);
    event({ stage: "catalog_published", catalog: actual, sourceChecksum: checksum.digest("hex") });
    const imports = new OfficialReportImports(database), bundleId = randomUUID();
    for (const [kind, count] of [["users", 100_000], ["agents", 200_000], ["userAgents", 1_000_000]] as const) {
      await imports.stage(identity, { bundleId }, (async function* () {
        yield Buffer.from(schemaRegistry[kind].headers.join(",") + "\n");
        for (let offset = 0; offset < count; offset += 250) yield Buffer.from(Array.from({ length: Math.min(250, count - offset) },
          (_, j) => officialLine(kind, offset + j).replaceAll("agent-", "package-")).join(""));
      })(), { reportingPeriod: { startDate: "2026-09-01", endDate: "2026-09-30", provenance: "operator_asserted" } });
      event({ stage: "report_staged", kind, count });
    }
    await imports.acceptBundle(identity, bundleId, await imports.bundle(identity, bundleId));
    await fixture.operator.query("ANALYZE");
    const count = (await database.query(`SELECT (SELECT count(*) FROM directory_user_rows) AS people,
      (SELECT sum(row_count) FROM inventory_roots WHERE domain='canonical' AND current) AS catalog,
      (SELECT count(*) FROM official_usage_row_facts WHERE kind='userAgents') AS edges`)).rows[0];
    const machine = { node: process.version, platform: process.platform, architecture: process.arch,
      machine: os.cpus()[0]?.model, cpus: os.cpus().length, memoryBytes: os.totalmem(),
      cgroupMemory: readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim(),
      postgres: (await database.query("SELECT version() AS version")).rows[0].version };
    event({ stage: "dataset_ready", counts: count, ...machine });
    const service = new AgentDiscovery(database), shapes: [string, DiscoveryRequest, boolean][] = [
      ["search", { operation: "search", goal: "BRD", terms: ["business requirements documents"] }, false],
      ["department_popularity", { operation: "workplace", scope: "department", limit: 3 }, false],
      ["company_popularity", { operation: "workplace", scope: "company", limit: 3 }, false],
      ["combined_preview", { operation: "workplace", scope: "both", limit: 3 }, true],
    ];
    const samples = new Map<string, { sql: string; values: unknown[] }>();
    const originals = new Map<pg.PoolClient, pg.PoolClient["query"]>();
    const stop = observeTransactionStart(async client => {
      if (originals.has(client)) return;
      const original = client.query; originals.set(client, original);
      client.query = ((...args: unknown[]) => {
        if (typeof args[0] === "string" && Array.isArray(args[1]) && (args[0].includes("scored AS") || args[0].includes("SELECT identity,company_users"))) {
          samples.set(args[0].includes("scored AS") ? "search" : "popularity", { sql: args[0], values: args[1] });
        }
        return Reflect.apply(original, client, args);
      }) as typeof client.query;
    });
    const results: object[] = [];
    try {
      for (const [shape, request, preview] of shapes) {
        const durations: number[] = [], sizes: number[] = [], cards: number[] = [];
        let warmed = 0;
        try {
        const captureStarted = performance.now();
        const first = await service.execute(actor, request, preview ? userId(0) : undefined);
        const captureMs = performance.now() - captureStarted;
        const selected = { ...request, selectionId: first.selection.id };
        for (; warmed < 3; warmed++) await service.execute(actor, selected, preview ? userId(0) : undefined);
        for (let measured = 0; measured < 50; measured++) {
          const start = performance.now(), response = await service.execute(actor, selected, preview ? userId(0) : undefined);
          durations.push(performance.now() - start); sizes.push(Buffer.byteLength(JSON.stringify(response)));
          cards.push("value" in response ? response.value.length : "department" in response ? response.department.value.length + response.company.value.length : 0);
        }
        durations.sort((a, b) => a - b);
        const result = { shape, measured: durations.length, warmup: warmed, captureMs, p95Ms: durations[47], maxMs: durations.at(-1),
          bytesMax: Math.max(...sizes), cardsMax: Math.max(...cards), thresholdMs: 2000, status: durations[47] <= 2000 ? "passed" : "failed" };
        results.push(result); event(result);
        const sample = samples.get(shape === "search" ? "search" : "popularity");
        if (!sample) throw new Error("discovery_capacity_query_not_observed");
        try {
          const plan = await transaction(database, async client => {
            await client.query(discoveryQuerySettingsSql);
            return client.query(`EXPLAIN (ANALYZE,BUFFERS,SETTINGS,FORMAT JSON) ${sample.sql}`, sample.values);
          });
          event({ stage: "query_plan", shape, plan: plan.rows });
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error ? error.code : null;
          event({ stage: "query_plan_unavailable", shape,
            errorCode: typeof code === "string" && /^[a-zA-Z0-9_]{1,128}$/.test(code) ? code : "discovery_capacity_plan_failed" });
        }
        await service.reports.selections.invalidate(first.selection.id, identity);
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error ? error.code : null;
          const result = { shape, measured: durations.length, warmup: warmed, p95Ms: null, thresholdMs: 2000, status: "failed",
            errorCode: typeof code === "string" && /^[a-zA-Z0-9_]{1,128}$/.test(code) ? code : "discovery_capacity_query_failed" };
          results.push(result); event(result);
        }
      }
    } finally { stop(); for (const [client, original] of originals) client.query = original; }
    event({ stage: "result", results, counts: count, ...machine, authAndModelLatency: "excluded" });
    expect(results).toHaveLength(4);
    expect(results.every(result => "status" in result && result.status === "passed")).toBe(true);
  } finally { await fixture.close(); }
}, 1_700_000);
