import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EnvironmentFilter } from "./EnvironmentFilter";

const options = [
  { value: "env-finance", label: "Finance production" },
  { value: "env-dev", label: "Development" },
  { value: "unnamed-123", label: "unnamed-123" },
];

describe("EnvironmentFilter", () => {
  it("supports choosing directly or narrowing names/IDs without applying a draft search", async () => {
    const onChange = vi.fn();
    render(<EnvironmentFilter options={options} value="" loading={false} onChange={onChange} />);
    const select = screen.getByRole("combobox", { name: "Environment" });
    expect(screen.getAllByRole("option")).toHaveLength(4);
    const search = screen.getByRole("searchbox", { name: "Search environments" });
    await userEvent.type(search, "FIN");
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.selectOptions(select, "env-finance");
    expect(onChange).toHaveBeenCalledWith("env-finance");
    expect(search).toHaveValue("");
    await userEvent.type(search, "123");
    expect(screen.getByRole("option", { name: "Unnamed environment (unnamed-123)" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Development/ })).not.toBeInTheDocument();
  });

  it("retains the current choice through no-match searches and missing saved observations", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<EnvironmentFilter options={options} value="ENV-FINANCE" loading={false} onChange={onChange} />);
    expect(screen.getByRole("combobox", { name: "Environment" })).toHaveValue("env-finance");
    await userEvent.type(screen.getByRole("searchbox", { name: "Search environments" }), "no-match");
    expect(screen.getByRole("status")).toHaveTextContent("current selection is unchanged");
    expect(screen.getByRole("combobox", { name: "Environment" })).toHaveValue("env-finance");
    expect(onChange).not.toHaveBeenCalled();
    rerender(<EnvironmentFilter options={[]} value="retained-env" loading={false} onChange={onChange} />);
    expect(screen.getByRole("option", { name: "Not in saved inventory: retained-env" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Environment" })).toHaveValue("retained-env");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Environment" }), "");
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("makes loading and empty saved-inventory states explicit", () => {
    const props = { options: [], value: "", onChange: vi.fn() };
    const { rerender } = render(<EnvironmentFilter {...props} loading />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-busy", "true");
    rerender(<EnvironmentFilter {...props} loading={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("No environment choices");
  });
});
