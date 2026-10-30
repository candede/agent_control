import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dataLimits } from "./dataBounds.js";
import { currentSchemaSql } from "./currentSchema.js";
import { inventorySelectionRoots, selectedInventorySourcesSql, validateInventoryRoot } from "./inventorySelections.js";
import type { DependencyRoot } from "../services/dataSelections.js";

afterEach(() => { vi.restoreAllMocks(); });

function result(rows: pg.QueryResultRow[] = []): pg.QueryResult {
  return { command: "SELECT", rowCount: rows.length, fields: [], oid: 0, rows };
}

describe("inventory selection contracts", () => {
  it("allows 16 sources plus the canonical, history, directory and people dependencies in storage", () => {
    const rootLimit = Number(currentSchemaSql.match(/data_read_selections_root_count_check CHECK \(root_count >= 1 AND root_count <= (\d+)\)/)?.[1]);
    const ordinalLimit = Number(currentSchemaSql.match(/data_generation_pins_ordinal_check CHECK \(ordinal >= 0 AND ordinal <= (\d+)\)/)?.[1]);
    expect(rootLimit).toBe(20);
    expect(ordinalLimit).toBe(19);
    expect(rootLimit).toBe(dataLimits.selectionRoots);
    expect(ordinalLimit + 1).toBe(dataLimits.selectionRoots);
    expect(dataLimits.roots).toBe(16);
  });

  it("returns no pins when the requested current root is unavailable", async () => {
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    const query = vi.spyOn(client, "query").mockResolvedValue(result());
    await expect(inventorySelectionRoots(client, { id: "scope", tenantId: "tenant" }, new Date()))
      .resolves.toEqual([]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("r.current"), ["scope", "tenant"]);
  });

  it("retains historical pins without requiring current publication or unexpired provider authority", async () => {
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    const query = vi.spyOn(client, "query").mockResolvedValue(result([{}]));
    const root: DependencyRoot = {
      kind: "inventory_delta", scopeId: "saved-scope", generationId: "saved-baseline", revision: "7", expiresAt: new Date(),
    };
    const identity = { tenantId: "tenant", principalId: "reader", authorizationHash: "viewer", sessionEpoch: "0" };
    await expect(validateInventoryRoot(client, root, identity)).resolves.toBeUndefined();
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("r.collected_before<=$2");
    expect(sql).toContain("g.scope_epoch=s.epoch AND g.session_epoch=s.session_epoch");
    expect(sql).toContain("g.state IN ('published','retired') AND g.validated");
    expect(sql).not.toMatch(/r\.current|expires_at/);
    expect(query).toHaveBeenCalledWith(expect.any(String), ["saved-scope", "7", "saved-baseline", "tenant"]);
    expect(sql).toContain("s.scope_kind='tenant' AND s.token_mode='tenant'");
  });

  it("rejects unavailable retained revisions rather than returning a successful empty read", async () => {
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    vi.spyOn(client, "query").mockResolvedValue(result());
    await expect(validateInventoryRoot(client, {
      kind: "inventory_delta", scopeId: "scope", generationId: "baseline", revision: "1", expiresAt: new Date(),
    }, { tenantId: "tenant", principalId: "reader", authorizationHash: "viewer", sessionEpoch: "0" }))
      .rejects.toMatchObject({ status: 409, code: "selection_invalidated" });
  });

  it("resolves exact source generations from saved temporal membership, not live heads", () => {
    const sql = selectedInventorySourcesSql("$1", "$2", "$3", "$4");
    expect(sql).toContain("pin.selection_id=selected.id AND pin.root_kind='inventory_delta'");
    expect(sql).toContain("membership.baseline_id=pin.generation_id");
    expect(sql).toContain("membership.valid_from_revision<=pin.revision");
    expect(sql).toContain("membership.valid_to_revision>pin.revision");
    expect(sql).toContain("source.generation_id=member.source_generation_id AND source.identity=member.source_identity");
    expect(sql).toContain("selected.id=$4::uuid AND selected.tenant_id=$1 AND selected.principal_id=$2");
    expect(sql).toContain("scope.tenant_id=$1 AND scope.scope_kind='tenant'");
    expect(sql).not.toMatch(/inventory_live_sources|data_generation_heads|\.current|expires_at/);
  });
});
