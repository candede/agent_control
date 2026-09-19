import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUnifiedVerification } from "./test/inventoryVerification";
import { ApiError, getUnifiedAgents, type UnifiedAgentInventoryPage } from "./api/client";
import { AgentInventoryQueries } from "./agentInventoryQueries";

vi.mock("./api/client", async importOriginal => ({
  ...await importOriginal<typeof import("./api/client")>(),
  getUnifiedAgents: vi.fn(),
}));

function page(expiresAt = "2026-09-20T12:10:00.000Z"): UnifiedAgentInventoryPage {
  const summary = { total: 0, linked: 0, graphOnly: 0, powerPlatformOnly: 0, ambiguous: 0, conflicting: 0 };
  return {
    revision: "a".repeat(64), value: [], count: 0, offset: 0, limit: 50, summary, filteredSummary: summary,
    verification: createUnifiedVerification({ graphPackageCount: 0, powerPlatformAgentCount: 0, logicalAgentCount: 0 }),
    facets: { environments: [], platforms: [] }, partial: true, errors: [],
    sources: {
      graphPackages: {
        state: "available", error: null,
        observation: {
          id: "snapshot", snapshotId: "snapshot", observedAt: "2026-09-20T12:00:00.000Z", expiresAt,
          current: true, tokenMode: "delegated", scopeKind: "broad", observedCount: 0, totalRecords: 0,
        },
      },
      powerPlatform: {
        state: "unavailable", observation: null,
        error: { source: "power_platform", code: "snapshot_unavailable", message: "Not collected." },
      },
    },
  };
}

describe("AgentInventoryQueries", () => {
  let queries: AgentInventoryQueries;
  const read = vi.mocked(getUnifiedAgents);
  const signal = () => new AbortController().signal;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T12:00:00.000Z"));
    read.mockReset().mockResolvedValue(page());
    queries = new AgentInventoryQueries();
  });
  afterEach(() => {
    queries.clear();
    vi.useRealTimers();
  });

  it("reuses saved reads for 30 seconds while separating filters, sorts and pages", async () => {
    const query = { view: "organization" as const, sortBy: "responses" as const, sortDirection: "desc" as const, offset: 0 };
    await queries.read("tenant:account:viewer:1", query, signal());
    await queries.read("tenant:account:viewer:1", { ...query }, signal());
    expect(read).toHaveBeenCalledTimes(1);
    await queries.read("tenant:account:viewer:1", { ...query, offset: 50 }, signal());
    await queries.read("tenant:account:viewer:1", { ...query, view: "all" }, signal());
    await queries.read("tenant:account:viewer:1", { ...query, sortBy: "hosts" }, signal());
    expect(read).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(30_001);
    await queries.read("tenant:account:viewer:1", query, signal());
    expect(read).toHaveBeenCalledTimes(5);
  });

  it("does not reuse private data across tenants, accounts, roles or revalidated sessions", async () => {
    for (const owner of ["tenant-a:user-a:viewer:1", "tenant-b:user-a:viewer:1", "tenant-a:user-b:viewer:1", "tenant-a:user-a:admin:1", "tenant-a:user-a:viewer:2"]) {
      await queries.read(owner, {}, signal());
    }
    expect(read).toHaveBeenCalledTimes(5);
    queries.clear();
    await queries.read("tenant-a:user-a:viewer:1", {}, signal());
    expect(read).toHaveBeenCalledTimes(6);
  });

  it("never extends a saved source or selected report expiration", async () => {
    read.mockResolvedValueOnce(page("2026-09-20T12:00:05.000Z"));
    await queries.read("owner", {}, signal());
    vi.advanceTimersByTime(5_001);
    await queries.read("owner", {}, signal());
    expect(read).toHaveBeenCalledTimes(2);

    const usagePage = page();
    usagePage.usageContext = {
      revision: "usage", lineages: [], availability: "active",
      reportSet: {
        id: "report", bundleId: "bundle", complete: true, kinds: ["agents", "userAgents", "users"],
        reportingPeriod: { startDate: null, endDate: null, provenance: "activity_range" },
        supersedesSetId: null, acceptedAt: null, deletedAt: null, createdAt: "2026-09-20T12:00:00.000Z",
        expiresAt: "2026-09-20T12:00:10.000Z",
      },
    };
    queries.clear();
    read.mockResolvedValueOnce(usagePage);
    await queries.read("owner", {}, signal());
    vi.advanceTimersByTime(5_000);
    await queries.read("owner", {}, signal());
    expect(read).toHaveBeenCalledTimes(4);
    queries.clear();
    read.mockResolvedValueOnce({
      ...usagePage, usageContext: { ...usagePage.usageContext, reportSet: { ...usagePage.usageContext.reportSet!, expiresAt: null }, expiresAt: "2026-09-20T12:00:15.000Z" },
    });
    await queries.read("owner", {}, signal());
    vi.advanceTimersByTime(5_000);
    await queries.read("owner", {}, signal());
    expect(read).toHaveBeenCalledTimes(6);
  });

  it("cancels provider reads on navigation and on private cache disposal", async () => {
    let providerSignal: AbortSignal | undefined;
    read.mockImplementation((_query, options) => new Promise((_resolve, reject) => {
      providerSignal = options?.signal;
      providerSignal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
    }));
    const controller = new AbortController();
    const cancelled = expect(queries.read("owner", {}, controller.signal)).rejects.toMatchObject({ code: "request_aborted" });
    controller.abort();
    await cancelled;
    expect(providerSignal?.aborted).toBe(true);

    const disposed = expect(queries.read("owner", {}, signal())).rejects.toMatchObject({ code: "request_aborted" });
    queries.clear();
    await disposed;
    expect(providerSignal?.aborted).toBe(true);
  });

  it("surfaces failed refreshes without retries or stale success-shaped fallback", async () => {
    await queries.read("owner", {}, signal());
    vi.advanceTimersByTime(30_001);
    read.mockRejectedValueOnce(new ApiError(503, "database_unavailable", "Saved inventory is unavailable."));
    await expect(queries.read("owner", {}, signal())).rejects.toMatchObject({ code: "database_unavailable" });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed expiration evidence instead of caching it indefinitely", async () => {
    read.mockResolvedValueOnce(page("invalid"));
    await expect(queries.read("owner", {}, signal())).rejects.toMatchObject({ code: "invalid_inventory_expiry" });
    expect(read).toHaveBeenCalledTimes(1);
  });
});
