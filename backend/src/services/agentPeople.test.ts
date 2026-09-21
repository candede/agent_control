import { randomUUID } from "node:crypto";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { revokeAccountSessionMutations } from "../db/sessions.js";
import { AppError } from "../errors.js";
import type { AuthenticatedUser } from "../types/session.js";
import type { SavedCopilotUsageSource } from "../db/dataSync.js";
import { AgentPeopleService } from "./agentPeople.js";
import type { DirectoryPrincipal } from "./directoryPrincipals.js";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const observedAt = "2026-09-20T12:00:00.000Z";
const options = { generation: "initial" };

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
  const requireAvailable = vi.fn();
  const admissions = vi.fn();
  const service = new AgentPeopleService({} as pg.Pool, {
    repository, saved, directory, revalidateUser, delegatedToken, requireAvailable, admissions,
    now: () => new Date(observedAt),
  });
  return { service, user, repository, saved, directory, revalidateUser, delegatedToken, requireAvailable, admissions };
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
    expect(value.repository.save.mock.calls[0][1][0]).toMatchObject({ status: "lookup_failed", errorCode: "missing_permission" });
    value.directory.resolve.mockClear();
    await expect(value.service.resolve(value.user, Array.from({ length: 20 }, () => randomUUID()), options))
      .rejects.toMatchObject({ code: "agent_people_incomplete" });
    expect(value.directory.resolve).toHaveBeenCalledTimes(8);
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
});
