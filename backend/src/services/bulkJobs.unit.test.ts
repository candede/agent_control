import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { packageMutationStateHash } from "./packageMutationState.js";

vi.mock("../db/sessions.js", () => ({
  beginAccountSessionValidation: vi.fn(() => 1),
  commitAccountSessionValidation: vi.fn(async (_validation, operation: () => Promise<unknown>) => operation()),
}));
vi.mock("./maintenance.js", () => ({ maintenanceActive: vi.fn(() => false) }));
vi.mock("./operationalState.js", () => ({ requireProviderAdmissions: vi.fn() }));

import { runBulkJob } from "./bulkJobs.js";
import { GraphPackagesClient, type FetchLike } from "./graphPackages.js";
import { requireProviderAdmissions } from "./operationalState.js";

const scope = { tenantId: "tenant", principalId: "principal" };
const prestate = { kind: "block" as const, isBlocked: false };

function fakeRepository() {
  const lease = { jobId: "job", scope, owner: "worker", version: 1 };
  let begun = false;
  return {
    get: vi.fn(async () => ({
      id: "job",
      tokenMode: "delegated" as const,
      capabilityId: "graph.package.block.manage" as const,
    })),
    waitForAuthorization: vi.fn(async () => undefined),
    claim: vi.fn(async () => lease),
    pauseForAuthorization: vi.fn(async () => undefined),
    beginItem: vi.fn(async () => {
      if (begun) return undefined;
      begun = true;
      return {
        item: {
          id: "item",
          target_id: "package",
          correlation_id: "11111111-1111-4111-8111-111111111111",
          prestate_hash: packageMutationStateHash(prestate),
        },
        job: {
          action: "block" as const,
          capability: "graph.package.block.manage" as const,
          access_update: null,
        },
        inventoryGeneration: null,
      };
    }),
    withTargetLock: vi.fn(async (_lease, _item, operation: () => Promise<unknown>) => operation()),
    markSent: vi.fn(async () => undefined),
    finishItem: vi.fn(async () => undefined),
    pauseItemForAuthorization: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  } satisfies Parameters<typeof runBulkJob>[3];
}

function provider(fetcher: FetchLike) {
  return new GraphPackagesClient(fetcher, { maxAttempts: 1, delay: async () => undefined });
}

describe("bulk job execution boundaries", () => {
  it("pauses unsent work when provider admission closes during the pre-read", async () => {
    let admitted = true;
    vi.mocked(requireProviderAdmissions).mockImplementation(() => {
      if (!admitted) throw new AppError(503, "provider_requalification_required", "Provider work is disabled.");
    });
    const repository = fakeRepository();
    const fetcher = vi.fn<FetchLike>(async () => {
      admitted = false;
      return Response.json({ id: "package", displayName: "Package", isBlocked: false });
    });

    await runBulkJob("job", scope, false, repository, provider(fetcher), async () => "token");

    expect(repository.pauseItemForAuthorization).toHaveBeenCalledWith(expect.anything(), "item");
    expect(repository.markSent).not.toHaveBeenCalled();
    expect(repository.finishItem).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("keeps a sent write inconclusive when admission closes before readback", async () => {
    let admitted = true;
    vi.mocked(requireProviderAdmissions).mockImplementation(() => {
      if (!admitted) throw new AppError(503, "provider_requalification_required", "Provider work is disabled.");
    });
    const repository = fakeRepository();
    const fetcher = vi.fn<FetchLike>(async (_url, request) => {
      if (request?.method === "POST") {
        admitted = false;
        return new Response(null, { status: 204 });
      }
      return Response.json({ id: "package", displayName: "Package", isBlocked: false });
    });

    await runBulkJob("job", scope, false, repository, provider(fetcher), async () => "token");

    expect(repository.markSent).toHaveBeenCalledOnce();
    expect(repository.finishItem).toHaveBeenCalledWith(
      expect.anything(),
      "item",
      "inconclusive",
      expect.objectContaining({ errorCode: "provider_requalification_required" }),
    );
    expect(fetcher.mock.calls.filter(([, request]) => request?.method === "POST")).toHaveLength(1);
  });

  it("records a controlled shutdown before dispatch as cancellation", async () => {
    vi.mocked(requireProviderAdmissions).mockImplementation(() => undefined);
    const repository = fakeRepository();
    const controller = new AbortController();
    const stopped = new AppError(503, "shutdown", "Application shutdown stopped package work.");
    const fetcher = vi.fn<FetchLike>(async () => {
      controller.abort(stopped);
      return Response.json({ id: "package", displayName: "Package", isBlocked: false });
    });

    await runBulkJob("job", scope, false, repository, provider(fetcher), async () => "token", controller.signal);

    expect(repository.markSent).not.toHaveBeenCalled();
    expect(repository.finishItem).toHaveBeenCalledWith(
      expect.anything(),
      "item",
      "cancelled",
      expect.objectContaining({ errorCode: "shutdown" }),
    );
  });

  it("persists the bounded item deadline as a provider timeout", async () => {
    vi.mocked(requireProviderAdmissions).mockImplementation(() => undefined);
    const repository = fakeRepository();
    const fetcher = vi.fn<FetchLike>(async () => {
      throw new DOMException("The item execution deadline expired.", "TimeoutError");
    });

    await runBulkJob("job", scope, false, repository, provider(fetcher), async () => "token");

    expect(repository.finishItem).toHaveBeenCalledWith(
      expect.anything(),
      "item",
      "failed",
      expect.objectContaining({ errorCode: "provider_timeout" }),
    );
    expect(repository.pauseItemForAuthorization).not.toHaveBeenCalled();
  });
});
