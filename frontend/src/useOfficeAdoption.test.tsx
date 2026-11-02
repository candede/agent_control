import { act, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { officeAdoption } from "./api/officeAppAdoption";
import { ApiError } from "./api/client";
import { PublicationContext } from "./publicationContext";
import { SavedQueryProvider } from "./components/SavedQueryProvider";
import { officeContext, officeGroup, officeHistory, officePage, officePerson, officeSummary } from "./test/officeAdoptionFixture";
import { useOfficeAdoption, useOfficeHistory, useOfficePage, useOfficePerson, useOfficeSummary, validateOfficeContext } from "./useOfficeAdoption";
import { deferred } from "./test/deferred";
import { CapabilityContext, type useCapabilityContext } from "./capabilityContext";
import { createSavedQueryClient } from "./savedQueries";

vi.mock("./api/officeAppAdoption", async original => ({ ...await original<typeof import("./api/officeAppAdoption")>(),
  officeAdoption: { context: vi.fn(), summary: vi.fn(), history: vi.fn(), groups: vi.fn(), people: vi.fn() } }));
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });
describe("one Office context owner", () => {
  it("opens an already accepted late-page person without rescanning a 100000-person group", async () => {
    const context = officeContext(), person = officePerson(100000);
    const started = performance.now();
    const query = { officeSnapshot: context.observation!.id };
    vi.mocked(officeAdoption.context).mockResolvedValue({ ...context, query });
    const { result } = renderHook(() => {
      const owner = useOfficeAdoption(query, 0, vi.fn());
      return useOfficePerson(owner, person.groupId, person.identity, {
        person, observationId: context.observation!.id, principal: owner.principal, query: {},
      });
    }, { wrapper: SavedQueryProvider });
    await waitFor(() => expect(result.current.data?.value).toEqual(person));
    expect(officeAdoption.people).not.toHaveBeenCalled();
    expect(result.current.isCurrent()).toBe(true);
    const openedMs = performance.now() - started;
    expect(openedMs).toBeLessThan(5000);
    console.info("OFFICE_ACCEPTED_PERSON", { identityOrdinal: 100000, peopleReads: 0, openedMs });
  });
  it.each(["observation", "filters", "principal", "identity", "group"] as const)(
    "does not reuse frozen facts across a changed %s", async mismatch => {
      const context = officeContext(), person = officePerson();
      vi.mocked(officeAdoption.context).mockResolvedValue(context);
      vi.mocked(officeAdoption.people).mockResolvedValue(officePage([person], context));
      const { result } = renderHook(() => {
        const owner = useOfficeAdoption({}, 0, vi.fn());
        return useOfficePerson(owner, person.groupId, person.identity, {
          person: { ...person, ...(mismatch === "identity" ? { identity: "other" } : {}),
            ...(mismatch === "group" ? { groupId: "b".repeat(64) } : {}) },
          observationId: mismatch === "observation" ? "other" : context.observation!.id,
          principal: mismatch === "principal" ? "other" : owner.principal,
          query: mismatch === "filters" ? { app: "word" } : {},
        });
      }, { wrapper: SavedQueryProvider });
      await waitFor(() => expect(result.current.data?.value).toEqual(person));
      expect(officeAdoption.people).toHaveBeenCalledOnce();
    });
  it("binds summary and every complete history page to the exact filters and selection", async () => {
    const query = { company: null, app: "word" as const };
    const context = officeContext(query);
    vi.mocked(officeAdoption.context).mockResolvedValue(context);
    vi.mocked(officeAdoption.summary).mockResolvedValue(officeSummary(context));
    vi.mocked(officeAdoption.history).mockResolvedValueOnce(officePage(officeHistory(context).slice(0, 1), context, {
      counts: { total: 3, filtered: 3 }, page: { limit: 100, number: 1, pages: 2, offset: 0, anchor: null, previousCursor: null, nextCursor: "next" },
    })).mockResolvedValueOnce(officePage(officeHistory(context).slice(1), context, { counts: { total: 3, filtered: 3 } }));
    const { result } = renderHook(() => { const owner = useOfficeAdoption(query, 0, vi.fn()); return { summary: useOfficeSummary(owner), history: useOfficeHistory(owner) }; }, { wrapper: SavedQueryProvider });
    await waitFor(() => expect(result.current.history.data?.value).toHaveLength(3));
    expect(result.current.summary.data?.organization?.reportedActiveUsers).toBe(40);
    expect(officeAdoption.summary).toHaveBeenCalledWith({ ...query, selectionId: context.selection.id }, expect.any(AbortSignal));
    expect(officeAdoption.history).toHaveBeenLastCalledWith({ ...query, selectionId: context.selection.id, limit: 100, cursor: "next" }, expect.any(AbortSignal));
  });
  it("rejects mixed query or selection metadata instead of treating it as valid counts", () => {
    expect(() => validateOfficeContext(officeContext({ app: "excel" }), { app: "word" }, performance.now())).toThrow(/does not match/);
    expect(() => validateOfficeContext(officeContext(), {}, performance.now(), "different")).toThrow(/does not match/);
  });
  it.each([false, true])("automatically renews an initial expired context response without discarding a live observation pin (pinned=%s)", async pinned => {
    const query = pinned ? { officeSnapshot: officeContext().observation!.id } : {};
    const context = officeContext(query), recover = vi.fn();
    vi.mocked(officeAdoption.context).mockRejectedValueOnce(new ApiError(409, "selection_invalidated", "Expired",
      { details: { reason: "expired" } })).mockResolvedValueOnce(context);
    const { result } = renderHook(() => useOfficeAdoption(query, 0, recover), { wrapper: SavedQueryProvider });
    await waitFor(() => expect(result.current.isCurrent()).toBe(true));
    expect(officeAdoption.context).toHaveBeenCalledTimes(2);
    expect(officeAdoption.context).toHaveBeenLastCalledWith({ ...query, selectionId: undefined }, expect.any(AbortSignal));
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(recover).not.toHaveBeenCalled();
  });
  it("automatically renews an expired context response received after an accepted context", async () => {
    const first = officeContext(), renewed = officeContext();
    renewed.selection.id = "20000000-0000-4000-8000-000000000099";
    vi.mocked(officeAdoption.context).mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new ApiError(409, "selection_invalidated", "Expired", { details: { reason: "expired" } }))
      .mockResolvedValueOnce(renewed);
    const { result, rerender } = renderHook(({ revision }) => useOfficeAdoption({}, revision, vi.fn()),
      { wrapper: SavedQueryProvider, initialProps: { revision: 0 } });
    await waitFor(() => expect(result.current.isCurrent()).toBe(true));
    rerender({ revision: 1 });
    await waitFor(() => expect(result.current.context?.selection.id).toBe(renewed.selection.id));
    expect(officeAdoption.context).toHaveBeenCalledTimes(3);
    expect(result.current.isCurrent()).toBe(true);
    expect(result.current.loading).toBe(false);
  });
  it("waits for browser availability before renewing an expired context response", async () => {
    let online = false;
    vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
    const context = officeContext();
    vi.mocked(officeAdoption.context).mockRejectedValueOnce(new ApiError(409, "selection_invalidated", "Expired",
      { details: { reason: "expired" } })).mockResolvedValueOnce(context);
    const { result } = renderHook(() => useOfficeAdoption({}, 0, vi.fn()), { wrapper: SavedQueryProvider });
    await waitFor(() => expect(result.current.error).toMatchObject({ details: { reason: "expired" } }));
    expect(officeAdoption.context).toHaveBeenCalledOnce();
    expect(result.current.loading).toBe(false);
    act(() => { online = true; window.dispatchEvent(new Event("online")); });
    await waitFor(() => expect(result.current.isCurrent()).toBe(true));
    expect(officeAdoption.context).toHaveBeenCalledTimes(2);
  });
  it("renews a numbered group page through its last validated anchor instead of resetting to page one", async () => {
    const first = officeContext(), renewed = officeContext();
    renewed.selection.id = "20000000-0000-4000-8000-000000000099";
    vi.mocked(officeAdoption.context).mockResolvedValueOnce(first).mockResolvedValueOnce(renewed);
    vi.mocked(officeAdoption.groups).mockImplementation(async input => officePage([officeGroup()], input?.selectionId === first.selection.id ? first : renewed, {
      page: { limit: 5, number: 2, pages: 2, offset: 5, anchor: officeGroup().id, nextCursor: null, previousCursor: "previous" },
    }));
    const { result } = renderHook(() => {
      const owner = useOfficeAdoption({}, 0, vi.fn());
      return { owner, page: useOfficePage(owner, "groups", { pageNumber: 2 }) };
    }, { wrapper: SavedQueryProvider });
    await waitFor(() => expect(result.current.page.isCurrent()).toBe(true));
    expect(officeAdoption.groups).toHaveBeenLastCalledWith({ selectionId: first.selection.id, limit: 5, pageNumber: 2 }, expect.any(AbortSignal));
    act(() => result.current.owner.restart());
    await waitFor(() => expect(result.current.page.data?.context.selection.id).toBe(renewed.selection.id));
    expect(officeAdoption.groups).toHaveBeenLastCalledWith({ selectionId: renewed.selection.id, limit: 5, anchor: officeGroup().id }, expect.any(AbortSignal));
    expect(result.current.page.data?.page.number).toBe(2);
  });
  it("retains a validated Next cursor when its controlled page number is admitted and resets it on selection renewal",async()=>{
    const first=officeContext(),renewed=officeContext();
    renewed.selection.id="20000000-0000-4000-8000-000000000099";
    vi.mocked(officeAdoption.context).mockResolvedValueOnce(first).mockResolvedValueOnce(renewed);
    vi.mocked(officeAdoption.people).mockImplementation(async (_,input)=>{
      const number=input?.pageNumber ?? (input?.cursor==="second" ? 2 : 1);
      return officePage([officePerson(number)],input?.selectionId===first.selection.id ? first : renewed,{
        counts:{total:150,filtered:150},
        page:{limit:50,number,pages:3,offset:(number-1)*50,anchor:null,
          previousCursor:number>1 ? "first" : null,nextCursor:number<3 ? "second" : null},
      });
    });
    const {result}=renderHook(()=>{
      const [number,setNumber]=useState(1),owner=useOfficeAdoption({},0,vi.fn());
      return {owner,setNumber,page:useOfficePage(owner,"people",{groupId:officeGroup().id,pageNumber:number})};
    },{wrapper:SavedQueryProvider});
    await waitFor(()=>expect(result.current.page.isCurrent()).toBe(true));
    act(()=>{expect(result.current.page.next()).toBe(true);result.current.setNumber(2);});
    await waitFor(()=>expect(result.current.page.data?.page.number).toBe(2));
    expect(officeAdoption.people).toHaveBeenLastCalledWith(officeGroup().id,
      {selectionId:first.selection.id,limit:50,cursor:"second"},expect.any(AbortSignal));
    act(()=>{expect(result.current.page.previous()).toBe(true);result.current.setNumber(1);});
    await waitFor(()=>expect(result.current.page.data?.page.number).toBe(1));
    expect(officeAdoption.people).toHaveBeenLastCalledWith(officeGroup().id,
      {selectionId:first.selection.id,limit:50,cursor:"first"},expect.any(AbortSignal));
    act(()=>result.current.setNumber(3));
    await waitFor(()=>expect(result.current.page.data?.page.number).toBe(3));
    expect(officeAdoption.people).toHaveBeenLastCalledWith(officeGroup().id,
      {selectionId:first.selection.id,limit:50,pageNumber:3},expect.any(AbortSignal));
    act(()=>result.current.owner.restart());
    await waitFor(()=>expect(result.current.page.data?.context.selection.id).toBe(renewed.selection.id));
    expect(officeAdoption.people).toHaveBeenLastCalledWith(officeGroup().id,
      {selectionId:renewed.selection.id,limit:50,pageNumber:3},expect.any(AbortSignal));
  });
  it("withdraws inconsistent history and counts instead of accepting a partial trend as a validated selection", async () => {
    const context = officeContext();
    vi.mocked(officeAdoption.context).mockResolvedValue(context);
    vi.mocked(officeAdoption.summary).mockResolvedValue(officeSummary(context));
    vi.mocked(officeAdoption.history).mockResolvedValue(officePage(officeHistory(context).slice(0, 1), context, { counts: { total: 3, filtered: 3 } }));
    const { result } = renderHook(() => {
      const owner = useOfficeAdoption({}, 0, vi.fn());
      return { owner, summary: useOfficeSummary(owner), history: useOfficeHistory(owner) };
    }, { wrapper: SavedQueryProvider });
    await waitFor(() => expect(result.current.owner.error).toMatchObject({ code: "invalid_response", message: "Office history is incomplete." }));
    expect(result.current.owner.invalidated).toBe(true);
    expect(result.current.history.data).toBeUndefined();
    expect(result.current.summary.data).toBeUndefined();
  });
  it.each([
    ["observation", 0], ["observation", 1], ["baseline", 0], ["baseline", 1],
  ] as const)("withdraws a mismatched %s context on history page %s", async (field, pageIndex) => {
    const context = officeContext(), points = officeHistory(context);
    const other = { ...context, [field]: officeContext({}, 2).observation };
    const counts = { total: points.length, filtered: points.length };
    vi.mocked(officeAdoption.context).mockResolvedValue(context);
    vi.mocked(officeAdoption.summary).mockResolvedValue(officeSummary(context));
    vi.mocked(officeAdoption.history).mockResolvedValueOnce(officePage(points.slice(0, 1), pageIndex === 0 ? other : context, {
      counts, page: { limit: 100, number: 1, pages: 2, offset: 0, anchor: null, previousCursor: null, nextCursor: "next" },
    })).mockResolvedValueOnce(officePage(points.slice(1), pageIndex === 1 ? other : context, { counts }));
    const { result } = renderHook(() => {
      const owner = useOfficeAdoption({}, 0, vi.fn());
      return { owner, summary: useOfficeSummary(owner), history: useOfficeHistory(owner) };
    }, { wrapper: SavedQueryProvider });
    await waitFor(() => expect(result.current.owner.error).toMatchObject({
      code: "selection_invalidated", message: "Office panels returned different observations.",
    }));
    expect(result.current.owner.invalidated).toBe(true);
    expect(result.current.history.data).toBeUndefined();
    expect(result.current.summary.data).toBeUndefined();
    expect(officeAdoption.history).toHaveBeenCalledTimes(pageIndex + 1);
  });
  it.each(["observation", "baseline"] as const)("withdraws a mismatched %s context before scanning the next person page", async field => {
    const context = officeContext(), other = { ...context, [field]: officeContext({}, 2).observation };
    const person = officePerson(2);
    vi.mocked(officeAdoption.context).mockResolvedValue(context);
    vi.mocked(officeAdoption.people).mockResolvedValueOnce(officePage([officePerson(1)], other, {
      counts: { total: 2, filtered: 2 },
      page: { limit: 100, number: 1, pages: 2, offset: 0, anchor: null, previousCursor: null, nextCursor: "next" },
    })).mockResolvedValueOnce(officePage([person], context));
    const { result } = renderHook(() => {
      const owner = useOfficeAdoption({}, 0, vi.fn());
      return { owner, person: useOfficePerson(owner, person.groupId, person.identity) };
    }, { wrapper: SavedQueryProvider });
    await waitFor(() => expect(result.current.owner.error).toMatchObject({
      code: "selection_invalidated", message: "Office panels returned different observations.",
    }));
    expect(result.current.owner.invalidated).toBe(true);
    expect(result.current.person.data).toBeUndefined();
    expect(officeAdoption.people).toHaveBeenCalledOnce();
  });
  it.each([
    ["identity", false],
    ["provider date", false],
    ["identity", true],
    ["provider date", true],
  ] as const)("withdraws duplicate %s history within or across pages (across=%s)", async (duplicate, acrossPages) => {
    const context = officeContext(), points = officeHistory(context);
    const second = { ...points[1], observation: {
      ...points[1].observation,
      ...(duplicate === "identity" ? { id: points[0].observation.id } : { reportRefreshDate: points[0].observation.reportRefreshDate }),
    } };
    vi.mocked(officeAdoption.context).mockResolvedValue(context);
    vi.mocked(officeAdoption.summary).mockResolvedValue(officeSummary(context));
    const counts = { total: 2, filtered: 2 };
    if (acrossPages) {
      vi.mocked(officeAdoption.history).mockResolvedValueOnce(officePage([points[0]], context, {
        counts, page: { limit: 100, number: 1, pages: 2, offset: 0, anchor: null, previousCursor: null, nextCursor: "next" },
      })).mockResolvedValueOnce(officePage([second], context, { counts }));
    } else {
      vi.mocked(officeAdoption.history).mockResolvedValue(officePage([points[0], second], context, { counts }));
    }
    const { result } = renderHook(() => {
      const owner = useOfficeAdoption({}, 0, vi.fn());
      return { owner, summary: useOfficeSummary(owner), history: useOfficeHistory(owner) };
    }, { wrapper: SavedQueryProvider });
    await waitFor(() => expect(result.current.owner.error).toMatchObject({
      code: "invalid_response", message: "Office history pages are inconsistent.",
    }));
    expect(result.current.owner.invalidated).toBe(true);
    expect(result.current.history.data).toBeUndefined();
    expect(result.current.summary.data).toBeUndefined();
  });
  it("recovers removed pins to Latest with an explicit notice", async () => {
    const recover = vi.fn();
    vi.mocked(officeAdoption.context).mockRejectedValue(new ApiError(409, "selection_invalidated", "Removed"));
    renderHook(() => useOfficeAdoption({ officeSnapshot: officeContext().observation!.id }, 0, recover), { wrapper: SavedQueryProvider });
    await waitFor(() => expect(recover).toHaveBeenCalledWith(expect.stringMatching(/Showing Latest/)));
  });
  it("recovers the same removed pin again after visiting Latest", async () => {
    const recover = vi.fn(), pin = officeContext().observation!.id;
    vi.mocked(officeAdoption.context).mockImplementation(async query => {
      if (query?.officeSnapshot) throw new ApiError(409, "selection_invalidated", "Removed");
      return officeContext();
    });
    const { result, rerender } = renderHook(({ pinned }) => useOfficeAdoption(pinned ? { officeSnapshot: pin } : {}, 0, recover),
      { wrapper: SavedQueryProvider, initialProps: { pinned: true } });
    await waitFor(() => expect(recover).toHaveBeenCalledOnce());
    rerender({ pinned: false });
    await waitFor(() => expect(result.current.isCurrent()).toBe(true));
    rerender({ pinned: true });
    await waitFor(() => expect(recover).toHaveBeenCalledTimes(2));
    expect(recover).toHaveBeenLastCalledWith(expect.stringMatching(/Showing Latest/));
  });
  it("keeps failed context revalidation readable but not actionable until retry succeeds", async () => {
    const context = officeContext(), page = officePage([officeGroup()], context);
    vi.mocked(officeAdoption.context).mockResolvedValueOnce(context)
      .mockRejectedValueOnce(new ApiError(503, "saved_data_unavailable", "Try again"))
      .mockResolvedValueOnce(context);
    vi.mocked(officeAdoption.groups).mockResolvedValue(page);
    const { result } = renderHook(() => {
      const owner = useOfficeAdoption({}, 0, vi.fn());
      return { owner, page: useOfficePage(owner, "groups") };
    }, { wrapper: SavedQueryProvider });
    await waitFor(() => expect(result.current.page.isCurrent()).toBe(true));
    act(() => result.current.owner.retry());
    await waitFor(() => expect(result.current.owner.error).toMatchObject({ status: 503 }));
    expect(result.current.owner.context).toBe(context);
    expect(result.current.page.data).toBe(page);
    expect(result.current.owner.isCurrent()).toBe(false);
    expect(result.current.page.isCurrent()).toBe(false);
    act(() => result.current.owner.retry());
    await waitFor(() => expect(result.current.page.isCurrent()).toBe(true));
  });
  it.each(["context", "page"] as const)("blocks Office paging immediately when %s revalidation starts", async resource => {
    const client = createSavedQueryClient(), context = officeContext();
    const page = officePage([officeGroup()], context, {
      counts: { total: 6, filtered: 6 },
      page: { limit: 5, number: 1, pages: 2, offset: 0, anchor: officeGroup().id, nextCursor: "next", previousCursor: null },
    });
    const pendingContext = deferred<ReturnType<typeof officeContext>>();
    const pendingPage = deferred<typeof page>();
    vi.mocked(officeAdoption.context).mockResolvedValueOnce(context).mockReturnValueOnce(pendingContext.promise);
    vi.mocked(officeAdoption.groups).mockResolvedValueOnce(page).mockReturnValueOnce(pendingPage.promise);
    const { result } = renderHook(() => {
      const owner = useOfficeAdoption({}, 0, vi.fn());
      return { owner, page: useOfficePage(owner, "groups") };
    }, { wrapper: ({ children }) => <SavedQueryProvider client={client}>{children}</SavedQueryProvider> });
    await waitFor(() => expect(result.current.page.isCurrent()).toBe(true));
    act(() => {
      if (resource === "context") result.current.owner.retry();
      else result.current.page.retry();
      expect(result.current.page.isCurrent()).toBe(false);
      expect(result.current.page.next()).toBe(false);
    });
    await act(async () => { pendingContext.resolve(context); pendingPage.resolve(page); });
    await waitFor(() => expect(result.current.page.isCurrent()).toBe(true));
    client.clear();
  });
  it("cancels late responses and never exposes the prior account's Office facts", async () => {
    const pending = deferred<ReturnType<typeof officeContext>>();
    const context = officeContext();
    let account = "first";
    vi.mocked(officeAdoption.context).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(context);
    const capability = (): ReturnType<typeof useCapabilityContext> => ({
      user: { homeAccountId: account, tenantId: "tenant", displayName: account, username: `${account}@example.invalid`, roles: ["AgentControl.Viewer"] },
      now: Date.now(), loading: false, pending: false, error: undefined, views: [], reload: vi.fn(), openPermissions: vi.fn(),
    });
    const { result, rerender } = renderHook(() => useOfficeAdoption({}, 0, vi.fn()), { wrapper: ({ children }) =>
      <SavedQueryProvider><CapabilityContext value={capability()}>{children}</CapabilityContext></SavedQueryProvider> });
    await waitFor(() => expect(officeAdoption.context).toHaveBeenCalledTimes(1));
    const signal = vi.mocked(officeAdoption.context).mock.calls[0][1]!;
    account = "second"; rerender();
    await waitFor(() => expect(result.current.context).toBeDefined());
    expect(signal.aborted).toBe(true);
    const older = { ...context, observation: { ...context.observation!, reportRefreshDate: "2025-01-01" } };
    await act(async () => pending.resolve(older));
    expect(result.current.context?.observation?.reportRefreshDate).toBe(context.observation!.reportRefreshDate);
  });
  it("withdraws summary facts on role revocation and rejects incomplete later history", async () => {
    const context = officeContext();
    vi.mocked(officeAdoption.context).mockResolvedValue(context);
    vi.mocked(officeAdoption.summary).mockRejectedValue(new ApiError(403, "role_required", "Viewer access was revoked."));
    vi.mocked(officeAdoption.history).mockResolvedValue(officePage([
      { ...officeHistory(context)[0], observation: { ...officeHistory(context)[0].observation, reportRefreshDate: "2027-01-01" } },
    ], context));
    const { result } = renderHook(() => {
      const owner = useOfficeAdoption({}, 0, vi.fn());
      return { owner, summary: useOfficeSummary(owner), history: useOfficeHistory(owner) };
    }, { wrapper: SavedQueryProvider });
    await waitFor(() => expect(result.current.owner.invalidated).toBe(true));
    expect(result.current.owner.context).toBeUndefined();
    expect(result.current.summary.data).toBeUndefined();
    expect(result.current.history.data).toBeUndefined();
  });
  it.each([false, true])("refreshes users publications automatically without moving a valid historical pin (pinned=%s)", async pinned => {
    const query = pinned ? { officeSnapshot: officeContext().observation!.id } : {};
    const context = officeContext(query);
    const pending = deferred<ReturnType<typeof officeContext>>();
    vi.mocked(officeAdoption.context).mockResolvedValueOnce(context).mockReturnValueOnce(pending.promise);
    let revision = context.selection.publicationRevisions.users;
    const { result, rerender } = renderHook(() => useOfficeAdoption(query, 0, vi.fn()), { wrapper: ({ children }) =>
      <SavedQueryProvider><PublicationContext value={{ admit: vi.fn(), revisions: { ...context.selection.publicationRevisions, users: revision } }}>{children}</PublicationContext></SavedQueryProvider> });
    await waitFor(() => expect(result.current.context).toBeDefined());
    revision = "9".repeat(64);
    rerender();
    await waitFor(() => expect(officeAdoption.context).toHaveBeenCalledTimes(2));
    expect(result.current.context?.observation?.id).toBe(context.observation!.id);
    expect(result.current.renewing).toBe(true);
    expect(officeAdoption.context).toHaveBeenLastCalledWith({ ...query, selectionId: pinned ? context.selection.id : undefined }, expect.any(AbortSignal));
    await act(async () => pending.resolve({ ...context, selection: { ...context.selection, publicationRevisions: { ...context.selection.publicationRevisions, users: revision } } }));
    expect(result.current.context?.observation?.id).toBe(context.observation!.id);
  });
});
