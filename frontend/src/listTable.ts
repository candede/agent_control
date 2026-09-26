import {
  createSortedRowModel,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type OnChangeFn,
  type RowData,
  type SortingState,
} from "@tanstack/react-table";

const listTableFeatures = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
});

export type ListColumn<T extends RowData> = ColumnDef<typeof listTableFeatures, T>;

export function restoreTableSortFocus(region: HTMLElement | null, label: string | undefined) {
  if (!region || !label) return;
  const focused = document.activeElement;
  // An asynchronous sort must not steal focus if the user moved to another control.
  if (focused && focused !== document.body && focused.isConnected) return;
  [...region.querySelectorAll<HTMLButtonElement>(".table-sort-heading")]
    .find(button => button.getAttribute("aria-label") === `Sort by ${label}`)?.focus();
}

export function useListTable<T extends RowData>({
  data, columns, sorting, onSortingChange, getRowId, manualSorting = false,
}: {
  data: T[];
  columns: ListColumn<T>[];
  sorting: SortingState;
  onSortingChange: OnChangeFn<SortingState>;
  getRowId: (row: T, index: number) => string;
  manualSorting?: boolean;
}) {
  return useTable({
    features: listTableFeatures,
    data,
    columns,
    getRowId,
    manualSorting,
    enableMultiSort: false,
    enableSortingRemoval: false,
    state: { sorting },
    onSortingChange,
    defaultColumn: {
      sortUndefined: "last",
      sortDescFirst: false,
      sortFn: (left, right, columnId) => {
        const a = left.getValue<string | number | undefined>(columnId);
        const b = right.getValue<string | number | undefined>(columnId);
        if (typeof a === "number" && typeof b === "number") return a - b;
        return String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true, sensitivity: "base" });
      },
    },
  });
}
