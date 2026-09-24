import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { capabilityDefinitions } from "../../../backend/src/services/capabilityRegistry";
import type { CapabilityCheckProgress, CapabilityView } from "../api/client";
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
