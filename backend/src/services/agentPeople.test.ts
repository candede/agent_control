import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateAccountSession, revokeAccountSessionMutations } from "../db/sessions.js";
import { AppError } from "../errors.js";
import type { AuthenticatedUser } from "../types/session.js";
import type { SavedCopilotUsageSource } from "../db/dataSync.js";
import { AgentPeopleService } from "./agentPeople.js";
import type { DirectoryPrincipal } from "./directoryPrincipals.js";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const observedAt = "2026-09-20T12:00:00.000Z";
const options = { generation: "initial" };

afterEach(() => vi.restoreAllMocks());

function harness() {
  const user: AuthenticatedUser = { tenantId: randomUUID(), homeAccountId: randomUUID(), username: "reader@example.invalid",
    displayName: "Reader", roles: ["AgentControl.Viewer"] };
  const repository = {
    generation: vi.fn(async () => "initial"), referencedIds: vi.fn(async () => [id, secondId]),
    read: vi.fn(async () => []), save: vi.fn(),
  };
  const source: SavedCopilotUsageSource<unknown> = { source: "directory", value: null, observedAt: null,
    attemptStatus: null, message: null, attemptedAt: null, lastSuccessAt: null, rowCount: null };
  const saved = { getDirectorySource: vi.fn(async () => source) };
  const directory = { resolve: vi.fn(async (_token, ids): Promise<DirectoryPrincipal[]> => ids.map(entity => ({
    ...entity, displayName: "Unlicensed creator", secondaryText: "mail@example.invalid",
    userPrincipalName: "login@example.invalid", principalKind: "user" as const,
  }))) };
  const revalidateUser = vi.fn(async () => user);
  const delegatedToken = vi.fn(async () => "fixture-token");
  const requireAvailable = vi.fn(async () => {});
  const admissions = vi.fn();
  const reportedFailures = vi.fn();
  const observeOperation = vi.fn(async (_id, _user, operation) => operation(reportedFailures));
  const service = new AgentPeopleService({} as pg.Pool, {
    observeOperation,
    repository, saved, directory, revalidateUser, delegatedToken, requireAvailable, admissions,
    now: () => new Date(observedAt),
  });
  return { service, user, repository, saved, directory, revalidateUser, delegatedToken, requireAvailable, admissions, reportedFailures, observeOperation };
}

describe("persistent agent people resolution", () => {
  it("resolves unlicensed exact IDs once, saves real UPN rather than mail, and reauthorizes publication", async () => {
    const value = harness();
    expect(await value.service.resolve(value.user, [id, id.toUpperCase()], options))
      .toEqual({ changed: true, resolved: 1, notFound: 0, failed: 0 });
    expect(value.directory.resolve).toHaveBeenCalledExactlyOnceWith("fixture-token",
      [{ resourceId: id, resourceType: "user" }], expect.any(AbortSignal));
    expect(value.repository.save).toHaveBeenCalledWith({
      tenantId: value.user.tenantId, principalId: value.user.homeAccountId,
    }, [{ objectId: id, status: "resolved", displayName: "Unlicensed creator",
      userPrincipalName: "login@example.invalid", checkedAt: observedAt }], expect.objectContaining(options));
    expect(value.revalidateUser).toHaveBeenCalledTimes(2);
    expect(value.requireAvailable).toHaveBeenCalledTimes(2);
  });

  it("skips fresh cached results unless explicitly retried", async () => {
    const value = harness();
    value.repository.read.mockResolvedValueOnce([{ objectId: id }] as never);
    expect((await value.service.resolve(value.user, [id], options)).changed).toBe(false);
    expect(value.directory.resolve).not.toHaveBeenCalled();
    value.repository.read.mockResolvedValueOnce([{ objectId: id }] as never);
    await value.service.resolve(value.user, [id], { ...options, force: true });
    expect(value.directory.resolve).toHaveBeenCalledTimes(1);
  });

  it("uses existing reference identities during automatic sync rather than forcing all lookups", async () => {
    const value = harness();
    value.repository.read.mockResolvedValueOnce([{ objectId: id, status: "resolved" }] as never);
    await value.service.refreshReferences(value.user, new AbortController().signal,
      { runId: randomUUID(), jobId: randomUUID() }, { incompleteOnly: false, useCache: true });
    expect(value.directory.resolve).toHaveBeenCalledExactlyOnceWith("fixture-token",
      [{ resourceId: secondId, resourceType: "user" }], expect.any(AbortSignal));
  });

  it("keeps 404 not-found distinct from lookup failure and does not claim deletion", async () => {
    const value = harness();
    value.directory.resolve.mockResolvedValueOnce([{ resourceId: id, resourceType: "user", displayName: id, principalKind: "unknown" }])
      .mockRejectedValueOnce(new AppError(502, "provider_error", "Provider unavailable"));
    expect(await value.service.resolve(value.user, [id, secondId], options))
      .toEqual({ changed: true, resolved: 0, notFound: 1, failed: 1 });
    expect(value.repository.save.mock.calls[0][1]).toEqual([
      { objectId: id, status: "not_found", displayName: null, userPrincipalName: null, checkedAt: observedAt },
      { objectId: secondId, status: "lookup_failed", displayName: null, userPrincipalName: null,
        checkedAt: observedAt, errorCode: "provider_error" },
    ]);
  });

  it("refreshes only referenced people missing from the licensed reporting roster during Users sync", async () => {
    const value = harness();
    value.saved.getDirectorySource.mockResolvedValue({
      source: "directory", observedAt, rowCount: 1, attemptStatus: "available", attemptedAt: observedAt,
      lastSuccessAt: observedAt, message: "Fixture",
      value: [{ identity: { objectId: id, displayName: "Licensed", userPrincipalName: "licensed@example.invalid",
        accountEnabled: true, userType: "Member", employeeType: null, department: null, companyName: null },
      serviceEvidenceVersion: 1, copilotServiceState: "unknown", servicePlans: [] }],
    });
    const publication = { runId: randomUUID(), jobId: randomUUID() };
    await value.service.refreshReferences(value.user, new AbortController().signal, publication, { incompleteOnly: false });
    expect(value.directory.resolve).toHaveBeenCalledExactlyOnceWith("fixture-token",
      [{ resourceId: secondId, resourceType: "user" }], expect.any(AbortSignal));
    expect(value.repository.save.mock.calls[0][2]).toMatchObject({ generation: "initial", publication });
  });

  it("retries only failed or missing people rather than refreshing completed references again", async () => {
    const value = harness();
    value.repository.read.mockResolvedValueOnce([{ objectId: id, status: "resolved" },
      { objectId: secondId, status: "lookup_failed" }] as never);
    await value.service.refreshReferences(value.user, new AbortController().signal,
      { runId: randomUUID(), jobId: randomUUID() }, { incompleteOnly: true });
    expect(value.directory.resolve).toHaveBeenCalledExactlyOnceWith("fixture-token",
      [{ resourceId: secondId, resourceType: "user" }], expect.any(AbortSignal));
  });

  it("normalizes Graph error codes to bounded saved failure states and stops systemic failures early", async () => {
    const value = harness();
    value.directory.resolve.mockRejectedValue(new AppError(403, "Authorization_RequestDenied", "Denied"));
    expect((await value.service.resolve(value.user, [id], options)).failed).toBe(1);
    expect(value.reportedFailures).toHaveBeenCalledOnce();
    expect(value.reportedFailures).toHaveBeenCalledWith(expect.objectContaining({ code: "Authorization_RequestDenied" }));
    expect(value.repository.save.mock.calls[0][1][0]).toMatchObject({ status: "lookup_failed", errorCode: "missing_permission" });
    value.directory.resolve.mockClear();
    await expect(value.service.resolve(value.user, Array.from({ length: 20 }, () => randomUUID()), options))
      .rejects.toMatchObject({ code: "agent_people_incomplete" });
    expect(value.directory.resolve).toHaveBeenCalledTimes(8);
  });

  it("preserves cancellation before reads and records provider request deadlines distinctly", async () => {
    const cancelled = harness();
    const controller = new AbortController();
    controller.abort(new Error("Fixture cancellation"));
    await expect(cancelled.service.resolve(cancelled.user, [id], { ...options, signal: controller.signal }))
      .rejects.toThrow("Fixture cancellation");
    expect(cancelled.saved.getDirectorySource).not.toHaveBeenCalled();
    expect(cancelled.repository.read).not.toHaveBeenCalled();
    expect(cancelled.directory.resolve).not.toHaveBeenCalled();

    const deadline = harness();
    const deadlineController = new AbortController();
    deadlineController.abort(new DOMException("Private deadline details", "TimeoutError"));
    await expect(deadline.service.resolve(deadline.user, [id], { ...options, signal: deadlineController.signal }))
      .rejects.toMatchObject({ status: 504, code: "provider_timeout" });
    expect(deadline.saved.getDirectorySource).not.toHaveBeenCalled();

    const timedOut = harness();
    timedOut.directory.resolve.mockRejectedValueOnce(new DOMException("Private provider details", "TimeoutError"));
    expect((await timedOut.service.resolve(timedOut.user, [id], options)).failed).toBe(1);
    expect(timedOut.repository.save.mock.calls[0][1][0]).toMatchObject({
      status: "lookup_failed", errorCode: "provider_timeout",
    });
  });

  it("stops refresh-reference reads when cancellation arrives between persistence calls", async () => {
    const value = harness();
    const controller = new AbortController();
    value.repository.generation.mockImplementationOnce(async () => {
      controller.abort(new Error("Fixture cancellation"));
      return "initial";
    });
    await expect(value.service.refreshReferences(value.user, controller.signal,
      { runId: randomUUID(), jobId: randomUUID() }, { incompleteOnly: false }))
      .rejects.toThrow("Fixture cancellation");
    expect(value.repository.referencedIds).not.toHaveBeenCalled();
    expect(value.saved.getDirectorySource).not.toHaveBeenCalled();
  });

  it("bounds provider concurrency and rejects invalid IDs before provider work", async () => {
    const value = harness();
    let active = 0;
    let maximum = 0;
    value.directory.resolve.mockImplementation(async (_token, ids) => {
      maximum = Math.max(maximum, ++active);
      await new Promise(resolve => setTimeout(resolve, 1));
      --active;
      return ids.map(entity => ({ ...entity, displayName: entity.resourceId, principalKind: "unknown" }));
    });
    await expect(value.service.resolve(value.user, ["arbitrary-name"], options)).rejects.toMatchObject({ code: "invalid_agent_people" });
    await value.service.resolve(value.user, Array.from({ length: 19 }, () => randomUUID()), options);
    expect(maximum).toBe(8);
    expect(value.repository.save).toHaveBeenCalledTimes(3);
  });

  it("does not publish mismatched, revoked, cancelled, or cross-tenant results as resolved identities", async () => {
    const mismatch = harness();
    mismatch.directory.resolve.mockResolvedValueOnce([{ resourceId: secondId, resourceType: "user", displayName: "Wrong", principalKind: "user" }]);
    expect((await mismatch.service.resolve(mismatch.user, [id], options)).failed).toBe(1);
    expect(mismatch.repository.save.mock.calls[0][1][0]).toMatchObject({ status: "lookup_failed", errorCode: "principal_identity_mismatch" });
    const revoked = harness();
    revoked.directory.resolve.mockImplementationOnce(async () => {
      await revokeAccountSessionMutations(revoked.user.tenantId!, revoked.user.homeAccountId, async () => undefined);
      return [{ resourceId: id, resourceType: "user", displayName: "Creator", principalKind: "user" }];
    });
    await expect(revoked.service.resolve(revoked.user, [id], options)).rejects.toMatchObject({ code: "unauthorized" });
    expect(revoked.repository.save).not.toHaveBeenCalled();
    const cancelled = harness();
    const controller = new AbortController();
    cancelled.directory.resolve.mockImplementationOnce(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    await expect(cancelled.service.resolve(cancelled.user, [id], { ...options, signal: controller.signal })).rejects.toThrow();
    expect(cancelled.repository.save).not.toHaveBeenCalled();
    const changed = harness();
    changed.revalidateUser.mockResolvedValueOnce(changed.user).mockResolvedValueOnce({ ...changed.user, tenantId: "other" });
    await expect(changed.service.resolve(changed.user, [id], options)).rejects.toMatchObject({ code: "scope_mismatch" });
    expect(changed.repository.save).not.toHaveBeenCalled();
  });

  it.each(["generation", "references", "directory", "cache"] as const)(
    "pins the initiating session before the %s read, even if the account signs in again", async phase => {
      const value = harness();
      const replaceSession = async () => {
        await revokeAccountSessionMutations(value.user.tenantId!, value.user.homeAccountId, async () => {});
        await activateAccountSession(value.user.tenantId!, value.user.homeAccountId, async () => {});
      };
      if (phase === "generation") value.repository.generation.mockImplementationOnce(async () => {
        await replaceSession();
        return "initial";
      });
      if (phase === "references") value.repository.referencedIds.mockImplementationOnce(async () => {
        await replaceSession();
        return [id];
      });
      if (phase === "directory") value.saved.getDirectorySource.mockImplementationOnce(async () => {
        await replaceSession();
        return { source: "directory", value: null, observedAt: null, attemptStatus: null,
          message: null, attemptedAt: null, lastSuccessAt: null, rowCount: null };
      });
      if (phase === "cache") value.repository.read.mockImplementationOnce(async () => {
        await replaceSession();
        return [];
      });
      const operation = phase === "generation" || phase === "references"
        ? value.service.refreshReferences(value.user, new AbortController().signal,
          { runId: randomUUID(), jobId: randomUUID() }, { incompleteOnly: false })
        : value.service.resolve(value.user, [id], options);
      await expect(operation).rejects.toMatchObject({ code: "unauthorized" });
      expect(value.delegatedToken).not.toHaveBeenCalled();
      expect(value.directory.resolve).not.toHaveBeenCalled();
      expect(value.repository.save).not.toHaveBeenCalled();
    },
  );

  it.each(["revocation", "admission"] as const)(
    "stops token acquisition when %s changes during capability validation", async change => {
      const value = harness();
      let revoked: Promise<void> | undefined;
      value.requireAvailable.mockImplementationOnce(async () => {
        if (change === "revocation") {
          revoked = revokeAccountSessionMutations(value.user.tenantId!, value.user.homeAccountId, async () => {});
        } else {
          value.admissions.mockImplementation(() => { throw new AppError(503, "maintenance", "Provider work stopped"); });
        }
      });
      try {
        await expect(value.service.resolve(value.user, [id], options))
          .rejects.toMatchObject({ code: change === "revocation" ? "unauthorized" : "maintenance" });
        expect(value.delegatedToken).not.toHaveBeenCalled();
        expect(value.directory.resolve).not.toHaveBeenCalled();
        expect(value.repository.save).not.toHaveBeenCalled();
      } finally { await revoked; }
    },
  );

  it.each(["token", "publication", "evidence"] as const)(
    "rechecks the session after awaited %s work", async phase => {
      const value = harness();
      let revoked: Promise<void> | undefined;
      const revoke = () => { revoked = revokeAccountSessionMutations(value.user.tenantId!, value.user.homeAccountId, async () => {}); };
      if (phase === "token") value.delegatedToken.mockImplementationOnce(async () => { revoke(); return "fixture-token"; });
      if (phase === "publication") value.requireAvailable.mockImplementationOnce(async () => {})
        .mockImplementationOnce(async () => { revoke(); });
      if (phase === "evidence") value.observeOperation.mockImplementationOnce(async (_id, _user, operation) => {
        const result = await operation(value.reportedFailures);
        revoke();
        return result;
      });
      try {
        await expect(value.service.resolve(value.user, [id], options)).rejects.toMatchObject({ code: "unauthorized" });
        if (phase === "token") expect(value.directory.resolve).not.toHaveBeenCalled();
        if (phase !== "evidence") expect(value.repository.save).not.toHaveBeenCalled();
      } finally { await revoked; }
    },
  );

  it("fences session changes inside database publication and before the next provider batch", async () => {
    const value = harness();
    let revoked: Promise<void> | undefined;
    value.repository.save.mockImplementationOnce(async (_scope, _observations, context) => {
      context.fence();
      revoked = revokeAccountSessionMutations(value.user.tenantId!, value.user.homeAccountId, async () => {});
      context.fence();
    });
    try {
      await expect(value.service.resolve(value.user, Array.from({ length: 9 }, () => randomUUID()), options))
        .rejects.toMatchObject({ code: "unauthorized" });
      expect(value.directory.resolve).toHaveBeenCalledTimes(8);
    } finally { await revoked; }
  });

  it("keeps account publication serialized until timed-out transaction cleanup settles", async () => {
    const value = harness();
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let finishQuery!: () => void;
    let finishRollback!: () => void;
    const query = new Promise<void>(resolve => { finishQuery = resolve; });
    const rollback = new Promise<void>(resolve => { finishRollback = resolve; });
    const rollingBack = vi.fn();
    const revoked = vi.fn();
    value.repository.save.mockImplementationOnce(async (_scope, _observations, context) => {
      await query;
      try { context.fence(); }
      catch (error) { rollingBack(); await rollback; throw error; }
    });
    const outcome = value.service.resolve(value.user, [id], options).then(result => result, error => error);
    await vi.waitFor(() => expect(value.repository.save).toHaveBeenCalledOnce());
    deadline.abort(new DOMException("Fixture deadline", "TimeoutError"));
    expect(await outcome).toMatchObject({ code: "provider_timeout" });
    const revocation = revokeAccountSessionMutations(value.user.tenantId!, value.user.homeAccountId, async () => { revoked(); });
    try {
      finishQuery();
      await vi.waitFor(() => expect(rollingBack).toHaveBeenCalledOnce());
      expect(revoked).not.toHaveBeenCalled();
    } finally {
      finishQuery();
      finishRollback();
      await revocation;
    }
    expect(revoked).toHaveBeenCalledOnce();
  });

  it.each(["directory", "cache", "authentication", "capability", "token", "provider", "publication", "evidence"] as const)(
    "enforces a wall-clock deadline during stalled %s work and discards late completion", async phase => {
      const value = harness();
      const deadline = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
      let release!: () => void;
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const reached = vi.fn();
      const stall = async () => { reached(); await blocked; };
      if (phase === "directory") {
        const source = await value.saved.getDirectorySource();
        value.saved.getDirectorySource.mockClear().mockImplementationOnce(async () => { await stall(); return source; });
      }
      if (phase === "cache") value.repository.read.mockImplementationOnce(async () => { await stall(); return []; });
      if (phase === "authentication") value.revalidateUser.mockImplementationOnce(async () => { await stall(); return value.user; });
      if (phase === "capability") value.requireAvailable.mockImplementationOnce(stall);
      if (phase === "token") value.delegatedToken.mockImplementationOnce(async () => { await stall(); return "fixture-token"; });
      if (phase === "provider") value.directory.resolve.mockImplementationOnce(async () => {
        await stall();
        return [{ resourceId: id, resourceType: "user", principalKind: "user", displayName: "Late person" }];
      });
      if (phase === "publication") value.repository.save.mockImplementationOnce(stall);
      if (phase === "evidence") value.observeOperation.mockImplementationOnce(async (_id, _user, operation) => {
        const result = await operation(value.reportedFailures);
        await stall();
        return result;
      });
      const outcome = value.service.resolve(value.user, [id], options).then(result => result, error => error);
      await vi.waitFor(() => expect(reached).toHaveBeenCalledOnce());
      deadline.abort(new DOMException("Fixture deadline", "TimeoutError"));
      const result = await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve("still pending"), 25))]);
      release();
      await outcome;
      expect(result).toMatchObject({ status: 504, code: "provider_timeout" });
      expect(AbortSignal.timeout).toHaveBeenCalledWith(120_000);
      if (!["publication", "evidence"].includes(phase)) expect(value.repository.save).not.toHaveBeenCalled();
      if (!["provider", "publication", "evidence"].includes(phase)) expect(value.directory.resolve).not.toHaveBeenCalled();
    },
  );
});
