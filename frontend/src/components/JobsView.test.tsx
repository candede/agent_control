import { act, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import type { ContextType, ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capabilityDefinitions } from "../../../backend/src/services/capabilityRegistry";
import { workbenchActions } from "../../../backend/src/services/workbenchMetadata";
import type { CapabilityView, WorkbenchJobsResponse } from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { WorkbenchActionProvider } from "../workbenchActionContext";
import { mockNativeDialogs } from "../test/dialog";
import { JobsView } from "./JobsView";
import { SavedQueryProvider } from "./SavedQueryProvider";
import { createSavedQueryClient, readSavedQuery } from "../savedQueries";

mockNativeDialogs();

function render(ui: ReactNode, options?: { reactStrictMode?: boolean }) {
  const wrap = (children: ReactNode) => <CapabilityContext value={capabilityContext}>
    <WorkbenchActionProvider value={workbenchActions}>{children}</WorkbenchActionProvider>
  </CapabilityContext>;
  const result = rtlRender(wrap(ui), options);
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
  pending: false,
  error: undefined,
  now: Date.now(),
  reload: vi.fn(),
  openPermissions: vi.fn(),
} satisfies NonNullable<ContextType<typeof CapabilityContext>>;

const emptyProjection = { value: [], unavailableSources: [], polledAt: "2026-09-10T07:00:00.000Z", requestId: "request-1" };

async function openJob(id: string) {
  await userEvent.click(await screen.findByRole("button", { name: name => name.endsWith(`, job ${id}`) }));
  return within(screen.getByRole("dialog", { name: "Job details" }));
}

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
    expect(screen.getByText("request-1", { selector: "code" }).parentElement).toHaveTextContent("Status request request-1");
  });

  it("deduplicates shared jobs readers through real Strict Mode replay and one consumer unmount", async () => {
    const client = createSavedQueryClient();
    let resolveRead!: (value: Response) => void;
    fetchMock.mockImplementation(() => new Promise(resolve => { resolveRead = resolve; }));
    const content = (showJobs: boolean) => <SavedQueryProvider client={client}>
      {showJobs ? <JobsView user={{ ...user, roles: ["AgentControl.Viewer"] }} /> : null}
      <JobsView user={{ ...user, roles: ["AgentControl.Viewer"] }} scope="sync" />
    </SavedQueryProvider>;
    const view = render(content(true), { reactStrictMode: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const firstSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    const sharedSignal = fetchMock.mock.calls[1][1].signal as AbortSignal;
    expect(firstSignal.aborted).toBe(true);
    view.rerender(content(false));
    expect(sharedSignal.aborted).toBe(false);
    await act(async () => {
      resolveRead(Response.json({ ...emptyProjection, value: [{
        id: "shared-run", source: "data-sync", label: "Shared saved sync", target: "Saved sources",
        status: "completed", total: 1, completed: 1, partial: false, canResume: false, canCancel: false,
        canReconcile: false, updatedAt: emptyProjection.polledAt, href: "/sync?syncRun=shared-run",
      }] }));
    });
    expect(await screen.findByText("Shared saved sync")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    await openJob("bulk-job");
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

  it("does not poll progressing mutation jobs hidden from a Viewer", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => Response.json({
      ...emptyProjection,
      value: [
        { id: "read-job", source: "package-refresh", label: "Finished refresh", target: "Current principal Graph package catalog",
          status: "succeeded", total: 1, completed: 1, partial: false, canResume: false, canCancel: false,
          canReconcile: false, updatedAt: emptyProjection.polledAt, href: "/sync?refreshJob=read-job" },
        { id: "mutation-job", source: "package-controls", label: "Hidden package mutation", target: "1 exact target",
          status: "running", total: 1, completed: 0, partial: false, canResume: false, canCancel: false,
          canReconcile: false, updatedAt: emptyProjection.polledAt, href: "/agents?controlJob=mutation-job" },
      ],
    }));
    const rendered = render(<JobsView user={{ ...user, roles: ["AgentControl.Viewer"] }} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.getByText("Finished refresh")).toBeVisible();
    expect(screen.queryByText("Hidden package mutation")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rendered.rerender(<JobsView user={{ ...user, roles: ["AgentControl.Admin"] }} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.getByText("Hidden package mutation")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    rendered.rerender(<JobsView user={{ ...user, roles: ["AgentControl.Viewer"] }} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.queryByText("Hidden package mutation")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(4);
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
    expect(screen.queryByRole("button", { name: "Resume search" })).not.toBeInTheDocument();
    expect(screen.queryByText("Package block")).not.toBeInTheDocument();
    const details = await openJob("audit-job");
    expect(details.getByRole("button", { name: "Resume search" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reconcile changes/ })).not.toBeInTheDocument();
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

    const details = await openJob("sync-job");
    expect(details.getByRole("link", { name: "Open sync details" })).toHaveAttribute(
      "href",
      "/sync?syncRun=sync-job",
    );
    expect(details.getByText("4 saved-data sources")).toBeVisible();
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
    const onChanged = vi.fn();
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
    render(<JobsView user={{ ...user, roles: ["AgentControl.Viewer"] }} onChanged={onChanged} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      screen.getByRole("button", { name: /View details for Full data sync/ }).click();
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
    const otherJob = screen.getByText("Other inventory refresh").closest("tr");
    expect(otherJob).not.toBeNull();
    expect(otherJob).toHaveTextContent("Complete");
    expect(screen.getByRole("alert")).toHaveTextContent("The server could not be reached.");
    expect(onChanged).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/data-sync/runs/sync-job/retry")).toHaveLength(1);
  });

  it("never joins post-mutation revalidation to a GET admitted before the mutation", async () => {
    const active = {
      id: "running-job", source: "package-refresh", label: "Running refresh", target: "Saved package inventory",
      status: "running", total: 10, completed: 2, partial: false, canResume: false, canCancel: true,
      canReconcile: false, updatedAt: emptyProjection.polledAt, href: "/sync?refreshJob=running-job",
    };
    let releaseOld!: (response: Response) => void;
    let jobsReads = 0;
    fetchMock.mockImplementation((input: string) => {
      if (input === "/api/workbench/jobs") {
        jobsReads += 1;
        if (jobsReads === 1) return Promise.resolve(Response.json({ ...emptyProjection, value: [active] }));
        if (jobsReads === 2) return new Promise<Response>(resolve => { releaseOld = resolve; });
        return Promise.resolve(Response.json({
          ...emptyProjection,
          value: [{ ...active, status: "cancelled", canCancel: false }],
        }));
      }
      if (input === "/api/agents/refresh-jobs/running-job/cancel") {
        return Promise.resolve(Response.json({ id: active.id, status: "cancelled" }));
      }
      return Promise.reject(new Error(`Unexpected request ${input}`));
    });
    render(<JobsView user={{ ...user, roles: ["AgentControl.Viewer"] }} />);
    const details = await openJob(active.id);
    await userEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(jobsReads).toBe(2));
    const staleSignal = fetchMock.mock.calls.filter(([path]) => path === "/api/workbench/jobs")[1][1].signal as AbortSignal;

    await userEvent.click(details.getByRole("button", { name: "Cancel refresh" }));

    await waitFor(() => expect(jobsReads).toBe(3));
    expect(staleSignal.aborted).toBe(true);
    expect(details.getByText("Cancelled")).toBeVisible();
    releaseOld(Response.json({ ...emptyProjection, value: [active] }));
    await waitFor(() => expect(details.getByText("Cancelled")).toBeVisible());
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/agents/refresh-jobs/running-job/cancel")).toHaveLength(1);
  });

  it("keeps recovery busy until fresh post-action metadata arrives", async () => {
    const active = {
      id: "running-job", source: "package-refresh", label: "Running refresh", target: "Saved package inventory",
      status: "running", total: 10, completed: 2, partial: false, canResume: false, canCancel: true,
      canReconcile: false, updatedAt: emptyProjection.polledAt, href: "/sync?refreshJob=running-job",
    };
    let resolveStatus!: (value: Response) => void;
    fetchMock.mockResolvedValueOnce(Response.json({ ...emptyProjection, value: [active] }))
      .mockResolvedValueOnce(Response.json({ id: active.id, status: "cancelled" }))
      .mockReturnValueOnce(new Promise(resolve => { resolveStatus = resolve; }));
    render(<JobsView user={{ ...user, roles: ["AgentControl.Viewer"] }} />);
    const details = await openJob(active.id);
    await userEvent.click(details.getByRole("button", { name: "Cancel refresh" }));
    expect(await details.findByRole("button", { name: "Cancelling..." })).toBeDisabled();
    await act(async () => {
      resolveStatus(Response.json({ ...emptyProjection, value: [{ ...active, status: "cancelled", canCancel: false }] }));
    });
    expect(details.getByText("Cancelled")).toBeVisible();
    expect(details.queryByRole("button", { name: "Cancel refresh" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/agents/refresh-jobs/running-job/cancel")).toHaveLength(1);
  });

  it.each([401, 403])("does not automatically restore denied mutation metadata after %s", async status => {
    const onChanged = vi.fn();
    const active = {
      id: "denied-job", source: "data-sync", label: "Private retained sync", target: "Saved sources",
      status: "partial", total: 3, completed: 1, partial: true, canResume: true, canCancel: false,
      canReconcile: false, updatedAt: emptyProjection.polledAt, href: "/sync?syncRun=denied-job",
    };
    let reads = 0;
    fetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/workbench/jobs") {
        reads += 1;
        return Response.json({ ...emptyProjection, value: [active] });
      }
      return Response.json({ type: "about:blank", status, code: "forbidden", detail: "This sync is no longer authorized." },
        { status, headers: { "Content-Type": "application/problem+json" } });
    });
    render(<JobsView user={{ ...user, roles: ["AgentControl.Viewer"] }} onChanged={onChanged} />);
    const details = await openJob(active.id);
    await userEvent.click(details.getByRole("button", { name: "Retry incomplete" }));
    expect(await details.findByRole("alert")).toHaveTextContent("This sync is no longer authorized.");
    expect(details.queryByText(active.id, { exact: true })).not.toBeInTheDocument();
    expect(details.queryByRole("button", { name: "Retry incomplete" })).not.toBeInTheDocument();
    expect(reads).toBe(1);
    expect(onChanged).not.toHaveBeenCalled();
    await userEvent.click(details.getByRole("button", { name: "Close job details" }));
    await userEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(await screen.findByText(active.label)).toBeVisible();
    expect(reads).toBe(2);
  });

  it.each([401, 403])("releases an interrupted status check after a %s action denial", async status => {
    const onChanged = vi.fn();
    const active = {
      id: "denied-job", source: "data-sync", label: "Private retained sync", target: "Saved sources",
      status: "partial", total: 3, completed: 1, partial: true, canResume: true, canCancel: false,
      canReconcile: false, updatedAt: emptyProjection.polledAt, href: "/sync?syncRun=denied-job",
    };
    const projection = { ...emptyProjection, value: [active] };
    let releaseOld!: (response: Response) => void;
    let reads = 0;
    fetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/workbench/jobs") {
        reads += 1;
        if (reads === 2) return new Promise<Response>(resolve => { releaseOld = resolve; });
        return Response.json(projection);
      }
      return Response.json({ type: "about:blank", status, code: "forbidden", detail: "This sync is no longer authorized." },
        { status, headers: { "Content-Type": "application/problem+json", "X-Request-ID": "denied-request" } });
    });
    render(<JobsView user={{ ...user, roles: ["AgentControl.Viewer"] }} onChanged={onChanged} />);
    const details = await openJob(active.id);
    await userEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(reads).toBe(2));
    const staleSignal = fetchMock.mock.calls[1][1].signal as AbortSignal;
    expect(screen.getByRole("button", { name: "Checking..." })).toBeDisabled();

    await userEvent.click(details.getByRole("button", { name: "Retry incomplete" }));

    expect(await details.findByRole("alert")).toHaveTextContent("This sync is no longer authorized. Request denied-request.");
    expect(staleSignal.aborted).toBe(true);
    expect(details.queryByText(active.id, { exact: true })).not.toBeInTheDocument();
    expect(details.queryByRole("button", { name: "Retry incomplete" })).not.toBeInTheDocument();
    expect(details.queryByText("Checking the selected job...")).not.toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
    expect(reads).toBe(2);

    await act(async () => { releaseOld(Response.json(projection)); });
    expect(details.queryByText(active.id, { exact: true })).not.toBeInTheDocument();
    await userEvent.click(details.getByRole("button", { name: "Close job details" }));
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(await screen.findByText(active.label)).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(reads).toBe(3);
    expect(fetchMock.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  });

  it("leaves a shared pre-action observer running while using a fresh post-action read", async () => {
    const client = createSavedQueryClient();
    const active = {
      id: "running-job", source: "package-refresh", label: "Running refresh", target: "Saved package inventory",
      status: "running", total: 10, completed: 2, partial: false, canResume: false, canCancel: true,
      canReconcile: false, updatedAt: emptyProjection.polledAt, href: "/sync?refreshJob=running-job",
    };
    let resolveOld!: (value: Response) => void;
    let reads = 0;
    fetchMock.mockImplementation(async (path: string) => {
      if (path !== "/api/workbench/jobs") return Response.json({ id: active.id, status: "cancelled" });
      reads += 1;
      if (reads === 1) return Response.json({ ...emptyProjection, value: [active] });
      if (reads === 2) return new Promise<Response>(resolve => { resolveOld = resolve; });
      return Response.json({ ...emptyProjection, value: [{ ...active, status: "cancelled", canCancel: false }] });
    });
    render(<SavedQueryProvider client={client}><JobsView user={{ ...user, roles: ["AgentControl.Viewer"] }} /></SavedQueryProvider>);
    const details = await openJob(active.id);
    await userEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    const query = client.getQueryCache().getAll().find(query => query.state.fetchStatus === "fetching")!;
    const peer = new AbortController();
    const peerRead = readSavedQuery<WorkbenchJobsResponse>(client, query.queryKey.slice(1), () => Promise.reject(new Error("Expected deduplication")), peer.signal);
    const oldSignal = fetchMock.mock.calls.filter(([path]) => path === "/api/workbench/jobs")[1][1].signal as AbortSignal;
    await userEvent.click(details.getByRole("button", { name: "Cancel refresh" }));
    await waitFor(() => expect(reads).toBe(3));
    expect(oldSignal.aborted).toBe(false);
    expect(details.getByText("Cancelled")).toBeVisible();
    await act(async () => {
      resolveOld(Response.json({ ...emptyProjection, value: [active] }));
      await peerRead;
    });
    expect(details.getByText("Cancelled")).toBeVisible();
  });

  it("does not collide independent consumers' mutation revisions with an older post-action read", async () => {
    const client = createSavedQueryClient();
    const jobs = ["alpha", "beta"].map(id => ({
      id, source: "package-refresh", label: `${id} refresh`, target: "Saved package inventory",
      status: "running", total: 10, completed: 2, partial: false, canResume: false, canCancel: true,
      canReconcile: false, updatedAt: emptyProjection.polledAt, href: `/sync?refreshJob=${id}`,
    }));
    const cancelled = (ids: string[]) => ({
      ...emptyProjection,
      value: jobs.map(job => ids.includes(job.id) ? { ...job, status: "cancelled", canCancel: false } : job),
    });
    let resolveFirstFollowUp!: (value: Response) => void;
    let reads = 0;
    fetchMock.mockImplementation(async (path: string) => {
      if (path !== "/api/workbench/jobs") return Response.json({ status: "cancelled" });
      reads += 1;
      if (reads === 1) return Response.json(cancelled([]));
      if (reads === 2) return new Promise<Response>(resolve => { resolveFirstFollowUp = resolve; });
      return Response.json(cancelled(["alpha", "beta"]));
    });
    const content = <SavedQueryProvider client={client}><JobsView user={{ ...user, roles: ["AgentControl.Viewer"] }} /></SavedQueryProvider>;
    const first = render(content);
    const second = render(content);
    const firstView = within(first.container);
    const secondView = within(second.container);
    await firstView.findByRole("button", { name: "View details for alpha refresh, job alpha" });
    await secondView.findByRole("button", { name: "View details for beta refresh, job beta" });
    expect(reads).toBe(1);

    await userEvent.click(firstView.getByRole("button", { name: "View details for alpha refresh, job alpha" }));
    const firstDetails = within(firstView.getByRole("dialog", { name: "Job details" }));
    await userEvent.click(firstDetails.getByRole("button", { name: "Cancel refresh" }));
    await waitFor(() => expect(reads).toBe(2));
    const firstFollowUpSignal = fetchMock.mock.calls.filter(([path]) => path === "/api/workbench/jobs")[1][1].signal as AbortSignal;

    await userEvent.click(secondView.getByRole("button", { name: "View details for beta refresh, job beta" }));
    const secondDetails = within(secondView.getByRole("dialog", { name: "Job details" }));
    await userEvent.click(secondDetails.getByRole("button", { name: "Cancel refresh" }));
    await waitFor(() => expect(reads).toBe(3));
    expect(secondDetails.getByText("Cancelled")).toBeVisible();
    expect(firstDetails.getByRole("button", { name: "Cancelling..." })).toBeDisabled();
    expect(firstFollowUpSignal.aborted).toBe(false);

    await act(async () => { resolveFirstFollowUp(Response.json(cancelled(["alpha"]))); });
    expect(firstDetails.getByText("Cancelled")).toBeVisible();
    expect(secondDetails.getByText("Cancelled")).toBeVisible();
    expect(secondDetails.queryByRole("button", { name: "Cancel refresh" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(2);
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
    expect(screen.getByText("fixed preset")).toBeVisible();
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
    await openJob("bulk-job");
    const button = await screen.findByRole("button", { name: /Resume unsent/ });
    act(() => { button.click(); button.click(); });
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
    await openJob("bulk-job");
    await userEvent.click(await screen.findByRole("button", { name: /Resume unsent/ }));
    rendered.rerender(<JobsView user={{ ...user, homeAccountId: "other", roles: ["AgentControl.Viewer"] }} />);
    release(Response.json({ id: "bulk-job" }));
    expect(await screen.findByText(/No retained jobs are visible/)).toBeInTheDocument();
    expect(screen.queryByText(/operation failed/i)).not.toBeInTheDocument();
  });

  it.each([
    ["package-refresh", "/api/agents/refresh-jobs/read-job/cancel"],
    ["power-platform", "/api/inventory/refresh-jobs/read-job/cancel"],
  ])("connects advertised %s cancellation without requiring provider-read permission", async (source, path) => {
    const projection = { ...emptyProjection, value: [{
      id: "read-job", source, label: "Waiting refresh", target: "Current principal saved inventory",
      status: "waiting_authorization", total: null, completed: 0, partial: false,
      canResume: true, canCancel: true, canReconcile: false, updatedAt: emptyProjection.polledAt, href: "/sync",
    }] };
    fetchMock.mockImplementation(async (input: string) => {
      if (input === "/api/workbench/jobs") return Response.json(projection);
      if (input === path) return Response.json({ id: "read-job" });
      throw new Error(`Unexpected request ${input}`);
    });
    render(<JobsView user={{ ...user, roles: ["AgentControl.Viewer"] }} />);
    const details = await openJob("read-job");
    expect(details.getByRole("button", { name: "Resume refresh" })).toBeDisabled();
    expect(details.getByRole("button", { name: "Cancel refresh" })).toBeEnabled();
    await userEvent.click(details.getByRole("button", { name: "Cancel refresh" }));
    expect(fetchMock).toHaveBeenCalledWith(path, expect.objectContaining({ method: "POST" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    ["purview", "Resume search", "/api/audit-search/jobs/read-job/resume"],
    ["defender", "Resume investigation", "/api/hunting/jobs/read-job/resume"],
  ])("resumes an advertised %s job without imposing delegated capability readiness", async (source, label, path) => {
    const projection = { ...emptyProjection, value: [{
      id: "read-job", source, label: "Retained investigation", target: "Saved query window",
      status: "waiting_authorization", total: null, completed: 0, partial: false,
      canResume: true, canCancel: false, canReconcile: false, updatedAt: emptyProjection.polledAt, href: "/jobs",
    }] };
    fetchMock.mockImplementation(async (input: string) => {
      if (input === "/api/workbench/jobs") return Response.json(projection);
      if (input === path) return Response.json({ id: "read-job" }, { status: 202 });
      throw new Error(`Unexpected request ${input}`);
    });

    render(<JobsView user={{ ...user, roles: ["AgentControl.Admin"] }} />);
    const details = await openJob("read-job");
    const resume = details.getByRole("button", { name: label });
    expect(resume).toBeEnabled();
    expect(fetchMock.mock.calls.every(([input]) => input === "/api/workbench/jobs")).toBe(true);
    await userEvent.click(resume);
    expect(fetchMock).toHaveBeenCalledWith(path, expect.objectContaining({ method: "POST" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    ["purview", "Resume search", "/api/audit-search/jobs/read-job/resume"],
    ["defender", "Resume investigation", "/api/hunting/jobs/read-job/resume"],
  ])("surfaces server authorization failures when resuming %s", async (source, label, path) => {
    const projection = { ...emptyProjection, value: [{
      id: "read-job", source, label: "Retained investigation", target: "Saved query window",
      status: "waiting_authorization", total: null, completed: 0, partial: false,
      canResume: true, canCancel: false, canReconcile: false, updatedAt: emptyProjection.polledAt, href: "/jobs",
    }] };
    fetchMock.mockImplementation(async (input: string) => {
      if (input === "/api/workbench/jobs") return Response.json(projection);
      if (input === path) return Response.json({
        type: "about:blank", status: 403, code: "forbidden", detail: "This job is no longer authorized.",
      }, { status: 403, headers: { "Content-Type": "application/problem+json" } });
      throw new Error(`Unexpected request ${input}`);
    });
    render(<JobsView user={{ ...user, roles: ["AgentControl.Admin"] }} />);
    const details = await openJob("read-job");
    await userEvent.click(details.getByRole("button", { name: label }));
    expect(await details.findByRole("alert")).toHaveTextContent("This job is no longer authorized.");
    expect(fetchMock).toHaveBeenCalledWith(path, expect.objectContaining({ method: "POST" }));
  });

  it.each([
    ["purview", "Resume search"],
    ["defender", "Resume investigation"],
  ])("keeps %s resume role-gated even when the backend advertises recovery", async (source, label) => {
    const unauthorizedUser = { ...user, roles: [] };
    fetchMock.mockResolvedValue(Response.json({ ...emptyProjection, value: [{
      id: "read-job", source, label: "Retained investigation", target: "Saved query window",
      status: "waiting_authorization", total: null, completed: 0, partial: false,
      canResume: true, canCancel: false, canReconcile: false, updatedAt: emptyProjection.polledAt, href: "/jobs",
    }] }));
    rtlRender(<CapabilityContext value={{ ...capabilityContext, user: unauthorizedUser }}>
      <WorkbenchActionProvider value={workbenchActions}><JobsView user={unauthorizedUser} /></WorkbenchActionProvider>
    </CapabilityContext>);
    const details = await openJob("read-job");
    const resume = details.getByRole("button", { name: label });
    expect(resume).toBeDisabled();
    expect(details.getByText("Requires AgentControl.Viewer.")).toBeVisible();
    await userEvent.click(resume);
    expect(fetchMock.mock.calls.every(([input]) => input === "/api/workbench/jobs")).toBe(true);
  });

  it("shows a failed initial load as an error, not perpetual loading or an empty successful history", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ type: "about:blank", status: 503, code: "unavailable", detail: "Status service unavailable." }, {
      status: 503, headers: { "Content-Type": "application/problem+json" },
    }));
    render(<JobsView user={{ ...user, roles: ["AgentControl.Viewer"] }} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Status service unavailable.");
    expect(screen.queryByText(/Loading authorized job metadata/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No retained jobs/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(await screen.findByText(/No retained jobs are visible/)).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["delegated", "application"])("preserves %s mode when cancelling a package refresh", async tokenMode => {
    const path = "/api/agents/refresh-jobs/mode-job/cancel";
    fetchMock.mockImplementation(async (input: string) => {
      if (input === "/api/workbench/jobs") return Response.json({ ...emptyProjection, value: [{
        id: "mode-job", source: "package-refresh", tokenMode, label: "Package refresh", target: "Saved inventory",
        status: "waiting_authorization", total: null, completed: 0, partial: false,
        canResume: false, canCancel: true, canReconcile: false, updatedAt: emptyProjection.polledAt, href: "/sync",
      }] });
      if (input === path) return Response.json({ id: "mode-job" });
      throw new Error(`Unexpected request ${input}`);
    });
    render(<JobsView user={{ ...user, roles: ["AgentControl.Viewer"] }} />);
    const details = await openJob("mode-job");
    await userEvent.click(details.getByRole("button", { name: "Cancel refresh" }));
    expect(fetchMock).toHaveBeenCalledWith(path, expect.objectContaining({ method: "POST", body: JSON.stringify({ mode: tokenMode }) }));
  });

  it.each(["delegated", "application"] as const)("resumes %s package jobs using only their matching capability", async tokenMode => {
    const capabilityId = tokenMode === "application" ? "graph.package.read.application" : "graph.package.read.delegated";
    const view: CapabilityView = {
      definition: capabilityDefinitions.find(definition => definition.id === capabilityId)!,
      decision: {
        capabilityId, status: "available", authorized: true, fresh: true, verification: "provider",
        checkedAt: new Date(capabilityContext.now - 1_000).toISOString(),
        expiresAt: new Date(capabilityContext.now + 60_000).toISOString(),
        previewQualification: "not_required", remediation: [],
      },
    };
    const path = "/api/agents/refresh-jobs/mode-job/resume";
    fetchMock.mockImplementation(async (input: string) => {
      if (input === "/api/workbench/jobs") return Response.json({ ...emptyProjection, value: [{
        id: "mode-job", source: "package-refresh", tokenMode, label: "Package refresh", target: "1 exact Graph package target",
        status: "waiting_authorization", total: null, completed: 0, partial: false,
        canResume: true, canCancel: true, canReconcile: false, updatedAt: emptyProjection.polledAt, href: "/sync",
      }] });
      if (input === path) return Response.json({ id: "mode-job" });
      throw new Error(`Unexpected request ${input}`);
    });
    rtlRender(<CapabilityContext value={{ ...capabilityContext, views: [view] }}>
      <WorkbenchActionProvider value={workbenchActions}><JobsView user={{ ...user, roles: ["AgentControl.Viewer"] }} /></WorkbenchActionProvider>
    </CapabilityContext>);
    const details = await openJob("mode-job");
    const resume = details.getByRole("button", { name: "Resume refresh" });
    expect(resume).toBeEnabled();
    await userEvent.click(resume);
    expect(fetchMock).toHaveBeenCalledWith(path, expect.objectContaining({ method: "POST", body: JSON.stringify({ mode: tokenMode }) }));
  });

  it("removes expired or no-longer-authorized selected metadata and returns focus safely", async () => {
    let discarded = false;
    fetchMock.mockImplementation(async (input: string) => {
      if (input === "/api/workbench/jobs") return Response.json({
        ...emptyProjection, value: discarded ? [] : [{
          id: "draft-1", source: "official-usage", label: "Agents CSV import", target: "2 validated rows",
          status: "active", total: 2, completed: 2, partial: false, canResume: false, canCancel: true,
          canReconcile: false, updatedAt: emptyProjection.polledAt, href: "/official-usage?staging=draft-1",
        }],
      });
      if (input === "/api/official-usage/staging/draft-1") { discarded = true; return new Response(null, { status: 204 }); }
      throw new Error(`Unexpected request ${input}`);
    });
    render(<JobsView user={{ ...user, roles: ["AgentControl.Admin"] }} />);
    const details = await openJob("draft-1");
    await userEvent.click(details.getByRole("button", { name: "Discard draft" }));
    expect(await details.findByText(/no longer in the latest authorized/)).toBeVisible();
    expect(details.queryByText("draft-1", { exact: true })).not.toBeInTheDocument();
    expect(details.queryByRole("button", { name: "Discard draft" })).not.toBeInTheDocument();
    await userEvent.click(details.getByRole("button", { name: "Close job details" }));
    expect(screen.getByRole("heading", { name: "Jobs" })).toHaveFocus();
  });

  it("announces the standalone Jobs polling budget and resumes only on refresh", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => Response.json({
      ...emptyProjection, value: [{
        id: "running-job", source: "data-sync", label: "Active sync", target: "3 sources",
        status: "running", total: 3, completed: 1, partial: false, canResume: false, canCancel: true,
        canReconcile: false, updatedAt: emptyProjection.polledAt, href: "/sync?syncRun=running-job",
      }],
    }));
    render(<JobsView user={{ ...user, roles: ["AgentControl.Viewer"] }} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(299_999); });
    expect(fetchMock).toHaveBeenCalledTimes(150);
    expect(screen.queryByText(/Automatic status updates paused/)).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2); });
    expect(fetchMock).toHaveBeenCalledTimes(151);
    expect(screen.getByText(/Automatic status updates paused after five minutes/)).toBeVisible();
    expect(screen.getByText(/Automatic status updates paused after five minutes/)).toHaveTextContent("Use Refresh status to continue");
    const reads = fetchMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(reads);
    await act(async () => {
      screen.getByRole("button", { name: "Refresh status" }).click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(reads + 1);
    expect(screen.queryByText(/Automatic status updates paused/)).not.toBeInTheDocument();
  });

  it("keeps Sync history updating beyond thirty minutes until collection finishes", async () => {
    vi.useFakeTimers();
    let completed = false;
    fetchMock.mockImplementation(async () => Response.json({
      ...emptyProjection, value: [{
        id: "running-job", source: "data-sync", label: "Active sync", target: "3 sources",
        status: completed ? "completed" : "running", total: 3, completed: completed ? 3 : 1,
        partial: false, canResume: false, canCancel: !completed, canReconcile: false,
        updatedAt: emptyProjection.polledAt, href: "/sync?syncRun=running-job",
      }],
    }));
    const view = render(<JobsView user={{ ...user, roles: ["AgentControl.Viewer"] }} scope="sync" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    vi.setSystemTime(Date.now() + 30 * 60_000);
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(screen.queryByText(/Automatic status updates paused/)).not.toBeInTheDocument();
    completed = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(screen.getByRole("table", { name: "Sync run history" })).toHaveTextContent("Complete");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    view.unmount();
  });
});
