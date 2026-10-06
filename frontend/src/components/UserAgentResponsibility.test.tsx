import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import * as api from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { responsibilityAgentId, responsibilityFixture, responsibilityOwnerId } from "../test/agentResponsibilityFixture";
import { UserAgentResponsibility } from "./UserAgentResponsibility";

afterEach(() => vi.restoreAllMocks());

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
    const data = responsibilityFixture(responsibilityOwnerId);
    data.selected = { ...data.selected!, state, agents: [], count: 0 };
    if (state === "unavailable") data.sources.powerPlatform = { state: "unavailable", observation: null,
      error: { source: "power_platform", code: "snapshot_unavailable", message: "No saved agent inventory." } };
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
    const data = responsibilityFixture(responsibilityOwnerId);
    data.selected!.count = 51;
    data.page.nextCursor = "next-responsibility-page";
    const read = vi.spyOn(api, "getAgentResponsibility").mockResolvedValue(data);
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
});
