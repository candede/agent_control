import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  displayName: "Four Role",
  username: "four-role@example.invalid",
  homeAccountId: "principal",
  tenantId: "tenant",
  roles: ["AgentControl.Reader", "AgentControl.Operator", "AgentControl.SecurityReader", "AgentControl.Administrator"],
} as const;

const capabilityContext = {
  views: [],
  user: { ...user, roles: [...user.roles] },
  loading: false,
  now: Date.now(),
  reload: vi.fn(),
  refresh: vi.fn(),
  openPermissions: vi.fn(),
} as never;

const emptyProjection = { value: [], unavailableSources: [], polledAt: "2026-09-10T07:00:00.000Z", requestId: "request-1" };

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(Response.json(emptyProjection));
});

describe("JobsView", () => {
  it("loads one backend-minimized authorized projection", async () => {
    render(<JobsView user={{ ...user, roles: [...user.roles] }} />);
    expect(await screen.findByText(/No retained jobs are visible/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/workbench/jobs", expect.objectContaining({ credentials: "include", signal: expect.any(AbortSignal) }));
    expect(screen.getByText(/request request-1/)).toBeInTheDocument();
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
    render(<JobsView user={{ ...user, roles: ["AgentControl.Operator"] }} />);
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
    render(<JobsView user={{ ...user, roles: ["AgentControl.SecurityReader"] }} />);
    expect(await screen.findByText(/1 authorized source is temporarily unavailable/)).toBeInTheDocument();
    await new Promise(resolve => window.setTimeout(resolve, 2_100));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("drops a settled response owned by the previous principal", async () => {
    let releaseOld!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { releaseOld = resolve; }))
      .mockResolvedValueOnce(Response.json({ ...emptyProjection, value: [{ id: "new", source: "package-refresh", label: "New principal job",
        target: "Current principal Graph package catalog", status: "succeeded", total: 1, completed: 1, partial: false,
        canResume: false, canCancel: false, canReconcile: false, updatedAt: "2026-09-10T07:00:00.000Z", href: "/agents?refreshJob=new" }] }));
    const rendered = render(<JobsView user={{ ...user, roles: ["AgentControl.Reader"] }} />);
    rendered.rerender(<JobsView user={{ ...user, homeAccountId: "other", roles: ["AgentControl.Reader"] }} />);
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
    render(<JobsView user={{ ...user, roles: ["AgentControl.Operator"] }} />);
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
    const rendered = render(<JobsView user={{ ...user, roles: ["AgentControl.Operator"] }} />);
    await userEvent.click(await screen.findByRole("button", { name: /Resume unsent/ }));
    rendered.rerender(<JobsView user={{ ...user, homeAccountId: "other", roles: ["AgentControl.Reader"] }} />);
    release(Response.json({ id: "bulk-job" }));
    expect(await screen.findByText(/No retained jobs are visible/)).toBeInTheDocument();
    expect(screen.queryByText(/operation failed/i)).not.toBeInTheDocument();
  });
});
