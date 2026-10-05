import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { testDatabase } from "../../scripts/testDatabase.js";
import { inventoryBaseline } from "../../scripts/inventoryFixtures.js";
import { selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { InventoryGenerations } from "../db/inventoryGenerations.js";
import { InventoryQueries } from "../db/inventoryQueries.js";
import { AuditLog } from "./auditLog.js";
import { DataExports, type ExportSource } from "./dataExports.js";
import { inventoryExportColumns, inventoryExportSource } from "./inventoryExports.js";

describe("selected inventory transaction dependencies", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => { fixture = await testDatabase(); });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await fixture?.close(); });

  async function selectedOperation() {
    const principalId = randomUUID(), identity = { ...selectionIdentity, principalId };
    const scope = { tenantId: identity.tenantId, principalId };
    const root = await inventoryBaseline(new InventoryGenerations(fixture.runtime), principalId, 2);
    const operationId = randomUUID(), audit = new AuditLog(scope, fixture.runtime);
    const event = await audit.startEvent({
      id: randomUUID(), operationId, scope: "bulk", action: "block", targetBlockedState: true,
      agentId: "package-000000", requestPath: "/fixture",
      actor: { tenantId: scope.tenantId, homeAccountId: principalId, username: "fixture@example.invalid", displayName: "Fixture" },
    });
    await audit.completeEvent(event.id, { status: "succeeded" });
    const queries = new InventoryQueries(fixture.runtime, "synthetic-inventory-transaction-cursor-key");
    const selection = await queries.capture(identity, root.scopeId, { operationIdPrefix: operationId.slice(0, 8) });
    return { queries, identity, selection };
  }

  it("reads operation-reference rows, counts and context on one repeatable-read client without a pool query", async () => {
    const { queries, identity, selection } = await selectedOperation();
    const connect = vi.spyOn(fixture.runtime, "connect");
    const poolQuery = vi.spyOn(fixture.runtime, "query").mockRejectedValue(new Error("Unexpected extra pool query"));
    const query = vi.spyOn(pg.Client.prototype, "query");
    const page = await queries.page(selection.id, identity);
    expect(page.counts).toMatchObject({ total: 2, filtered: 1 });
    expect(page.value.map(row => row.id)).toEqual(["package-000000"]);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(poolQuery).not.toHaveBeenCalled();
    expect(new Set(query.mock.contexts).size).toBe(1);
    expect(query.mock.calls.filter(([sql]) => sql === "BEGIN ISOLATION LEVEL REPEATABLE READ")).toHaveLength(1);
    expect(query.mock.calls.filter(([sql]) => sql === "COMMIT")).toHaveLength(1);
  });

  it("keeps each durable export source callback on its supplied selected client", async () => {
    const { queries, identity, selection } = await selectedOperation();
    const exports = new DataExports(fixture.runtime, queries.selections, async () => {});
    const id = await exports.create(identity, { selectionId: selection.id, queryHash: selection.queryHash,
      kind: "graph_packages", filename: "synthetic-operation.csv" });
    const source = inventoryExportSource(queries, identity);
    let reads = 0;
    const checked: ExportSource = async function* (signal, job) {
      yield* source(signal, { ...job, read: work => job.read(async client => {
        const connect = vi.spyOn(fixture.runtime, "connect");
        const poolQuery = vi.spyOn(fixture.runtime, "query").mockRejectedValue(new Error("Unexpected export source pool query"));
        try {
          reads++;
          const result = await work(client);
          expect(connect).not.toHaveBeenCalled();
          expect(poolQuery).not.toHaveBeenCalled();
          return result;
        } finally { connect.mockRestore(); poolQuery.mockRestore(); }
      }) });
    };
    await exports.build(id, identity, inventoryExportColumns.graph_packages, checked);
    expect(reads).toBe(1);
    expect(await exports.status(id, identity)).toMatchObject({ status: "ready", rows: 1 });
  });
});
