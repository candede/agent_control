import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmployeeDiscoveryHandoff } from "./EmployeeDiscoveryHandoff";
import type { SessionUser } from "../api/client";
import * as api from "../api/client";
import * as content from "../api/adoptionContent";
import { deferred } from "../test/deferred";

const user: SessionUser = { tenantId: "synthetic", homeAccountId: "actual-employee", username: "employee@example.invalid", displayName: "Employee", roles: [] };
vi.mock("./CustomerStarterKit", () => ({ CustomerStarterKit: () => <div>Employee kit tested separately</div> }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
beforeEach(() => {
  vi.spyOn(content, "readSharedLearning").mockResolvedValue({ value: [], nextCursor: null });
  vi.spyOn(api, "getDiscoveryConnection").mockResolvedValue({ state: "not_configured" });
});
describe("discovery-only browser handoff", () => {
  it("automatically enters as the actual employee without staff background reads or manual Sync", async () => {
    const enter = vi.spyOn(api, "enterDiscovery").mockResolvedValue({ admission: "scheduled", nextCheckAt: new Date(Date.now() + 300_000).toISOString() });
    const signedOut = vi.fn();
    const view = render(<EmployeeDiscoveryHandoff user={user} onSignOut={signedOut} signingOut={false} />);
    await waitFor(() => expect(enter).toHaveBeenCalledOnce());
    expect(screen.getByRole("heading", { name: "Agent discovery" })).toBeVisible();
    expect(screen.getByText(/employee@example.invalid/)).toBeVisible();
    expect(screen.getByText(/Microsoft first-party and organization-created candidates/)).toBeVisible();
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
    expect(await screen.findByText("Collection admission failed")).toHaveAttribute("role", "status");
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
  it.each([
    { name: "unavailable", clipboard: undefined },
    { name: "throwing synchronously", clipboard: { writeText: () => { throw new Error("Copy unavailable"); } } },
    { name: "denied", clipboard: { writeText: () => Promise.reject(new Error("Copy denied")) } },
  ])("provides manual copy feedback when clipboard access is $name", async ({ clipboard }) => {
    vi.stubGlobal("navigator", { clipboard });
    vi.spyOn(api, "enterDiscovery").mockResolvedValue({ admission: "current", nextCheckAt: new Date(Date.now() + 300_000).toISOString() });
    vi.mocked(api.getDiscoveryConnection).mockResolvedValue({ state: "available", resourceUrl: "https://mcp.example.test/mcp" });
    render(<EmployeeDiscoveryHandoff user={user} onSignOut={() => {}} signingOut={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Copy MCP resource" }));
    expect(await screen.findByText("Copy unavailable. Select the resource text.")).toHaveAttribute("role", "status");
    expect(screen.getByText("https://mcp.example.test/mcp")).toBeVisible();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
  });
  it("retries connection setup independently of automatic entry and copies the configured resource", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const enter = vi.spyOn(api, "enterDiscovery").mockResolvedValue({ admission: "current", nextCheckAt: new Date(Date.now() + 300_000).toISOString() });
    const connection = vi.mocked(api.getDiscoveryConnection).mockRejectedValueOnce(new Error("Unavailable"))
      .mockResolvedValueOnce({ state: "available", resourceUrl: "https://mcp.example.test/mcp" });
    render(<EmployeeDiscoveryHandoff user={user} onSignOut={() => {}} signingOut={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry discovery connection" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy MCP resource" }));
    expect(await screen.findByText("MCP resource copied.")).toHaveAttribute("role", "status");
    expect(writeText).toHaveBeenCalledExactlyOnceWith("https://mcp.example.test/mcp");
    expect(connection).toHaveBeenCalledTimes(2);
    expect(connection.mock.calls[0][0]?.aborted).toBe(true);
    expect(screen.queryByText(/Connection setup could not be read/)).not.toBeInTheDocument();
    expect(enter).toHaveBeenCalledOnce();
  });
  it("discards prior-principal responses while automatically entering for the new principal", async () => {
    const previousConnection = deferred<Awaited<ReturnType<typeof api.getDiscoveryConnection>>>();
    const previousEntry = deferred<Awaited<ReturnType<typeof api.enterDiscovery>>>();
    const connection = vi.mocked(api.getDiscoveryConnection).mockReturnValueOnce(previousConnection.promise)
      .mockResolvedValueOnce({ state: "not_configured" });
    const enter = vi.spyOn(api, "enterDiscovery").mockReturnValueOnce(previousEntry.promise)
      .mockResolvedValueOnce({ admission: "current", nextCheckAt: new Date(Date.now() + 300_000).toISOString() });
    const view = render(<EmployeeDiscoveryHandoff user={user} onSignOut={() => {}} signingOut={false} />);
    view.rerender(<EmployeeDiscoveryHandoff user={{ ...user, tenantId: "another-tenant", homeAccountId: "another-employee" }}
      onSignOut={() => {}} signingOut={false} />);
    expect(connection.mock.calls[0][0]?.aborted).toBe(true);
    expect(enter.mock.calls[0][0]?.signal?.aborted).toBe(true);
    await act(async () => {
      previousConnection.resolve({ state: "available", resourceUrl: "https://previous.example.test/mcp" });
      previousEntry.resolve({ admission: "retryable", nextCheckAt: new Date().toISOString() });
    });
    expect(await screen.findByText(/No MCP resource is configured/)).toBeVisible();
    expect(screen.queryByText("https://previous.example.test/mcp")).not.toBeInTheDocument();
    expect(screen.queryByText(/Automatic source collection will retry/)).not.toBeInTheDocument();
    expect(enter).toHaveBeenCalledTimes(2);
    expect(content.readSharedLearning).toHaveBeenCalledTimes(2);
  });
  it("retries automatic admission after the minimum interval without requiring manual action", async () => {
    vi.useFakeTimers();
    const enter = vi.spyOn(api, "enterDiscovery")
      .mockResolvedValueOnce({ admission: "retryable", nextCheckAt: new Date(Date.now() - 60_000).toISOString() })
      .mockResolvedValue({ admission: "current", nextCheckAt: new Date(Date.now() + 300_000).toISOString() });
    render(<EmployeeDiscoveryHandoff user={user} onSignOut={() => {}} signingOut={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(/Automatic source collection will retry/)).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
    expect(enter).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(enter).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Automatic source collection will retry/)).not.toBeInTheDocument();
  });
});
