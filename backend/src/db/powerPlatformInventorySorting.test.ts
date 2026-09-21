import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { PowerPlatformInventoryRepository, type InventoryListQuery } from "./powerPlatformInventory.js";

vi.mock("./pool.js", () => ({
  secretValue: () => undefined,
  pool: { query: () => { throw new Error("Live database access is forbidden in this contract test."); } },
  transaction: () => { throw new Error("Transactions are forbidden in this contract test."); },
}));
vi.mock("../services/operationalState.js", () => ({ requireProviderAdmissions: vi.fn() }));
vi.mock("../services/copilotStudioQuarantine.js", () => ({ validateQuarantineTarget: vi.fn() }));
vi.mock("./packageInventory.js", () => ({ PackageInventoryRepository: vi.fn() }));

const scope = { tenantId: "tenant-a", principalId: "reader-a" };
const snapshot = {
  id: "11111111-1111-4111-8111-111111111111", role_scope: "full", environment_scope: "",
  requested_types: ["microsoft.powerapps/apps"], queried_types: ["microsoft.powerapps/apps"],
  observed_count: 0, total_records: 0, page_count: 1, unknown_field_count: 0,
  observed_at: new Date("2026-09-20T12:00:00.000Z"), expires_at: new Date("2026-09-22T12:00:00.000Z"),
};

describe("saved inventory list and selection contracts", () => {
  it.each([
    ["displayName", 'display_name COLLATE "C"'],
    ["type", 'resource_type COLLATE "C"'],
    ["environmentId", 'NULLIF(environment_id, \'\') COLLATE "C"'],
    ["createdAt", "created_at"],
    ["lastPublishedAt", "last_published_at"],
  ] satisfies [NonNullable<InventoryListQuery["sortBy"]>, string][])(
    "sorts %s before pagination with missing values last in either direction", async (sortBy, expression) => {
      for (const sortDirection of ["asc", "desc"] as const) {
        const query = vi.fn()
          .mockResolvedValueOnce({ rows: [snapshot] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [{ count: 0 }] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] });
        const repository = new PowerPlatformInventoryRepository({ query } as unknown as pg.Pool);
        const page = await repository.list(scope, {
          snapshotId: snapshot.id, excludeAgents: true, search: "flow", sortBy, sortDirection, limit: 50, offset: 50,
          includeAssociations: false,
        });
        const [sql, values] = query.mock.calls[4]!;
        expect(sql).toContain(`ORDER BY ${expression} ${sortDirection.toUpperCase()} NULLS LAST`);
        expect(sql).toContain(',resource_type COLLATE "C" ASC,environment_id COLLATE "C" ASC,native_id COLLATE "C" ASC LIMIT $5 OFFSET $6');
        expect(sql).toContain("resource_type<>'microsoft.copilotstudio/agents'");
        expect(values).toEqual([snapshot.id, scope.tenantId, scope.principalId, "%flow%", 50, 50]);
        expect(page).toMatchObject({ value: [], count: 0, snapshot: { id: snapshot.id } });
        expect(query).toHaveBeenCalledTimes(5);
      }
    },
  );

  it("rejects equal-sized selection results when one native ID is ambiguous and another is absent", async () => {
    const agentType = "microsoft.copilotstudio/agents";
    const row = {
      tenant_id: scope.tenantId, native_id: "duplicate", resource_type: agentType, environment_id: "environment-a",
      location: null, display_name: "Agent", created_at: null, created_by: null, last_published_at: null,
      source_system: "power_platform", authoring_tool: "Copilot Studio", creator_type: "unknown",
      agent_kind: "copilot_studio_agent", lifecycle: "draft", identity_confidence: "exact_native",
      identifiers: [], provenance: {}, details: {}, unknown_field_count: 0,
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ ...snapshot, requested_types: [agentType], queried_types: [agentType], observed_count: 2, total_records: 2 }] })
      .mockResolvedValueOnce({ rows: [row, { ...row, environment_id: "environment-b" }] })
      .mockResolvedValueOnce({ rows: [{ snapshot_id: snapshot.id, resource_type: agentType, count: 2, unique_count: 2, environment_matches: true }] });
    const repository = new PowerPlatformInventoryRepository({ query } as unknown as pg.Pool);
    await expect(repository.getQuarantineSelection(scope, snapshot.id, ["duplicate", "absent"]))
      .rejects.toMatchObject({ status: 409, code: "inventory_selection_stale" });
    expect(query).toHaveBeenCalledTimes(2);
  });
});
