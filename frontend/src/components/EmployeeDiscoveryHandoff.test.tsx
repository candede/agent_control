import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmployeeDiscoveryHandoff } from "./EmployeeDiscoveryHandoff";
import type { SessionUser } from "../api/client";
import * as api from "../api/client";

const user: SessionUser = { tenantId: "synthetic", homeAccountId: "actual-employee", username: "employee@example.invalid", displayName: "Employee", roles: [] };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe("discovery-only browser handoff", () => {
  it("automatically enters as the actual employee without staff background reads or manual Sync", async () => {
    const enter = vi.spyOn(api, "enterDiscovery").mockResolvedValue({ admission: "scheduled", nextCheckAt: new Date(Date.now() + 300_000).toISOString() });
    const signedOut = vi.fn();
    const view = render(<EmployeeDiscoveryHandoff user={user} onSignOut={signedOut} signingOut={false} />);
    await waitFor(() => expect(enter).toHaveBeenCalledOnce());
    expect(screen.getByRole("heading", { name: "Agent discovery" })).toBeVisible();
    expect(screen.getByText(/employee@example.invalid/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Check status" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sync" })).not.toBeInTheDocument();
    screen.getByRole("button", { name: "Sign out" }).click();
    expect(signedOut).toHaveBeenCalledOnce();
    view.unmount();
    expect(enter.mock.calls[0][0]?.signal?.aborted).toBe(true);
  });
  it("reports automatic-admission failure without claiming success or blocking the handoff", async () => {
    vi.spyOn(api, "enterDiscovery").mockRejectedValue(new Error("Collection admission failed"));
    const view = render(<EmployeeDiscoveryHandoff user={user} onSignOut={() => {}} signingOut={false} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Collection admission failed");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
    view.unmount();
  });
  it("bounds recovery polling even when the browser and API clocks disagree", async () => {
    vi.useFakeTimers();
    const enter = vi.spyOn(api, "enterDiscovery").mockResolvedValue({ admission: "current",
      nextCheckAt: new Date(Date.now() + 86400000).toISOString() });
    const view = render(<EmployeeDiscoveryHandoff user={user} onSignOut={() => {}} signingOut={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(enter).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    expect(enter).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    expect(enter).toHaveBeenCalledTimes(2);
  });
});
