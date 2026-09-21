import { useMemo, useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SortingState } from "@tanstack/react-table";
import { restoreTableSortFocus, useListTable, type ListColumn } from "./listTable";
import { ListTableHead } from "./components/ListTableHead";

type Item = { id: string; name: string; count?: number };
const items: Item[] = [
  { id: "unknown", name: "Unknown" }, { id: "ten", name: "Ten", count: 10 },
  { id: "zero", name: "Zero", count: 0 }, { id: "two", name: "Two", count: 2 },
];
function Fixture({ manual = false, onSort = () => {} }: { manual?: boolean; onSort?: (sort: SortingState) => void }) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "count", desc: true }]);
  const columns = useMemo<ListColumn<Item>[]>(() => [
    { id: "name", header: "Name", accessorFn: row => row.name },
    { id: "count", header: "Count", accessorFn: row => row.count, sortDescFirst: true },
    { id: "actions", header: "Actions", enableSorting: false },
  ], []);
  const table = useListTable({
    data: items, columns, sorting, getRowId: row => row.id, manualSorting: manual,
    onSortingChange: update => {
      const next = typeof update === "function" ? update(sorting) : update;
      setSorting(next);
      onSort(next);
    },
  });
  return <table><ListTableHead table={table} /><tbody>{table.getRowModel().rows.map(row =>
    <tr key={row.id}><td>{row.original.name}</td><td>{row.original.count ?? "Unknown"}</td><td>Inspect</td></tr>)}</tbody></table>;
}
function names() {
  return screen.getAllByRole("row").slice(1).map(row => within(row).getAllByRole("cell")[0].textContent);
}
describe("shared list table", () => {
  it("sorts numerically in both directions with missing values last, not zero", async () => {
    render(<Fixture />);
    expect(names()).toEqual(["Ten", "Two", "Zero", "Unknown"]);
    expect(screen.getByRole("columnheader", { name: "Count" })).toHaveAttribute("aria-sort", "descending");
    await userEvent.click(screen.getByRole("button", { name: "Sort by Count" }));
    expect(names()).toEqual(["Zero", "Two", "Ten", "Unknown"]);
    expect(screen.getByRole("columnheader", { name: "Count" })).toHaveAttribute("aria-sort", "ascending");
    expect(screen.queryByRole("button", { name: "Sort by Actions" })).not.toBeInTheDocument();
  });

  it("supports keyboard sorting while preserving the focused header", async () => {
    render(<Fixture />);
    const button = screen.getByRole("button", { name: "Sort by Name" });
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(names()).toEqual(["Ten", "Two", "Unknown", "Zero"]);
    expect(button).toHaveFocus();
    await userEvent.keyboard(" ");
    expect(names()).toEqual(["Zero", "Unknown", "Two", "Ten"]);
    expect(button).toHaveFocus();
  });

  it("delegates server sorting without reordering just the current page", async () => {
    const onSort = vi.fn();
    render(<Fixture manual onSort={onSort} />);
    await userEvent.click(screen.getByRole("button", { name: "Sort by Name" }));
    expect(onSort).toHaveBeenCalledWith([{ id: "name", desc: false }]);
    expect(names()).toEqual(["Unknown", "Ten", "Zero", "Two"]);
  });

  it("restores a removed header focus without stealing focus from another control", () => {
    render(<><input aria-label="Search" /><Fixture /></>);
    const table = screen.getByRole("table");
    const heading = screen.getByRole("button", { name: "Sort by Name" });
    restoreTableSortFocus(table, "Name");
    expect(heading).toHaveFocus();
    const input = screen.getByRole("textbox", { name: "Search" });
    input.focus();
    restoreTableSortFocus(table, "Name");
    expect(input).toHaveFocus();
  });
});
