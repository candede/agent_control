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
  it("keeps responsibility outside usage/licensing and navigates the exact canonical agent without provider calls", async () => {
    const read = vi.spyOn(api, "getAgentResponsibility").mockResolvedValue(responsibilityFixture(responsibilityOwnerId));
    const lookup = vi.spyOn(api, "resolveAgentPeople");
    const open = vi.fn();
    render(scope(<UserAgentResponsibility objectId={responsibilityOwnerId} onOpenAgent={open} />));
    await userEvent.click(await screen.findByRole("button", { name: "Open agent Responsible agent" }));
    expect(open).toHaveBeenCalledWith(responsibilityAgentId);
    expect(read).toHaveBeenCalledOnce();
    expect(lookup).not.toHaveBeenCalled();
    expect(screen.getByText(/Partial responsibility coverage/)).toBeVisible();
    expect(screen.getByText(/not usage, access assignments or permission/)).toBeVisible();
  });

  it.each([undefined, "Alice", "alice@example.invalid", "aaaaaaaa"])("does not guess directory IDs for %s", async objectId => {
    const read = vi.spyOn(api, "getAgentResponsibility");
    render(<UserAgentResponsibility objectId={objectId} />);
    expect(screen.getByText(/Responsibility unavailable: no exact verified directory object ID/)).toBeVisible();
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["not_found", "lookup_failed"] as const)("preserves %s evidence rather than manufacturing a resolved profile", async status => {
    const data = responsibilityFixture(responsibilityOwnerId);
    data.selected!.person.evidence = { ...data.selected!.person.evidence!, displayName: null, userPrincipalName: null, status, errorCode: "provider_error" };
    vi.spyOn(api, "getAgentResponsibility").mockResolvedValue(data);
    render(<UserAgentResponsibility objectId={responsibilityOwnerId} />);
    expect(await screen.findByText(status === "not_found" ? /User not found at the last/ : /Directory lookup failed \(provider_error\)/)).toBeVisible();
    expect(screen.queryByText("Resolved saved directory identity.")).not.toBeInTheDocument();
  });

  it.each(["unavailable", "no_reported_relationships"] as const)("does not convert %s into confirmed absence", async state => {
    const data = responsibilityFixture(responsibilityOwnerId);
    data.selected = { ...data.selected!, state, agents: [], count: 0 };
    data.coverage = state === "unavailable" ? "unavailable" : "partial";
    vi.spyOn(api, "getAgentResponsibility").mockResolvedValue(data);
    render(<UserAgentResponsibility objectId={responsibilityOwnerId} />);
    expect(await screen.findByText(state === "unavailable" ? /relationships are unknown, not zero/ : /This is not proof of no responsibility elsewhere/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Open agent/ })).not.toBeInTheDocument();
  });

  it("keeps expired identity evidence explicit without automatically looking it up again", async () => {
    const data = responsibilityFixture(responsibilityOwnerId);
    data.selected!.person.evidence!.expiresAt = "2000-01-01T00:00:00Z";
    const read = vi.spyOn(api, "getAgentResponsibility").mockResolvedValue(data);
    const lookup = vi.spyOn(api, "resolveAgentPeople");
    render(<UserAgentResponsibility objectId={responsibilityOwnerId} />);
    expect(await screen.findByText(/Saved lookup expired; identity is unverified/)).toBeVisible();
    expect(screen.queryByText("Resolved saved directory identity.")).not.toBeInTheDocument();
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
    await screen.findByText("Responsible only");
    expect(signal.aborted).toBe(true);
    await act(async () => finish(responsibilityFixture(responsibilityOwnerId)));
    expect(screen.queryByText(`ID: ${responsibilityOwnerId}`)).not.toBeInTheDocument();
    view.rerender(scope(<UserAgentResponsibility objectId="cccccccc-cccc-4ccc-8ccc-cccccccccccc" />, "other-reader", []));
    expect(screen.getByRole("alert")).toHaveTextContent("current Viewer access");
    expect(screen.queryByText("Responsible only")).not.toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("retains relationships while reloading, but clears them on a permission error and retries only saved reads", async () => {
    const read = vi.spyOn(api, "getAgentResponsibility").mockResolvedValueOnce(responsibilityFixture(responsibilityOwnerId))
      .mockRejectedValueOnce(new api.ApiError(403, "forbidden", "Saved access denied"))
      .mockResolvedValue(responsibilityFixture(responsibilityOwnerId));
    const view = render(<UserAgentResponsibility objectId={responsibilityOwnerId} />);
    await screen.findByText("Responsible only");
    view.rerender(<UserAgentResponsibility objectId={responsibilityOwnerId} dataRevision={1} />);
    expect(screen.getByText("Responsible only")).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved access denied");
    expect(screen.queryByText("Responsible only")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry saved responsibility" }));
    expect(await screen.findByText("Responsible only")).toBeVisible();
    expect(read).toHaveBeenCalledTimes(3);
  });

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
      view.rerender(scope(<UserAgentResponsibility objectId={responsibilityOwnerId} onOpenAgent={open} {...{ [revisionProp]: 1 }} />));
      expect(screen.getByText("Responsible agent")).toBeVisible();
      expect(screen.getByRole("button", { name: "Open agent Responsible agent" })).toBeEnabled();
      expect(screen.queryByText("Loading saved responsibility...")).not.toBeInTheDocument();
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

  it("pages both people and agents server-side and rejects cross-person responses", async () => {
    const data = responsibilityFixture();
    data.count = 51;
    const read = vi.spyOn(api, "getAgentResponsibility").mockResolvedValue(data);
    const change = vi.fn();
    const route = { view: "responsibility" as const, search: "", page: 0 };
    const view = render(<UserAgentResponsibility route={route} onRouteChange={change} />);
    await userEvent.click(await screen.findByRole("button", { name: "Next" }));
    expect(change).toHaveBeenCalledWith({ ...route, page: 1 });
    view.rerender(<UserAgentResponsibility route={{ ...route, page: 1 }} onRouteChange={change} />);
    await waitFor(() => expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50 }), expect.anything()));
    read.mockResolvedValue(responsibilityFixture("cccccccc-cccc-4ccc-8ccc-cccccccccccc"));
    view.rerender(<UserAgentResponsibility objectId={responsibilityOwnerId} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("did not match the exact requested user");
  });
});
