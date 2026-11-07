import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirectoryRecord, GenerationLease } from "./dataGenerations.js";
import { directoryRecord } from "../../scripts/largeTenantFixtures.js";
import { UserSourceStages } from "./userSourceStages.js";
import { OfficeAppAdoptionRepository } from "./officeAppAdoption.js";
import { AppError } from "../errors.js";

afterEach(() => { vi.restoreAllMocks(); });

const lease: GenerationLease = {
  id: "incoming-generation", scopeId: "activity-scope", tenantId: "synthetic-tenant",
  owner: "synthetic-owner", version: 1, epoch: "0", sessionEpoch: "0", expectedRevision: "1", schemaVersion: 1,
};
const observedAt = new Date("2026-10-01T00:00:00Z");
const sharedAlias = "shared@example.invalid";

function directory(identity: string, upn: string, padding = ""): DirectoryRecord {
  return directoryRecord(identity, { upn, upn_key: upn, residual: { padding } });
}

function fixture(previous: DirectoryRecord[], incoming: DirectoryRecord[] = []) {
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
    if (statement.includes("FROM directory_service_plan_rows plan")) return result([]);
    if (!statement.includes("FROM directory_user_rows old")) throw new Error("Unexpected retention query.");
    const after = values?.[2];
    if (typeof after !== "string") throw new Error("Missing retention cursor.");
    const freshOnly = statement.includes("AND NOT incoming.residual ? 'retainedObservedAt'");
    const candidates = previous.filter(old => old.identity > after && !incoming.some(row =>
      row.identity === old.identity && (!freshOnly || !Object.hasOwn(row.residual, "retainedObservedAt"))))
      .sort((a, b) => a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0).slice(0, 100);
    let bytes = 0;
    return result(candidates.filter(value => {
      bytes += Buffer.byteLength(JSON.stringify(value));
      return bytes <= 524288;
    }).map(value => ({ identity: value.identity, value })));
  });
  const append = vi.spyOn(stages, "append").mockImplementation(async (_lease, kind, rows) => {
    if (kind !== "directory") throw new Error("Unexpected retained record kind.");
    for (const row of rows) {
      if (!("upn" in row)) throw new Error("Expected a directory record.");
      incoming.push(row);
    }
  });
  return { stages, incoming, append };
}

function result(rows: pg.QueryResultRow[]): pg.QueryResult {
  return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
}

describe("guarded user-source failures", () => {
  it.each(["fence", "state", "query"] as const)(
    "preserves the original %s failure when aborting the generation also fails", async boundary => {
      const database = new pg.Pool({ max: 4 });
      vi.spyOn(database, "connect").mockRejectedValue(new Error("Unit tests must not connect to a database."));
      const client = Object.assign(new pg.Client(), { release: vi.fn() });
      const stages = new UserSourceStages(database);
      vi.spyOn(stages.generations.connections, "run").mockImplementation(async work => work(client));
      const failure = boundary === "state" ? new Error("data_not_staging")
        : new AppError(503, "data_acquisition_timeout", "Synthetic source-stage failure.");
      const fence = vi.spyOn(stages.generations, "fence").mockResolvedValue({
        state: boundary === "state" ? "validating" : "staging",
      });
      if (boundary === "fence") fence.mockRejectedValue(failure);
      const query = vi.spyOn(client, "query").mockRejectedValue(failure);
      const abortFailure = new Error("Synthetic generation abort failure.");
      const abort = vi.spyOn(stages.generations, "abort").mockRejectedValue(abortFailure);

      await expect(stages.query(lease, "catalog", "synthetic:catalog")).rejects.toMatchObject({
        name: "AggregateError", message: "data_poison_fence_failed", errors: [failure, abortFailure],
      });

      expect(abort).toHaveBeenCalledExactlyOnceWith(lease);
      expect(query).toHaveBeenCalledTimes(boundary === "query" ? 1 : 0);
    },
  );

  it("rethrows the original failure unchanged when abort succeeds", async () => {
    const database = new pg.Pool({ max: 4 });
    vi.spyOn(database, "connect").mockRejectedValue(new Error("Unit tests must not connect to a database."));
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    const stages = new UserSourceStages(database);
    vi.spyOn(stages.generations.connections, "run").mockImplementation(async work => work(client));
    vi.spyOn(stages.generations, "fence").mockResolvedValue({ state: "staging" });
    const failure = new AppError(503, "data_acquisition_timeout", "Synthetic source-stage failure.");
    vi.spyOn(client, "query").mockRejectedValue(failure);
    const abort = vi.spyOn(stages.generations, "abort").mockResolvedValue(undefined);

    await expect(stages.query(lease, "catalog", "synthetic:catalog")).rejects.toBe(failure);

    expect(abort).toHaveBeenCalledExactlyOnceWith(lease);
  });

  it.each([false, true])("preserves an invalid provider count error when abort fails=%s", async abortFails => {
    const database = new pg.Pool({ max: 4 });
    vi.spyOn(database, "connect").mockRejectedValue(new Error("Unit tests must not connect to a database."));
    const stages = new UserSourceStages(database);
    const abortFailure = new Error("Synthetic generation abort failure.");
    const abort = vi.spyOn(stages.generations, "abort").mockResolvedValue(undefined);
    if (abortFails) abort.mockRejectedValue(abortFailure);
    const observePage = vi.spyOn(stages.generations, "observePage").mockRejectedValue(new Error("Invalid page must not be recorded."));

    const pending = stages.page(lease, "synthetic-query", "synthetic:page", 1, -1);
    if (abortFails) {
      await expect(pending).rejects.toMatchObject({
        name: "AggregateError", message: "data_poison_fence_failed",
        errors: [expect.objectContaining({ code: "provider_count_mismatch", status: 502 }), abortFailure],
      });
    } else {
      await expect(pending).rejects.toMatchObject({ code: "provider_count_mismatch", status: 502 });
    }
    expect(abort).toHaveBeenCalledExactlyOnceWith(lease);
    expect(observePage).not.toHaveBeenCalled();
  });
});

describe("saved directory identity verification inputs", () => {
  it.each([0, 501])("feeds %i saved object IDs in bounded keyset batches", async size => {
    const database = new pg.Pool({ max: 4 });
    vi.spyOn(database, "connect").mockRejectedValue(new Error("Unit tests must not connect to a database."));
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    const stages = new UserSourceStages(database);
    vi.spyOn(stages.generations.connections, "run").mockImplementation(async work => work(client));
    vi.spyOn(stages.generations, "fence").mockResolvedValue({ state: "staging" });
    const ids = Array.from({ length: size }, (_, index) => `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`);
    const query = vi.spyOn(client, "query").mockImplementation(async (statement, values) => {
      expect(statement).toContain("g.scope_epoch=s.epoch AND g.session_epoch=s.session_epoch");
      expect(statement).toContain('ORDER BY old.identity COLLATE "C" LIMIT 250');
      expect(values?.slice(0, 2)).toEqual([lease.scopeId, lease.tenantId]);
      return result(ids.filter(id => id > String(values?.[2])).slice(0, 250).map(identity => ({ identity })));
    });
    const identities = vi.spyOn(stages, "identities").mockResolvedValue(undefined);
    await stages.includeSavedIdentities(lease, () => undefined);
    expect(identities.mock.calls.flatMap(([, batch]) => batch)).toEqual(ids);
    expect(identities.mock.calls.every(([, batch]) => batch.length <= 250)).toBe(true);
    expect(query).toHaveBeenCalledTimes(Math.ceil(size / 250) + 1);
  });
});

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

describe("unverified directory retention", () => {
  it.each([
    { boundary: "row", size: 101, padding: "" },
    { boundary: "byte", size: 2, padding: "x".repeat(262_100) },
  ])("preserves duplicate aliases across the $boundary page boundary", async ({ size, padding }) => {
    const previous = Array.from({ length: size }, (_, index) => directory(String(index).padStart(6, "0"),
      index === 0 || index === size - 1 ? sharedAlias : `person-${index}@example.invalid`, padding));
    const { stages, incoming, append } = fixture(previous);

    await expect(stages.preserveUnseen(lease, () => undefined)).resolves.toBe(size);

    expect(append).toHaveBeenCalledTimes(2);
    expect(incoming.filter(row => row.upn_key === sharedAlias)).toHaveLength(2);
    expect(new Set(incoming.map(row => row.identity)).size).toBe(size);
    for (const row of incoming) {
      expect(row.residual).toMatchObject({
        retainedObservedAt: observedAt.toISOString(), retainedCollectorPrincipalId: "original-collector",
      });
    }
  });

  it("does not mistake an observed alias for rechecking a different object ID", async () => {
    const fresh = directory("000001", sharedAlias);
    const { stages, incoming, append } = fixture([
      directory("000001", sharedAlias), directory("000002", sharedAlias),
    ], [fresh]);

    await expect(stages.preserveUnseen(lease, () => undefined)).resolves.toBe(1);

    expect(incoming.map(row => row.identity)).toEqual(["000001", "000002"]);
    expect(append).toHaveBeenCalledOnce();
  });

  it("keeps the original provenance when already-retained evidence is copied again", async () => {
    const previous = directory("retained-before", sharedAlias);
    previous.residual = { retainedObservedAt: "2026-09-01T00:00:00.000Z", retainedCollectorPrincipalId: "first-collector" };
    const { stages, incoming } = fixture([previous]);

    await expect(stages.preserveUnseen(lease, () => undefined)).resolves.toBe(1);

    expect(incoming[0].residual).toEqual(previous.residual);
  });

  it("keeps an explicitly unattributed original collector when retaining evidence again", async () => {
    const previous = directory("retained-before", sharedAlias);
    previous.residual = { retainedObservedAt: "2026-09-01T00:00:00.000Z", retainedCollectorPrincipalId: null };
    const { stages, incoming } = fixture([previous]);

    await expect(stages.preserveUnseen(lease, () => undefined)).resolves.toBe(1);

    expect(incoming[0].residual).toEqual(previous.residual);
  });
});
