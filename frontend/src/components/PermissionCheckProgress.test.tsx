import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { capabilityDefinitions } from "../../../backend/src/services/capabilityRegistry";
import { getCurrentUser, type CapabilityCheckProgress, type CapabilityView } from "../api/client";
import { PermissionCheckProgress } from "./PermissionCheckProgress";

const views: CapabilityView[] = capabilityDefinitions.map(definition => ({ definition, decision: {
  capabilityId: definition.id, status: "unknown", authorized: false, fresh: false, previewQualification: "not_required", remediation: [],
} }));
const activeCheck = { id: 1, retryFailed: true };
const initial: CapabilityCheckProgress = { checks: [
  { capabilityId: "graph.package.read.delegated", state: "checking" },
  { capabilityId: "graph.directory.read", state: "complete" },
  { capabilityId: "powerPlatform.inventory.read", state: "reviewing" },
] };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("describes catalog loading with no fabricated checks or percent", () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  render(<PermissionCheckProgress loading views={[]} />);
  expect(screen.getByRole("status")).toHaveTextContent("Loading permission results");
  expect(screen.getByText("Reading saved checks and recent issues.")).toBeVisible();
  expect(screen.getByRole("progressbar")).not.toHaveAttribute("value");
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("shows real active work and advances only when the server reports reviews complete", async () => {
  vi.useFakeTimers();
  let progress = initial;
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => Response.json({ progress }));
  vi.stubGlobal("fetch", fetchMock);
  render(<PermissionCheckProgress loading={false} activeCheck={activeCheck} views={views} />);
  expect(screen.getByText("Waiting for check updates...")).toBeVisible();
  await act(() => vi.advanceTimersByTimeAsync(499));
  expect(fetchMock).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/capabilities/check-progress?retry=failed");
  expect(screen.getByRole("status")).toHaveTextContent("1 of 3 reviewed");
  expect(screen.getByRole("progressbar")).toHaveAttribute("value", "1");
  expect(screen.getByText("Agent inventory")).toBeVisible();
  expect(screen.getByText("Power Platform inventory")).toBeVisible();
  expect(screen.queryByText("Agent people")).not.toBeInTheDocument();
  expect(screen.getByText("Reviewing saved result")).toBeVisible();
  progress = { checks: initial.checks.map(check => ({ ...check, state: "complete" })) };
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(screen.getByRole("status")).toHaveTextContent("Updating results");
  expect(screen.getByRole("progressbar")).toHaveAttribute("value", "3");
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
});

it("retries a brief progress transport failure without presenting an early warning", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("Network")).mockResolvedValue(Response.json({ progress: initial }));
  vi.stubGlobal("fetch", fetchMock);
  render(<PermissionCheckProgress loading={false} activeCheck={activeCheck} views={views} />);
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(screen.queryByText(/unavailable/)).not.toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(screen.getByText("1 of 3 reviewed")).toBeVisible();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("reports unavailable live details without claiming the permission checks failed", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "unavailable" }, { status: 503 })));
  render(<PermissionCheckProgress loading={false} activeCheck={activeCheck} views={views} />);
  await act(() => vi.advanceTimersByTimeAsync(500));
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(screen.getByText("Live check details are unavailable. Checks are still running.")).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("progressbar")).not.toHaveAttribute("value");
});

it.each([401, 403])("withdraws denied progress and suspends reads after HTTP %i until a new check", async status => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  let denied = false;
  const fetchMock = vi.fn(async () => denied
    ? Response.json({ code: status === 401 ? "interaction_required" : "missing_internal_role" }, { status })
    : Response.json({ progress: initial }));
  vi.stubGlobal("fetch", fetchMock);
  const { rerender } = render(<PermissionCheckProgress loading={false} activeCheck={activeCheck} views={views} />);
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(screen.getByText("1 of 3 reviewed")).toBeVisible();
  denied = true;
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(screen.getByText("Live check details are unavailable. Checks are still running.")).toBeVisible();
  expect(screen.getByRole("progressbar")).not.toHaveAttribute("value");
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(5000));
  visibility.mockReturnValue("hidden");
  await act(async () => fireEvent(document, new Event("visibilitychange")));
  visibility.mockReturnValue("visible");
  await act(async () => fireEvent(document, new Event("visibilitychange")));
  rerender(<PermissionCheckProgress loading={false} activeCheck={{ ...activeCheck }} views={[...views]} />);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  denied = false;
  rerender(<PermissionCheckProgress loading={false} activeCheck={{ id: 2, retryFailed: true }} views={views} />);
  expect(screen.queryByText(/unavailable/)).not.toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(screen.getByText("1 of 3 reviewed")).toBeVisible();
});

it("honors an admission cooldown before reading progress again and resumes normal polling after recovery", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn()
    .mockImplementationOnce(async () => Response.json({ progress: initial }))
    .mockImplementationOnce(async () => Response.json({ code: "request_admission_limit" }, { status: 429, headers: { "Retry-After": "5" } }))
    .mockImplementation(async () => Response.json({ progress: initial }));
  vi.stubGlobal("fetch", fetchMock);
  render(<PermissionCheckProgress loading={false} activeCheck={activeCheck} views={views} />);
  await act(() => vi.advanceTimersByTimeAsync(1_500));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.getByText("Live check details are unavailable. Checks are still running.")).toBeVisible();
  expect(screen.getByRole("progressbar")).not.toHaveAttribute("value");
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(4_999));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(screen.getByText("1 of 3 reviewed")).toBeVisible();
  expect(screen.queryByText(/unavailable/)).not.toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(999));
  expect(fetchMock).toHaveBeenCalledTimes(3);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

it.each([2_500, 6_000])("preserves a progress cooldown across a visibility pause of %i ms", async hiddenMs => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const fetchMock = vi.fn()
    .mockImplementationOnce(async () => Response.json({ code: "request_admission_limit" }, { status: 429, headers: { "Retry-After": "5" } }))
    .mockImplementation(async () => Response.json({ progress: initial }));
  vi.stubGlobal("fetch", fetchMock);
  const { rerender } = render(<PermissionCheckProgress loading={false} activeCheck={activeCheck} views={views} />);
  await act(() => vi.advanceTimersByTimeAsync(500));
  visibility.mockReturnValue("hidden");
  await act(async () => fireEvent(document, new Event("visibilitychange")));
  await act(() => vi.advanceTimersByTimeAsync(hiddenMs));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  rerender(<PermissionCheckProgress loading={false} activeCheck={{ ...activeCheck }} views={[...views]} />);
  visibility.mockReturnValue("visible");
  await act(async () => fireEvent(document, new Event("visibilitychange")));
  await act(async () => fireEvent(document, new Event("visibilitychange")));
  if (hiddenMs < 5_000) {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(5_000 - hiddenMs - 1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
  }
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.getByText("1 of 3 reviewed")).toBeVisible();
});

it.each([undefined, "invalid", "-1", "0", "9".repeat(400)])(
  "uses the normal poll interval for an unusable Retry-After header (%s)",
  async retryAfter => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => Response.json({ code: "request_admission_limit" }, {
        status: 429, headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter },
      }))
      .mockImplementation(async () => Response.json({ progress: initial }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PermissionCheckProgress loading={false} activeCheck={activeCheck} views={views} />);
    await act(() => vi.advanceTimersByTimeAsync(1_499));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText("1 of 3 reviewed")).toBeVisible();
  },
);

it("bounds long cooldown timers instead of overflowing into immediate requests", async () => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(window, "setTimeout");
  const fetchMock = vi.fn(async () => Response.json({ code: "request_admission_limit" }, {
    status: 429, headers: { "Retry-After": "2147484" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  render(<PermissionCheckProgress loading={false} activeCheck={activeCheck} views={views} />);
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(timeout).toHaveBeenLastCalledWith(expect.any(Function), 2_147_483_647);
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("retires the old cooldown on a replacement check and cancels its timer on unmount", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
    Response.json({ code: "request_admission_limit" }, { status: 429, headers: { "Retry-After": "5" } }));
  vi.stubGlobal("fetch", fetchMock);
  const { rerender, unmount } = render(<PermissionCheckProgress loading={false} activeCheck={activeCheck} views={views} />);
  await act(() => vi.advanceTimersByTimeAsync(500));
  rerender(<PermissionCheckProgress loading={false} activeCheck={{ id: 2, retryFailed: false }} views={views} />);
  expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  expect(screen.queryByText(/unavailable/)).not.toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    "/api/capabilities/check-progress?retry=failed", "/api/capabilities/check-progress",
  ]);
  unmount();
  expect(fetchMock.mock.calls[1][1]?.signal?.aborted).toBe(true);
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("aborts a pending progress read and rejects its late result when a new check replaces it", async () => {
  vi.useFakeTimers();
  let resolve!: (response: Response) => void;
  const first = new Promise<Response>(done => { resolve = done; });
  const signals: AbortSignal[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    signals.push(init.signal!);
    return signals.length === 1 ? first : Response.json({ progress: null });
  });
  vi.stubGlobal("fetch", fetchMock);
  const { rerender, unmount } = render(<PermissionCheckProgress loading={false} activeCheck={activeCheck} views={views} />);
  await act(() => vi.advanceTimersByTimeAsync(500));
  rerender(<PermissionCheckProgress loading={false} activeCheck={{ id: 2, retryFailed: false }} views={views} />);
  expect(signals[0].aborted).toBe(true);
  await act(async () => { resolve(Response.json({ progress: initial })); });
  expect(screen.queryByText("Agent inventory")).not.toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(fetchMock.mock.calls[1][0]).toBe("/api/capabilities/check-progress");
  unmount();
  expect(signals[1].aborted).toBe(true);
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("pauses progress reads while hidden and resumes without starting provider work", async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const fetchMock = vi.fn(async () => Response.json({ progress: initial }));
  vi.stubGlobal("fetch", fetchMock);
  render(<PermissionCheckProgress loading={false} activeCheck={activeCheck} views={views} />);
  await act(() => vi.advanceTimersByTimeAsync(2500));
  expect(fetchMock).not.toHaveBeenCalled();
  visibility.mockReturnValue("visible");
  await act(async () => fireEvent(document, new Event("visibilitychange")));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.getByText("1 of 3 reviewed")).toBeVisible();
});

it("preserves the pending read and cadence across equivalent run props and visibility events", async () => {
  vi.useFakeTimers();
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>(done => { resolve = done; });
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => Response.json({ progress: initial }))
    .mockImplementationOnce(() => pending);
  vi.stubGlobal("fetch", fetchMock);
  const { rerender } = render(<PermissionCheckProgress loading={false} activeCheck={activeCheck} views={views} />);
  await act(() => vi.advanceTimersByTimeAsync(500));
  rerender(<PermissionCheckProgress loading={false} activeCheck={{ ...activeCheck }} views={[...views]} />);
  expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => resolve(Response.json({ progress: initial })));
  await act(async () => fireEvent(document, new Event("visibilitychange")));
  await act(() => vi.advanceTimersByTimeAsync(999));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.getByText("1 of 3 reviewed")).toBeVisible();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.getByText("1 of 3 reviewed")).toBeVisible();
});

it("cancels a queued transport retry while hidden and resumes with one fresh read", async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("Network"))
    .mockImplementation(async () => Response.json({ progress: initial }));
  vi.stubGlobal("fetch", fetchMock);
  render(<PermissionCheckProgress loading={false} activeCheck={activeCheck} views={views} />);
  await act(() => vi.advanceTimersByTimeAsync(500));
  visibility.mockReturnValue("hidden");
  await act(async () => fireEvent(document, new Event("visibilitychange")));
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/unavailable/)).not.toBeInTheDocument();
  visibility.mockReturnValue("visible");
  await act(async () => fireEvent(document, new Event("visibilitychange")));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.getByText("1 of 3 reviewed")).toBeVisible();
});

it("retires hidden pending reads so late responses cannot replace resumed progress", async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>(done => { resolve = done; });
  const complete: CapabilityCheckProgress = { checks: initial.checks.map(check => ({ ...check, state: "complete" })) };
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => Response.json({ progress: complete }))
    .mockImplementationOnce(() => pending);
  vi.stubGlobal("fetch", fetchMock);
  render(<PermissionCheckProgress loading={false} activeCheck={activeCheck} views={views} />);
  await act(() => vi.advanceTimersByTimeAsync(500));
  visibility.mockReturnValue("hidden");
  await act(async () => fireEvent(document, new Event("visibilitychange")));
  expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  visibility.mockReturnValue("visible");
  await act(async () => fireEvent(document, new Event("visibilitychange")));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.getByText("Updating results")).toBeVisible();
  await act(async () => resolve(Response.json({ progress: initial })));
  expect(screen.getByText("Updating results")).toBeVisible();
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it.each(["initial delay", "poll interval", "transport retry", "admission cooldown", "pending read"] as const)(
  "retires the progress loop when the request session changes during the %s",
  async phase => {
    vi.useFakeTimers();
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/me") return Response.json({ user: {
        displayName: "Replacement", username: "replacement@example.invalid", homeAccountId: "replacement",
        tenantId: "tenant", roles: ["AgentControl.Viewer"],
      }, csrfToken: "synthetic", roleAssignmentRequired: false });
      if (phase === "transport retry") throw new TypeError("Network");
      if (phase === "admission cooldown") return Response.json({ code: "request_admission_limit" }, { status: 429, headers: { "Retry-After": "5" } });
      if (phase === "pending read") return pending;
      return Response.json({ progress: initial });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PermissionCheckProgress loading={false} activeCheck={activeCheck} views={views} />);
    if (phase !== "initial delay") await act(() => vi.advanceTimersByTimeAsync(500));
    await act(async () => { await getCurrentUser(); });
    if (phase === "pending read") await act(async () => resolve(Response.json({ progress: initial })));
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    await act(async () => fireEvent(document, new Event("visibilitychange")));
    expect(fetchMock.mock.calls.filter(([url]) => url.includes("check-progress"))).toHaveLength(phase === "initial delay" ? 0 : 1);
    expect(screen.queryByText("1 of 3 reviewed")).not.toBeInTheDocument();
    expect(screen.queryByText(/unavailable/)).not.toBeInTheDocument();
  },
);

it("cancels a queued retry on unmount without another request", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async () => { throw new TypeError("Network"); });
  vi.stubGlobal("fetch", fetchMock);
  const { unmount } = render(<PermissionCheckProgress loading={false} activeCheck={activeCheck} views={views} />);
  await act(() => vi.advanceTimersByTimeAsync(500));
  unmount();
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("withdraws previous progress when the server has no active run, without claiming success", async () => {
  vi.useFakeTimers();
  let progress: CapabilityCheckProgress | null = initial;
  const fetchMock = vi.fn(async () => Response.json({ progress }));
  vi.stubGlobal("fetch", fetchMock);
  render(<PermissionCheckProgress loading={false} activeCheck={activeCheck} views={views} />);
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(screen.getByText("1 of 3 reviewed")).toBeVisible();
  progress = null;
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(screen.getByText("Waiting for check updates...")).toBeVisible();
  expect(screen.getByRole("progressbar")).not.toHaveAttribute("value");
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
  expect(screen.queryByText("Updating results")).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("clears stale counts on a failed read and clears its warning after recovery", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn()
    .mockImplementationOnce(async () => Response.json({ progress: initial }))
    .mockImplementationOnce(async () => Response.json({ progress: { checks: [{ capabilityId: "not-a-check", state: "complete" }] } }))
    .mockImplementation(async () => Response.json({ progress: initial }));
  vi.stubGlobal("fetch", fetchMock);
  render(<PermissionCheckProgress loading={false} activeCheck={activeCheck} views={views} />);
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(screen.getByRole("progressbar")).toHaveAttribute("value", "1");
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(screen.getByText("Live check details are unavailable. Checks are still running.")).toBeVisible();
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
  expect(screen.getByRole("progressbar")).not.toHaveAttribute("value");
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(screen.queryByText(/unavailable/)).not.toBeInTheDocument();
  expect(screen.getByText("1 of 3 reviewed")).toBeVisible();
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("resets displayed progress when retry scope changes even if its numeric id is unchanged", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => Response.json({ progress: initial }));
  vi.stubGlobal("fetch", fetchMock);
  const { rerender } = render(<PermissionCheckProgress loading={false} activeCheck={activeCheck} views={views} />);
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(screen.getByText("1 of 3 reviewed")).toBeVisible();
  rerender(<PermissionCheckProgress loading={false} activeCheck={{ ...activeCheck, retryFailed: false }} views={views} />);
  expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  expect(screen.queryByText("1 of 3 reviewed")).not.toBeInTheDocument();
  expect(screen.getByRole("progressbar")).not.toHaveAttribute("value");
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    "/api/capabilities/check-progress?retry=failed", "/api/capabilities/check-progress",
  ]);
});

it("starts only one delayed progress read in StrictMode", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async () => Response.json({ progress: initial }));
  vi.stubGlobal("fetch", fetchMock);
  render(<PermissionCheckProgress loading={false} activeCheck={activeCheck} views={views} />, { reactStrictMode: true });
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.getByText("1 of 3 reviewed")).toBeVisible();
});
