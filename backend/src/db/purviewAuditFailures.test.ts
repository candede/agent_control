import { describe, expect, it, vi } from "vitest";
import { PurviewAuditRepository, type PurviewAuditScope } from "./purviewAudit.js";
import { AppError } from "../errors.js";
import type { PurviewAuditFilters, PurviewAuditRecord, PurviewAuditResult } from "../types/purviewAudit.js";
import * as operationalState from "../services/operationalState.js";

const mocks = vi.hoisted(() => ({ query: vi.fn(), commit: vi.fn() }));

vi.mock("./pool.js", () => ({
  pool: { query: mocks.query },
  secretValue: () => undefined,
  transaction: async (_database: unknown, work: (client: { query: typeof mocks.query }) => Promise<unknown>,
    _signal?: AbortSignal, beforeCommit?: () => void) => {
    const result = await work({ query: mocks.query });
    beforeCommit?.();
    mocks.commit();
    return result;
  },
}));

const scope: PurviewAuditScope = {
  tenantId: "tenant-a", authorizationPrincipalId: "reader-a", tokenMode: "delegated",
  resultScope: { kind: "principal", scopeId: "reader-a", configurationRevision: null },
};
const id = "11111111-1111-4111-8111-111111111111";
const execution = { owner: "22222222-2222-4222-8222-222222222222", version: 1 };
const filters: PurviewAuditFilters = { presetId: "copilot_interactions", operations: ["CopilotInteraction"],
  startDateTime: "2026-09-09T10:00:00.000Z", endDateTime: "2026-09-09T11:00:00.000Z",
  userPrincipalNames: [], ipAddresses: [], objectIds: [], administrativeUnitIds: [] };
const record: PurviewAuditRecord = {
  projectionVersion: 1, wrapperId: "wrapper-1", nativeEventId: null, eventDateTime: "2026-09-09T10:30:00.000Z",
  auditLogRecordType: "copilotInteraction", operation: "CopilotInteraction", service: "Copilot", resultStatus: null,
  actorUserId: null, actorUserPrincipalName: null, actorUserType: null, objectId: null, clientIp: null,
  administrativeUnits: [], correlationId: null, agentId: null, appIdentity: null, appHost: null, botId: null,
  environmentId: null, botComponentId: null, aiPluginOperationId: null, messages: [], contentAvailable: false, unknownFieldCount: 0,
};

describe("Purview audit failure persistence", () => {
  it.each(["cancel", "delete"] as const)("fences application %s by the authorization owner before writing", async action => {
    const repository = new PurviewAuditRepository();
    mocks.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    mocks.commit.mockClear();
    await expect(repository[action]({
      tenantId: "tenant-a", authorizationPrincipalId: "reader-b",
      resultScopes: [{ kind: "application", scopeId: "application-client", configurationRevision: 7 }],
    }, id)).rejects.toMatchObject({ code: "not_found" });
    expect(mocks.query).toHaveBeenCalledOnce();
    const [sql, values] = mocks.query.mock.calls[0];
    expect(sql).toContain("authorization_principal_id=");
    expect(sql).toContain("FOR UPDATE");
    expect(values).toContain("reader-b");
    expect(values).toContain("application-client");
    expect(values).toContain(7);
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("rejects a delegated read scope belonging to another principal", async () => {
    const repository = new PurviewAuditRepository();
    mocks.query.mockReset();
    await expect(repository.listJobs({
      tenantId: "tenant-a", authorizationPrincipalId: "reader-b",
      resultScopes: [{ kind: "principal", scopeId: "reader-a", configurationRevision: null }],
    })).rejects.toMatchObject({ code: "scope_mismatch" });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it.each(["cancel", "delete"] as const)("does not commit %s after saved-data authority changes during the write", async action => {
    const repository = new PurviewAuditRepository();
    const controller = new AbortController();
    const failure = new AppError(401, "authorization_expired", "Saved-data authority changed.");
    mocks.commit.mockClear();
    mocks.query.mockReset().mockImplementation(async (statement: string) => {
      if (statement.includes(action === "cancel" ? "UPDATE purview_audit_jobs" : "DELETE FROM purview_audit_jobs")) controller.abort(failure);
      return { rows: [{ id }], rowCount: 1 };
    });
    await expect(repository[action](scope, id, () => controller.signal.throwIfAborted())).rejects.toBe(failure);
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("does not admit a physical request after accounting crosses the durable deadline", async () => {
    const repository = new PurviewAuditRepository();
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    mocks.commit.mockClear();
    mocks.query.mockReset().mockImplementation(async (statement: string) => {
      if (statement.includes("UPDATE purview_audit_jobs")) vi.setSystemTime(now + 1_000);
      return { rows: [{ deadline_at: new Date(now + 1_000), provider_request_count: 0 }], rowCount: 1 };
    });
    try {
      await expect(repository.authorizeProviderRequest(scope, id, execution)).rejects.toMatchObject({ code: "audit_job_expired" });
      expect(mocks.query).toHaveBeenCalledTimes(2);
      expect(mocks.commit).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it.each(["authorization", "admissions"] as const)(
    "does not commit submission after %s changes during the write", async mode => {
      const repository = new PurviewAuditRepository();
      const controller = new AbortController();
      const reason = mode === "authorization" ? new AppError(401, "authorization_expired", "Initiating authority changed.")
        : new AppError(503, "maintenance", "Provider admissions are closed.");
      const admission = vi.spyOn(operationalState, "requireProviderAdmissions").mockImplementation(() => {
        if (mode === "admissions") controller.signal.throwIfAborted();
      });
      mocks.commit.mockClear();
      mocks.query.mockReset().mockImplementation(async (statement: string) => {
        if (statement.includes("INSERT INTO")) controller.abort(reason);
        return { rows: statement.includes("principal_count") ? [{ principal_count: 0, tenant_count: 0 }] : [], rowCount: 0 };
      });
      try {
        const assertCurrent = () => { if (mode === "authorization") controller.signal.throwIfAborted(); };
        await expect(repository.submit(scope, { idempotencyKey: "fenced-submission", filters }, assertCurrent)).rejects.toBe(reason);
        expect(mocks.commit).not.toHaveBeenCalled();
      } finally { admission.mockRestore(); }
    },
  );

  it.each([true, false])("rejects publication begun after the durable execution deadline (complete: %s)", async complete => {
    const repository = new PurviewAuditRepository();
    const result: PurviewAuditResult = { records: [record], pageCount: 1, providerRowCount: 1, storedRowCount: 1,
      byteCount: 1024, unknownFieldCount: 0, complete, nextLink: complete ? null : "https://graph.microsoft.com/v1.0/security/auditLog/queries/provider/records?$skiptoken=next",
      partialReason: complete ? null : "audit_job_expired" };
    mocks.commit.mockClear();
    mocks.query.mockReset().mockResolvedValueOnce({
      rows: [{ filters, deadline_at: new Date(Date.now() - 1_000), expires_at: new Date(Date.now() + 60_000) }], rowCount: 1,
    });
    await expect(repository.publish(scope, id, execution, result)).rejects.toMatchObject({ code: "audit_job_expired" });
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledOnce();
  });

  it("does not publish expired local caches even to preserve partial rows", async () => {
    const repository = new PurviewAuditRepository();
    const result: PurviewAuditResult = { records: [record], pageCount: 1, providerRowCount: 1, storedRowCount: 1,
      byteCount: 1024, unknownFieldCount: 0, complete: false, nextLink: null, partialReason: "audit_job_expired" };
    mocks.commit.mockClear();
    mocks.query.mockReset().mockResolvedValueOnce({
      rows: [{ filters, deadline_at: new Date(Date.now() - 1_000), expires_at: new Date(Date.now() - 1_000) }], rowCount: 1,
    });
    await expect(repository.publish(scope, id, execution, result)).rejects.toMatchObject({ code: "audit_job_expired" });
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledOnce();
  });

  it.each(["execution", "cache"] as const)("rechecks the %s deadline after awaiting record persistence", async deadline => {
    const repository = new PurviewAuditRepository();
    const getJob = vi.spyOn(repository, "getJob").mockResolvedValue(undefined);
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const result: PurviewAuditResult = { records: [record], pageCount: 1, providerRowCount: 1, storedRowCount: 1,
      byteCount: 1024, unknownFieldCount: 0, complete: true, nextLink: null, partialReason: null };
    mocks.commit.mockClear();
    mocks.query.mockReset().mockImplementation(async (statement: string) => {
      if (statement.includes("SELECT * FROM purview_audit_jobs")) return {
        rows: [{ filters, deadline_at: new Date(now + 1_000), expires_at: new Date(now + (deadline === "cache" ? 1_000 : 60_000)) }], rowCount: 1,
      };
      if (statement.includes("INSERT INTO purview_audit_records")) vi.setSystemTime(now + 2_000);
      return { rows: [], rowCount: 1 };
    });
    try {
      const publication = repository.publish(scope, id, execution, result);
      if (deadline === "cache") {
        await expect(publication).rejects.toMatchObject({ code: "audit_job_expired" });
        expect(mocks.commit).not.toHaveBeenCalled();
      } else {
        await publication;
        const update = mocks.query.mock.calls.find(([statement]) => statement.includes("UPDATE purview_audit_jobs"))!;
        expect(update[1][5]).toBe("partial");
        expect(update[1][11]).toBe(false);
        expect(update[1][14]).toBe("audit_job_expired");
        expect(mocks.commit).toHaveBeenCalledOnce();
      }
    } finally { getJob.mockRestore(); vi.useRealTimers(); }
  });

  it.each(["execution", "cache"] as const)("rechecks the %s deadline after finalizing job state", async deadline => {
    const repository = new PurviewAuditRepository();
    const getJob = vi.spyOn(repository, "getJob").mockResolvedValue(undefined);
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const result: PurviewAuditResult = { records: [record], pageCount: 1, providerRowCount: 1, storedRowCount: 1,
      byteCount: 1024, unknownFieldCount: 0, complete: true, nextLink: null, partialReason: null };
    mocks.commit.mockClear();
    mocks.query.mockReset().mockImplementation(async (statement: string) => {
      if (statement.includes("SELECT * FROM purview_audit_jobs")) return {
        rows: [{ filters, deadline_at: new Date(now + 1_000), expires_at: new Date(now + (deadline === "cache" ? 1_000 : 60_000)) }], rowCount: 1,
      };
      if (statement.includes("UPDATE purview_audit_jobs SET status=")) vi.setSystemTime(now + 1_000);
      return { rows: [], rowCount: 1 };
    });
    try {
      const publication = repository.publish(scope, id, execution, result);
      if (deadline === "cache") {
        await expect(publication).rejects.toMatchObject({ code: "audit_job_expired" });
        expect(mocks.commit).not.toHaveBeenCalled();
      } else {
        await publication;
        const finalization = mocks.query.mock.calls.at(-1)!;
        expect(finalization[0]).toContain("status='partial',page_complete=false");
        expect(finalization[1]).toEqual([id, "audit_job_expired", expect.stringContaining("preserved records are partial")]);
        expect(mocks.commit).toHaveBeenCalledOnce();
      }
    } finally { getJob.mockRestore(); vi.useRealTimers(); }
  });

  it.each(["authorization", "deadline"].flatMap(mode => ["records", "failure"].map(outcome => ({ mode, outcome }))))(
    "withholds $outcome publication when $mode changes during persistence", async ({ mode, outcome }) => {
      const repository = new PurviewAuditRepository();
      const getJob = vi.spyOn(repository, "getJob").mockResolvedValue(undefined);
      const controller = new AbortController();
      const reason = mode === "authorization" ? new AppError(401, "authorization_expired", "Authority changed.")
        : new DOMException("Publication expired.", "TimeoutError");
      const result: PurviewAuditResult = { records: [], pageCount: 1, providerRowCount: 0, storedRowCount: 0,
        byteCount: 2, unknownFieldCount: 0, complete: true, nextLink: null, partialReason: null };
      mocks.commit.mockClear();
      mocks.query.mockReset().mockImplementation(async (statement: string) => {
        if (statement.includes("UPDATE purview_audit_jobs SET status=")) controller.abort(reason);
        return { rows: [{ deadline_at: new Date(Date.now() + 60_000) }], rowCount: 1 };
      });
      try {
        const assertCurrent = () => controller.signal.throwIfAborted();
        await expect(outcome === "records" ? repository.publish(scope, id, execution, result, assertCurrent)
          : repository.fail(scope, id, execution, "provider_error", "Provider unavailable.", true, assertCurrent)).rejects.toBe(reason);
        expect(mocks.commit).not.toHaveBeenCalled();
        expect(getJob).not.toHaveBeenCalled();
      } finally { getJob.mockRestore(); }
    },
  );

  it.each([false, true])("derives remote continuation from the locked provider state, not inconclusive=%s", async inconclusive => {
    const repository = new PurviewAuditRepository();
    const getJob = vi.spyOn(repository, "getJob").mockResolvedValue(undefined);
    try {
      for (const attempted of [false, true]) {
        for (const status of [null, "notStarted", "running", "succeeded", "failed", "cancelled", "unknownFutureValue"]) {
          mocks.query.mockReset();
          mocks.query.mockResolvedValue({ rows: [], rowCount: 1 }).mockResolvedValueOnce({
            rows: [{ attempted_at: attempted ? new Date() : null, provider_status: status }], rowCount: 1,
          });
          await repository.fail(scope, id, execution, "provider_throttled", "Provider polling was throttled.", inconclusive);
          expect(mocks.query.mock.calls[0]).toEqual([
            expect.stringContaining("FOR UPDATE"),
            [id, scope.tenantId, "principal", "reader-a", null, "reader-a", "delegated", execution.owner, execution.version, ["running", "reconciling_create"]],
          ]);
          const remoteWorkMayContinue = attempted && (status === null || status === "notStarted" || status === "running");
          expect(mocks.query.mock.calls[1]).toEqual([
            expect.stringContaining("remote_work_may_continue=$7,"),
            [id, scope.tenantId, "reader-a", inconclusive ? "inconclusive" : "failed", "provider_throttled",
              "Provider polling was throttled.", remoteWorkMayContinue, execution.owner, execution.version],
          ]);
        }
      }
    } finally {
      getJob.mockRestore();
    }
  });
});
