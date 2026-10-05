import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { reportPage } from "../test/reportDataFixture";
import { ReportPageControls } from "./ReportPageControls";

describe("report page controls", () => {
  it.each(["missing data", "missing cursors", "disabled"] as const)("blocks pointer and keyboard navigation with %s", async state => {
    const previous = vi.fn(), next = vi.fn();
    const data = reportPage([], { page: { limit: 50, nextCursor: state === "missing cursors" ? null : "next",
      previousCursor: state === "missing cursors" ? null : "previous" } });
    render(<ReportPageControls data={state === "missing data" ? undefined : data}
      previous={previous} next={next} disabled={state === "disabled"} />);
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
