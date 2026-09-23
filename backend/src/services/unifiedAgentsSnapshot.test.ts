import { afterEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { PackageInventoryRepository } from "../db/packageInventory.js";
import { PowerPlatformInventoryRepository } from "../db/powerPlatformInventory.js";
import { UnifiedAgentRegistry } from "../db/unifiedAgentRegistry.js";
import { pool } from "../db/pool.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import { agentUsage } from "./agentUsage.js";
import { savedAgentPeople } from "./savedAgentPeople.js";
import { UnifiedAgentsService } from "./unifiedAgents.js";

afterEach(() => vi.restoreAllMocks());

describe("Unified agent snapshot dependencies", () => {
  it("uses the snapshot client for default operation-reference reads and exports without another pool checkout", async () => {
    const scope = { tenantId: "tenant-unified", principalId: "viewer" };
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    const packages = ["matched", "other"].map((id): CopilotPackageDetail => ({
      id, displayName: id, isBlocked: false, sourceSystem: "graph_packages",
      authoringTool: null, creatorType: "unknown", agentKind: "copilot_package",
      lifecycle: "unknown", identityConfidence: "exact_native", provenance: {},
    }));
    const observation = {
      snapshotId: "11111111-1111-4111-8111-111111111110",
      scopeKind: "broad" as const,
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const clientQuery = vi.spyOn(client, "query").mockImplementation(async sql => {
      const text = String(sql);
      if (!text.includes("FROM audit_events") && !text.includes("'graph_packages' AS source")) {
        throw new Error("Unexpected snapshot query");
      }
      const rows = text.includes("FROM audit_events") ? [{ agent_id: "matched" }] : [];
      return { rows, rowCount: rows.length, fields: [], command: "SELECT", oid: 0 };
    });
    const poolQuery = vi.spyOn(pool, "query").mockRejectedValue(new Error("Unexpected extra pool checkout"));
    vi.spyOn(PackageInventoryRepository.prototype, "readUnifiedSource").mockResolvedValue({
      packages, observations: Object.fromEntries(packages.map(value => [value.id, observation])),
      snapshot: {
        id: observation.snapshotId, tokenMode: "delegated", scopeKind: "broad",
        requestedIds: [], observedCount: packages.length, totalRecords: packages.length, pageCount: 1,
        observedAt: observation.observedAt, expiresAt: observation.expiresAt,
      },
    });
    vi.spyOn(PowerPlatformInventoryRepository.prototype, "readUnifiedSource").mockResolvedValue({
      resources: [], snapshot: null,
    });
    vi.spyOn(UnifiedAgentRegistry.prototype, "withSnapshot").mockImplementation((_scope, work) => work(client));
    vi.spyOn(UnifiedAgentRegistry.prototype, "reconcile").mockImplementation(async (_client, _scope, records) => [...records]);
    vi.spyOn(agentUsage, "project").mockImplementation(async (_scope, records) => ({
      context: { availability: "never_imported", reportSet: null, lineages: [], revision: "c".repeat(64) },
      summaries: new Map(records.map(record => [record.id, {
        status: "unavailable", reportSetId: null, responses: null, activeUsers: null,
        lastActivityDateUtc: null, associations: [],
      }])),
    }));
    vi.spyOn(savedAgentPeople, "project").mockImplementation(async (_scope, records) => [...records]);

    const service = new UnifiedAgentsService();
    const query = { operationIdPrefix: "a5331a93" };
    const page = await service.list(scope, query);
    expect(page).toMatchObject({ count: 1, value: [{ packages: [{ id: "matched" }] }] });
    const exported = await service.forExport(scope, page.revision!, query);
    expect(exported.value).toEqual(page.value);
    const auditCalls = clientQuery.mock.calls.filter(([sql]) => String(sql).includes("FROM audit_events"));
    expect(auditCalls).toHaveLength(2);
    for (const [sql, values] of auditCalls) {
      expect(sql).toContain("tenant_id=$1 AND principal_id=$2");
      expect(values).toEqual([scope.tenantId, scope.principalId, "a5331a93%", ["matched", "other"]]);
    }
    expect(poolQuery).not.toHaveBeenCalled();
  });
});
