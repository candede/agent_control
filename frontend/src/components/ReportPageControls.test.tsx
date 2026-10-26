import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
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

  it.each([false, true])("keeps an expired read failure visible and offers valid recovery (restartable=%s)", restartable => {
    const read = { loading: false, error: new Error("Page unavailable."), invalidated: false, leaseEnded: true,
      retry: vi.fn(), restart: vi.fn(), restartable };
    render(<ReportReadStatus read={read} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Page unavailable.");
    expect(alert).toHaveTextContent("This selection expired.");
    expect(alert).not.toHaveTextContent("Showing previously loaded saved data.");
    expect(screen.queryByRole("button", { name: "Retry saved data" })).not.toBeInTheDocument();
    if (restartable) {
      fireEvent.click(screen.getByRole("button", { name: "Restart selection" }));
      expect(read.restart).toHaveBeenCalledOnce();
    } else {
      expect(alert).toHaveTextContent("Restart its parent selection.");
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    }
    expect(read.retry).not.toHaveBeenCalled();
  });

  it.each([false, true])("describes expired data honestly (displayed=%s)", displayed => {
    const read = { loading: false,
      error: new ApiError(409, "selection_invalidated", "Selection expired.", { details: { reason: "expired" } }),
      invalidated: false, leaseEnded: true, data: displayed ? reportPage([]) : undefined,
      retry: vi.fn(), restart: vi.fn(), restartable: true };
    render(<ReportReadStatus read={read} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(displayed ? "Showing previously loaded saved data." : "This selection expired.");
    if (!displayed) expect(status).not.toHaveTextContent("Showing previously loaded saved data.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry saved data" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restart selection" }));
    expect(read.restart).toHaveBeenCalledOnce();
    expect(read.retry).not.toHaveBeenCalled();
  });

  it("does not interrupt automatic selection renewal with recovery warnings", () => {
    render(<ReportReadStatus read={{ loading: true, error: null, invalidated: false, leaseEnded: true,
      renewing: true, data: reportPage([]), retry: vi.fn(), restart: vi.fn(), restartable: true }} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
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

  describe("numbered report pages", () => {
    function numberedPage(number = 1, total = 100) {
      return reportPage(["a", "b", "c", "d", "e"].slice(0, Math.min(5, total - (number - 1) * 5)), {
        counts: { total, filtered: total },
        page: { limit: 5, number, offset: (number - 1) * 5, previousCursor: number > 1 ? "previous" : null,
          nextCursor: number * 5 < total ? "next" : null },
      });
    }
    it("shows only direction arrows and the current/total page in compact mode", () => {
      const previous = vi.fn(), next = vi.fn(), goToPage = vi.fn(() => true);
      render(<ReportPageControls data={numberedPage(38, 571)} previous={previous} next={next}
        goToPage={goToPage} label="groups" compact />);
      const navigation = screen.getByRole("navigation", { name: "groups page shortcuts" });
      const controls = within(navigation);
      expect(controls.getAllByRole("button")).toHaveLength(2);
      expect(controls.getByRole("status", { name: "Page 38 of 115" })).toHaveTextContent("38 / 115");
      expect(controls.getByRole("status")).toHaveAttribute("aria-live", "off");
      expect(controls.queryByRole("list")).not.toBeInTheDocument();
      expect(controls.queryByRole("spinbutton")).not.toBeInTheDocument();
      expect(controls.queryByText(/Showing/)).not.toBeInTheDocument();
      fireEvent.click(controls.getByRole("button", { name: "Previous groups" }));
      fireEvent.click(controls.getByRole("button", { name: "Next groups" }));
      expect(previous).toHaveBeenCalledOnce();
      expect(next).toHaveBeenCalledOnce();
      expect(goToPage).not.toHaveBeenCalled();
    });
    it.each([
      { number: 1, total: 0, previousDisabled: true, nextDisabled: true },
      { number: 1, total: 5, previousDisabled: true, nextDisabled: true },
      { number: 1, total: 571, previousDisabled: true, nextDisabled: false },
      { number: 115, total: 571, previousDisabled: false, nextDisabled: true },
    ])("keeps compact controls accurate at page $number of $total groups", ({ number, total, previousDisabled, nextDisabled }) => {
      render(<ReportPageControls data={numberedPage(number, total)} previous={vi.fn()} next={vi.fn()}
        goToPage={vi.fn(() => true)} label="groups" compact />);
      expect(screen.getByRole("button", { name: "Previous groups" })).toHaveAttribute("aria-disabled", String(previousDisabled));
      expect(screen.getByRole("button", { name: "Next groups" })).toHaveAttribute("aria-disabled", String(nextDisabled));
      expect(screen.getByRole("status")).toHaveTextContent(`${number} / ${Math.max(1, Math.ceil(total / 5))}`);
    });
    it.each(["missing", "loading", "disabled", "expired"] as const)("blocks compact pointer and keyboard navigation while %s", async state => {
      const previous = vi.fn(), next = vi.fn(), goToPage = vi.fn(() => true);
      render(<ReportPageControls data={state === "missing" ? undefined : numberedPage(3)}
        previous={previous} next={next} goToPage={goToPage} compact
        loading={state === "loading"} disabled={state === "disabled"} leaseEnded={state === "expired"} />);
      for (const button of screen.getAllByRole("button")) {
        expect(button).toHaveAttribute("aria-disabled", "true");
        expect(button).not.toBeDisabled();
        fireEvent.click(button);
        button.focus();
        await userEvent.keyboard("{Enter} ");
      }
      expect(previous).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
      expect(goToPage).not.toHaveBeenCalled();
      expect(screen.getByRole("navigation")).toHaveAttribute("aria-busy", String(state === "loading"));
      if (state === "missing") expect(screen.getByRole("status", { name: "rows unavailable" })).toHaveTextContent("— / —");
    });
    it("does not invent a compact page position before the first response", () => {
      render(<ReportPageControls previous={vi.fn()} next={vi.fn()} goToPage={vi.fn(() => true)} compact loading label="groups" />);
      expect(screen.getByRole("status", { name: "Loading groups..." })).toHaveTextContent("— / —");
    });
    it.each([
      { number: 1, expected: [1, 2, 3, 4, 20] },
      { number: 12, expected: [1, 11, 12, 13, 20] },
      { number: 20, expected: [1, 17, 18, 19, 20] },
    ])("shows a bounded page window around page $number with direct first and last access", ({ number, expected }) => {
      const goToPage = vi.fn(() => true);
      render(<ReportPageControls data={numberedPage(number)} previous={vi.fn()} next={vi.fn()} goToPage={goToPage} label="groups" />);
      const numbers = within(screen.getByRole("list", { name: "Page numbers" }));
      expect(numbers.getAllByRole("button").map(button => Number(button.textContent))).toEqual(expected);
      expect(screen.getByRole("button", { name: `Page ${number}` })).toHaveAttribute("aria-current", "page");
      expect(screen.getByRole("status")).toHaveTextContent(`Page ${number} of 20`);
      fireEvent.click(screen.getByRole("button", { name: number === 20 ? "Page 1" : "Page 20" }));
      expect(goToPage).toHaveBeenCalledExactlyOnceWith(number === 20 ? 1 : 20);
    });
    it("shows every page for a short result set and accurate ranges on its partial last page", () => {
      render(<ReportPageControls data={numberedPage(3, 12)} previous={vi.fn()} next={vi.fn()} goToPage={vi.fn(() => true)} label="groups" />);
      expect(screen.getByRole("status")).toHaveTextContent("Showing 11–12 of 12 groups");
      expect(screen.getByRole("list")).toHaveTextContent("123");
      expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Next groups" })).toHaveAttribute("aria-disabled", "true");
    });
    it.each(["missing", "loading", "disabled", "expired"] as const)("blocks numbered, directional, and form navigation while %s", async state => {
      const goToPage = vi.fn(() => true), previous = vi.fn(), next = vi.fn();
      render(<ReportPageControls data={state === "missing" ? undefined : numberedPage(3)} goToPage={goToPage}
        previous={previous} next={next} loading={state === "loading"} disabled={state === "disabled"} leaseEnded={state === "expired"} />);
      for (const button of screen.getAllByRole("button")) {
        expect(button).toHaveAttribute("aria-disabled", "true");
        fireEvent.click(button);
        button.focus();
        await userEvent.keyboard("{Enter}");
      }
      expect(goToPage).not.toHaveBeenCalled();
      expect(previous).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });
    it("submits a direct page jump with native required, integer, and range validation", async () => {
      const goToPage = vi.fn(() => true);
      render(<ReportPageControls data={numberedPage()} previous={vi.fn()} next={vi.fn()} goToPage={goToPage} />);
      const input = screen.getByRole("spinbutton", { name: "Go to page" });
      for (const value of ["", "0", "21", "2.5"]) {
        fireEvent.change(input, { target: { value } });
        expect(input).toBeInvalid();
        fireEvent.submit(input.closest("form")!);
      }
      expect(goToPage).not.toHaveBeenCalled();
      fireEvent.change(input, { target: { value: "16" } });
      expect(input).toBeValid();
      fireEvent.submit(input.closest("form")!);
      expect(goToPage).toHaveBeenCalledExactlyOnceWith(16);
      expect(input).toHaveValue(null);
      const page = screen.getByRole("button", { name: "Page 20" });
      page.focus();
      await userEvent.keyboard("{Enter}");
      expect(goToPage).toHaveBeenLastCalledWith(20);
    });
    it("renders zero results honestly with one live result summary", () => {
      const props = { data: numberedPage(1, 0), previous: vi.fn(), next: vi.fn(), goToPage: vi.fn(() => true), label: "groups" };
      render(<ReportPageControls {...props} />);
      expect(screen.getAllByRole("navigation")).toHaveLength(1);
      expect(screen.getAllByRole("status")).toHaveLength(1);
      expect(screen.getByRole("status")).toHaveTextContent("Showing 0–0 of 0 groups");
    });
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
