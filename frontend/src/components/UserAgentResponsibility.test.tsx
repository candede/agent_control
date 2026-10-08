import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import * as api from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { responsibilityAgentId, responsibilityFixture, responsibilityOwnerId } from "../test/agentResponsibilityFixture";
import { createSavedQueryClient } from "../savedQueries";
import { deferred } from "../test/deferred";
import { SavedQueryProvider } from "./SavedQueryProvider";
import { UserAgentResponsibility } from "./UserAgentResponsibility";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function scope(children: ReactNode, principal = "reader", roles: api.AppRole[] = ["AgentControl.Viewer"]) {
  return <CapabilityContext value={{
    views: [], user: { tenantId: "tenant", homeAccountId: principal, displayName: "Reader", username: "reader@example.invalid", roles },
    now: Date.now(), loading: false, pending: false, error: undefined, reload: vi.fn(), openPermissions: vi.fn(),
  }}>{children}</CapabilityContext>;
}

describe("saved Users responsibility", () => {
  it.each(["available", "partial"] as const)("presents reported relationships from %s sources without requiring all roles or a refresh", async state => {
    const data = responsibilityFixture(responsibilityOwnerId);
    if (data.sources.powerPlatform.state !== "partial") throw new Error("Expected a partial source fixture.");
    if (state === "available") data.sources.powerPlatform = { state, observation: data.sources.powerPlatform.observation, error: null };
    vi.spyOn(api, "getAgentResponsibility").mockResolvedValue(data);
    const open = vi.fn();
    render(scope(<UserAgentResponsibility objectId={responsibilityOwnerId} onOpenAgent={open} />));
    await userEvent.click(await screen.findByRole("button", { name: "Open agent Responsible agent" }));
    expect(open).toHaveBeenCalledWith(responsibilityAgentId);
    expect(screen.getByText("Owner")).toBeVisible();
    expect(screen.queryByText(/Partial agent inventory|Some relationships may be missing|Refresh agent inventory/)).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("1 agent")).toBeVisible();
    expect(screen.getByText(/Source observed/)).toBeVisible();
    expect(screen.queryByText("Responsible only")).not.toBeInTheDocument();
    expect(screen.queryByText(/not usage, access assignments|Responsibility source coverage|ID:/)).not.toBeInTheDocument();
    expect(document.querySelector("details")).toBeNull();
  });

  it("keeps responsibility outside usage/licensing and navigates the exact canonical agent without provider calls", async () => {
    const read = vi.spyOn(api, "getAgentResponsibility").mockResolvedValue(responsibilityFixture(responsibilityOwnerId));
    const lookup = vi.spyOn(api, "resolveAgentPeople");
    const open = vi.fn();
    render(scope(<UserAgentResponsibility objectId={responsibilityOwnerId} onOpenAgent={open} />));
    await userEvent.click(await screen.findByRole("button", { name: "Open agent Responsible agent" }));
    expect(open).toHaveBeenCalledWith(responsibilityAgentId);
    expect(read).toHaveBeenCalledOnce();
    expect(lookup).not.toHaveBeenCalled();
    expect(screen.getByText(/do not grant access or permission/)).toBeVisible();
  });

  it.each([undefined, "Alice", "alice@example.invalid", "aaaaaaaa"])("does not guess directory IDs for %s", async objectId => {
    const read = vi.spyOn(api, "getAgentResponsibility");
    render(<UserAgentResponsibility objectId={objectId} />);
    expect(screen.getByText(/Link this user to a directory identity/)).toBeVisible();
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["not_found", "lookup_failed"] as const)("preserves %s evidence rather than manufacturing a resolved profile", async status => {
    const data = responsibilityFixture(responsibilityOwnerId);
    data.selected!.person.evidence = { ...data.selected!.person.evidence!, displayName: null, userPrincipalName: null, status, errorCode: "provider_error" };
    vi.spyOn(api, "getAgentResponsibility").mockResolvedValue(data);
    const personLoaded = vi.fn();
    render(<UserAgentResponsibility objectId={responsibilityOwnerId} onPersonLoaded={personLoaded} />);
    await waitFor(() => expect(personLoaded).toHaveBeenLastCalledWith(data.selected!.person));
    expect(personLoaded.mock.lastCall?.[0].evidence.status).toBe(status);
  });

  it.each(["unavailable", "no_reported_relationships"] as const)("does not convert %s into confirmed absence", async state => {
    const data = responsibilityFixture(responsibilityOwnerId, { state });
    vi.spyOn(api, "getAgentResponsibility").mockResolvedValueOnce(responsibilityFixture(responsibilityOwnerId)).mockResolvedValueOnce(data);
    const view = render(<UserAgentResponsibility objectId={responsibilityOwnerId} />);
    await screen.findByText("Responsible agent");
    view.rerender(<UserAgentResponsibility objectId={responsibilityOwnerId} dataRevision={1} />);
    expect(await screen.findByText(state === "unavailable" ? /relationships are unknown, not zero/ : /does not rule out relationships/)).toBeVisible();
    expect(screen.queryByText(/Partial agent inventory|Some relationships may be missing/)).not.toBeInTheDocument();
    if (state === "unavailable") expect(screen.queryByText("0 agents")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open agent/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Responsible agent")).not.toBeInTheDocument();
  });

  it("keeps expired identity evidence explicit without automatically looking it up again", async () => {
    const data = responsibilityFixture(responsibilityOwnerId);
    data.selected!.person.evidence!.expiresAt = "2000-01-01T00:00:00Z";
    const read = vi.spyOn(api, "getAgentResponsibility").mockResolvedValue(data);
    const lookup = vi.spyOn(api, "resolveAgentPeople");
    const personLoaded = vi.fn();
    render(<UserAgentResponsibility objectId={responsibilityOwnerId} onPersonLoaded={personLoaded} />);
    await waitFor(() => expect(personLoaded).toHaveBeenLastCalledWith(data.selected!.person));
    expect(read).toHaveBeenCalledOnce();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("aborts and clears evidence on selected identity, principal and role changes and ignores late completions", async () => {
    let finish!: (value: api.AgentResponsibilityPage) => void;
    const read = vi.spyOn(api, "getAgentResponsibility").mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue(responsibilityFixture("cccccccc-cccc-4ccc-8ccc-cccccccccccc"));
    const view = render(scope(<UserAgentResponsibility objectId={responsibilityOwnerId} />));
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    const signal = read.mock.calls[0][1]!.signal!;
    view.rerender(scope(<UserAgentResponsibility objectId="cccccccc-cccc-4ccc-8ccc-cccccccccccc" />, "other-reader"));
    await screen.findByText("Responsible agent");
    expect(signal.aborted).toBe(true);
    await act(async () => finish(responsibilityFixture(responsibilityOwnerId)));
    expect(screen.queryByText(`ID: ${responsibilityOwnerId}`)).not.toBeInTheDocument();
    view.rerender(scope(<UserAgentResponsibility objectId="cccccccc-cccc-4ccc-8ccc-cccccccccccc" />, "other-reader", []));
    expect(screen.getByRole("alert")).toHaveTextContent("current Viewer access");
    expect(screen.queryByText("Responsible agent")).not.toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each([new api.ApiError(403, "forbidden", "Saved access denied"), new Error("Saved responsibility failed")])(
    "retains relationships only while reloading, clears them on $message and retries saved reads", async failure => {
      const read = vi.spyOn(api, "getAgentResponsibility").mockResolvedValueOnce(responsibilityFixture(responsibilityOwnerId))
        .mockRejectedValueOnce(failure)
        .mockResolvedValue(responsibilityFixture(responsibilityOwnerId));
      const view = render(<UserAgentResponsibility objectId={responsibilityOwnerId} />);
      await screen.findByText("Responsible agent");
      view.rerender(<UserAgentResponsibility objectId={responsibilityOwnerId} dataRevision={1} />);
      expect(screen.getByText("Responsible agent")).toBeVisible();
      expect(await screen.findByRole("alert")).toHaveTextContent(failure.message);
      expect(screen.queryByText("Responsible agent")).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Retry saved responsibility" }));
      expect(await screen.findByText("Responsible agent")).toBeVisible();
      expect(read).toHaveBeenCalledTimes(3);
    },
  );

  it.each(["dataRevision", "agentInventoryRevision"] as const)(
    "keeps relationships usable and fences superseded responses when %s changes", async revisionProp => {
      let finishStale!: (value: api.AgentResponsibilityPage) => void;
      const current = responsibilityFixture(responsibilityOwnerId);
      current.selected!.agents[0] = { ...current.selected!.agents[0], id: "agent:dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        displayName: "Current canonical agent", roles: ["createdBy"] };
      const read = vi.spyOn(api, "getAgentResponsibility").mockResolvedValueOnce(responsibilityFixture(responsibilityOwnerId))
        .mockReturnValueOnce(new Promise(resolve => { finishStale = resolve; })).mockResolvedValueOnce(current);
      const lookup = vi.spyOn(api, "resolveAgentPeople");
      const open = vi.fn();
      const view = render(scope(<UserAgentResponsibility objectId={responsibilityOwnerId} onOpenAgent={open} />));
      await screen.findByText("Responsible agent");
      const button = screen.getByRole("button", { name: "Open agent Responsible agent" });
      const panel = screen.getByRole("region", { name: "Agent responsibility" });
      button.focus();
      panel.scrollTop = 111;
      view.rerender(scope(<UserAgentResponsibility objectId={responsibilityOwnerId} onOpenAgent={open} {...{ [revisionProp]: 1 }} />));
      expect(screen.getByText("Responsible agent")).toBeVisible();
      expect(screen.getByRole("button", { name: "Open agent Responsible agent" })).toBeEnabled();
      expect(screen.queryByText("Loading saved responsibility...")).not.toBeInTheDocument();
      expect(button).toHaveFocus();
      expect(panel.scrollTop).toBe(111);
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      const staleSignal = read.mock.calls[1][1]!.signal!;
      view.rerender(scope(<UserAgentResponsibility objectId={responsibilityOwnerId} onOpenAgent={open} {...{ [revisionProp]: 2 }} />));
      expect(await screen.findByText("Current canonical agent")).toBeVisible();
      expect(staleSignal.aborted).toBe(true);
      await act(async () => finishStale(responsibilityFixture(responsibilityOwnerId)));
      expect(screen.queryByText("Responsible agent")).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Open agent Current canonical agent" }));
      expect(open).toHaveBeenCalledExactlyOnceWith(current.selected!.agents[0].id);
      expect(read).toHaveBeenCalledTimes(3);
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it("pages one user's agents server-side and rejects cross-person responses", async () => {
    const data = responsibilityFixture(responsibilityOwnerId, { agentCount: 51 });
    const next = responsibilityFixture(responsibilityOwnerId, { agentCount: 51, pageIndex: 1, selection: data.selection });
    const read = vi.spyOn(api, "getAgentResponsibility").mockResolvedValueOnce(data).mockResolvedValue(next);
    const view = render(<UserAgentResponsibility objectId={responsibilityOwnerId} />);
    await userEvent.click(await screen.findByRole("button", { name: "Next" }));
    await waitFor(() => expect(read).toHaveBeenLastCalledWith(expect.objectContaining({
      objectId: responsibilityOwnerId, selectionId: data.selection.id, cursor: data.page.nextCursor, limit: 50,
    }), expect.anything()));
    expect(read.mock.calls[1][0]).not.toHaveProperty("offset");
    read.mockResolvedValue(responsibilityFixture("cccccccc-cccc-4ccc-8ccc-cccccccccccc"));
    view.rerender(<UserAgentResponsibility objectId={responsibilityOwnerId} dataRevision={1} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("did not match the exact requested user");
  });

  it("rejects a page from a different inventory selection", async () => {
    const data = responsibilityFixture(responsibilityOwnerId);
    data.page.nextCursor = "next";
    vi.spyOn(api, "getAgentResponsibility").mockResolvedValueOnce(data).mockResolvedValue({
      ...data, selection: { ...data.selection, id: "different-selection" },
    });
    render(<UserAgentResponsibility objectId={responsibilityOwnerId} />);
    await userEvent.click(await screen.findByRole("button", { name: "Next" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("did not match the selected inventory");
    expect(screen.queryByText("Responsible agent")).not.toBeInTheDocument();
  });

  it.each(["success", "failure"] as const)("retains focused responsibility paging through loading and %s without duplicate requests", async outcome => {
    const first = responsibilityFixture(responsibilityOwnerId, { agentCount: 51 });
    const pending = deferred<api.AgentResponsibilityPage>();
    const read = vi.spyOn(api, "getAgentResponsibility").mockResolvedValueOnce(first).mockReturnValueOnce(pending.promise);
    render(<UserAgentResponsibility objectId={responsibilityOwnerId} />);
    const next = await screen.findByRole("button", { name: "Next" });
    await userEvent.click(next);
    expect(screen.getByRole("button", { name: "Next" })).toBe(next);
    expect(next).toHaveFocus();
    expect(next).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(next);
    expect(read).toHaveBeenCalledTimes(2);
    if (outcome === "failure") {
      await act(async () => pending.reject(new Error("Saved page unavailable")));
      expect(await screen.findByRole("alert")).toHaveTextContent("Saved page unavailable");
      expect(screen.queryByText(/Page 2 .*51 agents/)).not.toBeInTheDocument();
    } else {
      await act(async () => pending.resolve(responsibilityFixture(responsibilityOwnerId, {
        agentCount: 51, pageIndex: 1, selection: first.selection,
      })));
      expect(await screen.findByText("Page 2 · 1 of 51 agents")).toBeVisible();
      expect(screen.getByText("Responsible agent 51")).toBeVisible();
      expect(screen.queryByText("Responsible agent")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Previous" })).toHaveAttribute("aria-disabled", "false");
    }
    expect(screen.getByRole("button", { name: "Next" })).toBe(next);
    expect(next).toHaveFocus();
    expect(next).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(next);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each(["2000-01-01T00:00:00Z", "not-a-date"])("rejects responsibility delivered with expired or invalid selection expiry %s", async expiresAt => {
    const data = responsibilityFixture(responsibilityOwnerId);
    data.selection.expiresAt = expiresAt;
    const read = vi.spyOn(api, "getAgentResponsibility").mockResolvedValue(data);
    const personLoaded = vi.fn();
    render(<UserAgentResponsibility objectId={responsibilityOwnerId} onPersonLoaded={personLoaded} onOpenAgent={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/selection.*expired/i);
    expect(screen.queryByText("Responsible agent")).not.toBeInTheDocument();
    expect(personLoaded).toHaveBeenLastCalledWith(undefined);
    expect(read).toHaveBeenCalledOnce();
  });

  it("expires responsibility while the next page is pending and retries with a fresh first-page selection", async () => {
    const original = responsibilityFixture(responsibilityOwnerId);
    original.selection.expiresAt = new Date(Date.now() + 60_000).toISOString();
    original.page.nextCursor = "next";
    const pending = deferred<api.AgentResponsibilityPage>();
    const read = vi.spyOn(api, "getAgentResponsibility").mockResolvedValueOnce(original)
      .mockReturnValueOnce(pending.promise).mockResolvedValue(responsibilityFixture(responsibilityOwnerId));
    const personLoaded = vi.fn();
    render(<UserAgentResponsibility objectId={responsibilityOwnerId} onPersonLoaded={personLoaded} onOpenAgent={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Next" }));
    const signal = read.mock.calls[1][1]!.signal!;
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(original.selection.expiresAt) + 1);
    fireEvent(window, new Event("focus"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/selection.*expired/i);
    expect(signal.aborted).toBe(true);
    expect(personLoaded).toHaveBeenLastCalledWith(undefined);
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve(original));
    expect(screen.queryByText("Responsible agent")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry saved responsibility" }));
    expect(await screen.findByText("Responsible agent")).toBeVisible();
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls[2][0]).toEqual({ objectId: responsibilityOwnerId, selectionId: undefined, cursor: undefined, limit: 50 });
  });

  it.each(["Open agent Responsible agent", "Next"])("checks expiry before %s even before the timer renders", async action => {
    const data = responsibilityFixture(responsibilityOwnerId);
    data.page.nextCursor = "next";
    const read = vi.spyOn(api, "getAgentResponsibility").mockResolvedValue(data);
    const open = vi.fn();
    render(<UserAgentResponsibility objectId={responsibilityOwnerId} onOpenAgent={open} />);
    await screen.findByText("Responsible agent");
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(data.selection.expiresAt) + 1);
    fireEvent.click(screen.getByRole("button", { name: action }));
    expect(open).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledOnce();
    expect(await screen.findByRole("alert")).toHaveTextContent(/selection.*expired/i);
    expect(screen.queryByText("Responsible agent")).not.toBeInTheDocument();
  });

  it("discards the previous account's cursor even when returning to that account", async () => {
    const data = responsibilityFixture(responsibilityOwnerId);
    data.page.nextCursor = "next";
    const read = vi.spyOn(api, "getAgentResponsibility").mockResolvedValue(data);
    const view = render(scope(<UserAgentResponsibility objectId={responsibilityOwnerId} />));
    await userEvent.click(await screen.findByRole("button", { name: "Next" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    view.rerender(scope(<UserAgentResponsibility objectId={responsibilityOwnerId} />, "other-reader"));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    view.rerender(scope(<UserAgentResponsibility objectId={responsibilityOwnerId} />));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(4));
    expect(read.mock.calls[3][0]).toEqual({ objectId: responsibilityOwnerId, selectionId: undefined, cursor: undefined, limit: 50 });
  });

  it("shares concurrent saved reads without one departing reader cancelling its peer", async () => {
    const client = createSavedQueryClient();
    const pending = deferred<api.AgentResponsibilityPage>();
    const read = vi.spyOn(api, "getAgentResponsibility").mockReturnValue(pending.promise);
    const panels = (first: boolean) => <SavedQueryProvider client={client}>
      {first ? <section key="first" aria-label="First reader"><UserAgentResponsibility objectId={responsibilityOwnerId} /></section> : null}
      <section key="second" aria-label="Second reader"><UserAgentResponsibility objectId={responsibilityOwnerId} /></section>
    </SavedQueryProvider>;
    const view = render(panels(true));
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    const signal = read.mock.calls[0][1]!.signal!;
    view.rerender(panels(false));
    expect(signal.aborted).toBe(false);
    await act(async () => pending.resolve(responsibilityFixture(responsibilityOwnerId)));
    expect(await within(screen.getByRole("region", { name: "Second reader" })).findByText("Responsible agent")).toBeVisible();
    expect(read).toHaveBeenCalledOnce();
    view.unmount();
    client.clear();
  });

  it("revalidates shared saved responsibility without duplicate reads or reloads on equivalent renders", async () => {
    const client = createSavedQueryClient();
    const next = deferred<api.AgentResponsibilityPage>();
    const read = vi.spyOn(api, "getAgentResponsibility").mockResolvedValueOnce(responsibilityFixture(responsibilityOwnerId))
      .mockReturnValueOnce(next.promise);
    const panels = (second: boolean) => <SavedQueryProvider client={client}>
      <section key="first" aria-label="First reader"><UserAgentResponsibility objectId={responsibilityOwnerId} /></section>
      {second ? <section key="second" aria-label="Second reader"><UserAgentResponsibility objectId={responsibilityOwnerId.toUpperCase()} /></section> : null}
    </SavedQueryProvider>;
    const view = render(panels(false));
    await screen.findByText("Responsible agent");
    view.rerender(panels(true));
    await waitFor(() => expect(screen.getAllByText("Responsible agent")).toHaveLength(2));
    expect(read).toHaveBeenCalledOnce();
    const current = responsibilityFixture(responsibilityOwnerId);
    current.selected!.agents[0].displayName = "Current responsibility";
    await act(async () => { void client.invalidateQueries({ queryKey: ["saved"] }); });
    expect(read).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getAllByText(/Refreshing saved responsibility/)).toHaveLength(2));
    await act(async () => next.resolve(current));
    await waitFor(() => expect(screen.getAllByText("Current responsibility")).toHaveLength(2));
    expect(screen.queryByText("Responsible agent")).not.toBeInTheDocument();
    fireEvent(window, new Event("focus"));
    expect(read).toHaveBeenCalledTimes(2);
    view.unmount();
    client.clear();
  });

  it("expires mounted evidence on its timer without silently reloading or leaving identity labels", async () => {
    vi.useFakeTimers();
    const data = responsibilityFixture(responsibilityOwnerId);
    data.selection.expiresAt = new Date(Date.now() + 1_000).toISOString();
    const read = vi.spyOn(api, "getAgentResponsibility").mockResolvedValue(data);
    const personLoaded = vi.fn();
    render(<UserAgentResponsibility objectId={responsibilityOwnerId} onPersonLoaded={personLoaded} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(screen.getByText("Responsible agent")).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByRole("alert")).toHaveTextContent(/selection.*expired/i);
    expect(personLoaded).toHaveBeenLastCalledWith(undefined);
    expect(screen.queryByText("Responsible agent")).not.toBeInTheDocument();
    expect(read).toHaveBeenCalledOnce();
  });

  it.each(["revision", "cache"] as const)("withdraws an expired retained page without cancelling a fresh %s capture", async refresh => {
    vi.useFakeTimers();
    const client = createSavedQueryClient();
    const original = responsibilityFixture(responsibilityOwnerId);
    original.selection.expiresAt = new Date(Date.now() + 1_000).toISOString();
    const pending = deferred<api.AgentResponsibilityPage>();
    const read = vi.spyOn(api, "getAgentResponsibility").mockResolvedValueOnce(original).mockReturnValueOnce(pending.promise);
    const personLoaded = vi.fn();
    const panel = (dataRevision = 0) => <SavedQueryProvider client={client}>
      <UserAgentResponsibility objectId={responsibilityOwnerId} dataRevision={dataRevision} onPersonLoaded={personLoaded} />
    </SavedQueryProvider>;
    const view = render(panel());
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    if (refresh === "revision") view.rerender(panel(1));
    else await act(async () => { void client.invalidateQueries({ queryKey: ["saved"] }); await vi.advanceTimersByTimeAsync(10); });
    expect(screen.getByText("Responsible agent")).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.queryByText("Responsible agent")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Loading saved responsibility");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(personLoaded).toHaveBeenLastCalledWith(undefined);
    expect(read.mock.calls[1][1]!.signal!.aborted).toBe(false);
    await act(async () => {
      pending.resolve(responsibilityFixture(responsibilityOwnerId));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByText("Responsible agent")).toBeVisible();
    expect(read).toHaveBeenCalledTimes(2);
    view.unmount();
    client.clear();
  });

  it.each([
    new api.ApiError(401, "authentication_required", "Session expired"),
    new api.ApiError(403, "forbidden", "Saved access denied"),
    new api.ApiError(409, "selection_invalidated", "Selection changed"),
  ])("does not replay $code through cache invalidation and admits only one explicit retry", async failure => {
    const client = createSavedQueryClient();
    const pending = deferred<api.AgentResponsibilityPage>();
    const read = vi.spyOn(api, "getAgentResponsibility").mockRejectedValueOnce(failure).mockReturnValueOnce(pending.promise);
    const view = render(<SavedQueryProvider client={client}><UserAgentResponsibility objectId={responsibilityOwnerId} /></SavedQueryProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent(failure.message);
    await act(async () => { await client.invalidateQueries({ queryKey: ["saved"] }); });
    expect(read).toHaveBeenCalledOnce();
    const retry = screen.getByRole("button", { name: "Retry saved responsibility" });
    act(() => { fireEvent.click(retry); fireEvent.click(retry); });
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Loading saved responsibility");
    await act(async () => pending.resolve(responsibilityFixture(responsibilityOwnerId)));
    expect(await screen.findByText("Responsible agent")).toBeVisible();
    view.unmount();
    client.clear();
  });

  it("retires sibling pages of a rejected selection without replaying it on invalidation", async () => {
    const client = createSavedQueryClient();
    const first = responsibilityFixture(responsibilityOwnerId);
    first.page.nextCursor = "next";
    const next = deferred<api.AgentResponsibilityPage>();
    const read = vi.spyOn(api, "getAgentResponsibility").mockResolvedValueOnce(first).mockReturnValueOnce(next.promise);
    const view = render(<SavedQueryProvider client={client}>
      <section aria-label="First reader"><UserAgentResponsibility objectId={responsibilityOwnerId} /></section>
      <section aria-label="Second reader"><UserAgentResponsibility objectId={responsibilityOwnerId} /></section>
    </SavedQueryProvider>);
    const firstReader = within(screen.getByRole("region", { name: "First reader" }));
    const secondReader = within(screen.getByRole("region", { name: "Second reader" }));
    await userEvent.click(await firstReader.findByRole("button", { name: "Next" }));
    await act(async () => next.reject(new api.ApiError(409, "selection_invalidated", "Inventory changed")));
    expect(await firstReader.findByRole("alert")).toHaveTextContent("Inventory changed");
    expect(await secondReader.findByRole("alert")).toHaveTextContent(/selection changed or expired/);
    expect(screen.queryByText("Responsible agent")).not.toBeInTheDocument();
    await act(async () => { await client.invalidateQueries({ queryKey: ["saved"] }); });
    expect(read).toHaveBeenCalledTimes(2);
    view.unmount();
    client.clear();
  });

  it("makes cancellation recoverable and does not let late cancelled results replace the retry", async () => {
    const client = createSavedQueryClient();
    const pending = deferred<api.AgentResponsibilityPage>();
    const current = responsibilityFixture(responsibilityOwnerId);
    current.selected!.agents[0].displayName = "Current responsibility";
    const read = vi.spyOn(api, "getAgentResponsibility").mockReturnValueOnce(pending.promise).mockResolvedValueOnce(current);
    const view = render(<SavedQueryProvider client={client}><UserAgentResponsibility objectId={responsibilityOwnerId} /></SavedQueryProvider>);
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    await act(async () => { await client.cancelQueries({ queryKey: ["saved"] }); });
    expect(read.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(await screen.findByRole("alert")).toHaveTextContent(/cancelled/);
    await userEvent.click(screen.getByRole("button", { name: "Retry saved responsibility" }));
    expect(await screen.findByText("Current responsibility")).toBeVisible();
    await act(async () => pending.resolve(responsibilityFixture(responsibilityOwnerId)));
    expect(screen.queryByText("Responsible agent")).not.toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
    view.unmount();
    client.clear();
  });

  it.each([false, true])("withdraws cancelled shared cache revalidation before stale actions and retries only once (notified=%s)", async notified => {
    const client = createSavedQueryClient();
    const original = responsibilityFixture(responsibilityOwnerId, { agentCount: 51 });
    const pending = deferred<api.AgentResponsibilityPage>();
    const fresh = responsibilityFixture(responsibilityOwnerId);
    fresh.selected!.agents[0].displayName = "Current responsibility";
    const read = vi.spyOn(api, "getAgentResponsibility").mockResolvedValueOnce(original)
      .mockReturnValueOnce(pending.promise).mockResolvedValueOnce(fresh);
    const personLoaded = vi.fn(), open = vi.fn();
    const view = render(<SavedQueryProvider client={client}>
      <UserAgentResponsibility objectId={responsibilityOwnerId} onPersonLoaded={personLoaded} onOpenAgent={open} />
    </SavedQueryProvider>);
    const link = await screen.findByRole("button", { name: "Open agent Responsible agent" });
    const next = screen.getByRole("button", { name: "Next" });
    if (notified) {
      act(() => { void client.invalidateQueries({ queryKey: ["saved"] }); });
      await screen.findByText(/Refreshing saved responsibility/);
    }
    act(() => {
      if (!notified) void client.invalidateQueries({ queryKey: ["saved"] });
      void client.cancelQueries({ queryKey: ["saved"] });
      fireEvent.click(link);
      fireEvent.click(next);
    });
    expect(open).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1][1]!.signal!.aborted).toBe(true);
    expect(await screen.findByRole("alert")).toHaveTextContent(/needs reloading/);
    expect(screen.queryByText("Responsible agent")).not.toBeInTheDocument();
    expect(personLoaded).toHaveBeenLastCalledWith(undefined);
    expect(screen.getByRole("navigation", { name: "Responsibility pages" })).toHaveTextContent("Responsibility page unavailable");
    fireEvent(window, new Event("focus"));
    await act(async () => pending.resolve(original));
    expect(screen.queryByText("Responsible agent")).not.toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
    const retry = screen.getByRole("button", { name: "Retry saved responsibility" });
    act(() => { fireEvent.click(retry); fireEvent.click(retry); });
    expect(await screen.findByText("Current responsibility")).toBeVisible();
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls[2][0]).toEqual({ objectId: responsibilityOwnerId, selectionId: undefined, cursor: undefined, limit: 50 });
    view.unmount();
    client.clear();
  });

  it.each(["revision", "evaluatedAt", "expiresAt"] as const)("rejects changed %s on a pinned responsibility page", async field => {
    const first = responsibilityFixture(responsibilityOwnerId, { agentCount: 51 });
    const next = responsibilityFixture(responsibilityOwnerId, { agentCount: 51, pageIndex: 1, selection: first.selection });
    next.selection[field] = field === "revision" ? "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
      : new Date(Date.parse(first.selection[field]) + 60_000).toISOString();
    const read = vi.spyOn(api, "getAgentResponsibility").mockResolvedValueOnce(first).mockResolvedValueOnce(next);
    const personLoaded = vi.fn();
    render(<UserAgentResponsibility objectId={responsibilityOwnerId} onPersonLoaded={personLoaded} />);
    await userEvent.click(await screen.findByRole("button", { name: "Next" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/did not match the selected inventory/);
    expect(screen.queryByText("Responsible agent")).not.toBeInTheDocument();
    expect(personLoaded).toHaveBeenLastCalledWith(undefined);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each(["dataRevision", "agentInventoryRevision"] as const)(
    "withdraws retained relationships and permits a fresh retry when a %s refresh is cancelled", async revisionProp => {
      const client = createSavedQueryClient();
      const pending = deferred<api.AgentResponsibilityPage>();
      const current = responsibilityFixture(responsibilityOwnerId);
      current.selected!.agents[0].displayName = "Current responsibility";
      const read = vi.spyOn(api, "getAgentResponsibility").mockResolvedValueOnce(responsibilityFixture(responsibilityOwnerId))
        .mockReturnValueOnce(pending.promise).mockResolvedValueOnce(current);
      const personLoaded = vi.fn();
      const panel = (revision = 0) => <SavedQueryProvider client={client}>
        <UserAgentResponsibility objectId={responsibilityOwnerId} {...{ [revisionProp]: revision }}
          onPersonLoaded={personLoaded} onOpenAgent={vi.fn()} />
      </SavedQueryProvider>;
      const view = render(panel());
      await screen.findByText("Responsible agent");
      view.rerender(panel(1));
      expect(screen.getByText("Responsible agent")).toBeVisible();
      await act(async () => { await client.cancelQueries({ queryKey: ["saved"] }); });
      expect(read.mock.calls[1][1]!.signal!.aborted).toBe(true);
      expect(await screen.findByRole("alert")).toHaveTextContent(/cancelled/);
      expect(screen.queryByText("Responsible agent")).not.toBeInTheDocument();
      expect(personLoaded).toHaveBeenLastCalledWith(undefined);
      await userEvent.click(screen.getByRole("button", { name: "Retry saved responsibility" }));
      expect(await screen.findByText("Current responsibility")).toBeVisible();
      await act(async () => pending.resolve(responsibilityFixture(responsibilityOwnerId)));
      expect(screen.queryByText("Responsible agent")).not.toBeInTheDocument();
      expect(read).toHaveBeenCalledTimes(3);
      expect(read.mock.calls[2][0]).toEqual({ objectId: responsibilityOwnerId, selectionId: undefined, cursor: undefined, limit: 50 });
      view.unmount();
      client.clear();
    },
  );

  it("withdraws a rejected placeholder selection without cancelling its fresh revision capture", async () => {
    const client = createSavedQueryClient();
    const first = responsibilityFixture(responsibilityOwnerId);
    first.page.nextCursor = "next";
    const capture = deferred<api.AgentResponsibilityPage>(), page = deferred<api.AgentResponsibilityPage>();
    const read = vi.spyOn(api, "getAgentResponsibility").mockResolvedValueOnce(first)
      .mockReturnValueOnce(capture.promise).mockReturnValueOnce(page.promise);
    const personLoaded = vi.fn(), open = vi.fn();
    const panels = (revision = 0) => <SavedQueryProvider client={client}>
      <section aria-label="First reader"><UserAgentResponsibility objectId={responsibilityOwnerId}
        dataRevision={revision} onPersonLoaded={personLoaded} onOpenAgent={open} /></section>
      <section aria-label="Second reader"><UserAgentResponsibility objectId={responsibilityOwnerId} /></section>
    </SavedQueryProvider>;
    const view = render(panels());
    const firstReader = within(screen.getByRole("region", { name: "First reader" }));
    const secondReader = within(screen.getByRole("region", { name: "Second reader" }));
    await firstReader.findByText("Responsible agent");
    view.rerender(panels(1));
    expect(firstReader.getByText("Responsible agent")).toBeVisible();
    await userEvent.click(secondReader.getByRole("button", { name: "Next" }));
    const staleLink = firstReader.getByRole("button", { name: "Open agent Responsible agent" });
    const clickBeforeNotification = vi.fn(() => fireEvent.click(staleLink));
    const unsubscribe = client.getQueryCache().subscribe(event => {
      if (event.type === "updated" && event.query.queryKey[7] === first.selection.id
        && event.query.state.error instanceof api.ApiError && event.query.state.error.code === "selection_invalidated") clickBeforeNotification();
    });
    await act(async () => page.reject(new api.ApiError(409, "selection_invalidated", "Inventory changed")));
    unsubscribe();
    expect(clickBeforeNotification).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    expect(await secondReader.findByRole("alert")).toHaveTextContent("Inventory changed");
    await waitFor(() => expect(firstReader.queryByText("Responsible agent")).not.toBeInTheDocument());
    expect(personLoaded).toHaveBeenLastCalledWith(undefined);
    expect(firstReader.getByRole("status")).toHaveTextContent("Loading saved responsibility");
    expect(firstReader.queryByRole("alert")).not.toBeInTheDocument();
    expect(read.mock.calls[1][1]!.signal!.aborted).toBe(false);
    const fresh = responsibilityFixture(responsibilityOwnerId);
    fresh.selection.id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    fresh.selected!.agents[0].displayName = "Current responsibility";
    await act(async () => capture.resolve(fresh));
    expect(await firstReader.findByText("Current responsibility")).toBeVisible();
    expect(read).toHaveBeenCalledTimes(3);
    view.unmount();
    client.clear();
  });

  it.each(["cancelled", "denied", "invalidated", "failed"] as const)(
    "does not resurrect retained relationships on a later revision after the previous refresh was %s", async failure => {
      const client = createSavedQueryClient();
      const failed = deferred<api.AgentResponsibilityPage>(), pending = deferred<api.AgentResponsibilityPage>();
      const read = vi.spyOn(api, "getAgentResponsibility").mockResolvedValueOnce(responsibilityFixture(responsibilityOwnerId))
        .mockReturnValueOnce(failed.promise).mockReturnValueOnce(pending.promise);
      const personLoaded = vi.fn();
      const panel = (revision = 0) => <SavedQueryProvider client={client}>
        <UserAgentResponsibility objectId={responsibilityOwnerId} dataRevision={revision} onPersonLoaded={personLoaded} />
      </SavedQueryProvider>;
      const view = render(panel());
      await screen.findByText("Responsible agent");
      view.rerender(panel(1));
      await act(async () => {
        if (failure === "cancelled") await client.cancelQueries({ queryKey: ["saved"] });
        else failed.reject(failure === "denied" ? new api.ApiError(403, "forbidden", "Access denied")
          : failure === "invalidated" ? new api.ApiError(409, "selection_invalidated", "Selection changed") : new Error("Read failed"));
      });
      await screen.findByRole("alert");
      view.rerender(panel(2));
      expect(screen.queryByText("Responsible agent")).not.toBeInTheDocument();
      expect(personLoaded).toHaveBeenLastCalledWith(undefined);
      expect(screen.getByRole("status")).toHaveTextContent("Loading saved responsibility");
      const fresh = responsibilityFixture(responsibilityOwnerId);
      fresh.selected!.agents[0].displayName = "Current responsibility";
      await act(async () => {
        failed.resolve(responsibilityFixture(responsibilityOwnerId));
        pending.resolve(fresh);
      });
      expect(await screen.findByText("Current responsibility")).toBeVisible();
      expect(read).toHaveBeenCalledTimes(3);
      view.unmount();
      client.clear();
    },
  );

  it("does not supersede pending revalidation with paging before observer notification", async () => {
    const client = createSavedQueryClient();
    const data = responsibilityFixture(responsibilityOwnerId);
    data.page.nextCursor = "next";
    const pending = deferred<api.AgentResponsibilityPage>();
    const read = vi.spyOn(api, "getAgentResponsibility").mockResolvedValueOnce(data).mockReturnValueOnce(pending.promise);
    const view = render(<SavedQueryProvider client={client}><UserAgentResponsibility objectId={responsibilityOwnerId} /></SavedQueryProvider>);
    const next = await screen.findByRole("button", { name: "Next" });
    act(() => { void client.invalidateQueries({ queryKey: ["saved"] }); fireEvent.click(next); });
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1][0]?.cursor).toBeUndefined();
    expect(read.mock.calls[1][1]!.signal!.aborted).toBe(false);
    await act(async () => pending.resolve(data));
    await screen.findByText("Responsible agent");
    view.unmount();
    client.clear();
  });

  it("does not replace an already-admitted saved retry through a stale error button", async () => {
    const client = createSavedQueryClient();
    const pending = deferred<api.AgentResponsibilityPage>();
    const read = vi.spyOn(api, "getAgentResponsibility").mockRejectedValueOnce(new Error("Read failed")).mockReturnValueOnce(pending.promise);
    const view = render(<SavedQueryProvider client={client}><UserAgentResponsibility objectId={responsibilityOwnerId} /></SavedQueryProvider>);
    const retry = await screen.findByRole("button", { name: "Retry saved responsibility" });
    act(() => { void client.invalidateQueries({ queryKey: ["saved"] }); fireEvent.click(retry); });
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1][1]!.signal!.aborted).toBe(false);
    await act(async () => pending.resolve(responsibilityFixture(responsibilityOwnerId)));
    expect(await screen.findByText("Responsible agent")).toBeVisible();
    view.unmount();
    client.clear();
  });

  it("does not reload equivalent identity/role spelling and accepts case-equivalent selection replies", async () => {
    const original = responsibilityFixture(responsibilityOwnerId, { agentCount: 51 });
    const next = responsibilityFixture(responsibilityOwnerId, { agentCount: 51, pageIndex: 1, selection: original.selection });
    next.selected!.person.objectId = responsibilityOwnerId.toUpperCase();
    next.selection.id = original.selection.id.toUpperCase();
    const read = vi.spyOn(api, "getAgentResponsibility").mockResolvedValueOnce(original).mockResolvedValueOnce(next);
    const view = render(scope(<UserAgentResponsibility objectId={responsibilityOwnerId} />,
      "reader", ["AgentControl.Viewer", "AgentControl.Admin"]));
    await screen.findByText("Responsible agent");
    view.rerender(scope(<UserAgentResponsibility objectId={responsibilityOwnerId.toUpperCase()} />,
      "reader", ["AgentControl.Admin", "AgentControl.Viewer"]));
    expect(read).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Responsible agent 51")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("fences a replaced same-account saved-query session and aborts its last reader", async () => {
    const first = createSavedQueryClient(), second = createSavedQueryClient();
    const pending = deferred<api.AgentResponsibilityPage>();
    const current = responsibilityFixture(responsibilityOwnerId);
    current.selected!.agents[0].displayName = "Current session";
    const read = vi.spyOn(api, "getAgentResponsibility").mockReturnValueOnce(pending.promise).mockResolvedValue(current);
    const panels = (client: typeof first) => <SavedQueryProvider client={client}>{scope(<UserAgentResponsibility objectId={responsibilityOwnerId} />)}</SavedQueryProvider>;
    const view = render(panels(first));
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    view.rerender(panels(second));
    expect(await screen.findByText("Current session")).toBeVisible();
    expect(read.mock.calls[0][1]!.signal!.aborted).toBe(true);
    await act(async () => pending.resolve(responsibilityFixture(responsibilityOwnerId)));
    expect(screen.queryByText("Responsible agent")).not.toBeInTheDocument();
    view.unmount();
    first.clear(); second.clear();
  });
});
