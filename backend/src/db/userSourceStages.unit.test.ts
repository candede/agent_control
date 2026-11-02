import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityRecord, GenerationLease } from "./dataGenerations.js";
import { UserSourceStages } from "./userSourceStages.js";
import { OfficeAppAdoptionRepository } from "./officeAppAdoption.js";

afterEach(() => { vi.restoreAllMocks(); });

const lease: GenerationLease = {
  id: "incoming-generation", scopeId: "activity-scope", tenantId: "synthetic-tenant",
  owner: "synthetic-owner", version: 1, epoch: "0", sessionEpoch: "0", expectedRevision: "1", schemaVersion: 1,
};
const observedAt = new Date("2026-10-01T00:00:00Z");
const sharedAlias = "shared@example.invalid";

function activity(identity: string, upn: string, padding = ""): ActivityRecord {
  return {
    identity, upn_key: upn, report_refresh_date: "2026-10-01", last_activity_date: "2026-10-01",
    chat_date: null, teams_date: null, word_date: null, excel_date: null, powerpoint_date: null,
    outlook_date: null, onenote_date: null, loop_date: null, period: "D28", residual: { padding },
  };
}

function fixture(previous: ActivityRecord[], incoming: ActivityRecord[] = []) {
  const database = new pg.Pool({ max: 4 });
  vi.spyOn(database, "connect").mockRejectedValue(new Error("Unit tests must not connect to a database."));
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const stages = new UserSourceStages(database);
  vi.spyOn(stages.generations.connections, "run").mockImplementation(async work => work(client));
  vi.spyOn(stages.generations, "fence").mockResolvedValue({ state: "staging" });
  vi.spyOn(client, "query").mockImplementation(async (statement, values) => {
    if (typeof statement !== "string") throw new Error("Unexpected query shape.");
    if (statement.includes("SELECT g.id,g.observed_at,g.actor_principal_id")) {
      return result([{ id: "previous-generation", observed_at: observedAt, actor_principal_id: "original-collector" }]);
    }
    if (!statement.includes("FROM app_activity_rows old")) throw new Error("Unexpected retention query.");
    const after = values?.[2];
    if (typeof after !== "string") throw new Error("Missing retention cursor.");
    const freshOnly = statement.includes("AND NOT incoming.residual ? 'retainedObservedAt'");
    const candidates = previous.filter(old => old.identity > after && !incoming.some(row =>
      row.upn_key === old.upn_key && (!freshOnly || !Object.hasOwn(row.residual, "retainedObservedAt"))))
      .sort((a, b) => a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0).slice(0, 100);
    let bytes = 0;
    return result(candidates.filter(value => {
      bytes += Buffer.byteLength(JSON.stringify(value));
      return bytes <= 524288;
    }).map(value => ({ identity: value.identity, value })));
  });
  const append = vi.spyOn(stages, "append").mockImplementation(async (_lease, kind, rows) => {
    if (kind !== "activity") throw new Error("Unexpected retained record kind.");
    for (const row of rows) {
      if (!("report_refresh_date" in row)) throw new Error("Expected an activity record.");
      incoming.push(row);
    }
  });
  return { stages, incoming, append };
}

function result(rows: pg.QueryResultRow[]): pg.QueryResult {
  return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
}

describe("automatic Office preparation after source publication", () => {
  it.each((["directory", "app_activity"] as const).flatMap(source =>
    (["none", "publish", "execute"] as const).flatMap(cleanupAt =>
      [false, true].map(derivationFails => ({ source, cleanupAt, derivationFails }))),
  ))("recovers Office after $source commits, cleanupAt=$cleanupAt, derivationFails=$derivationFails",
    async ({ source, cleanupAt, derivationFails }) => {
      const database = new pg.Pool({ max: 4 });
      vi.spyOn(database, "connect").mockRejectedValue(new Error("Unit tests must not connect to a database."));
      vi.spyOn(database, "query").mockRejectedValue(new Error("Unit tests must not query a database."));
      const client = Object.assign(new pg.Client(), { release: vi.fn() });
      const query = vi.spyOn(client, "query").mockResolvedValue(result([]));
      const stages = new UserSourceStages(database);
      const counts = { rows: 0, children: 0, batches: 0, pages: 0, wireRows: 0, bytes: 0 };
      vi.spyOn(stages.generations.connections, "run").mockImplementation(async work => work(client));
      vi.spyOn(stages.generations, "fence").mockResolvedValue({ state: "staging" });
      vi.spyOn(stages.generations, "execute").mockImplementation(async (_input, work) => {
        const published = await work(lease, new AbortController().signal);
        if (cleanupAt === "execute") throw new Error("Synthetic execution cleanup failure.");
        return published;
      });
      vi.spyOn(stages, "preserveUnseen").mockResolvedValue(0);
      vi.spyOn(stages, "validate").mockResolvedValue(undefined);
      vi.spyOn(stages, "counts").mockResolvedValue(counts);
      const publish = vi.spyOn(stages.generations, "publish").mockImplementation(async (_lease, options) => {
        await options?.completeJob?.(client, { jobId: "source-job", runId: "source-run", rows: 0, bytes: 0 });
        options?.onCommitted?.("2");
        if (cleanupAt === "publish") throw new Error("Synthetic publication cleanup failure.");
        return "2";
      });
      const recover = vi.spyOn(OfficeAppAdoptionRepository.prototype, "recover").mockResolvedValue(undefined);
      if (derivationFails) recover.mockRejectedValue(new Error("Synthetic Office derivation failure."));
      const completeJob = vi.fn();
      const now = new Date();
      const published = await stages.execute({
        scope: { tenantId: lease.tenantId, kind: "tenant", principalId: null, tokenMode: "tenant", source, selector: "complete" },
        actorPrincipalId: "signed-in-viewer", schemaVersion: 1, jobKind: "data_sync", jobId: "source-job", runId: "source-run",
        sessionEpoch: "0", observedAt: now, expiresAt: new Date(now.getTime() + 60_000),
        deadlineAt: new Date(now.getTime() + 30_000), reserveBytes: 1024,
      }, vi.fn(async () => {}), { completeJob, beforePublish: vi.fn(async () => {}) });

      expect(published).toEqual({ generationId: lease.id, scopeId: lease.scopeId, revision: "2", ...counts });
      expect(completeJob).toHaveBeenCalledExactlyOnceWith(client,
        { jobId: "source-job", runId: "source-run", rows: 0, bytes: 0, source, generationId: lease.id });
      expect(recover).toHaveBeenCalledExactlyOnceWith(lease.tenantId, undefined);
      expect(recover.mock.invocationCallOrder[0]).toBeGreaterThan(publish.mock.invocationCallOrder[0]);
      expect(query.mock.calls.some(([statement]) => typeof statement === "string"
        && statement.includes("SET status=$2,error_code=$3"))).toBe(false);
    },
  );

  it.each(["work", "publish"] as const)("does not recover Office after a pre-commit %s failure", async boundary => {
    const database = new pg.Pool({ max: 4 });
    vi.spyOn(database, "connect").mockRejectedValue(new Error("Unit tests must not connect to a database."));
    vi.spyOn(database, "query").mockRejectedValue(new Error("Unit tests must not query a database."));
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    vi.spyOn(client, "query").mockResolvedValue(result([]));
    const stages = new UserSourceStages(database);
    vi.spyOn(stages.generations.connections, "run").mockImplementation(async work => work(client));
    vi.spyOn(stages.generations, "fence").mockResolvedValue({ state: "staging" });
    vi.spyOn(stages.generations, "execute").mockImplementation(async (_input, work) =>
      work(lease, new AbortController().signal));
    vi.spyOn(stages, "preserveUnseen").mockResolvedValue(0);
    vi.spyOn(stages, "validate").mockResolvedValue(undefined);
    vi.spyOn(stages, "counts").mockResolvedValue({ rows: 0, children: 0, batches: 0, pages: 0, wireRows: 0, bytes: 0 });
    const failure = new Error("Synthetic pre-commit failure.");
    vi.spyOn(stages.generations, "publish").mockRejectedValue(failure);
    const recover = vi.spyOn(OfficeAppAdoptionRepository.prototype, "recover").mockResolvedValue(undefined);
    const now = new Date();

    await expect(stages.execute({
      scope: { tenantId: lease.tenantId, kind: "tenant", principalId: null, tokenMode: "tenant", source: "directory", selector: "complete" },
      actorPrincipalId: "signed-in-viewer", schemaVersion: 1, jobKind: "data_sync", jobId: "source-job", runId: "source-run",
      sessionEpoch: "0", observedAt: now, expiresAt: new Date(now.getTime() + 60_000),
      deadlineAt: new Date(now.getTime() + 30_000), reserveBytes: 1024,
    }, async () => { if (boundary === "work") throw failure; },
    { completeJob: vi.fn(), beforePublish: vi.fn(async () => {}) })).rejects.toBe(failure);

    expect(recover).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("SET status=$2,error_code=$3"),
      [lease.id, "failed", "user_source_failed", expect.any(String)]);
  });
});

describe("unseen app activity retention", () => {
  it.each([
    { boundary: "row", size: 101, padding: "" },
    { boundary: "byte", size: 2, padding: "x".repeat(262_100) },
  ])("preserves duplicate aliases across the $boundary page boundary", async ({ size, padding }) => {
    const previous = Array.from({ length: size }, (_, index) => activity(String(index).padStart(6, "0"),
      index === 0 || index === size - 1 ? sharedAlias : `person-${index}@example.invalid`, padding));
    const { stages, incoming, append } = fixture(previous);

    await expect(stages.preserveUnseen(lease, "app_activity", () => undefined)).resolves.toBe(size);

    expect(append).toHaveBeenCalledTimes(2);
    expect(incoming.filter(row => row.upn_key === sharedAlias)).toHaveLength(2);
    expect(new Set(incoming.map(row => row.identity)).size).toBe(size);
    for (const row of incoming) {
      expect(row.residual).toMatchObject({
        retainedObservedAt: observedAt.toISOString(), retainedCollectorPrincipalId: "original-collector",
      });
    }
  });

  it("replaces all old duplicate aliases when the provider freshly observes that alias", async () => {
    const fresh = activity("fresh", sharedAlias);
    const { stages, incoming, append } = fixture([
      activity("000001", sharedAlias), activity("000002", sharedAlias),
    ], [fresh]);

    await expect(stages.preserveUnseen(lease, "app_activity", () => undefined)).resolves.toBe(0);

    expect(incoming).toEqual([fresh]);
    expect(append).not.toHaveBeenCalled();
  });

  it("keeps the original provenance when already-retained evidence is copied again", async () => {
    const previous = activity("retained-before", sharedAlias);
    previous.residual = { retainedObservedAt: "2026-09-01T00:00:00.000Z", retainedCollectorPrincipalId: "first-collector" };
    const { stages, incoming } = fixture([previous]);

    await expect(stages.preserveUnseen(lease, "app_activity", () => undefined)).resolves.toBe(1);

    expect(incoming[0].residual).toEqual(previous.residual);
  });
});
