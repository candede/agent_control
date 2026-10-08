import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { reportPage } from "../test/reportDataFixture";
import { ReportPageControls, ReportReadStatus } from "./ReportPageControls";

describe("report read status", () => {
  it.each([false, true])("replaces a previous failure with loading feedback (quiet=%s)", quietLoading => {
    const read = { loading: false, error: new Error("Page unavailable."), invalidated: false,
      retry: vi.fn(), restart: vi.fn(), restartable: true };
    const view = render(<ReportReadStatus read={read} quietLoading={quietLoading} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Page unavailable.");
    fireEvent.click(screen.getByRole("button", { name: "Retry saved data" }));
    expect(read.retry).toHaveBeenCalledOnce();
    view.rerender(<ReportReadStatus read={{ ...read, loading: true }} quietLoading={quietLoading} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading saved data...");
    expect(status.classList.contains("sr-only")).toBe(quietLoading);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    view.rerender(<ReportReadStatus read={{ ...read, error: null, data: reportPage([]) }} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it.each([false, true])("offers only valid selection recovery rather than retrying or reporting loading (restartable=%s)", restartable => {
    const read = { loading: true, error: new Error("Selection expired."), invalidated: true,
      retry: vi.fn(), restart: vi.fn(), restartable };
    render(<ReportReadStatus read={read} />);
    expect(screen.getByRole("alert")).toHaveTextContent("This selection changed or expired.");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry saved data" })).not.toBeInTheDocument();
    if (restartable) {
      fireEvent.click(screen.getByRole("button", { name: "Restart selection" }));
      expect(read.restart).toHaveBeenCalledOnce();
    } else {
      expect(screen.getByRole("alert")).toHaveTextContent("Close this detail and restart its parent selection.");
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    }
    expect(read.retry).not.toHaveBeenCalled();
  });
});

describe("report page controls", () => {
  it.each(["missing data", "missing cursors", "disabled", "loading"] as const)("blocks pointer and keyboard navigation with %s", async state => {
    const previous = vi.fn(), next = vi.fn();
    const data = reportPage([], { page: { limit: 50, nextCursor: state === "missing cursors" ? null : "next",
      previousCursor: state === "missing cursors" ? null : "previous" } });
    render(<ReportPageControls data={state === "missing data" ? undefined : data}
      previous={previous} next={next} disabled={state === "disabled"} loading={state === "loading"} />);
    for (const name of ["Previous rows", "Next rows"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).not.toBeDisabled();
      fireEvent.click(button);
      button.focus();
      await userEvent.keyboard("{Enter} ");
    }
    expect(previous).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it.each(["Previous", "Next"])("keeps %s focused when its cursor disappears and allows navigation again when restored", async direction => {
    const previous = vi.fn(), next = vi.fn();
    const data = reportPage([], { page: { limit: 50, nextCursor: "next", previousCursor: "previous" } });
    const view = render(<ReportPageControls data={data} previous={previous} next={next} />);
    const button = screen.getByRole("button", { name: `${direction} rows` });
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(direction === "Next" ? next : previous).toHaveBeenCalledOnce();
    view.rerender(<ReportPageControls previous={previous} next={next} loading />);
    expect(button).toHaveFocus();
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{Enter}");
    expect(direction === "Next" ? next : previous).toHaveBeenCalledOnce();
    view.rerender(<ReportPageControls data={data} previous={previous} next={next} />);
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute("aria-disabled", "false");
    expect(button).not.toHaveAttribute("tabindex");
    await userEvent.keyboard("{Enter}");
    expect(direction === "Next" ? next : previous).toHaveBeenCalledTimes(2);
    expect(direction === "Next" ? previous : next).not.toHaveBeenCalled();
  });
});
