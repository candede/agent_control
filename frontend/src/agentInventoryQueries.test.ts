import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUnifiedVerification, inventoryPageMetadata } from "./test/inventoryVerification";
import { ApiError, getUnifiedAgents, type UnifiedAgentInventoryPage, type UnifiedAgentRecord } from "./api/client";
import { AgentInventoryQueries } from "./agentInventoryQueries";
import { reports } from "./test/reportDataFixture";

vi.mock("./api/client", async importOriginal => ({
  ...await importOriginal<typeof import("./api/client")>(),
  getUnifiedAgents: vi.fn(),
}));

function page(expiresAt = "2026-09-20T12:10:00.000Z",
  selection?: Partial<Omit<UnifiedAgentInventoryPage["selection"], "expiresAt">>): UnifiedAgentInventoryPage {
  const summary = { total: 0, linked: 0, graphOnly: 0, powerPlatformOnly: 0, ambiguous: 0, conflicting: 0 };
  return {
    ...inventoryPageMetadata(undefined, expiresAt, selection),
    inventoryScope: "all", scopeSummary: summary,
    value: [], summary, filteredSummary: summary,
    verification: createUnifiedVerification({ graphPackageCount: 0, powerPlatformAgentCount: 0, logicalAgentCount: 0 }, { sourceScopes: false }),
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

function deferredPage() {
  let resolve!: (value: UnifiedAgentInventoryPage) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<UnifiedAgentInventoryPage>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
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

  it("shares concurrent reads without one caller cancelling the remaining reader", async () => {
    const response = deferredPage();
    read.mockReturnValueOnce(response.promise);
    const controller = new AbortController();
    const cancelled = expect(queries.read("owner", {}, controller.signal)).rejects.toMatchObject({
      code: "request_aborted", kind: "aborted",
    });
    const current = expect(queries.read("owner", {}, signal())).resolves.toEqual(page());

    controller.abort();
    await cancelled;
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0][1]?.signal?.aborted).toBe(false);
    response.resolve(page());
    await current;
    expect(queries.getCached("owner", {})).toEqual(page());
  });

  it("aborts a shared transport only after its last caller cancels and allows a new read", async () => {
    read.mockImplementationOnce(() => new Promise(() => {}));
    const first = new AbortController();
    const second = new AbortController();
    const cancelled = [first, second].map(controller =>
      expect(queries.read("owner", {}, controller.signal)).rejects.toMatchObject({ code: "request_aborted" }));
    first.abort();
    expect(read.mock.calls[0][1]?.signal?.aborted).toBe(false);
    second.abort();
    expect(read.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await expect(queries.read("owner", {}, signal())).resolves.toEqual(page());
    await Promise.all(cancelled);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each(["not_collected", "preparing", "unavailable"] as const)("shares a %s outcome with every concurrent reader without caching it", async state => {
    const unavailable = { state, message: "Waiting for inventory." };
    read.mockResolvedValueOnce(unavailable);
    await expect(Promise.all([
      queries.read("owner", {}, signal()),
      queries.read("owner", {}, signal()),
    ])).resolves.toEqual([unavailable, unavailable]);
    expect(read).toHaveBeenCalledOnce();
    expect(queries.getCached("owner", {})).toBeUndefined();
    await expect(queries.read("owner", {}, signal())).resolves.toEqual(page());
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each([
    [401, "unauthorized"], [403, "forbidden"], [409, "selection_invalidated"], [409, "inventory_changed"],
  ] as const)("shares a %s %s error with every concurrent reader", async (status, code) => {
    read.mockRejectedValueOnce(new ApiError(status, code, "Saved inventory is no longer available."));
    const denied = [0, 1].map(() =>
      expect(queries.read("owner", {}, signal())).rejects.toMatchObject({ status, code }));
    await Promise.all(denied);
    expect(read).toHaveBeenCalledOnce();
    expect(queries.getCached("owner", {})).toBeUndefined();
  });

  it.each(["success", "access denial"] as const)("ignores a late shared %s after the principal changes", async outcome => {
    const response = deferredPage();
    const currentPage = page("2026-09-20T12:05:00.000Z", { id: "current-account-selection", revision: "2" });
    read.mockReturnValueOnce(response.promise).mockResolvedValueOnce(currentPage);
    const cancelled = [0, 1].map(() =>
      expect(queries.read("old-owner", {}, signal())).rejects.toMatchObject({ code: "request_aborted" }));

    await expect(queries.read("current-owner", {}, signal())).resolves.toEqual(currentPage);
    await Promise.all(cancelled);
    expect(read.mock.calls[0][1]?.signal?.aborted).toBe(true);
    if (outcome === "success") response.resolve(page());
    else response.reject(new ApiError(403, "forbidden", "Previous account denied."));
    await Promise.resolve();
    expect(queries.getCached("old-owner", {})).toBeUndefined();
    expect(queries.getCached("current-owner", {})).toEqual(currentPage);
    await expect(queries.read("current-owner", {}, signal())).resolves.toEqual(currentPage);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("cancels every shared reader on selection invalidation without reviving it from a late response", async () => {
    const response = deferredPage();
    const pinned = { selectionId: page().selection.id };
    read.mockReturnValueOnce(response.promise);
    const cancelled = [0, 1].map(() =>
      expect(queries.read("owner", pinned, signal())).rejects.toMatchObject({ code: "request_aborted" }));
    queries.invalidateSelection(pinned.selectionId);
    await Promise.all(cancelled);
    expect(read.mock.calls[0][1]?.signal?.aborted).toBe(true);
    response.resolve(page());
    await Promise.resolve();
    expect(queries.getCached("owner", pinned)).toBeUndefined();
    await expect(queries.read("owner", pinned, signal())).resolves.toEqual(page());
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not let an already-cancelled read change the cache owner", async () => {
    await queries.read("current-owner", {}, signal());
    const controller = new AbortController();
    controller.abort();
    await expect(queries.read("old-owner", {}, controller.signal)).rejects.toMatchObject({ code: "request_aborted" });
    expect(queries.getCached("current-owner", {})).toEqual(page());
    expect(read).toHaveBeenCalledOnce();
  });

  it("does not join an old pinned selection to an unfinished recapture", async () => {
    const original = page();
    const revalidated = { ...original, selection: { ...original.selection, validatedAt: new Date(Date.now() + 30_001).toISOString() } };
    const recaptured = page(undefined, { id: "recaptured-selection", revision: "2" });
    const response = deferredPage();
    read.mockResolvedValueOnce(original).mockReturnValueOnce(response.promise).mockResolvedValueOnce(revalidated);
    const pinned = { selectionId: original.selection.id };
    await queries.read("owner", pinned, signal());
    vi.advanceTimersByTime(30_001);

    const superseded = expect(queries.read("owner", {}, signal())).rejects.toMatchObject({ code: "request_aborted" });
    await Promise.resolve();
    const current = expect(queries.read("owner", pinned, signal())).resolves.toEqual(revalidated);
    response.resolve(recaptured);
    await Promise.all([superseded, current]);
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls[1][1]?.signal?.aborted).toBe(true);
    expect(queries.getCached("owner", pinned)).toEqual(revalidated);
    expect(queries.getCached("owner", { selectionId: recaptured.selection.id })).toBeUndefined();
  });

  it("does not evict a pending adjacent page when the current page is read again", async () => {
    const first = { ...page(), page: { limit: 50, previousCursor: null, nextCursor: "next" } };
    const next = { ...page(), page: { limit: 50, previousCursor: "back", nextCursor: null } };
    const response = deferredPage();
    read.mockResolvedValueOnce(first).mockReturnValueOnce(response.promise);
    const pinned = { selectionId: first.selection.id };
    await queries.read("owner", pinned, signal());

    const pending = expect(queries.read("owner", { ...pinned, cursor: "next" }, signal())).resolves.toEqual(next);
    await expect(queries.read("owner", pinned, signal())).resolves.toEqual(first);
    expect(read.mock.calls[1][1]?.signal?.aborted).toBe(false);
    response.resolve(next);
    await pending;
    expect(read).toHaveBeenCalledTimes(2);
    expect(queries.getCached("owner", pinned)).toEqual(first);
    expect(queries.getCached("owner", { ...pinned, cursor: "next" })).toEqual(next);
  });

  it.each(["first", "next"] as const)("retains adjacent pages whose transports finish together, %s page first", async leading => {
    const first = { ...page(), page: { limit: 50, previousCursor: null, nextCursor: "next" } };
    const next = { ...page(), page: { limit: 50, previousCursor: "back", nextCursor: null } };
    const firstResponse = deferredPage(), nextResponse = deferredPage();
    read.mockReturnValueOnce(firstResponse.promise).mockReturnValueOnce(nextResponse.promise);
    const pinned = { selectionId: first.selection.id };
    const pending = Promise.all([
      queries.read("owner", pinned, signal()),
      queries.read("owner", { ...pinned, cursor: "next" }, signal()),
    ]);
    if (leading === "first") {
      firstResponse.resolve(first);
      nextResponse.resolve(next);
    } else {
      nextResponse.resolve(next);
      firstResponse.resolve(first);
    }
    await expect(pending).resolves.toEqual([first, next]);

    expect(queries.getCached("owner", pinned)).toEqual(first);
    expect(queries.getCached("owner", { ...pinned, cursor: "next" })).toEqual(next);
    await queries.read("owner", { ...pinned, cursor: "next" }, signal());
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("bounds retained pages after several adjacent reads finish together", async () => {
    const responses = Array.from({ length: 4 }, () => deferredPage());
    const pages = responses.map((_, index) => ({
      ...page(), page: { limit: 50, previousCursor: index ? `back-${index - 1}` : null, nextCursor: `next-${index + 1}` },
    }));
    const pinned = { selectionId: page().selection.id };
    responses.forEach(response => read.mockReturnValueOnce(response.promise));
    const pending = Promise.all(pages.map((_, index) =>
      queries.read("owner", { ...pinned, ...(index ? { cursor: `next-${index}` } : {}) }, signal())));
    responses.forEach((response, index) => response.resolve(pages[index]));
    await expect(pending).resolves.toEqual(pages);

    expect(queries.getCached("owner", pinned)).toBeUndefined();
    expect(queries.getCached("owner", { ...pinned, cursor: "next-1" })).toBeUndefined();
    for (const index of [2, 3]) {
      expect(queries.getCached("owner", { ...pinned, cursor: `next-${index}` })).toEqual(pages[index]);
    }
    expect(read).toHaveBeenCalledTimes(4);
  });

  it.each(["clear", "selection", "principal", "replacement", "eviction"] as const)(
    "cancels a finalized cache hit before caller delivery on %s invalidation", async invalidation => {
      const pinned = { selectionId: page().selection.id };
      await queries.read("owner", pinned, signal());
      const pending = expect(queries.read("owner", pinned, signal())).rejects.toMatchObject({
        code: "request_aborted", kind: "aborted",
      });
      await Promise.resolve();
      if (invalidation === "clear") queries.clear();
      else if (invalidation === "selection") queries.invalidateSelection(pinned.selectionId);
      else if (invalidation === "principal") await queries.read("replacement-owner", pinned, signal());
      else if (invalidation === "replacement") {
        const replacement = { ...page(), selection: { ...page().selection, id: "replacement-selection" } };
        read.mockResolvedValueOnce(replacement);
        await queries.read("owner", { selectionId: replacement.selection.id }, signal());
      } else {
        await Promise.all(Array.from({ length: 4 }, (_, index) =>
          queries.read("owner", { search: String(index) }, signal())));
      }
      await pending;
    },
  );

  it("does not return a recaptured selection under the old pinned request key", async () => {
    const original = page();
    const refreshed = page(undefined, { id: "new-selection", revision: "2" });
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

  it("invalidates only an export's selection and aborts its pending pages without discarding other families", async () => {
    const original = page();
    const replacement = { ...page(), selection: { ...page().selection, id: "replacement-selection" } };
    read.mockResolvedValueOnce(original).mockResolvedValueOnce(replacement);
    await queries.read("owner", {}, signal());
    await queries.read("owner", { search: "current" }, signal());
    read.mockImplementationOnce(() => new Promise(() => {}));
    const pending = expect(queries.read("owner", { selectionId: original.selection.id, cursor: "next" }, signal()))
      .rejects.toMatchObject({ code: "request_aborted" });
    queries.invalidateSelection(original.selection.id);
    await pending;
    expect(read.mock.calls[2][1]?.signal?.aborted).toBe(true);
    expect(queries.getCached("owner", {})).toBeUndefined();
    expect(queries.getCached("owner", { search: "current" })).toBe(replacement);
    expect(await queries.read("owner", { search: "current" }, signal())).toBe(replacement);
    expect(read).toHaveBeenCalledTimes(3);
    await queries.read("owner", {}, signal());
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

  it.each(["not_collected", "preparing", "unavailable"] as const)("does not pin or retain a %s result as an empty inventory", async state => {
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
  it.each([false, true])("retains admitted inventory when optional identity current=%s ages", async current => {
    const result = pageWithPeople(undefined);
    const expiresAt = current ? "2026-09-20T12:00:05.000Z" : "2026-09-20T11:59:00.000Z";
    result.value[0].observations.packageSnapshots.aging = {
      id: "catalog", snapshotId: "catalog", scopeKind: "broad", current: true,
      observedAt: "2026-09-20T11:00:00.000Z", expiresAt: result.selection.expiresAt,
      identityDetails: { id: "detail", snapshotId: "detail", current, observedAt: "2026-09-20T11:00:00.000Z", expiresAt },
    };
    read.mockResolvedValue(result);
    await expect(queries.read("owner", {}, signal())).resolves.toEqual(result);
    vi.advanceTimersByTime(5_001);
    await expect(queries.read("owner", {}, signal())).resolves.toBe(result);
    expect(read).toHaveBeenCalledOnce();
  });
  it.each(["fresh", "stale"] as const)("retains admitted inventory when optional package detail %s ages", async state => {
    const result = pageWithPeople(undefined);
    result.value[0].packages = [{ id: "access", displayName: "Access details", isBlocked: false,
      sourceSystem: "graph_packages", authoringTool: null, creatorType: "unknown", agentKind: "copilot_package",
      lifecycle: "unknown", identityConfidence: "exact_native", provenance: {},
      detailFreshness: { state, observedAt: "2026-09-20T11:00:00.000Z",
        expiresAt: state === "fresh" ? "2026-09-20T12:00:05.000Z" : "2026-09-20T11:59:00.000Z" },
      availableTo: "none", deployedTo: "none" }];
    read.mockResolvedValue(result);
    await expect(queries.read("owner", {}, signal())).resolves.toEqual(result);
    vi.advanceTimersByTime(5_001);
    await expect(queries.read("owner", {}, signal())).resolves.toBe(result);
    expect(read).toHaveBeenCalledOnce();
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

  it("bounds reuse by the server selection lease, not nested report freshness", async () => {
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
    expect(read).toHaveBeenCalledTimes(3);
    queries.clear();
    read.mockResolvedValueOnce({
      ...usagePage, usageContext: { ...usagePage.usageContext, reports: { ...reports, expiresAt: null }, expiresAt: "2026-09-20T12:00:15.000Z" },
    });
    await queries.read("owner", {}, signal());
    vi.advanceTimersByTime(5_000);
    await queries.read("owner", {}, signal());
    expect(read).toHaveBeenCalledTimes(4);
  });

  it.each(["source", "usage"] as const)("keeps a validated %s response delivered after its recorded deadline without inventing authority", async source => {
    const expiresAt = "2026-09-20T12:00:05.000Z";
    const expiring: UnifiedAgentInventoryPage = source === "source" ? page(expiresAt) : {
      ...page(),
      usageContext: { revision: "usage", reports: { ...reports, expiresAt: null }, expiresAt },
    };
    read.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(5_000);
      return expiring;
    });

    await expect(queries.read("owner", {}, signal())).resolves.toBe(expiring);
    expect(queries.getCached("owner", {})).toBe(source === "source" ? undefined : expiring);
    await expect(queries.read("owner", {}, signal())).resolves.toMatchObject({ selection: { revision: "1" } });
    expect(read).toHaveBeenCalledTimes(source === "source" ? 2 : 1);
  });

  it("keeps a cache hit delivered at lease end as historical data, without extending reuse", async () => {
    read.mockResolvedValueOnce(page("2026-09-20T12:00:05.000Z"));
    await queries.read("owner", {}, signal());
    vi.advanceTimersByTime(4_999);

    const expired = expect(queries.read("owner", {}, signal())).resolves.toMatchObject({ selection: { id: page().selection.id } });
    vi.advanceTimersByTime(1);
    await expired;
    expect(read).toHaveBeenCalledOnce();
    expect(queries.getCached("owner", {})).toBeUndefined();
    await expect(queries.read("owner", {}, signal())).resolves.toEqual(page());
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("retains pinned environment labels after their recorded freshness date", async () => {
    const environmentPage = pageWithEnvironment("2026-09-20T12:00:05.000Z");
    read.mockResolvedValueOnce(environmentPage);
    await expect(queries.read("owner", {}, signal())).resolves.toBe(environmentPage);
    vi.advanceTimersByTime(4_999);
    await expect(queries.read("owner", {}, signal())).resolves.toBe(environmentPage);
    expect(read).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await expect(queries.read("owner", {}, signal())).resolves.toBe(environmentPage);
    expect(read).toHaveBeenCalledTimes(1);
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
    ["2026-09-20T12:00:00.000Z", "invalid_selected_read"],
    ["invalid", "invalid_selected_read"],
  ])("rejects a page-level deadline of %s", async (expiresAt, code) => {
    read.mockResolvedValueOnce({ ...page(), selection: { ...page().selection, expiresAt } });
    await expect(queries.read("owner", {}, signal())).rejects.toMatchObject({ code });
    await expect(queries.read("owner", {}, signal())).resolves.toMatchObject({ value: [] });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("retains selected environment context that ages in flight", async () => {
    const expiresAt = "2026-09-20T12:00:05.000Z";
    read.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(5_000);
      return pageWithEnvironment(expiresAt);
    });
    await expect(queries.read("owner", {}, signal())).resolves.toEqual(pageWithEnvironment(expiresAt));
    await expect(queries.read("owner", {}, signal())).resolves.toEqual(pageWithEnvironment(expiresAt));
    expect(read).toHaveBeenCalledOnce();
  });

  it("rejects malformed environment expiry instead of extending saved context", async () => {
    read.mockResolvedValueOnce(pageWithEnvironment("invalid"));
    await expect(queries.read("owner", {}, signal())).rejects.toMatchObject({ code: "invalid_inventory_metadata" });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["owner", "resolved"],
    ["createdBy", "not_found"],
    ["lastModifiedBy", "lookup_failed"],
  ] as const)("retains the admitted page at the optional %s %s person boundary", async (field, status) => {
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
    await expect(queries.read("owner", {}, signal())).resolves.toBe(peoplePage);
    expect(read).toHaveBeenCalledOnce();
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
    await expect(queries.read("owner", {}, signal())).rejects.toMatchObject({ code: "invalid_inventory_metadata" });
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
    expect(queries.getCached("owner", {})).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed expiration evidence instead of caching it indefinitely", async () => {
    read.mockResolvedValueOnce(page("invalid"));
    await expect(queries.read("owner", {}, signal())).rejects.toMatchObject({ code: "invalid_selected_read" });
    expect(read).toHaveBeenCalledTimes(1);
  });
});
