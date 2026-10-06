import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUnifiedVerification, inventoryPageMetadata } from "./test/inventoryVerification";
import { ApiError, getUnifiedAgents, type UnifiedAgentInventoryPage, type UnifiedAgentRecord } from "./api/client";
import { AgentInventoryQueries } from "./agentInventoryQueries";
import { reports } from "./test/reportDataFixture";

vi.mock("./api/client", async importOriginal => ({
  ...await importOriginal<typeof import("./api/client")>(),
  getUnifiedAgents: vi.fn(),
}));

function page(expiresAt = "2026-09-20T12:10:00.000Z"): UnifiedAgentInventoryPage {
  const summary = { total: 0, linked: 0, graphOnly: 0, powerPlatformOnly: 0, ambiguous: 0, conflicting: 0 };
  return {
    ...inventoryPageMetadata(undefined, expiresAt),
    inventoryScope: "all", scopeSummary: summary,
    value: [], summary, filteredSummary: summary,
    verification: createUnifiedVerification({ graphPackageCount: 0, powerPlatformAgentCount: 0, logicalAgentCount: 0 }),
    partial: true, errors: [],
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

function pageWithPeople(people: UnifiedAgentRecord["people"]): UnifiedAgentInventoryPage {
  return {
    ...page(),
    value: [{
      id: "agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", displayName: "Saved agent",
      presence: "power_platform", environmentId: null, packages: [], powerPlatformResource: null,
      identity: { state: "unmatched", reason: null, evidence: [], packageEvidence: [] },
      observations: { graphPackages: null, powerPlatform: null, packageSnapshots: {} },
      people,
    }],
    counts: { total: 1, scoped: 1, filtered: 1, packageTargets: 0 },
  };
}

function pageWithEnvironment(expiresAt: string): UnifiedAgentInventoryPage {
  const result = pageWithPeople(undefined);
  result.value[0].environmentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  result.value[0].environment = {
    id: result.value[0].environmentId, displayName: "Saved environment", region: null,
    environmentType: null, isManaged: null, groupName: null, groupId: null, provenance: {},
    observation: {
      id: "environment-snapshot", snapshotId: "environment-snapshot", current: true,
      observedAt: "2026-09-20T11:00:00.000Z", expiresAt,
    },
  };
  return result;
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
    const query = { view: "organization" as const, sortBy: "responses" as const, sortDirection: "desc" as const };
    await queries.read("tenant:account:viewer:1", query, signal());
    await queries.read("tenant:account:viewer:1", { ...query }, signal());
    expect(read).toHaveBeenCalledTimes(1);
    await queries.read("tenant:account:viewer:1", { ...query, selectionId: page().selection.id, cursor: "next-page" }, signal());
    await queries.read("tenant:account:viewer:1", { ...query, view: "all" }, signal());
    await queries.read("tenant:account:viewer:1", { ...query, sortBy: "hosts" }, signal());
    expect(read).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(30_001);
    await queries.read("tenant:account:viewer:1", query, signal());
    expect(read).toHaveBeenCalledTimes(5);
  });

  it("reuses the first page under its pinned selection without a duplicate read", async () => {
    const query = { inventoryScope: "catalog" as const, limit: 50 };
    const first = await queries.read("owner", query, signal());
    if ("state" in first) throw new Error("Expected inventory");
    const pinned = { ...query, selectionId: first.selection.id };
    expect(queries.getCached("owner", pinned)).toBe(first);
    expect(await queries.read("owner", pinned, signal())).toBe(first);
    expect(read).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(30_001);
    expect(queries.getCached("owner", pinned)).toBeUndefined();
    await queries.read("owner", pinned, signal());
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not return a recaptured selection under the old pinned request key", async () => {
    const original = page();
    const refreshed = { ...page(), selection: { ...page().selection, id: "new-selection" } };
    read.mockResolvedValueOnce(original).mockResolvedValueOnce(refreshed);
    const pinned = { selectionId: original.selection.id };
    await queries.read("owner", pinned, signal());
    vi.advanceTimersByTime(30_001);
    await expect(queries.read("owner", {}, signal())).resolves.toBe(refreshed);

    expect(queries.getCached("owner", pinned)).toBeUndefined();
    const cached = queries.getCached("owner", {});
    expect(cached).toEqual(refreshed);
    expect(queries.getCached("owner", { selectionId: refreshed.selection.id })).toBe(cached);
    read.mockResolvedValueOnce(original);
    await expect(queries.read("owner", pinned, signal())).resolves.toBe(original);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("does not let a cached read restore a replaced selection family", async () => {
    const original = page();
    const replacement = { ...page(), selection: { ...page().selection, id: "replacement-selection" } };
    read.mockResolvedValueOnce(original).mockResolvedValueOnce(replacement);
    const pinned = { selectionId: original.selection.id };
    await queries.read("owner", pinned, signal());

    const superseded = expect(queries.read("owner", pinned, signal())).rejects.toMatchObject({
      code: "request_aborted", kind: "aborted",
    });
    const current = expect(queries.read("owner", { selectionId: replacement.selection.id }, signal())).resolves.toBe(replacement);
    await Promise.all([superseded, current]);
    expect(queries.getCached("owner", {})).toBe(replacement);
    expect(queries.getCached("owner", pinned)).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not let an old family's abort cancel a re-admitted read of the same selection", async () => {
    read.mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementationOnce(() => new Promise(() => {}));
    const original = new AbortController();
    const pinned = { selectionId: page().selection.id };
    const superseded = expect(queries.read("owner", pinned, original.signal)).rejects.toMatchObject({
      code: "request_aborted",
    });
    const replaced = expect(queries.read("owner", { selectionId: "replacement-selection" }, signal())).rejects.toMatchObject({
      code: "request_aborted",
    });
    const current = expect(queries.read("owner", pinned, signal())).resolves.toEqual(page());
    original.abort();

    await Promise.all([superseded, replaced, current]);
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls[2][1]?.signal?.aborted).toBe(false);
    expect(queries.getCached("owner", pinned)).toEqual(page());
  });

  it("cancels an unfinished capture when an explicit selection replaces its family", async () => {
    read.mockImplementationOnce(() => new Promise(() => {}));
    const capturing = expect(queries.read("owner", {}, signal())).rejects.toMatchObject({
      code: "request_aborted",
    });
    const pinned = { selectionId: page().selection.id };
    const current = expect(queries.read("owner", pinned, signal())).resolves.toEqual(page());

    await Promise.all([capturing, current]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(read.mock.calls[1][1]?.signal?.aborted).toBe(false);
    expect(queries.getCached("owner", pinned)).toEqual(page());
  });

  it("keeps recent catalog and Power Platform families with their own filters and selection pins", async () => {
    read.mockImplementation(async query => ({
      ...page(), inventoryScope: query?.inventoryScope ?? "catalog",
      selection: { ...page().selection, id: `${query?.inventoryScope}:${query?.search ?? ""}` },
    }));
    const catalog = { inventoryScope: "catalog" as const, limit: 50 };
    const platform = { inventoryScope: "power_platform_only" as const, limit: 50 };
    const first = await queries.read("owner", catalog, signal());
    const second = await queries.read("owner", platform, signal());
    await queries.read("owner", { ...catalog, search: "filtered" }, signal());
    expect(queries.getCached("owner", catalog)).toBe(first);
    expect(queries.getCached("owner", platform)).toBe(second);
    expect(await queries.read("owner", catalog, signal())).toBe(first);
    expect(await queries.read("owner", platform, signal())).toBe(second);
    expect(read).toHaveBeenCalledTimes(3);
    queries.clear();
    expect(queries.getCached("owner", catalog)).toBeUndefined();
    expect(queries.getCached("other-owner", platform)).toBeUndefined();
    await queries.read("owner", catalog, signal());
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("bounds retained inventory families and evicts the least recently used family", async () => {
    for (let index = 0; index < 4; index++) await queries.read("owner", { search: String(index) }, signal());
    await queries.read("owner", { search: "0" }, signal());
    await queries.read("owner", { search: "4" }, signal());
    expect(read).toHaveBeenCalledTimes(5);
    expect(queries.getCached("owner", { search: "0" })).toBeDefined();
    expect(queries.getCached("owner", { search: "1" })).toBeUndefined();
    await queries.read("owner", { search: "1" }, signal());
    expect(read).toHaveBeenCalledTimes(6);
  });

  it("does not recreate an evicted family while an expired read awaits invalidation", async () => {
    read.mockResolvedValueOnce(page("2026-09-20T12:00:05.000Z"));
    await queries.read("owner", { search: "expired" }, signal());
    vi.advanceTimersByTime(5_000);

    const evicted = expect(queries.read("owner", { search: "expired" }, signal())).rejects.toMatchObject({
      code: "request_aborted", kind: "aborted",
    });
    await Promise.all([evicted, ...Array.from({ length: 4 }, (_, index) =>
      queries.read("owner", { search: String(index) }, signal()))]);
    expect(read).toHaveBeenCalledTimes(5);
    expect(queries.getCached("owner", { search: "expired" })).toBeUndefined();
    for (let index = 0; index < 4; index++) {
      expect(queries.getCached("owner", { search: String(index) })).toBeDefined();
    }
  });

  it("clears every retained family on access denial", async () => {
    await queries.read("owner", { inventoryScope: "catalog" }, signal());
    await queries.read("owner", { inventoryScope: "power_platform_only" }, signal());
    read.mockRejectedValueOnce(new ApiError(403, "forbidden", "Access denied."));
    await expect(queries.read("owner", { search: "new" }, signal())).rejects.toMatchObject({ status: 403 });
    expect(queries.getCached("owner", { inventoryScope: "catalog" })).toBeUndefined();
    expect(queries.getCached("owner", { inventoryScope: "power_platform_only" })).toBeUndefined();
  });

  it.each(["not_collected", "preparing"] as const)("does not pin or retain a %s result as an empty inventory", async state => {
    const unavailable = { state, message: "Waiting for inventory." };
    read.mockResolvedValueOnce(unavailable);
    await expect(queries.read("owner", {}, signal())).resolves.toEqual(unavailable);
    await expect(queries.read("owner", {}, signal())).resolves.toEqual(page());
    expect(read).toHaveBeenCalledTimes(2);
    await queries.read("owner", {}, signal());
    expect(read).toHaveBeenCalledTimes(2);
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
  it.each([false, true])("acceptance: optional identity current=%s controls active expiry, not retained stale evidence", async current => {
    const result = pageWithPeople(undefined);
    const expiresAt = current ? "2026-09-20T12:00:05.000Z" : "2026-09-20T11:59:00.000Z";
    result.value[0].observations.packageSnapshots.aging = {
      id: "catalog", snapshotId: "catalog", scopeKind: "broad", current: true,
      observedAt: "2026-09-20T11:00:00.000Z", expiresAt: result.selection.expiresAt,
      identityDetails: { id: "detail", snapshotId: "detail", current, observedAt: "2026-09-20T11:00:00.000Z", expiresAt },
    };
    read.mockResolvedValue(result);
    await expect(queries.read("owner", {}, signal())).resolves.toEqual(result);
    if (current) {
      vi.advanceTimersByTime(5_001);
      await expect(queries.read("owner", {}, signal())).rejects.toMatchObject({ code: "inventory_changed" });
    }
  });
  it.each(["fresh", "stale"] as const)("acceptance: optional package/access detail %s evidence has the same active expiry rules", async state => {
    const result = pageWithPeople(undefined);
    result.value[0].packages = [{ id: "access", displayName: "Access details", isBlocked: false,
      sourceSystem: "graph_packages", authoringTool: null, creatorType: "unknown", agentKind: "copilot_package",
      lifecycle: "unknown", identityConfidence: "exact_native", provenance: {},
      detailFreshness: { state, observedAt: "2026-09-20T11:00:00.000Z",
        expiresAt: state === "fresh" ? "2026-09-20T12:00:05.000Z" : "2026-09-20T11:59:00.000Z" },
      availableTo: "none", deployedTo: "none" }];
    read.mockResolvedValue(result);
    await expect(queries.read("owner", {}, signal())).resolves.toEqual(result);
    if (state === "fresh") {
      vi.advanceTimersByTime(5_001);
      await expect(queries.read("owner", {}, signal())).rejects.toMatchObject({ code: "inventory_changed" });
    }
  });

  it("retains only the current and directly adjacent pinned pages, including reverse-cursor aliases", async () => {
    read.mockImplementation(async query => {
      const number = Number(query?.cursor?.split("-").at(-1) ?? 0);
      return { ...page(), page: { limit: 50, previousCursor: number ? `back-${number - 1}` : null, nextCursor: `forward-${number + 1}` } };
    });
    const selected = page().selection.id;
    for (let number = 0; number <= 4; number++) {
      await queries.read("owner", { selectionId: selected, ...(number ? { cursor: `forward-${number}` } : {}) }, signal());
    }
    expect(read).toHaveBeenCalledTimes(5);
    await queries.read("owner", { selectionId: selected, cursor: "forward-3" }, signal());
    await queries.read("owner", { selectionId: selected, cursor: "forward-4" }, signal());
    expect(read).toHaveBeenCalledTimes(5);
    await queries.read("owner", { selectionId: selected, cursor: "back-3" }, signal());
    expect(read).toHaveBeenCalledTimes(6);
    await queries.read("owner", { selectionId: selected, cursor: "forward-4" }, signal());
    expect(read).toHaveBeenCalledTimes(6);
    await queries.read("owner", { selectionId: selected, cursor: "forward-2" }, signal());
    expect(read).toHaveBeenCalledTimes(7);
    await queries.read("owner", { selectionId: selected, publisher: "different-filter" }, signal());
    await queries.read("owner", { selectionId: selected, cursor: "forward-2" }, signal());
    expect(read).toHaveBeenCalledTimes(8);
  });

  it("separates quick-view and independent evidence filters in the saved query cache", async () => {
    const base = { view: "third_party" as const };
    await queries.read("owner", base, signal());
    for (const filters of [
      { endUserAccess: "available" as const }, { reportedUsage: "used" as const },
      { management: "organization_managed" as const }, { relevance: "unknown" as const },
      { endUserAccess: "available" as const, reportedUsage: "used" as const, management: "organization_managed" as const },
    ]) {
      await queries.read("owner", { ...base, ...filters }, signal());
      await queries.read("owner", { ...base, ...filters }, signal());
    }
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
      revision: "usage", expiresAt: null, reports: { ...reports, expiresAt: "2026-09-20T12:00:10.000Z" },
    };
    queries.clear();
    read.mockResolvedValueOnce(usagePage);
    await queries.read("owner", {}, signal());
    vi.advanceTimersByTime(5_000);
    await queries.read("owner", {}, signal());
    expect(read).toHaveBeenCalledTimes(4);
    queries.clear();
    read.mockResolvedValueOnce({
      ...usagePage, usageContext: { ...usagePage.usageContext, reports: { ...reports, expiresAt: null }, expiresAt: "2026-09-20T12:00:15.000Z" },
    });
    await queries.read("owner", {}, signal());
    vi.advanceTimersByTime(5_000);
    await queries.read("owner", {}, signal());
    expect(read).toHaveBeenCalledTimes(6);
  });

  it.each(["source", "usage"] as const)("rejects a response whose %s evidence expires in flight instead of caching it", async source => {
    const expiresAt = "2026-09-20T12:00:05.000Z";
    const expiring: UnifiedAgentInventoryPage = source === "source" ? page(expiresAt) : {
      ...page(),
      usageContext: { revision: "usage", reports: { ...reports, expiresAt: null }, expiresAt },
    };
    read.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(expiresAt));
      return expiring;
    });

    await expect(queries.read("owner", {}, signal())).rejects.toMatchObject({ code: "inventory_changed" });
    await expect(queries.read("owner", {}, signal())).resolves.toMatchObject({ selection: { revision: "1" } });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("rejects a cache hit that expires before the async read completes", async () => {
    read.mockResolvedValueOnce(page("2026-09-20T12:00:05.000Z"));
    await queries.read("owner", {}, signal());
    vi.advanceTimersByTime(4_999);

    const expired = expect(queries.read("owner", {}, signal())).rejects.toMatchObject({
      status: 409, code: "inventory_changed",
    });
    vi.advanceTimersByTime(1);
    await expired;
    expect(read).toHaveBeenCalledOnce();
    expect(queries.getCached("owner", {})).toBeUndefined();
    await expect(queries.read("owner", {}, signal())).resolves.toEqual(page());
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("expires cached environment context independently of the agent source snapshots", async () => {
    const environmentPage = pageWithEnvironment("2026-09-20T12:00:05.000Z");
    read.mockResolvedValueOnce(environmentPage);
    await expect(queries.read("owner", {}, signal())).resolves.toBe(environmentPage);
    vi.advanceTimersByTime(4_999);
    await expect(queries.read("owner", {}, signal())).resolves.toBe(environmentPage);
    expect(read).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await expect(queries.read("owner", {}, signal())).resolves.toMatchObject({ value: [] });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("expires an empty filtered page when its off-page context deadline is reached", async () => {
    const filteredPage = { ...page(), selection: { ...page().selection, expiresAt: "2026-09-20T12:00:05.000Z" } };
    read.mockResolvedValueOnce(filteredPage);
    await expect(queries.read("owner", { search: "no results" }, signal())).resolves.toBe(filteredPage);
    vi.advanceTimersByTime(5_000);
    await expect(queries.read("owner", { search: "no results" }, signal())).resolves.toMatchObject({
      selection: { expiresAt: "2026-09-20T12:10:00.000Z" },
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["2026-09-20T12:00:00.000Z", "inventory_changed"],
    ["invalid", "invalid_inventory_expiry"],
  ])("rejects a page-level deadline of %s", async (expiresAt, code) => {
    read.mockResolvedValueOnce({ ...page(), selection: { ...page().selection, expiresAt } });
    await expect(queries.read("owner", {}, signal())).rejects.toMatchObject({ code });
    await expect(queries.read("owner", {}, signal())).resolves.toMatchObject({ value: [] });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("rejects environment context that expires in flight instead of caching it", async () => {
    const expiresAt = "2026-09-20T12:00:05.000Z";
    read.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(expiresAt));
      return pageWithEnvironment(expiresAt);
    });
    await expect(queries.read("owner", {}, signal())).rejects.toMatchObject({ code: "inventory_changed" });
    await expect(queries.read("owner", {}, signal())).resolves.toMatchObject({ value: [] });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed environment expiry instead of extending saved context", async () => {
    read.mockResolvedValueOnce(pageWithEnvironment("invalid"));
    await expect(queries.read("owner", {}, signal())).rejects.toMatchObject({ code: "invalid_inventory_expiry" });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["owner", "resolved"],
    ["createdBy", "not_found"],
    ["lastModifiedBy", "lookup_failed"],
  ] as const)("expires the cached page at the %s %s person boundary", async (field, status) => {
    const peoplePage = pageWithPeople({
      [field]: {
        objectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        displayName: status === "resolved" ? "Saved person" : null,
        userPrincipalName: null, observedAt: "2026-09-20T11:00:00.000Z", status,
        expiresAt: "2026-09-20T12:00:05.000Z",
      },
    });
    read.mockResolvedValueOnce(peoplePage);
    await expect(queries.read("owner", {}, signal())).resolves.toBe(peoplePage);
    vi.advanceTimersByTime(4_999);
    await expect(queries.read("owner", {}, signal())).resolves.toBe(peoplePage);
    expect(read).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await expect(queries.read("owner", {}, signal())).resolves.toMatchObject({ value: [] });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("retains the ordinary cache window for legacy people without expiry", async () => {
    const peoplePage = pageWithPeople({ owner: {
      objectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      displayName: "Legacy person", userPrincipalName: "legacy@example.invalid",
      observedAt: "2026-09-20T11:00:00.000Z",
    } });
    read.mockResolvedValueOnce(peoplePage);
    await queries.read("owner", {}, signal());
    vi.advanceTimersByTime(29_999);
    await expect(queries.read("owner", {}, signal())).resolves.toBe(peoplePage);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed person expiry rather than extending stale name evidence", async () => {
    read.mockResolvedValueOnce(pageWithPeople({ owner: {
      objectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      displayName: "Saved person", userPrincipalName: null,
      observedAt: "2026-09-20T11:00:00.000Z", expiresAt: "invalid",
    } }));
    await expect(queries.read("owner", {}, signal())).rejects.toMatchObject({ code: "invalid_inventory_expiry" });
    expect(read).toHaveBeenCalledTimes(1);
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
