import pg from "pg";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfficialReportImports, type ReportConfirmation } from "./officialReportImports.js";
import { CursorCodec, type SelectionIdentity } from "../services/dataSelections.js";
import { AppError } from "../errors.js";
import { operationalLog } from "../services/telemetry.js";
import { currentSchemaSql } from "./currentSchema.js";

vi.mock("../services/telemetry.js", async original => ({
  ...await original<typeof import("../services/telemetry.js")>(), operationalLog: vi.fn(),
}));
vi.mock("./dataRetention.js", async original => ({
  ...await original<typeof import("./dataRetention.js")>(),
  retireUnreferencedReportVersions: vi.fn(async () => undefined),
  retainDeletedReportRows: vi.fn(async () => undefined),
}));

const identity: SelectionIdentity = { tenantId: "tenant-import", principalId: "operator-import",
  sessionEpoch: "1", authorizationHash: "admin" };
const bundleId = "60000000-0000-4000-8000-000000000001";
const pools = new Set<pg.Pool>();
afterEach(async () => {
  for (const database of pools) await database.end();
  pools.clear();
  vi.restoreAllMocks();
});

function fixture(correctionsAllowed = true) {
  const database = new pg.Pool({ max: 4 });
  pools.add(database);
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const stages = (["agents", "userAgents", "users"] as const).map((kind, index) => ({
    id: `70000000-0000-4000-8000-00000000000${index + 1}`, kind, revision: 1, content_hash: String(index + 1).repeat(64),
    row_count: 1, reconciliation: { rows: 1, responses: 2, agentsUsed: null },
    period_provenance: "activity_range", reporting_start: null, reporting_end: null, correction_of_set_id: null as string | null,
    source_as_of_provenance: "operator_asserted", source_as_of: new Date(`2026-02-0${index + 1}T00:00:00Z`),
  }));
  const result = (rows: object[]) => ({ command: "", oid: 0, fields: [], rowCount: rows.length, rows });
  const query = vi.fn(async (text: unknown, values?: unknown) => {
    if (typeof text !== "string") throw new Error("Expected SQL.");
    if (text === "COMMIT") return { ...result([]), command: "COMMIT" };
    if (["BEGIN", "BEGIN ISOLATION LEVEL REPEATABLE READ", "ROLLBACK"].includes(text)) return result([]);
    if (text.startsWith("INSERT INTO data_principal_epochs")) return result([]);
    if (text.startsWith("SELECT epoch FROM data_principal_epochs")) return result([{ epoch: "1" }]);
    if (text.startsWith("SELECT revision::text FROM official_usage_state")) return result([{ revision: "4" }]);
    if (text.includes("FROM official_usage_bundle_receipts")) return result([]);
    if (text.includes("FROM official_usage_staging s JOIN official_usage_ingestions")) {
      expect(values).toEqual([identity.tenantId, identity.principalId, bundleId, identity.sessionEpoch]);
      expect(text).toContain("i.session_epoch=$4 AND s.expires_at>clock_timestamp()");
      expect(text).toContain("LIMIT 4");
      return result(stages);
    }
    throw new Error("Unexpected import query.");
  });
  vi.spyOn(client, "query").mockImplementation(query);
  vi.spyOn(database, "connect").mockImplementation(vi.fn(async () => client));
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected unscoped database query."));
  return { imports: new OfficialReportImports(database, correctionsAllowed), stages, query };
}

describe("stored report correction authorization", () => {
  const denied = { status: 403, code: "missing_internal_role" };

  it("rejects correction upload intent before acquiring persistence", async () => {
    const { imports, query } = fixture(false);
    const ensure = vi.spyOn(imports.history, "ensure");
    await expect(imports.open(identity, { bundleId, correctionOfSetId: bundleId })).rejects.toMatchObject(denied);
    expect(ensure).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("blocks correction review and acceptance after downgrade, but permits cleanup inspection", async () => {
    const { imports, stages, query } = fixture(false);
    for (const stage of stages) stage.correction_of_set_id = bundleId;
    await expect(imports.bundle(identity, bundleId)).rejects.toMatchObject(denied);
    const cleanup = await imports.bundle(identity, bundleId, { forDiscard: true });
    expect(cleanup.stages).toHaveLength(3);
    await expect(imports.acceptBundle(identity, bundleId, cleanup)).rejects.toMatchObject(denied);
    expect(query.mock.calls.some(([text]) => String(text).startsWith("UPDATE official_usage_"))).toBe(false);
  });

  it("keeps new report bundle review available to Uploaders", async () => {
    const { imports, stages } = fixture(false);
    for (const stage of stages) stage.source_as_of = stages[0].source_as_of;
    await expect(imports.bundle(identity, bundleId)).resolves.toMatchObject({ complete: true, stages: expect.any(Array) });
  });

  it("keeps correction review available to Admins", async () => {
    const { imports, stages } = fixture();
    for (const stage of stages) {
      stage.correction_of_set_id = bundleId;
      stage.source_as_of = stages[0].source_as_of;
    }
    await expect(imports.bundle(identity, bundleId)).resolves.toMatchObject({ complete: true });
  });

  it("blocks correction stage previews before loading their example rows", async () => {
    const { imports, query } = fixture(false), original = query.getMockImplementation()!;
    query.mockImplementation(async (text, values) => String(text).startsWith("SELECT s.id,s.revision,s.kind,s.bundle_id")
      ? { command: "", oid: 0, fields: [], rowCount: 1, rows: [{ correction_of_set_id: bundleId }] }
      : original(text, values));
    await expect(imports.preview(identity, bundleId)).rejects.toMatchObject(denied);
    expect(query.mock.calls.some(([text]) => String(text).includes("SELECT row_data"))).toBe(false);
  });

  it("checks a stored single-stage correction inside the acceptance transaction before any write", async () => {
    const { imports, stages, query } = fixture(false), original = query.getMockImplementation()!;
    vi.spyOn(imports.history, "ensure").mockResolvedValue("scope");
    vi.spyOn(imports.history, "lock").mockResolvedValue("scope");
    query.mockImplementation(async (text, values) => {
      const sql = String(text);
      if (sql.startsWith("SELECT pg_advisory_xact_lock") || sql.startsWith("INSERT INTO official_usage_state")) {
        return { command: "", oid: 0, fields: [], rowCount: 0, rows: [] };
      }
      if (sql.startsWith("SELECT active_set_id,revision::text")) {
        return { command: "", oid: 0, fields: [], rowCount: 1, rows: [{ revision: "4" }] };
      }
      if (sql.startsWith("SELECT s.*,i.id AS ingestion_id")) {
        return { command: "", oid: 0, fields: [], rowCount: 1, rows: [{ ...stages[0], correction_of_set_id: bundleId }] };
      }
      return original(text, values);
    });
    await expect(imports.accept(identity, { stagingId: stages[0].id, revision: 1,
      contentHash: stages[0].content_hash, expectedActiveRevision: "4" })).rejects.toMatchObject(denied);
    expect(query.mock.calls.some(([text]) => String(text).startsWith("UPDATE official_usage_"))).toBe(false);
    expect(query.mock.calls.map(([text]) => text)).toContain("ROLLBACK");
  });

  it("does not bypass current correction authorization through an accepted bundle receipt", async () => {
    const { imports, query } = fixture(false), original = query.getMockImplementation()!;
    query.mockImplementation(async (text, values) => String(text).includes("FROM official_usage_bundle_receipts")
      ? { command: "", oid: 0, fields: [], rowCount: 1, rows: [{ result_set_id: bundleId, correction_of_set_id: bundleId }] }
      : original(text, values));
    await expect(imports.acceptBundle(identity, bundleId, { bundleHash: "a".repeat(64), expectedActiveRevision: "4" }))
      .rejects.toMatchObject(denied);
  });

  it("blocks correction diagnostics after downgrade before querying companion reports", async () => {
    const { imports, stages, query } = fixture(false), original = query.getMockImplementation()!;
    query.mockImplementation(async (text, values) => {
      if (String(text).startsWith("SELECT s.* FROM official_usage_staging")) {
        return { command: "", oid: 0, fields: [], rowCount: 1, rows: [{ ...stages[0], correction_of_set_id: bundleId }] };
      }
      if (String(text).startsWith("WITH companions AS")) {
        const rows = String(text).includes("SELECT count(*)::text AS n FROM diagnostics") ? [{ n: "0" }] : [];
        return { command: "", oid: 0, fields: [], rowCount: rows.length, rows };
      }
      return original(text, values);
    });
    await expect(imports.diagnostics(identity, stages[0].id, {}, new CursorCodec("synthetic-report-diagnostics-secret")))
      .rejects.toMatchObject(denied);
    expect(query.mock.calls.some(([text]) => String(text).startsWith("WITH companions AS"))).toBe(false);
  });
});

describe("semantic-duplicate acceptance receipt authorization without a database", () => {
  it("persists original correction intent independently of the canonical result in the current schema", () => {
    const table = currentSchemaSql.match(/CREATE TABLE official_usage_bundle_receipts \(([\s\S]*?)\n\);/)?.[1];
    expect(table).toMatch(/,\s*correction_of_set_id uuid/);
  });

  function duplicateAcceptance(correctionOf: string | null, canonicalCorrectionOf: string | null) {
    const { imports, stages, query } = fixture(), original = query.getMockImplementation()!;
    vi.spyOn(imports.history, "ensure").mockResolvedValue("scope");
    vi.spyOn(imports.history, "lock").mockResolvedValue("scope");
    vi.spyOn(imports, "cleanupIngestion").mockResolvedValue(0);
    for (const stage of stages) {
      stage.source_as_of = stages[0].source_as_of;
      stage.correction_of_set_id = correctionOf;
    }
    const canonicalId = "90000000-0000-4000-8000-000000000001";
    const result = (rows: object[]) => ({ command: "", oid: 0, fields: [], rowCount: rows.length, rows });
    let receipt: Record<string, unknown> | undefined;
    query.mockImplementation(async (text, values) => {
      const sql = String(text), args = values as unknown[];
      if (sql.includes("FROM official_usage_bundle_receipts")) return result(receipt ? [receipt] : []);
      if (sql.startsWith("SELECT pg_advisory_xact_lock") || sql.startsWith("INSERT INTO official_usage_state")) return result([]);
      if (sql.startsWith("SELECT active_set_id,revision::text")) return result([{ active_set_id: canonicalId, revision: "4" }]);
      if (sql.startsWith("SELECT s.*,i.id AS ingestion_id")) {
        return result(stages.filter(stage => stage.id === args[0]).map(stage => ({
          ...stage, bundle_id: bundleId, ingestion_id: stage.id, ingestion_state: "ready", status: "active",
        })));
      }
      if (sql.startsWith("SELECT count(*)::int AS active")) return result([{ active: 0, tenant: 0 }]);
      if (sql.startsWith("SELECT * FROM official_usage_sets WHERE tenant_id=")) return result([]);
      if (sql.startsWith("SELECT 1 FROM official_usage_sets WHERE id=")) return result([{ exists: true }]);
      if (sql.startsWith("SELECT s.id FROM official_usage_sets s")) return result([{ id: canonicalId }]);
      if (sql.startsWith("SELECT kind,version_id")) return result(stages.map(stage => ({ kind: stage.kind, version_id: stage.id })));
      if (sql.startsWith("UPDATE official_usage_ingestions") || sql.startsWith("UPDATE official_usage_staging")
        || sql.startsWith("INSERT INTO official_usage_audit")) return result([]);
      if (sql.startsWith("INSERT INTO official_usage_bundle_receipts")) {
        const columns = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",").map(column => column.trim());
        receipt = Object.fromEntries(columns.map((column, index) => [column, args[index]]));
        return result([]);
      }
      return original(text, values);
    });
    const expireStaging = () => {
      stages.length = 0;
      if (receipt) {
        receipt.supersedes_set_id = canonicalCorrectionOf;
        receipt.deleted_at = null;
      }
    };
    return { imports, query, canonicalId, expireStaging };
  }

  it("lets an Uploader replay a normal import that reused a corrected report after staging expires", async () => {
    const { imports, query, canonicalId, expireStaging } = duplicateAcceptance(null, bundleId);
    const uploader = new OfficialReportImports(imports.database, false);
    vi.spyOn(uploader.history, "ensure").mockResolvedValue("scope");
    vi.spyOn(uploader.history, "lock").mockResolvedValue("scope");
    vi.spyOn(uploader, "cleanupIngestion").mockResolvedValue(0);
    const input = await uploader.bundle(identity, bundleId);
    const accepted = await uploader.acceptBundle(identity, bundleId, input);
    expect(accepted).toEqual({ setId: canonicalId, activeRevision: "4", complete: true });
    expireStaging();
    query.mockClear();
    await expect(uploader.acceptBundle(identity, bundleId, input)).resolves.toEqual(accepted);
    expect(query.mock.calls.some(([text]) => String(text).includes("FROM official_usage_staging"))).toBe(false);
  });

  it("retains correction authorization when unchanged content reuses an ordinary report", async () => {
    const { imports, query, canonicalId, expireStaging } = duplicateAcceptance(bundleId, null);
    const input = await imports.bundle(identity, bundleId);
    expect(await imports.acceptBundle(identity, bundleId, input)).toMatchObject({ setId: canonicalId, complete: true });
    expireStaging();
    query.mockClear();
    const uploader = new OfficialReportImports(imports.database, false);
    await expect(uploader.acceptBundle(identity, bundleId, input)).rejects.toMatchObject({ status: 403, code: "missing_internal_role" });
    expect(query.mock.calls.some(([text]) => String(text).includes("FROM official_usage_staging"))).toBe(false);
  });
});

describe("bundle validation and cleanup inspection without a database", () => {
  it("preserves normal validation of incompatible observation metadata", async () => {
    const { imports } = fixture();
    await expect(imports.bundle(identity, bundleId)).rejects.toMatchObject({ code: "incompatible_bundle" });
    await expect(imports.bundle(identity, bundleId, { forDiscard: false })).rejects.toMatchObject({ code: "incompatible_bundle" });
  });

  describe("canonical report intent UUIDs without a database", () => {
    const id = "abcdefab-1234-4567-89ab-abcdefabcdef";
    function canonicalIntent() {
      const { imports, stages, query } = fixture();
      vi.spyOn(imports.history, "ensure").mockResolvedValue("scope");
      vi.spyOn(imports.history, "lock").mockResolvedValue("scope");
      const invalidate = vi.spyOn(imports.history, "invalidate").mockResolvedValue(undefined);
      const original = query.getMockImplementation()!;
      const result = (rows: object[]) => ({ command: "", oid: 0, fields: [], rowCount: rows.length, rows });
      const confirmations: unknown[][] = [];
      let active: string | null = id;
      query.mockImplementation(async (text, values) => {
        if (typeof text !== "string") throw new Error("Expected SQL.");
        const args = values as unknown[] | undefined;
        if (text.startsWith("SELECT s.*,i.id AS ingestion_id")) return result([]);
        if (text.includes("FROM official_usage_staging s JOIN official_usage_ingestions")) {
          expect(String(args?.[2]).toLowerCase()).toBe(id);
          return result(stages.map(stage => ({ ...stage, source_as_of: null, source_as_of_provenance: "absent" })));
        }
        if (text === "BEGIN" || text.startsWith("SELECT pg_advisory_xact_lock")
          || text.startsWith("INSERT INTO official_usage_state") || text.startsWith("SELECT set_config")
          || text.startsWith("INSERT INTO official_usage_audit")) return result([]);
        if (text.startsWith("SELECT active_set_id,revision::text")) return result([{ active_set_id: active, revision: "4" }]);
        if (text.startsWith("SELECT revision::text,invalidation_epoch::text")) return result([{ revision: "9", invalidation_epoch: "2" }]);
        if (text.startsWith("SELECT 1 FROM official_usage_sets")) return result([{ exists: true }]);
        if (text.startsWith("INSERT INTO official_usage_confirmations")) { confirmations.push(args!); return result([]); }
        if (text.startsWith("SELECT c.id FROM official_usage_confirmations")) {
          const stored = confirmations.find(row => row[0] === String(args?.[0]).toLowerCase());
          return result(stored && stored[6] === args?.[6]
            && String(stored[4]).toLowerCase() === String(args?.[4]).toLowerCase() ? [{ id: stored[0] }] : []);
        }
        if (text.startsWith("UPDATE official_usage_sets") || text.startsWith("UPDATE official_usage_confirmations")) return result([]);
        if (text.startsWith("UPDATE official_usage_state SET active_set_id=NULL")) { active = null; return result([]); }
        if (text.startsWith("UPDATE official_usage_state SET active_set_id=$2")) { active = String(args?.[1]).toLowerCase(); return result([]); }
        if (text.startsWith('SELECT active_set_id AS "activeSetId"')) return result([{ activeSetId: active, activeRevision: "5" }]);
        return original(text, values);
      });
      return { imports, query, invalidate };
    }

    it("produces the same bundle identity and review hash for either UUID spelling", async () => {
      const { imports } = canonicalIntent();
      const lower = await imports.bundle(identity, id), upper = await imports.bundle(identity, id.toUpperCase());
      expect(upper).toEqual(lower);
      expect(upper.bundleId).toBe(id);
    });

    it("can accept a canonical review using an uppercase bundle route before canonical validation", async () => {
      const { imports } = canonicalIntent(), preview = await imports.bundle(identity, id);
      await expect(imports.acceptBundle(identity, id.toUpperCase(), preview)).rejects.toMatchObject({ code: "staging_unavailable" });
    });

    it("retains the reviewed bundle hash when its caller changes the input during authorization", async () => {
      const { imports, query } = canonicalIntent(), preview = await imports.bundle(identity, id);
      const expectedHash = preview.bundleHash, original = query.getMockImplementation()!;
      query.mockImplementation(async (text, values) => {
        if (typeof text === "string" && text.startsWith("SELECT epoch FROM data_principal_epochs")) preview.bundleHash = "f".repeat(64);
        return original(text, values);
      });
      await expect(imports.acceptBundle(identity, id, preview)).rejects.toMatchObject({ code: "staging_unavailable" });
      const receipt = query.mock.calls.find(([text]) => typeof text === "string" && text.includes("FROM official_usage_bundle_receipts"));
      expect(receipt?.[1]).toEqual([identity.tenantId, identity.principalId, id, expectedHash, "4"]);
    });

    it("canonicalizes a confirmed deletion before comparing the active report pointer", async () => {
      const { imports, invalidate } = canonicalIntent();
      const preview = await imports.confirmPreview(identity, id.toUpperCase(), "delete");
      expect(await imports.confirm(identity, preview)).toMatchObject({ activeSetId: null });
      expect(preview.setId).toBe(id);
      expect(invalidate).toHaveBeenCalledWith(expect.any(pg.Client), identity.tenantId, id, true);
    });

    it("freezes confirmation intent before asynchronous authority checks", async () => {
      const { imports, query, invalidate } = canonicalIntent(), input = await imports.confirmPreview(identity, id, "delete");
      const original = query.getMockImplementation()!;
      query.mockImplementation(async (text, values) => {
        const value = await original(text, values);
        if (typeof text === "string" && text.startsWith("SELECT c.id FROM official_usage_confirmations")) {
          input.setId = "fedcbafe-1234-4567-89ab-fedcbafedcba";
        }
        return value;
      });
      expect(await imports.confirm(identity, input)).toMatchObject({ activeSetId: null });
      expect(invalidate).toHaveBeenCalledWith(expect.any(pg.Client), identity.tenantId, id, true);
    });

    it("rejects inherited or accessor confirmation identity without reading it", async () => {
      const { imports, query } = canonicalIntent(), input = await imports.confirmPreview(identity, id, "select");
      query.mockClear();
      const getter = vi.fn(() => id);
      const accessor = { ...input };
      Object.defineProperty(accessor, "setId", { enumerable: true, get: getter });
      for (const value of [Object.create(input), accessor]) {
        await expect(async () => imports.confirm(identity, value as ReportConfirmation)).rejects.toMatchObject({ status: 400 });
      }
      expect(getter).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    });

    it.each(["9223372036854775808", "9999999999999999999", "01"])("rejects an unrepresentable or noncanonical revision %s before persistence", async value => {
      const { imports, query } = canonicalIntent(), input = await imports.confirmPreview(identity, id, "select");
      query.mockClear();
      await expect(async () => imports.confirm(identity, { ...input, historyRevision: value }))
        .rejects.toMatchObject({ status: 400, code: "invalid_import_confirmation" });
      await expect(async () => imports.acceptBundle(identity, id, { bundleHash: "a".repeat(64), expectedActiveRevision: value }))
        .rejects.toMatchObject({ status: 400, code: "invalid_import_confirmation" });
      expect(query).not.toHaveBeenCalled();
    });
  });

  it("lists bounded owned companions for cleanup despite incompatible metadata", async () => {
    const { imports, stages, query } = fixture();
    const preview = await imports.bundle(identity, bundleId, { forDiscard: true });
    expect(preview).toMatchObject({ bundleId, complete: true, expectedActiveRevision: "4" });
    expect(preview.stages.map(stage => stage.stagingId)).toEqual(stages.map(stage => stage.id));
    expect(query.mock.calls.some(([text]) => typeof text === "string" && /^(UPDATE|DELETE)/.test(text))).toBe(false);
  });

  it("cannot use a cleanup inspection to bypass acceptance validation", async () => {
    const { imports } = fixture();
    const preview = await imports.bundle(identity, bundleId, { forDiscard: true });
    await expect(imports.acceptBundle(identity, bundleId, preview)).rejects.toMatchObject({ code: "incompatible_bundle" });
  });

  it("still rejects a retired session before revealing cleanup receipts", async () => {
    const { imports, query } = fixture();
    await expect(imports.bundle({ ...identity, sessionEpoch: "2" }, bundleId, { forDiscard: true }))
      .rejects.toMatchObject({ code: "staging_unavailable" });
    expect(query.mock.calls.some(([text]) => typeof text === "string" && text.includes("FROM official_usage_staging"))).toBe(false);
  });
});

describe("atomic staged-import discard without a database", () => {
  function discarded(initial: "ready" | "accepting" | "accepted" = "ready") {
    const { imports, query } = fixture();
    const stagingId = "70000000-0000-4000-8000-000000000001", ingestionId = "80000000-0000-4000-8000-000000000001";
    let state: string = initial, status = initial === "accepted" ? "accepted" : "active", inspected = false;
    const commits: Array<{ state: string; status: string }> = [];
    const result = (rows: object[]) => ({ command: "", oid: 0, fields: [], rowCount: rows.length, rows });
    query.mockImplementation(async (text, values) => {
      if (typeof text !== "string") throw new Error("Expected SQL.");
      if (text === "BEGIN" || text === "ROLLBACK") return result([]);
      if (text === "COMMIT") {
        commits.push({ state, status });
        // A competing acceptance can acquire these rows as soon as discard releases them.
        if (inspected && state === "ready") state = "accepting";
        return { ...result([]), command: "COMMIT" };
      }
      if (text.startsWith("INSERT INTO data_principal_epochs")) return result([]);
      if (text.startsWith("SELECT epoch FROM data_principal_epochs")) return result([{ epoch: "1" }]);
      if (text.startsWith("SELECT i.id,s.kind,s.row_count")) {
        expect(values).toEqual([stagingId, identity.tenantId, identity.principalId, identity.sessionEpoch]);
        expect(text).toContain("s.status='active' AND i.state='ready' AND i.session_epoch=$4 FOR UPDATE OF s,i");
        inspected = true;
        return result(state === "ready" && status === "active" ? [{ id: ingestionId, kind: "agents", row_count: 1 }] : []);
      }
      if (text.startsWith("UPDATE official_usage_ingestions SET state='cancelled'")) {
        state = "cancelled";
        return result([{ staging_id: stagingId, kind: "agents", row_count: 1 }]);
      }
      if (text.startsWith("UPDATE official_usage_staging SET status='cancelled'")) { status = "cancelled"; return result([]); }
      if (text.startsWith("INSERT INTO official_usage_audit")) return result([]);
      throw new Error("Unexpected discard query.");
    });
    const cleanup = vi.spyOn(imports, "cleanupIngestion").mockResolvedValue(0);
    return { imports, query, cleanup, commits, stagingId, ingestionId };
  }

  it("cancels under the same ready-state row locks, before a competing acceptance can start", async () => {
    const { imports, query, cleanup, commits, stagingId, ingestionId } = discarded();
    await imports.discard(identity, stagingId);
    expect(commits).toEqual([{ state: "cancelled", status: "cancelled" }]);
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(ingestionId);
    expect(query.mock.calls.filter(([text]) => typeof text === "string" && text.startsWith("INSERT INTO official_usage_audit"))).toHaveLength(1);
  });

  it.each(["accepting", "accepted"] as const)("cannot cancel an already %s import", async state => {
    const { imports, query, cleanup, stagingId } = discarded(state);
    await expect(imports.discard(identity, stagingId)).rejects.toMatchObject({ code: "staging_unavailable" });
    expect(query.mock.calls.some(([text]) => typeof text === "string" && text.startsWith("UPDATE"))).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("retains durable cancellation when post-commit cleanup fails", async () => {
    const { imports, cleanup, commits, stagingId } = discarded();
    cleanup.mockRejectedValueOnce(new Error("Cleanup unavailable"));
    await expect(imports.discard(identity, stagingId)).rejects.toThrow("Cleanup unavailable");
    expect(commits).toEqual([{ state: "cancelled", status: "cancelled" }]);
    await expect(imports.discard(identity, stagingId)).rejects.toMatchObject({ code: "staging_unavailable" });
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

describe("source-contract preview diagnostics without a database", () => {
  it.each([false, true])("compares positive-response agent identities for permitted diagnostics (correction=%s)", async correction => {
    const { imports, stages, query } = fixture(correction);
    stages[2].correction_of_set_id = correction ? bundleId : null;
    const result = (rows: object[]) => ({ command: "", oid: 0, fields: [], rowCount: rows.length, rows });
    query.mockImplementation(async text => {
      if (typeof text !== "string") throw new Error("Expected SQL.");
      if (text === "BEGIN ISOLATION LEVEL REPEATABLE READ" || text === "ROLLBACK") return result([]);
      if (text === "COMMIT") return { ...result([]), command: "COMMIT" };
      if (text.startsWith("INSERT INTO data_principal_epochs")) return result([]);
      if (text.startsWith("SELECT epoch FROM data_principal_epochs")) return result([{ epoch: "1" }]);
      if (text.startsWith("SELECT s.* FROM official_usage_staging")) return result([stages[2]]);
      if (text.startsWith("WITH companions AS")) {
        expect(text).toContain("count(DISTINCT c.row_data->>'agentId')");
        expect(text).toContain("AND (c.row_data->>'responsesSentToUsers')::numeric>0");
        return text.includes("SELECT count(*)::text AS n FROM diagnostics") ? result([{ n: "0" }]) : result([]);
      }
      throw new Error("Unexpected diagnostics query.");
    });
    const diagnostics = await imports.diagnostics(identity, stages[2].id, {}, new CursorCodec("synthetic-report-diagnostics-secret"));
    expect(diagnostics.value).toEqual([]);
    expect(diagnostics.counts).toEqual({ total: 0, filtered: 0 });
  });
});

describe("stream upload cancellation and batch rollback without a database", () => {
  function ingestion(correctionsAllowed = true) {
    const { imports, query } = fixture(correctionsAllowed);
    const result = (rows: object[]) => ({ command: "", oid: 0, fields: [], rowCount: rows.length, rows });
    const ensure = vi.spyOn(imports.history, "ensure").mockResolvedValue("1");
    const cleanup = vi.spyOn(imports, "cleanupIngestion").mockResolvedValue(0);
    let state = "streaming";
    const onInsert = vi.fn();
    query.mockImplementation(async text => {
      if (typeof text !== "string") throw new Error("Expected SQL.");
      if (text === "BEGIN" || text === "ROLLBACK") return result([]);
      if (text === "COMMIT") return { ...result([]), command: "COMMIT" };
      if (text.startsWith("INSERT INTO data_principal_epochs")) return result([]);
      if (text.startsWith("SELECT epoch FROM data_principal_epochs")) return result([{ epoch: "1" }]);
      if (text.startsWith("SELECT pg_advisory_xact_lock") || text.startsWith("INSERT INTO official_usage_state")) return result([]);
      if (text.startsWith("SELECT active_set_id,revision::text")) return result([{ active_set_id: null, revision: "1" }]);
      if (text.startsWith("SELECT count(")) return result([{ n: 0, tenant: 0, actor: 0 }]);
      if (text.includes("bundle_owner") || text.startsWith("SELECT 1 FROM official_usage_ingestions")) return result([]);
      if (text.includes("sum(stored_bytes)")) return result([{ tenant: "0", actor: "0", bundle: "0" }]);
      if (text.startsWith("INSERT INTO official_usage_ingestions")) return result([]);
      if (text.startsWith("SELECT * FROM official_usage_ingestions")) {
        return result(state === "streaming" ? [{ bundle_id: bundleId, row_count: 0, kind: null, reject_duplicate_kind: false }] : []);
      }
      if (text.startsWith("SELECT id,state,staging_id")) return result([]);
      if (text.startsWith("INSERT INTO official_usage_ingestion_rows")) { onInsert(); return result([]); }
      if (text.startsWith("UPDATE official_usage_ingestions SET kind=")) return result([]);
      if (text.startsWith("UPDATE official_usage_ingestions SET state='cancelled'")) {
        state = "cancelled"; return result([{ staging_id: null, kind: "users", row_count: 0 }]);
      }
      if (text.startsWith("INSERT INTO official_usage_audit")) return result([]);
      throw new Error("Unexpected streaming query.");
    });
    return { imports, query, ensure, cleanup, onInsert };
  }
  const csv = "Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\nuser,Name,1,1,\n";

  it("allows Uploaders to stream and cancel new report drafts", async () => {
    const { imports, cleanup } = ingestion(false);
    const upload = await imports.open(identity, { bundleId });
    await expect(upload.receive(Readable.from([Buffer.from(csv)]))).resolves.toMatchObject({ kind: "users", rows: 1 });
    await upload.cancel();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("rejects joining a preexisting correction bundle without restating its correction intent", async () => {
    const { imports, query } = ingestion(false), original = query.getMockImplementation()!;
    query.mockImplementation(async (text, values) => String(text).includes("AND correction_of IS NOT NULL")
      ? { command: "", oid: 0, fields: [], rowCount: 1, rows: [{}] } : original(text, values));
    await expect(imports.open(identity, { bundleId })).rejects.toMatchObject({ status: 403, code: "missing_internal_role" });
    expect(query.mock.calls.some(([text]) => String(text).startsWith("INSERT INTO official_usage_ingestions"))).toBe(false);
  });

  it("does not initialize persistence for an already cancelled upload", async () => {
    const { imports, ensure, query } = ingestion(), controller = new AbortController();
    const reason = new AppError(408, "upload_deadline", "Upload deadline exceeded.");
    controller.abort(reason);
    await expect(imports.open(identity, { bundleId }, controller.signal)).rejects.toBe(reason);
    expect(ensure).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("retains the original upload bundle and duplicate guard when its caller changes the intent", async () => {
    const { imports, ensure, query } = ingestion();
    const intent = { bundleId, rejectDuplicateKind: true };
    ensure.mockImplementationOnce(async () => {
      intent.bundleId = "abcdefab-1234-4567-89ab-abcdefabcdef";
      intent.rejectDuplicateKind = false;
      return "scope";
    });
    const upload = await imports.open(identity, intent);
    try {
      const insertion = query.mock.calls.find(([text]) => typeof text === "string" && text.startsWith("INSERT INTO official_usage_ingestions"));
      const values = insertion?.[1] as unknown[];
      expect(values[3]).toBe(bundleId);
      expect(values[7]).toBe(true);
    } finally { await upload.cancel(); }
  });

  it("rolls back a row batch cancelled after its INSERT instead of committing it", async () => {
    const { imports, query, cleanup, onInsert } = ingestion(), controller = new AbortController();
    const reason = new AppError(408, "upload_deadline", "Upload deadline exceeded.");
    const upload = await imports.open(identity, { bundleId }, controller.signal);
    query.mockClear();
    onInsert.mockImplementation(() => controller.abort(reason));
    await expect(upload.receive(Readable.from([Buffer.from(csv)]))).rejects.toBe(reason);
    const statements = query.mock.calls.map(([text]) => text);
    const insertion = statements.findIndex(text => typeof text === "string" && text.startsWith("INSERT INTO official_usage_ingestion_rows"));
    expect(insertion).toBeGreaterThanOrEqual(0);
    expect(statements.slice(insertion, statements.indexOf("ROLLBACK") + 1)).not.toContain("COMMIT");
    expect(statements).toContain("ROLLBACK");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("maps duplicate-identity insertion failures, rolls back the batch and cleans the ingestion", async () => {
    const { imports, query, cleanup, onInsert } = ingestion(), upload = await imports.open(identity, { bundleId });
    query.mockClear();
    onInsert.mockImplementation(() => { throw Object.assign(new Error("Synthetic duplicate"), { code: "23505" }); });
    await expect(upload.receive(Readable.from([Buffer.from(csv)]))).rejects.toMatchObject({ status: 400, code: "duplicate_identity" });
    const statements = query.mock.calls.map(([text]) => text);
    expect(statements).toContain("ROLLBACK");
    expect(statements.some(text => typeof text === "string" && text.startsWith("UPDATE official_usage_ingestions SET kind="))).toBe(false);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("explicit cancellation aborts the receiving signal and cannot return a successful parse", async () => {
    const { imports, cleanup } = ingestion(), upload = await imports.open(identity, { bundleId });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    async function* input() { yield Buffer.from(csv); entered(); await gate; }
    const receiving = upload.receive(input()).catch(error => error);
    await waiting;
    try {
      await upload.cancel();
      expect(upload.signal.aborted).toBe(true);
      expect(upload.signal.reason).toMatchObject({ status: 400, code: "upload_cancelled" });
    } finally { release(); }
    expect(await receiving).toMatchObject({ status: 400, code: "upload_cancelled" });
    expect(cleanup).toHaveBeenCalled();
  });

  it("reports an unverified cleanup explicitly and retains the parser and cleanup causes without logging values", async () => {
    const { imports, cleanup } = ingestion(), upload = await imports.open(identity, { bundleId });
    const cleanupFailure = new Error("Synthetic cleanup failure");
    cleanup.mockRejectedValueOnce(cleanupFailure);
    const error = await upload.receive(Readable.from([Buffer.from([0xc3, 0x28])])).catch(error => error);
    expect(error).toMatchObject({ status: 500, code: "upload_cleanup_failed" });
    expect(error.cause).toBeInstanceOf(AggregateError);
    expect(error.cause.errors).toEqual([expect.objectContaining({ status: 400, code: "invalid_utf8" }), cleanupFailure]);
    expect(operationalLog).toHaveBeenCalledWith("error", "official_usage_upload_cleanup_failed");
  });
});
