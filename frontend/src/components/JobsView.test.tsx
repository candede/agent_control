import { act, render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workbenchActions } from "../../../backend/src/services/workbenchMetadata";
import { CapabilityContext } from "../capabilityContext";
import { WorkbenchActionProvider } from "../workbenchActionContext";
import { JobsView } from "./JobsView";

function render(ui: ReactNode) {
  const wrap = (children: ReactNode) => <CapabilityContext value={capabilityContext}>
    <WorkbenchActionProvider value={workbenchActions}>{children}</WorkbenchActionProvider>
  </CapabilityContext>;
  const result = rtlRender(wrap(ui));
  return { ...result, rerender: (next: ReactNode) => result.rerender(wrap(next)) };
}

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const user = {
  displayName: "Admin",
  username: "admin@example.invalid",
  homeAccountId: "principal",
  tenantId: "tenant",
  roles: ["AgentControl.Admin"],
} as const;

const capabilityContext = {
  views: [],
  user: { ...user, roles: [...user.roles] },
  loading: false,
  now: Date.now(),
  reload: vi.fn(),
  openPermissions: vi.fn(),
} as never;

const emptyProjection = { value: [], unavailableSources: [], polledAt: "2026-09-10T07:00:00.000Z", requestId: "request-1" };

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(Response.json(emptyProjection));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("JobsView", () => {
  it("limits embedded sync history to collection/import sources and opens exact sync runs without reloading", async () => {
    fetchMock.mockResolvedValue(Response.json({
      ...emptyProjection,
      value: [
        { id: "sync-history", source: "data-sync", label: "Retained sync", target: "4 saved-data sources",
          status: "completed", total: 4, completed: 4, partial: false, canResume: false, canCancel: false,
          canReconcile: false, updatedAt: emptyProjection.polledAt, href: "/sync?syncRun=sync-history" },
        { id: "mutation-history", source: "package-controls", label: "Package mutation", target: "1 target",
          status: "completed", total: 1, completed: 1, partial: false, canResume: false, canCancel: false,
          canReconcile: false, updatedAt: emptyProjection.polledAt, href: "/agents?controlJob=mutation-history" },
      ],
      unavailableSources: [{ source: "defender", code: "source_unavailable" }],
    }));
    const onOpenSyncRun = vi.fn();
    render(<JobsView user={{ ...user, roles: ["AgentControl.Admin"] }} scope="sync" onOpenSyncRun={onOpenSyncRun} />);
    expect(await screen.findByText("Retained sync")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Sync history" })).toBeVisible();
    expect(screen.queryByText("Package mutation")).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Package controls" })).not.toBeInTheDocument();
    expect(screen.queryByText(/authorized source.*temporarily unavailable/)).not.toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Sync run history" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry incomplete" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: /View details for Retained sync/ }));
    expect(onOpenSyncRun).toHaveBeenCalledWith("sync-history");
  });

  it("loads one backend-minimized authorized projection", async () => {
    render(<JobsView user={{ ...user, roles: [...user.roles] }} />);
    expect(await screen.findByText(/No retained jobs are visible/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/workbench/jobs", expect.objectContaining({ credentials: "include", signal: expect.any(AbortSignal) }));
    expect(screen.getByText(/request request-1/)).toBeInTheDocument();
  });

  it("does not replace refreshed sync history with an aborted older response", async () => {
    let resolveOld!: (response: Response) => void;
    const entry = (label: string) => ({
      id: label, label, source: "data-sync", target: "1 source", status: "completed",
      total: 1, completed: 1, partial: false, canResume: false, canCancel: false, canReconcile: false,
      updatedAt: emptyProjection.polledAt, href: `/sync?syncRun=${label}`,
    });
    fetchMock.mockReturnValueOnce(new Promise<Response>(resolve => { resolveOld = resolve; }))
      .mockResolvedValue(Response.json({ ...emptyProjection, value: [entry("New history")] }));
    render(<JobsView user={{ ...user, roles: ["AgentControl.Viewer"] }} scope="sync" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    await userEvent.click(screen.getByRole("button", { name: "Refresh history" }));
    expect(signal.aborted).toBe(true);
    expect(await screen.findByText("New history")).toBeVisible();
    await act(async () => resolveOld(Response.json({ ...emptyProjection, value: [entry("Old history")] })));
    expect(screen.getByText("New history")).toBeVisible();
    expect(screen.queryByText("Old history")).not.toBeInTheDocument();
  });

  it("routes package control recovery without exposing result bodies", async () => {
    const projection = { ...emptyProjection, value: [{
      id: "bulk-job", source: "package-controls", label: "Package block", target: "1 exact Graph package target",
      status: "waiting_authorization", total: 1, completed: 0, partial: false, canResume: true, canCancel: true,
      canReconcile: false, updatedAt: "2026-09-10T07:00:00.000Z", href: "/agents?controlJob=bulk-job",
    }] };
    fetchMock.mockImplementation(async (input: string) => input === "/api/workbench/jobs"
      ? Response.json(projection)
      : input === "/api/agents/bulk-jobs/bulk-job/resume" ? Response.json({ id: "bulk-job" })
      : Promise.reject(new Error(`Unexpected request ${input}`)));
    const input = userEvent.setup();
    render(<JobsView user={{ ...user, roles: ["AgentControl.Admin"] }} />);
    await input.click(await screen.findByRole("button", { name: /Resume unsent/ }));
    expect(fetchMock).toHaveBeenCalledWith("/api/agents/bulk-jobs/bulk-job/resume", expect.objectContaining({ method: "POST" }));
    expect(screen.queryByText(/result bodies/i)).not.toBeInTheDocument();
  });

  it("does not poll waiting-authorization jobs and preserves partial source success", async () => {
    fetchMock.mockResolvedValue(Response.json({
      ...emptyProjection,
      value: [{ id: "audit-job", source: "purview", label: "Purview Audit Search", target: "fixed preset",
        status: "waiting_authorization", total: null, completed: 0, partial: false, canResume: true, canCancel: true,
        canReconcile: false, updatedAt: "2026-09-10T07:00:00.000Z", href: "/audit?job=audit-job" }],
      unavailableSources: [{ source: "defender", code: "source_unavailable" }],
    }));
    render(<JobsView user={{ ...user, roles: ["AgentControl.Viewer"] }} />);
    expect(await screen.findByText(/1 authorized source is temporarily unavailable/)).toBeInTheDocument();
    await new Promise(resolve => window.setTimeout(resolve, 2_100));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lets Viewer manage read-job lifecycle but hides mutation jobs and controls", async () => {
    fetchMock.mockResolvedValue(Response.json({
      ...emptyProjection,
      value: [
        { id: "audit-job", source: "purview", label: "Purview Audit Search", target: "fixed preset",
          status: "waiting_authorization", total: null, completed: 0, partial: false, canResume: true, canCancel: false,
          canReconcile: false, updatedAt: "2026-09-10T07:00:00.000Z", href: "/audit?job=audit-job" },
        { id: "mutation-job", source: "package-controls", label: "Package block", target: "1 exact target",
          status: "waiting_authorization", total: 1, completed: 0, partial: false, canResume: true, canCancel: true,
          canReconcile: true, updatedAt: "2026-09-10T07:00:00.000Z", href: "/agents?controlJob=mutation-job" },
      ],
    }));
    render(<JobsView user={{ ...user, roles: ["AgentControl.Viewer"] }} />);

    expect(await screen.findByText("Purview Audit Search")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Resume unsent/ })).toBeInTheDocument();
    expect(screen.queryByText("Package block")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /GET-only reconcile/ })).not.toBeInTheDocument();
  });

  it("lets a Viewer retry incomplete data-sync sources and cancel the server-owned run", async () => {
    const projection = {
      ...emptyProjection,
      value: [{
        id: "sync-job",
        source: "data-sync",
        label: "Full data sync",
        target: "4 saved-data sources",
        status: "partial",
        total: 4,
        completed: 2,
        partial: true,
        canResume: true,
        canCancel: true,
        canReconcile: false,
        updatedAt: "2026-09-10T07:00:00.000Z",
        href: "/agents",
      }],
    };
    fetchMock.mockImplementation(async (input: string) => {
      if (input === "/api/workbench/jobs") return Response.json(projection);
      if (input === "/api/data-sync/runs/sync-job/retry") return Response.json({ id: "sync-job" });
      if (input === "/api/data-sync/runs/sync-job/cancel") return Response.json({ id: "sync-job" });
      throw new Error(`Unexpected request ${input}`);
    });
    render(<JobsView user={{ ...user, roles: ["AgentControl.Viewer"] }} />);

    expect(await screen.findByRole("link", { name: "Open sync details" })).toHaveAttribute(
      "href",
      "/sync?syncRun=sync-job",
    );
    expect(screen.getByText(/Data sync · 4 saved-data sources/)).toBeVisible();
    await userEvent.click(await screen.findByRole("button", { name: "Retry incomplete" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/data-sync/runs/sync-job/retry",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/data-sync/runs/sync-job/cancel",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("keeps polling an admitted data-sync run after the retry response is lost", async () => {
    vi.useFakeTimers();
    let projectionLoads = 0;
    const projection = (otherStatus: "running" | "succeeded") => ({
      ...emptyProjection,
      value: [
        {
          id: "sync-job",
          source: "data-sync",
          label: "Full data sync",
          target: "4 saved-data sources",
          status: "partial",
          total: 4,
          completed: 2,
          partial: true,
          canResume: true,
          canCancel: false,
          canReconcile: false,
          updatedAt: "2026-09-10T07:00:00.000Z",
          href: "/agents?syncRun=sync-job",
        },
        {
          id: "other-job",
          source: "package-refresh",
          label: "Other inventory refresh",
          target: "Current principal Graph package catalog",
          status: otherStatus,
          total: 1,
          completed: otherStatus === "succeeded" ? 1 : 0,
          partial: false,
          canResume: false,
          canCancel: false,
          canReconcile: false,
          updatedAt: "2026-09-10T07:00:00.000Z",
          href: "/agents?refreshJob=other-job",
        },
      ],
    });
    fetchMock.mockImplementation(async (input: string) => {
      if (input === "/api/workbench/jobs") {
        projectionLoads += 1;
        return Response.json(projection(projectionLoads >= 3 ? "succeeded" : "running"));
      }
      if (input === "/api/data-sync/runs/sync-job/retry") throw new Error("Retry response lost");
      throw new Error(`Unexpected request ${input}`);
    });
    render(<JobsView user={{ ...user, roles: ["AgentControl.Viewer"] }} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      screen.getByRole("button", { name: "Retry incomplete" }).click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("The server could not be reached.");
    expect(projectionLoads).toBe(2);
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/data-sync/runs/sync-job/retry")).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(projectionLoads).toBe(3);
    const otherJob = screen.getByText("Other inventory refresh").closest("article");
    expect(otherJob).not.toBeNull();
    expect(otherJob).toHaveTextContent("succeeded");
    expect(screen.getByRole("alert")).toHaveTextContent("The server could not be reached.");
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/data-sync/runs/sync-job/retry")).toHaveLength(1);
  });

  it("filters authorized jobs by their human-readable source", async () => {
    fetchMock.mockResolvedValue(Response.json({
      ...emptyProjection,
      value: [
        { id: "sync-job", source: "data-sync", label: "Full data sync", target: "4 saved-data sources",
          status: "completed", total: 4, completed: 4, partial: false, canResume: false, canCancel: false,
          canReconcile: false, updatedAt: "2026-09-10T07:00:00.000Z", href: "/agents" },
        { id: "audit-job", source: "purview", label: "Purview Audit Search", target: "fixed preset",
          status: "succeeded", total: 1, completed: 1, partial: false, canResume: false, canCancel: false,
          canReconcile: false, updatedAt: "2026-09-10T07:00:00.000Z", href: "/audit?job=audit-job" },
      ],
    }));
    render(<JobsView user={{ ...user, roles: ["AgentControl.Viewer"] }} />);

    expect(await screen.findByText("Full data sync")).toBeVisible();
    expect(screen.getByText(/Purview audit · fixed preset/)).toBeVisible();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Filter jobs by source" }), "purview");
    expect(screen.queryByText("Full data sync")).not.toBeInTheDocument();
    expect(screen.getByText("Purview Audit Search")).toBeVisible();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Filter jobs by source" }), "data-sync");
    expect(screen.getByText("Full data sync")).toBeVisible();
    expect(screen.queryByText("Purview Audit Search")).not.toBeInTheDocument();
  });

  it("drops a settled response owned by the previous principal", async () => {
    let releaseOld!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { releaseOld = resolve; }))
      .mockResolvedValueOnce(Response.json({ ...emptyProjection, value: [{ id: "new", source: "package-refresh", label: "New principal job",
        target: "Current principal Graph package catalog", status: "succeeded", total: 1, completed: 1, partial: false,
        canResume: false, canCancel: false, canReconcile: false, updatedAt: "2026-09-10T07:00:00.000Z", href: "/agents?refreshJob=new" }] }));
    const rendered = render(<JobsView user={{ ...user, roles: ["AgentControl.Viewer"] }} />);
    rendered.rerender(<JobsView user={{ ...user, homeAccountId: "other", roles: ["AgentControl.Viewer"] }} />);
    expect(await screen.findByText("New principal job")).toBeInTheDocument();
    releaseOld(Response.json({ ...emptyProjection, value: [{ id: "old", source: "package-refresh", label: "Old principal job",
      target: "Current principal Graph package catalog", status: "succeeded", total: 1, completed: 1, partial: false,
      canResume: false, canCancel: false, canReconcile: false, updatedAt: "2026-09-10T06:00:00.000Z", href: "/agents?refreshJob=old" }] }));
    await waitFor(() => expect(screen.queryByText("Old principal job")).not.toBeInTheDocument());
  });

  it("admits a recovery mutation only once in the same render turn", async () => {
    let release!: () => void;
    const operation = new Promise<Response>(resolve => { release = () => resolve(Response.json({ id: "bulk-job" })); });
    fetchMock.mockImplementation(async (input: string) => input === "/api/workbench/jobs"
      ? Response.json({ ...emptyProjection, value: [{
        id: "bulk-job", source: "package-controls", label: "Package block", target: "1 exact Graph package target",
        status: "waiting_authorization", total: 1, completed: 0, partial: false, canResume: true, canCancel: false,
        canReconcile: false, updatedAt: "2026-09-10T07:00:00.000Z", href: "/agents?controlJob=bulk-job",
      }] })
      : operation);
    render(<JobsView user={{ ...user, roles: ["AgentControl.Admin"] }} />);
    const button = await screen.findByRole("button", { name: /Resume unsent/ });
    button.click();
    button.click();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/agents/bulk-jobs/bulk-job/resume",
      expect.objectContaining({ method: "POST" }),
    ));
    expect(fetchMock.mock.calls.filter(([input]) => input === "/api/agents/bulk-jobs/bulk-job/resume")).toHaveLength(1);
    release();
  });

  it("does not let an old principal mutation settle into the new principal view", async () => {
    let release!: (value: Response) => void;
    let projectionLoads = 0;
    fetchMock.mockImplementation((input: string) => {
      if (input === "/api/workbench/jobs") {
        projectionLoads += 1;
        return Promise.resolve(Response.json(projectionLoads === 1 ? {
          ...emptyProjection,
          value: [{ id: "bulk-job", source: "package-controls", label: "Package block", target: "1 target",
            status: "waiting_authorization", total: 1, completed: 0, partial: false, canResume: true, canCancel: false,
            canReconcile: false, updatedAt: "2026-09-10T07:00:00.000Z", href: "/agents?controlJob=bulk-job" }],
        } : emptyProjection));
      }
      return new Promise<Response>(resolve => { release = resolve; });
    });
    const rendered = render(<JobsView user={{ ...user, roles: ["AgentControl.Admin"] }} />);
    await userEvent.click(await screen.findByRole("button", { name: /Resume unsent/ }));
    rendered.rerender(<JobsView user={{ ...user, homeAccountId: "other", roles: ["AgentControl.Viewer"] }} />);
    release(Response.json({ id: "bulk-job" }));
    expect(await screen.findByText(/No retained jobs are visible/)).toBeInTheDocument();
    expect(screen.queryByText(/operation failed/i)).not.toBeInTheDocument();
  });
});
