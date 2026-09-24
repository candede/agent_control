import { act, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PackageDetailFreshnessStatus } from "./PackageDetailFreshnessStatus";

const observedAt = "2026-09-24T10:00:00.000Z";
const expiresAt = "2026-09-24T11:00:00.000Z";

describe("package detail freshness", () => {
  it("shows a distinct collection time and hourly expiry rather than the inventory timestamp", () => {
    render(<PackageDetailFreshnessStatus freshness={{ state: "fresh", observedAt, expiresAt }} now={Date.parse(observedAt)} />);
    const status = screen.getByRole("complementary", { name: "Package detail freshness" });
    expect(status).toHaveTextContent("Package details · Fresh");
    expect(status).toHaveTextContent("independently of the 15-minute inventory refresh");
    expect(status.querySelector(`time[datetime="${observedAt}"]`)).toBeInTheDocument();
    expect(status.querySelector(`time[datetime="${expiresAt}"]`)).toBeInTheDocument();
  });

  it.each(["stale", "missing", "invalidated"] as const)("shows %s without presenting saved detail as current", state => {
    render(<PackageDetailFreshnessStatus freshness={{ state, observedAt: state === "missing" ? null : observedAt, expiresAt: null }} />);
    const status = screen.getByRole("complementary", { name: "Package detail freshness" });
    expect(status).toHaveTextContent("Saved details may be incomplete or out of date");
    expect(within(status).getByRole("link", { name: "Sync" })).toHaveAttribute("href", "/sync");
  });

  it("does not keep a fresh label after the expiry passes", () => {
    render(<PackageDetailFreshnessStatus freshness={{ state: "fresh", observedAt, expiresAt }} now={Date.parse(expiresAt)} />);
    expect(screen.getByText("Package details · Stale")).toBeVisible();
  });

  it("expires visible detail freshness even when automatic refresh is paused", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(observedAt));
    const view = render(<PackageDetailFreshnessStatus freshness={{ state: "fresh", observedAt, expiresAt }} />);
    try {
      expect(screen.getByText("Package details · Fresh")).toBeVisible();
      act(() => vi.advanceTimersByTime(60 * 60_000 - 1));
      expect(screen.getByText("Package details · Fresh")).toBeVisible();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.getByText("Package details · Stale")).toBeVisible();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });
});
