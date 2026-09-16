import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import type { AuthenticatedUser } from "../types/session.js";
import { PackageInventoryService, scanPackages } from "./packageInventory.js";
import { allowlistedPackage } from "./packageObservation.js";
import { GraphPackagesClient, packageInventoryReadPolicy, type FetchLike } from "./graphPackages.js";

const user: AuthenticatedUser = {
  tenantId: "tenant-package",
  homeAccountId: "principal-package",
  displayName: "Package Reader",
  username: "reader@example.invalid",
  roles: ["AgentControl.Viewer"],
};

function fixture(overrides: Record<string, unknown> = {}) {
  const job = {
    id: "11111111-1111-1111-1111-111111111111",
    authorizationPrincipalId: user.homeAccountId,
    tokenMode: "delegated" as const,
    scopeKind: "broad" as const,
    requestedIds: [],
    status: "waiting_authorization" as const,
    pageCount: 0,
    observedCount: 0,
    totalRecords: null,
    snapshotId: null,
    createdAt: "2026-09-09T00:00:00.000Z",
    attemptedAt: null,
    updatedAt: "2026-09-09T00:00:00.000Z",
    finishedAt: null,
  };
  const repository = {
    submit: vi.fn(async () => job),
    getJob: vi.fn(async () => job),
    markRunning: vi.fn(async () => true),
    recordProgress: vi.fn(async () => undefined),
    publish: vi.fn(async () => undefined),
    markWaitingAuthorization: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
    cancel: vi.fn(async () => ({ ...job, status: "cancelled" as const })),
    recoverInterrupted: vi.fn(async () => 0),
    ...overrides,
  };
  const dependencies = {
    delegatedToken: vi.fn(async () => "delegated-token"),
    applicationToken: vi.fn(async () => "application-token"),
    revalidateUser: vi.fn(async () => user),
    requireAvailable: vi.fn(async () => undefined),
    requireApplicationDataScope: vi.fn(async () => undefined),
    scan: vi.fn<typeof scanPackages>(async () => ({ packages: [], totalRecords: 0, pages: 1 })),
    applicationPrincipalId: vi.fn(() => "application-id"),
  };
  return { job, repository, dependencies, service: new PackageInventoryService(repository as never, dependencies as never) };
}

describe("Package refresh service", () => {
  it("publishes only after current delegated authorization and a complete explicit scan", async () => {
    const { service, repository, dependencies, job } = fixture();
    await service.start(user, job.id, "delegated");
    await vi.waitFor(() => expect(repository.publish).toHaveBeenCalledTimes(1));
    expect(dependencies.requireAvailable).toHaveBeenCalledWith("graph.package.read.delegated", user);
    expect(repository.markRunning).toHaveBeenCalledBefore(dependencies.scan);
  });

  describe("bounded identity detail refresh", () => {
    const packageValue = (id: string) => allowlistedPackage({ id, displayName: id, isBlocked: false });

    it("completes a 1,010-package identity scan through the real client despite transient detail failures", async () => {
      const listed = Array.from({ length: 1010 }, (_, index) => ({ id: `package-${index}`, displayName: `Agent ${index}`, isBlocked: false }));
      const definition = JSON.stringify({ SourceIds: { EnvironmentId: "environment", CdsBotId: "bot", SchemaName: "agent_schema" } });
      let attempts = 0;
      const fetcher = vi.fn<FetchLike>(async input => {
        const url = new URL(input);
        if (url.pathname.endsWith("/packages")) return Response.json(url.searchParams.has("page")
          ? { value: listed.slice(500) }
          : { value: listed.slice(0, 500), "@odata.nextLink": "https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages?page=2" });
        const id = url.pathname.split("/").at(-1)!;
        if (id === "package-20" && ++attempts <= 2) {
          return Response.json({ error: { code: "InternalServerError", message: "private provider message" } }, { status: attempts === 1 ? 500 : 502 });
        }
        return Response.json({ id, displayName: id, isBlocked: false,
          elementDetails: [{ elementType: "AgentMetadatas", elements: [{ id: "metadata", definition }] }] });
      });
      const retryDelay = vi.fn(async () => undefined);
      const client = new GraphPackagesClient(fetcher, { delay: retryDelay });
      const { service, repository, dependencies, job } = fixture();
      dependencies.scan.mockImplementation((token, ids, signal, progress) => scanPackages(token, ids, signal, progress, client));

      await service.start(user, job.id, "delegated");
      await vi.waitFor(() => expect(repository.publish).toHaveBeenCalledOnce(), { timeout: 5_000 });

      expect(repository.publish).toHaveBeenCalledWith(expect.anything(), job.id, expect.objectContaining({
        totalRecords: 1010, pages: 2, packages: expect.arrayContaining([
          expect.objectContaining({ id: "package-20", identityDetailsCollected: true,
            elementDetails: [{ elementType: "AgentMetadatas", elements: [{ id: "metadata", definition }] }] }),
        ]),
      }));
      expect(repository.recordProgress).toHaveBeenLastCalledWith(expect.anything(), job.id, 2, 1010, 1010,
        "Matching agent records (1010/1010 identities checked).");
      expect(repository.markFailed).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(1014);
      expect(retryDelay.mock.calls).toEqual([[2000, expect.any(AbortSignal)], [4000, expect.any(AbortSignal)]]);
    });

    it.each([400, 424, 500])("retains the old snapshot and sanitized HTTP %i diagnostics when a real detail read fails", async status => {
      const requestId = "22222222-2222-2222-2222-222222222222";
      const providerCode = status === 500 ? "InternalServerError" : status === 424 ? "UnknownError" : "BadRequest";
      const fetcher = vi.fn<FetchLike>(async input => new URL(input).pathname.endsWith("/packages")
        ? Response.json({ value: [{ id: "package", displayName: "Agent", isBlocked: false }] })
        : Response.json({ error: { code: providerCode, message: `${status === 424 ? "Too many requests " : ""}private-token person@example.invalid` } },
          { status, headers: { "request-id": requestId } }));
      const client = new GraphPackagesClient(fetcher, { ...packageInventoryReadPolicy, minimumReadIntervalMs: 0, delay: async () => undefined });
      const { service, repository, dependencies, job } = fixture();
      dependencies.scan.mockImplementation((token, ids, signal, progress) => scanPackages(token, ids, signal, progress, client));
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await service.start(user, job.id, "delegated");
        await vi.waitFor(() => expect(repository.markFailed).toHaveBeenCalledOnce());
        expect(repository.publish).not.toHaveBeenCalled();
        expect(repository.markFailed).toHaveBeenCalledWith(expect.anything(), job.id, `graph_http_${status}`,
          expect.stringContaining(`HTTP ${status}, ${providerCode}`));
        expect(repository.markFailed).toHaveBeenCalledWith(expect.anything(), job.id, `graph_http_${status}`,
          expect.stringContaining(requestId));
        expect(fetcher).toHaveBeenCalledTimes(status === 500 ? 4 : status === 424 ? 7 : 2);
        expect(log.mock.calls.flat().join("\n")).toContain('"event":"package_refresh_failed"');
        expect(log.mock.calls.flat().join("\n")).toContain(`"status":${status}`);
        expect(JSON.stringify([repository.markFailed.mock.calls, log.mock.calls])).not.toMatch(/private-token|person@/);
      } finally { log.mockRestore(); }
    });

    it("collects every listed identity automatically beyond the manual 100-target limit", async () => {
      const listed = Array.from({ length: 105 }, (_, index) => ({ ...packageValue(`package-${index}`), publisher: "Saved publisher" }));
      let active = 0;
      let maximumActive = 0;
      const client = {
        listCopilotAgents: vi.fn(async () => listed),
        getPackageDetails: vi.fn(async (_token: string, id: string) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await Promise.resolve();
          active -= 1;
          if (id === "package-104") throw new AppError(404, "not_found", "Removed after listing");
          return { ...packageValue(id), elementDetails: [{ elementType: "AgentMetadatas", elements: [] }] };
        }),
      };
      const progress = vi.fn(async () => undefined);
      const result = await scanPackages("token", [], new AbortController().signal, progress, client);
      expect(result).toMatchObject({ totalRecords: 104, pages: 1 });
      expect(result.packages.every(value => value.identityDetailsCollected === true && value.publisher === "Saved publisher")).toBe(true);
      expect(result.packages.map(value => value.id)).toEqual(listed.slice(0, 104).map(value => value.id));
      expect(client.getPackageDetails).toHaveBeenCalledTimes(105);
      expect(maximumActive).toBe(4);
      expect(progress).toHaveBeenLastCalledWith(1, 105, 105, "Matching agent records (105/105 identities checked).");
    });

    it("distinguishes a completed detail read with no metadata from a broad summary", async () => {
      const client = {
        listCopilotAgents: vi.fn(async () => [packageValue("one")]),
        getPackageDetails: vi.fn(async () => packageValue("one")),
      };
      const result = await scanPackages("token", [], new AbortController().signal, async () => undefined, client);
      expect(result.packages[0]).toMatchObject({ id: "one", identityDetailsCollected: true });
      expect(result.packages[0].elementDetails).toBeUndefined();
    });

    it("does not advance identity collection after cancellation or a failed detail read", async () => {
      const controller = new AbortController();
      const client = {
        listCopilotAgents: vi.fn(async () => Array.from({ length: 8 }, (_, index) => packageValue(`package-${index}`))),
        getPackageDetails: vi.fn(async (_token: string, id: string) => {
          if (id === "package-1") controller.abort(new AppError(409, "read_job_cancelled", "Cancelled"));
          return packageValue(id);
        }),
      };
      await expect(scanPackages("token", [], controller.signal, async () => undefined, client))
        .rejects.toMatchObject({ code: "read_job_cancelled" });
      expect(client.getPackageDetails).toHaveBeenCalledTimes(4);
      client.getPackageDetails.mockRejectedValue(new AppError(403, "missing_permission", "Denied"));
      await expect(scanPackages("token", [], new AbortController().signal, async () => undefined, client))
        .rejects.toMatchObject({ code: "missing_permission" });
      expect(client.getPackageDetails).toHaveBeenCalledTimes(8);
    });

    it("reads exact details in bounded batches and retains complete deterministic results", async () => {
      let active = 0;
      let maximumActive = 0;
      const client = {
        listCopilotAgents: vi.fn(),
        getPackageDetails: vi.fn(async (_token: string, id: string) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await Promise.resolve();
          active -= 1;
          return packageValue(id);
        }),
      };
      const progress = vi.fn(async () => undefined);
      const ids = Array.from({ length: 9 }, (_, index) => `package-${index}`);
      const result = await scanPackages("token", ids, new AbortController().signal, progress, client);
      expect(result.packages.map(value => value.id)).toEqual(ids);
      expect(result).toMatchObject({ pages: 9, totalRecords: 9 });
      expect(maximumActive).toBe(4);
      expect(progress.mock.calls).toEqual([[4, 4, 4], [8, 8, 8], [9, 9, 9]]);
      expect(client.listCopilotAgents).not.toHaveBeenCalled();
    });

    it("records a missing exact package as absence without substituting another identity", async () => {
      const client = {
        listCopilotAgents: vi.fn(),
        getPackageDetails: vi.fn(async (_token: string, id: string) => {
          if (id === "gone") throw new AppError(404, "not_found", "No longer present");
          return packageValue(id);
        }),
      };
      expect(await scanPackages("token", ["gone", "present"], new AbortController().signal, async () => undefined, client))
        .toMatchObject({ packages: [{ id: "present" }], totalRecords: 1, pages: 2 });
      client.getPackageDetails.mockResolvedValue(packageValue("different"));
      await expect(scanPackages("token", ["requested"], new AbortController().signal, async () => undefined, client))
        .rejects.toMatchObject({ code: "target_mismatch" });
    });

    it("does not publish a partial scan or dispatch the next batch after an error", async () => {
      const client = {
        listCopilotAgents: vi.fn(),
        getPackageDetails: vi.fn(async (_token: string, id: string) => {
          if (id === "bad") throw new AppError(403, "not_authorized", "Denied");
          return packageValue(id);
        }),
      };
      const progress = vi.fn(async () => undefined);
      await expect(scanPackages("token", ["a", "bad", "b", "c", "not-dispatched"], new AbortController().signal, progress, client))
        .rejects.toMatchObject({ code: "not_authorized" });
      expect(client.getPackageDetails).toHaveBeenCalledTimes(4);
      expect(progress).not.toHaveBeenCalled();
    });
  });

  it("keeps application reads independent and requires approved shared scope", async () => {
    const applicationJob = { ...fixture().job, tokenMode: "application" as const };
    const { service, repository, dependencies } = fixture({ getJob: vi.fn(async () => applicationJob) });
    await service.submit(user, { tokenMode: "application", idempotencyKey: "application-read" });
    expect(repository.submit).toHaveBeenCalledWith({ tenantId: user.tenantId, principalId: "application-id" }, expect.objectContaining({ authorizationPrincipalId: user.homeAccountId, tokenMode: "application" }));
    await service.start(user, applicationJob.id, "application");
    await vi.waitFor(() => expect(repository.publish).toHaveBeenCalledTimes(1));
    expect(dependencies.applicationToken).toHaveBeenCalledWith("graph.package.read.application");
    expect(dependencies.delegatedToken).not.toHaveBeenCalled();
    expect(dependencies.requireApplicationDataScope).toHaveBeenCalled();
  });

  it("lets Admin inherit every Viewer package read mode", async () => {
    const admin = { ...user, roles: ["AgentControl.Admin" as const] };
    const direct = fixture();
    await expect(direct.service.submit(admin, { tokenMode: "delegated", idempotencyKey: "broad" })).resolves.toBeDefined();
    await expect(direct.service.submit(admin, { tokenMode: "application", idempotencyKey: "application" })).resolves.toBeDefined();
    await expect(direct.service.submit(admin, { tokenMode: "delegated", idempotencyKey: "exact", requestedIds: ["package-1"] })).resolves.toBeDefined();
  });

  it("lets only the owning Viewer cancel a read refresh", async () => {
    const direct = fixture();
    await expect(direct.service.cancel(user, direct.job.id, "delegated")).resolves.toMatchObject({ status: "cancelled" });
    expect(direct.repository.cancel).toHaveBeenCalledWith({ tenantId: user.tenantId, principalId: user.homeAccountId }, direct.job.id, user.homeAccountId);
    await expect(direct.service.cancel({ ...user, roles: [] }, direct.job.id, "delegated")).rejects.toMatchObject({ code: "missing_internal_role" });
  });

  it("leaves authorization failure waiting without starting the scan", async () => {
    const { service, repository, dependencies, job } = fixture();
    dependencies.delegatedToken.mockRejectedValue(new AppError(401, "interaction_required", "reauthenticate"));
    await expect(service.start(user, job.id, "delegated")).rejects.toMatchObject({ code: "interaction_required" });
    expect(repository.markRunning).not.toHaveBeenCalled();
    expect(dependencies.scan).not.toHaveBeenCalled();
  });

  it("aborts logout work and never publishes after the principal changes", async () => {
    const { service, repository, dependencies, job } = fixture();
    dependencies.scan.mockImplementation((_token, _ids, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
    await service.start(user, job.id, "delegated");
    await service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: user.homeAccountId });
    await service.drain();
    expect(repository.markWaitingAuthorization).toHaveBeenCalledTimes(1);
    expect(repository.publish).not.toHaveBeenCalled();
  });
});