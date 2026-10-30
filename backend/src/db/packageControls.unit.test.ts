import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import { packageInventoryRecord } from "../services/inventoryRecordProjection.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import { capturePackageMutationState, type PackageMutationState } from "../services/packageMutationState.js";
import { publishPackageReadback, readPackageControls } from "./packageControls.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const scope = { tenantId: "tenant", principalId: "principal" };
const observedAt = new Date("2026-10-29T10:00:00Z");
const botId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function detail(isBlocked: boolean, identity?: string) {
  return allowlistedPackage({
    id: "package", displayName: "Package", isBlocked,
    ...(identity ? { elementDetails: [{ elementType: "Bots", elements: [{
      id: "bot", definition: JSON.stringify({ botId: identity }),
    }] }] } : {}),
  });
}

type Receipt = {
  id: string; tenantId: string; principalId: string; queryHash: string;
  state: PackageMutationState; current: boolean; identityRevalidationRequired: boolean;
  observedAt: Date; expiresAt: Date; detail?: CopilotPackageDetail;
};

function result(rows: pg.QueryResultRow[] = []): pg.QueryResult {
  return { command: "SELECT", oid: 0, fields: [], rowCount: rows.length, rows };
}

function fixture(sourceExpired = false) {
  vi.useFakeTimers();
  vi.setSystemTime(observedAt);
  let source = packageInventoryRecord({ ...detail(false, botId), identityDetailsCollected: true,
    detailFreshness: { state: "fresh", observedAt: new Date(observedAt.getTime() - 60_000).toISOString(),
      expiresAt: new Date(observedAt.getTime() + 60_000).toISOString() } });
  let readStartedAt = new Date(observedAt.getTime() - 60_000);
  const receipts: Receipt[] = [];
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const query = vi.spyOn(client, "query").mockImplementation(async (statement: unknown, parameters?: unknown[]) => {
    if (typeof statement !== "string") throw new Error("Unexpected query shape");
    const values = parameters ?? [];
    if (statement.includes("pg_advisory_xact_lock") || statement.startsWith("SELECT id FROM data_sync_runs")) return result();
    if (statement.startsWith("SELECT r.generation_id,r.identity,r.residual")) {
      if (sourceExpired && /(?:g|r)\.expires_at>clock_timestamp\(\)/.test(statement)) return result();
      const freshness = source.residual.detailFreshness as CopilotPackageDetail["detailFreshness"];
      const identityReadAt = freshness?.observedAt ? Date.parse(freshness.observedAt) : -Infinity;
      return result([{ generation_id: "source", identity: "package", residual: source.residual,
        ...(statement.includes("AS pending_identity_revalidation_required") ? {
          pending_identity_revalidation_required: receipts.some(receipt => receipt.current && receipt.identityRevalidationRequired
            && receipt.tenantId === values[0] && receipt.principalId === values[1] && receipt.observedAt.getTime() >= identityReadAt),
        } : {}) }]);
    }
    if (statement.startsWith("SELECT ordinal,kind,value,payload FROM inventory_facts")) {
      return result(source.facts.map((fact, ordinal) => ({ ...fact, ordinal }))
        .filter(fact => fact.ordinal > Number(values[2]) && (fact.kind === "elementTypes" || values[3]
          && (fact.kind === "elementGroup" || fact.kind === "element"
            && ["agentmetadatas", "declarativecopilots", "bots", "customenginecopilots"].includes(String(fact.payload.elementType).toLowerCase()))))
        .slice(0, 1));
    }
    if (statement.startsWith("UPDATE package_inventory_snapshots")) {
      for (const receipt of receipts) if (receipt.tenantId === values[0] && receipt.principalId === values[1]
        && receipt.queryHash === values[2]) receipt.current = false;
      return result();
    }
    if (statement.startsWith("INSERT INTO package_inventory_snapshots")) {
      receipts.push({ id: String(values[0]), tenantId: String(values[1]), principalId: String(values[2]),
        queryHash: String(values[3]), state: values[6] as PackageMutationState, current: true,
        identityRevalidationRequired: Boolean(values[7]), observedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 86_400_000) });
      return result();
    }
    if (statement.startsWith("INSERT INTO package_inventory_resources")) {
      receipts.find(receipt => receipt.id === values[0])!.detail = values[9] as CopilotPackageDetail;
      return result();
    }
    if (statement.startsWith("WITH latest AS")) {
      const selected = receipts.filter(receipt => receipt.current && receipt.tenantId === values[0]
        && receipt.principalId === values[1] && receipt.expiresAt.getTime() > Date.now()
        && Array.isArray(values[2]) && values[2].includes(receipt.detail?.id));
      return result(selected.map(receipt => ({
        id: receipt.id, native_id: receipt.detail!.id, package_data: receipt.detail, control_state: receipt.state,
        identity_revalidation_required: receipt.identityRevalidationRequired, total: selected.length,
        observed_at: receipt.observedAt, expires_at: receipt.expiresAt,
      })));
    }
    if (statement.startsWith("SELECT 1 FROM package_inventory_snapshots")) return result();
    throw new Error(`Unexpected package control query: ${statement}`);
  });
  return { client, query, receipts, publish: async (value: CopilotPackageDetail, kind: "block" | "access" = "block") => {
    const id = await publishPackageReadback(scope, value, client, null,
      capturePackageMutationState(value, kind === "block" ? "block" : "update-availability"));
    vi.advanceTimersByTime(1);
    return id;
  }, revalidate: () => {
    readStartedAt = new Date();
    source = packageInventoryRecord({ ...detail(false, botId), identityDetailsCollected: true,
      detailFreshness: { state: "fresh", observedAt: readStartedAt.toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    vi.advanceTimersByTime(1);
  }, catalogOnly: () => { source = packageInventoryRecord(detail(false)); } };
}

describe("package control identity persistence without a database", () => {
  it("compares changed native identity against expired but retained source records", async () => {
    const f = fixture(true);
    await f.publish(detail(true, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
    expect(await readPackageControls(f.client, scope, ["package"])).toMatchObject([
      { state: { kind: "block", isBlocked: true }, identityRevalidationRequired: true },
    ]);
    const sql = String(f.query.mock.calls.find(([statement]) => String(statement).startsWith("SELECT r.generation_id"))?.[0]);
    expect(sql).not.toMatch(/(?:g|r)\.expires_at>clock_timestamp\(\)/);
    expect(sql).toContain("g.session_epoch=s.session_epoch");
    expect(sql).toContain("g.state IN ('published','retired') AND g.validated");
    expect(sql).toContain("s.selector='complete'");
  });

  it.each(["block", "access"] as const)("preserves an unprojected identity conflict through a later sparse %s receipt", async kind => {
    const f = fixture();
    await f.publish(detail(true, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
    const sparse = kind === "block" ? detail(false) : { ...detail(false), availableTo: "none", deployedTo: "none",
      allowedUsersAndGroups: [], acquireUsersAndGroups: [] };
    const latestId = await f.publish(sparse, kind);
    expect(f.receipts.find(receipt => receipt.id === latestId)?.identityRevalidationRequired).toBe(true);
    expect(await readPackageControls(f.client, scope, ["package"])).toEqual(expect.arrayContaining([
      expect.objectContaining({ observation: expect.objectContaining({ snapshotId: latestId }), identityRevalidationRequired: true }),
    ]));
  });

  it("lets a later exact identity read supersede an earlier unprojected conflict", async () => {
    const f = fixture();
    await f.publish(detail(true, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
    f.revalidate();
    await f.publish(detail(false));
    expect(f.receipts.at(-1)?.identityRevalidationRequired).toBe(false);
  });

  it("does not mistake a catalog without identity details for conflict revalidation", async () => {
    const f = fixture();
    await f.publish(detail(true, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
    f.catalogOnly();
    await f.publish(detail(false));
    expect(f.receipts.at(-1)?.identityRevalidationRequired).toBe(true);
  });

  it("does not carry a conflict from a superseded receipt", async () => {
    const f = fixture();
    await f.publish(detail(true, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
    f.receipts[0].current = false;
    await f.publish(detail(false));
    expect(f.receipts.at(-1)?.identityRevalidationRequired).toBe(false);
  });

  it("does not make unchanged retained identity require revalidation", async () => {
    const f = fixture(true);
    await f.publish(detail(true, botId));
    expect(f.receipts.at(-1)?.identityRevalidationRequired).toBe(false);
  });

  it.each([{ tenantId: "other", principalId: scope.principalId }, { ...scope, principalId: "other" }])(
    "keeps receipt reads and pending conflict lookup scoped to the initiating actor: %j", async other => {
      const f = fixture();
      await f.publish(detail(true, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
      f.receipts[0].tenantId = other.tenantId;
      f.receipts[0].principalId = other.principalId;
      await f.publish(detail(false));
      expect(f.receipts.at(-1)?.identityRevalidationRequired).toBe(false);
      expect(await readPackageControls(f.client, scope, ["package"])).toHaveLength(1);
      const sql = String(f.query.mock.calls.find(([statement]) => String(statement).startsWith("SELECT r.generation_id"))?.[0]);
      expect(sql).toContain("control.tenant_id=s.tenant_id AND control.principal_id=$2");
      expect(sql).toContain("control.requested_ids->>0=r.identity");
      expect(sql).toContain("control.observation_kind IN ('block','access') AND control.is_current");
      expect(sql).toContain("control.observed_at>=COALESCE((r.residual#>>'{detailFreshness,observedAt}')::timestamptz,'-infinity'::timestamptz)");
    },
  );

  it("rejects mismatched readback without superseding a saved receipt", async () => {
    const f = fixture();
    await f.publish(detail(true));
    await expect(publishPackageReadback(scope, detail(false), f.client, null, { kind: "block", isBlocked: true }))
      .rejects.toMatchObject({ code: "mutation_readback_mismatch" });
    expect(f.receipts).toHaveLength(1);
    expect(f.receipts[0].current).toBe(true);
  });
});
