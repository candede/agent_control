import { StrictMode, useMemo, useState, type ReactElement } from "react";
import { act, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SortingState } from "@tanstack/react-table";
import { useListTable, type ListColumn } from "./listTable";
import { ListTableHead } from "./components/ListTableHead";

type Item = { id: string; name: string; count?: number };
const items: Item[] = [
  { id: "unknown", name: "Unknown" }, { id: "ten", name: "Ten", count: 10 },
  { id: "zero", name: "Zero", count: 0 }, { id: "two", name: "Two", count: 2 },
];
function Fixture({ manual = false, grouped = false, onSort = () => {} }: {
  manual?: boolean; grouped?: boolean; onSort?: (sort: SortingState) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "count", desc: true }]);
  const columns = useMemo<ListColumn<Item>[]>(() => {
    const details: ListColumn<Item>[] = [
      { id: "count", header: "Count", accessorFn: row => row.count, sortDescFirst: true },
      { id: "actions", header: "Actions", enableSorting: false },
    ];
    return [
      { id: "name", header: "Name", accessorFn: row => row.name },
      ...(grouped ? [{ id: "details", header: "Details", columns: details }] : details),
    ];
  }, [grouped]);
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
function firstSortHandler(head: ReactElement<{
  children: ReactElement<{ children: ReactElement<{ children: ReactElement<{ onClick: () => void }> }>[] }>[];
}>) {
  return head.props.children[0].props.children[0].props.children.props.onClick;
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

  it("updates cached values for stable row identities without resetting controlled sorting or mutating input", () => {
    const onSortingChange = vi.fn();
    const columns: ListColumn<Item>[] = [{ id: "count", header: "Count", accessorFn: row => row.count }];
    const sorting: SortingState = [{ id: "count", desc: true }];
    const getRowId = (row: Item) => row.id;
    const view = renderHook(({ data, manualSorting }) => useListTable({
      data, columns, sorting, getRowId, manualSorting, onSortingChange,
    }), { initialProps: { data: items, manualSorting: false } });
    const rowIds = () => view.result.current.getRowModel().rows.map(row => row.id);
    expect(rowIds()).toEqual(["ten", "two", "zero", "unknown"]);
    const original = view.result.current.getRow("ten");
    expect(original.getValue("count")).toBe(10);

    const updated = items.map(item => item.id === "ten" ? { ...item, count: 1 } : item);
    view.rerender({ data: updated, manualSorting: false });
    expect(rowIds()).toEqual(["two", "ten", "zero", "unknown"]);
    expect(view.result.current.getRow("ten")).not.toBe(original);
    expect(view.result.current.getRow("ten").getValue("count")).toBe(1);
    expect(view.result.current.getRow("ten").original).toBe(updated[1]);
    expect(view.result.current.state.sorting).toEqual(sorting);
    expect(items[1].count).toBe(10);
    expect(updated.map(item => item.id)).toEqual(["unknown", "ten", "zero", "two"]);

    view.rerender({ data: updated, manualSorting: true });
    expect(rowIds()).toEqual(["unknown", "ten", "zero", "two"]);
    view.rerender({ data: [], manualSorting: false });
    expect(rowIds()).toEqual([]);
    expect(view.result.current.getRowModel().rowsById.ten).toBeUndefined();
    view.rerender({ data: items, manualSorting: false });
    expect(rowIds()).toEqual(["ten", "two", "zero", "unknown"]);
    expect(view.result.current.getRow("ten").getValue("count")).toBe(10);
    expect(onSortingChange).not.toHaveBeenCalled();
  });

  it.each([false, true])("admits a batched heading activation once (manual sorting: %s)", manual => {
    const onSort = vi.fn();
    render(<Fixture manual={manual} onSort={onSort} />);
    const button = screen.getByRole("button", { name: "Sort by Name" });
    button.focus();
    act(() => { button.click(); button.click(); });
    expect(onSort).toHaveBeenCalledExactlyOnceWith([{ id: "name", desc: false }]);
    expect(button).toHaveFocus();
  });

  it("retires headings after data, sort, callback and unmount transitions, including A-B-A", () => {
    const onSort = vi.fn(), replacement = vi.fn();
    const columns: ListColumn<Item>[] = [{ id: "name", header: "Name", accessorFn: row => row.name }];
    const props = { data: items, sorting: [] as SortingState, onSortingChange: onSort };
    const view = renderHook(current => {
      const table = useListTable({ ...current, columns, getRowId: row => row.id });
      return ListTableHead({ table });
    }, { initialProps: props, wrapper: StrictMode });
    const original = firstSortHandler(view.result.current);
    view.rerender({ ...props, data: items.slice(1) });
    act(original);
    expect(onSort).not.toHaveBeenCalled();
    const changedData = firstSortHandler(view.result.current);
    view.rerender({ ...props, sorting: [{ id: "name", desc: true }] });
    act(changedData);
    expect(onSort).not.toHaveBeenCalled();
    const changedSort = firstSortHandler(view.result.current);
    view.rerender({ ...props, onSortingChange: replacement });
    act(changedSort);
    expect(onSort).not.toHaveBeenCalled();
    expect(replacement).not.toHaveBeenCalled();
    const changedOwner = firstSortHandler(view.result.current);
    view.rerender(props);
    act(() => { original(); changedData(); changedSort(); changedOwner(); });
    expect(onSort).not.toHaveBeenCalled();
    expect(replacement).not.toHaveBeenCalled();
    act(firstSortHandler(view.result.current));
    expect(onSort).toHaveBeenCalledOnce();
    view.rerender(props);
    const unmounted = firstSortHandler(view.result.current);
    view.unmount();
    act(unmounted);
    expect(onSort).toHaveBeenCalledOnce();
  });

  it("aligns grouped headers without duplicating placeholder sort controls", async () => {
    const onSort = vi.fn();
    render(<Fixture grouped manual onSort={onSort} />);
    expect(screen.getByRole("columnheader", { name: "Details" })).toHaveAttribute("colspan", "2");
    expect(screen.getByRole("columnheader", { name: "Details" })).toHaveAttribute("scope", "colgroup");
    const placeholder = within(screen.getAllByRole("row")[0]).getAllByRole("columnheader")[0];
    expect(placeholder).toBeEmptyDOMElement();
    expect(placeholder).not.toHaveAttribute("aria-label");
    const button = screen.getByRole("button", { name: "Sort by Name" });
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(onSort).toHaveBeenCalledExactlyOnceWith([{ id: "name", desc: false }]);
    expect(button).toHaveFocus();
  });
});
