import { fireEvent, render, screen } from "@testing-library/react";
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
});
