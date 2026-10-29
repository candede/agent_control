import { randomUUID } from "node:crypto";
import type pg from "pg";
import { inventoryInput, reconcileInventoryFixture } from "./inventoryFixtures.js";
import { selectionIdentity } from "./largeTenantFixtures.js";
import { publishFixtureDirectory } from "./userSourceFixture.js";
import { publishUsageReports } from "../src/db/agentUsageTestSupport.js";
import { InventoryGenerations, inventorySelector } from "../src/db/inventoryGenerations.js";
import { InventoryQueries, type InventoryQuery } from "../src/db/inventoryQueries.js";
import { packageInventoryRecord, powerPlatformInventoryRecord, type InventoryRecord } from "../src/services/inventoryRecordProjection.js";
import { inventoryPresentation } from "../src/services/inventoryPresentation.js";
import { DataExports } from "../src/services/dataExports.js";
import { inventoryExportColumns, inventoryExportSource, type InventoryExportKind } from "../src/services/inventoryExports.js";
import type { CopilotPackageDetail } from "../src/types/copilotPackage.js";
import type { CopilotDirectoryUser } from "../src/types/copilotUsage.js";
import { isInventoryCount, powerPlatformResourceTypes, type PowerPlatformResource, type PowerPlatformResourceType } from "../src/types/powerPlatformInventory.js";

export type SelectedInventoryFixtureInput = {
  scope?: { tenantId: string; principalId: string };
  packages?: CopilotPackageDetail[];
  resources?: PowerPlatformResource[];
  omitPackages?: boolean;
  omitResources?: boolean;
  directory?: CopilotDirectoryUser[];
  /** Per-agent response totals, distributed across users (one user by default). */
  usage?: { id: string; responses: number; users?: number }[];
  resourceTypes?: PowerPlatformResourceType[];
  roleScope?: "full" | "ai" | "unknown";
  environmentId?: string;
  observedAt?: Date;
  expiresAt?: Date;
};

export async function seedSelectedInventory(database: pg.Pool, options: SelectedInventoryFixtureInput = {}) {
  if (process.env.AGENT_CONTROL_ISOLATED_TESTS !== "1") throw new Error("fixture_only");
  if ((options.packages?.length ?? 0) + (options.resources?.length ?? 0) > 1000) throw new Error("selected_fixture_limit");
  if (options.usage && (options.usage.length > 100 || options.usage.some(value => !isInventoryCount(value.responses)
    || !isInventoryCount(value.users ?? 1) || (value.users ?? 1) > 10))) throw new Error("selected_usage_fixture_limit");
  const scope = options.scope ?? { tenantId: `selected-${randomUUID()}`, principalId: randomUUID() };
  const store = new InventoryGenerations(database);
  const identity = { ...selectionIdentity, ...scope, sessionEpoch: await store.generations.sessionEpoch(scope.tenantId, scope.principalId) };
  async function publish(domain: "packages" | "power_platform", records: InventoryRecord[], channel: "catalog" | "detail" = "catalog") {
    const input = { ...inventoryInput(scope.principalId, domain), sessionEpoch: identity.sessionEpoch,
      ...(options.observedAt ? { observedAt: options.observedAt } : {}),
      ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}) };
    input.scope.tenantId = scope.tenantId;
    const intent = { domain, mode: channel === "detail" ? "delta" as const : "baseline" as const, channel,
      ...(channel === "detail" ? { targets: records.map(record => record.native_id) } : {}),
      ...(domain === "power_platform" ? { resourceTypes: options.resourceTypes ?? [...powerPlatformResourceTypes],
        roleScope: options.roleScope ?? "full", ...(options.environmentId ? { environmentId: options.environmentId } : {}) } : {}) };
    input.scope.selector = inventorySelector(intent);
    return store.execute(input, intent, async lease => {
      for (let offset = 0; offset < records.length || offset === 0; offset += 100) {
        const page = records.slice(offset, offset + 100);
        const token = String(offset);
        await store.visit(lease, token);
        await store.appendBounded(lease, page);
        await store.acceptPage(lease, { token, nextToken: offset + 100 < records.length ? String(offset + 100) : null,
          records: page, rawCount: page.length, expectedCount: records.length, page: offset / 100 + 1 }, page.length);
      }
    }, { authorize: async () => {} });
  }
  let packages = options.omitPackages ? undefined : await publish("packages", (options.packages ?? []).map(packageInventoryRecord));
  const details = (options.packages ?? []).filter(value => value.detailFreshness && value.detailFreshness.state !== "missing");
  if (packages) {
    for (let offset = 0; offset < details.length; offset += 100) {
      packages = await publish("packages", details.slice(offset, offset + 100).map(packageInventoryRecord), "detail");
    }
  }
  const resources = options.omitResources ? undefined : await publish("power_platform",
    (options.resources ?? []).map(value => powerPlatformInventoryRecord({ ...value, tenantId: scope.tenantId })));
  if (options.directory) await publishFixtureDirectory(database, identity, options.directory);
  if (options.usage) {
    const csv = (rows: unknown[][]) => rows.map(row => row.map(cell => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const userRows = options.usage.flatMap(agent => {
      const users = agent.users ?? 1;
      return Array.from({ length: users }, (_, index) => ({
        agent, username: `${agent.id}-user-${index}`, responses: Math.floor(agent.responses / users) + Number(index < agent.responses % users),
      }));
    });
    const reports = {
      agents: csv([["Agent ID", "Agent name", "Creator type", "Active users (licensed)", "Active users (unlicensed)", "Responses sent to users", "Last activity date (UTC)"],
        ...options.usage.map(agent => [agent.id, agent.id, "Your org", Math.min(agent.responses, agent.users ?? 1), 0, agent.responses, "2026-09-16"])]),
      userAgents: csv([["Agent ID", "Agent name", "Creator type", "Username", "Responses sent to users", "Last activity date (UTC)"],
        ...userRows.map(row => [row.agent.id, row.agent.id, "Your org", row.username, row.responses, "2026-09-16"])]),
      users: csv([["Username", "Display name", "Number of agents used", "Agent responses received", "Last activity date (UTC)"],
        ...userRows.map(row => [row.username, row.username, row.responses ? 1 : 0, row.responses, "2026-09-16"])]),
    };
    await publishUsageReports(database, scope, 10, kind => reports[kind]);
  }
  const canonical = await reconcileInventoryFixture(database, scope, { observedAt: options.observedAt, expiresAt: options.expiresAt });
  if (!canonical) throw new Error("selected_fixture_canonical_required");
  const queries = new InventoryQueries(database, "synthetic-selected-inventory-golden-key");
  const selections = new Set<string>();
  return { scope, identity, queries, packages, resources, canonical, input: structuredClone(options),
    async releaseSelections() {
      for (const id of selections) {
        await queries.selections.invalidate(id, identity);
        selections.delete(id);
      }
    },
    async select(query: InventoryQuery = {}, limit = 50, domain: "canonical" | "packages" | "power_platform" = "canonical") {
      const root = domain === "canonical" ? canonical : domain === "packages" ? packages : resources;
      if (!root) throw new Error("selected_fixture_source_missing");
      const selection = await queries.capture(identity, root.scopeId, query);
      selections.add(selection.id);
      const raw = await queries.page(selection.id, identity, { limit });
      return { selection, raw, page: domain === "canonical" ? inventoryPresentation(raw) : undefined };
    } };
}

export async function selectedInventoryCsv(database: pg.Pool,
  fixture: Awaited<ReturnType<typeof seedSelectedInventory>>,
  selection: Awaited<ReturnType<InventoryQueries["capture"]>>,
  kind: InventoryExportKind = "unified_agents") {
  const exports = new DataExports(database, fixture.queries.selections, async () => {});
  const id = await exports.create(fixture.identity, { selectionId: selection.id, queryHash: selection.queryHash, kind, filename: "synthetic.csv" });
  await exports.build(id, fixture.identity, inventoryExportColumns[kind], inventoryExportSource(fixture.queries, fixture.identity));
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of exports.download(id, fixture.identity, new AbortController().signal)) {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) throw new Error("selected_csv_fixture_limit");
    chunks.push(chunk);
  }
  return { csv: Buffer.concat(chunks, bytes).toString("utf8"), status: await exports.status(id, fixture.identity) };
}
