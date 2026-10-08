import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AutomaticRefreshStatus as Status } from "../useAutomaticRefresh";
import { AutomaticRefreshStatus } from "./AutomaticRefreshStatus";

const base: Status = {
  phase: "ready", checking: false, paused: false, enabled: true, online: true, visible: true,
  checkedAt: undefined, message: undefined, setPaused: vi.fn(),
};

describe("automatic refresh status", () => {
  it("quietly describes cadence, retains manual sync wayfinding and offers a session-only pause", () => {
    const onOpenSync = vi.fn();
    const setPaused = vi.fn();
    render(<AutomaticRefreshStatus status={{ ...base, setPaused }} onOpenSync={onOpenSync} onOpenPermissions={vi.fn()} />);
    expect(screen.getByRole("region", { name: "Automatic refresh" })).toHaveTextContent("Users and inventory every 15 minutes; package details hourly");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pause automatic refresh" }));
    expect(setPaused).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "View sync status" }));
    expect(onOpenSync).toHaveBeenCalledOnce();
  });

  it("shows an explicit sign-in link and permission guidance rather than navigating automatically", () => {
    const permissions = vi.fn();
    render(<AutomaticRefreshStatus status={{ ...base, phase: "sign_in_required" }} onOpenSync={vi.fn()} onOpenPermissions={permissions} />);
    expect(screen.getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", "/api/auth/login");
    fireEvent.click(screen.getByRole("button", { name: "Review permissions" }));
    expect(permissions).toHaveBeenCalledOnce();
  });

  it("keeps cancellation guidance and manual sync available while paused", () => {
    const setPaused = vi.fn();
    render(<AutomaticRefreshStatus status={{ ...base, paused: true, setPaused }} onOpenSync={vi.fn()} onOpenPermissions={vi.fn()} />);
    expect(screen.getByText(/Existing work may finish/)).toHaveTextContent("Manual sync remains available");
    fireEvent.click(screen.getByRole("button", { name: "Resume automatic refresh" }));
    expect(setPaused).toHaveBeenCalledWith(false);
  });

  it("does not describe a retired browser check as active work", () => {
    const props = { onOpenSync: vi.fn(), onOpenPermissions: vi.fn() };
    const { rerender } = render(<AutomaticRefreshStatus status={{ ...base, phase: "checking", checking: true }} {...props} />);
    expect(screen.getByText("Automatic refresh · Checking saved data")).toBeVisible();
    rerender(<AutomaticRefreshStatus status={{ ...base, phase: "checking", checking: false }} {...props} />);
    expect(screen.queryByText("Automatic refresh · Checking saved data")).not.toBeInTheDocument();
    expect(screen.getByText("Automatic refresh · Waiting for the next check")).toBeVisible();
  });

  it.each([
    [{ paused: true }, "Paused for this session"],
    [{ enabled: false }, "Waiting for workbench access"],
    [{ online: false }, "Offline — checks paused"],
    [{ visible: false }, "Checks paused while hidden"],
  ])("describes unavailable checks rather than retained progress: %s", (overrides, headline) => {
    render(<AutomaticRefreshStatus status={{ ...base, phase: "refreshing", ...overrides }}
      onOpenSync={vi.fn()} onOpenPermissions={vi.fn()} />);
    expect(screen.getByText(`Automatic refresh · ${headline}`)).toBeVisible();
    expect(screen.getByRole("button", { name: "View sync status" })).toBeEnabled();
  });

  it("keeps authorization recovery available during a session pause", () => {
    render(<AutomaticRefreshStatus status={{ ...base, phase: "permission_required", paused: true,
      message: "Some sources need permission. Review Sync and Permissions; saved data remains available." }}
      onOpenSync={vi.fn()} onOpenPermissions={vi.fn()} />);
    expect(screen.getByText("Automatic refresh · Paused for this session")).toBeVisible();
    expect(screen.getByText(/Some sources need permission/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Review permissions" })).toBeEnabled();
  });

  it("prioritizes offline guidance over a pause without hiding authorization recovery", () => {
    const props = { onOpenSync: vi.fn(), onOpenPermissions: vi.fn() };
    const status: Status = { ...base, online: false, paused: true, phase: "sign_in_required",
      message: "Sign in again to continue automatic refresh." };
    const { rerender } = render(<AutomaticRefreshStatus status={status} {...props} />);
    expect(screen.getByText("Automatic refresh · Offline — checks paused")).toBeVisible();
    expect(screen.getByText(/Reconnect before starting a manual sync/)).toBeVisible();
    expect(screen.queryByText(/Manual sync remains available/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in again" })).toBeVisible();
    expect(screen.getByRole("button", { name: "View sync status" })).toBeEnabled();
    rerender(<AutomaticRefreshStatus status={{ ...status, online: true }} {...props} />);
    expect(screen.getByText("Automatic refresh · Paused for this session")).toBeVisible();
    expect(screen.getByText(/Manual sync remains available/)).toBeVisible();
  });

  it("keeps navigation mounted and focused when an automatic check clears a source issue", () => {
    const onOpenPermissions = vi.fn();
    const onOpenSync = vi.fn();
    const props = { onOpenSync, onOpenPermissions };
    const { rerender } = render(<AutomaticRefreshStatus status={{ ...base, phase: "permission_required" }} {...props} />);
    const permissions = screen.getByRole("button", { name: "Review permissions" });
    const pause = screen.getByRole("button", { name: "Pause automatic refresh" });
    const sync = screen.getByRole("button", { name: "View sync status" });
    permissions.focus();
    for (const status of [
      { ...base, phase: "checking" as const, checking: true },
      { ...base, phase: "backoff" as const },
      { ...base, phase: "failed" as const },
      { ...base, phase: "refreshing" as const },
      base,
      { ...base, paused: true, online: false },
    ]) {
      rerender(<AutomaticRefreshStatus status={status} {...props} />);
      expect(screen.getByRole("button", { name: "Review permissions" })).toBe(permissions);
      expect(permissions).toBeEnabled();
      expect(permissions).toHaveFocus();
      expect(screen.getByRole("button", { name: /^(Pause|Resume) automatic refresh$/ })).toBe(pause);
      expect(pause).toBeEnabled();
      expect(screen.getByRole("button", { name: "View sync status" })).toBe(sync);
      expect(sync).toBeEnabled();
    }
    expect(onOpenPermissions).not.toHaveBeenCalled();
    expect(onOpenSync).not.toHaveBeenCalled();
    fireEvent.click(permissions);
    expect(onOpenPermissions).toHaveBeenCalledOnce();
  });

  it("politely announces changing status and recovery guidance without reannouncing static cadence or controls", () => {
    const props = { onOpenSync: vi.fn(), onOpenPermissions: vi.fn() };
    const { rerender } = render(<AutomaticRefreshStatus status={base} {...props} />);
    const announcement = screen.getByRole("status");
    expect(announcement).toHaveAttribute("aria-live", "polite");
    expect(announcement).toHaveAttribute("aria-atomic", "true");
    expect(announcement).toHaveTextContent("Automatic refresh · On");
    expect(announcement).not.toHaveTextContent("Users and inventory every");
    expect(within(announcement).queryByRole("button")).not.toBeInTheDocument();
    rerender(<AutomaticRefreshStatus status={{ ...base, phase: "checking", checking: true }} {...props} />);
    expect(screen.getByRole("status")).toBe(announcement);
    expect(announcement).toHaveTextContent("Checking saved data");
    rerender(<AutomaticRefreshStatus status={{ ...base, phase: "backoff",
      message: "Automatic refresh could not be checked. Saved data remains available." }} {...props} />);
    expect(screen.getByRole("status")).toBe(announcement);
    expect(announcement).toHaveTextContent("Check failed — retrying with a delay");
    expect(announcement).toHaveTextContent("Saved data remains available.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["sign-in", "sync"] as const)("preserves %s focus when source authorization recovers", focus => {
    const props = { onOpenSync: vi.fn(), onOpenPermissions: vi.fn() };
    const status: Status = { ...base, phase: "sign_in_required" };
    const { rerender } = render(<AutomaticRefreshStatus status={status} {...props} />);
    const signIn = screen.getByRole("link", { name: "Sign in again" });
    const sync = screen.getByRole("button", { name: "View sync status" });
    const focused = focus === "sign-in" ? signIn : sync;
    focused.focus();
    rerender(<AutomaticRefreshStatus status={{ ...status, checking: true }} {...props} />);
    expect(screen.getByRole("link", { name: "Sign in again" })).toBe(signIn);
    expect(focused).toHaveFocus();
    rerender(<AutomaticRefreshStatus status={{ ...base, phase: "refreshing" }} {...props} />);
    expect(screen.queryByRole("link", { name: "Sign in again" })).not.toBeInTheDocument();
    expect(focus === "sign-in" ? screen.getByRole("button", { name: "Pause automatic refresh" }) : sync).toHaveFocus();
    expect(props.onOpenSync).not.toHaveBeenCalled();
    expect(props.onOpenPermissions).not.toHaveBeenCalled();
  });

  it.each([
    ["refreshing", "Refreshing in the background"],
    ["permission_required", "Permission required"],
    ["failed", "Some sources need attention"],
    ["backoff", "Check failed — retrying with a delay"],
  ] as const)("presents %s without opening a workflow or hiding manual recovery", (phase, headline) => {
    const onOpenSync = vi.fn();
    const onOpenPermissions = vi.fn();
    render(<AutomaticRefreshStatus status={{ ...base, phase }}
      onOpenSync={onOpenSync} onOpenPermissions={onOpenPermissions} />);
    expect(screen.getByText(`Automatic refresh · ${headline}`)).toBeVisible();
    expect(screen.getByRole("button", { name: "View sync status" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onOpenSync).not.toHaveBeenCalled();
    expect(onOpenPermissions).not.toHaveBeenCalled();
  });
});
