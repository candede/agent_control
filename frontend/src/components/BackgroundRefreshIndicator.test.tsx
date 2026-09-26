import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundRefreshIndicator } from "./BackgroundRefreshIndicator";
import { SavedQueryProvider } from "./SavedQueryProvider";
import { createSavedQueryClient, readSavedQuery } from "../savedQueries";

function indicator(active = true, client?: ReturnType<typeof createSavedQueryClient>) {
  return <SavedQueryProvider client={client}><BackgroundRefreshIndicator active={active} /></SavedQueryProvider>;
}

describe("background refresh indicator", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("only announces work lasting at least half a second and disappears when it finishes", () => {
    const view = render(indicator());
    act(() => vi.advanceTimersByTime(499));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    const status = screen.getByRole("status", { name: "Background refresh" });
    expect(status.textContent).toBe("");
    expect(status.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(status.childElementCount).toBe(1);
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).not.toHaveAttribute("tabindex");
    view.rerender(indicator(false));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it.each(["success", "failure", "cancelled"] as const)("removes the icon when the final saved read finishes with %s", async outcome => {
    const client = createSavedQueryClient();
    const controller = new AbortController();
    let finish!: () => void;
    let fail!: (error: Error) => void;
    const pending = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    const view = render(indicator(false, client));
    let read!: Promise<unknown>;
    act(() => {
      read = readSavedQuery(client, ["copilot-usage-users"], () => pending, controller.signal).catch(error => error);
    });
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(screen.getByRole("status", { name: "Background refresh" })).toBeVisible();
    await act(async () => {
      if (outcome === "cancelled") controller.abort();
      else if (outcome === "failure") fail(new Error("Saved read failed"));
      else finish();
      await read;
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByRole("status", { name: "Background refresh" })).not.toBeInTheDocument();
    view.unmount();
    client.clear();
  });

  it("does not flash for short requests or leave a pending timer after unmount", () => {
    const view = render(indicator());
    act(() => vi.advanceTimersByTime(250));
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    render(indicator());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole("status", { name: "Background refresh" })).toBeVisible();
  });
});
