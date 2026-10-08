import { useLayoutEffect, useRef } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { RowData } from "@tanstack/react-table";
import type { useListTable } from "../listTable";
import "./listTable.css";

export function ListTableHead<T extends RowData>({ table, titles, classes }: {
  table: ReturnType<typeof useListTable<T>>;
  titles?: Record<string, string>;
  classes?: Record<string, string>;
}) {
  const action = {};
  const committed = useRef<{ action: object; changed: boolean } | undefined>(undefined);
  // Table methods remain live across renders; a retained control must not.
  useLayoutEffect(() => {
    committed.current = { action, changed: false };
    return () => { committed.current = undefined; };
  });
  return <thead>{table.getHeaderGroups().map(group => <tr key={group.id}>
    {group.headers.map(header => {
      const sorted = header.column.getIsSorted();
      const label = typeof header.column.columnDef.header === "string" ? header.column.columnDef.header : header.column.id;
      return <th key={header.id} colSpan={header.colSpan} scope={header.column.columns.length ? "colgroup" : "col"}
        className={classes?.[header.column.id]} title={titles?.[header.column.id]}
        aria-label={!header.isPlaceholder && typeof header.column.columnDef.header === "string" ? label : undefined}
        aria-sort={header.isPlaceholder ? undefined : sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}>
        {header.isPlaceholder ? null : header.column.getCanSort() ? <button type="button" className="table-sort-heading"
          aria-label={`Sort by ${label}`}
          title={`Sort ${header.column.getNextSortingOrder() === "desc" ? "descending" : "ascending"}`}
          onClick={event => {
            if (committed.current?.action !== action || committed.current.changed) return;
            committed.current.changed = true;
            header.column.getToggleSortingHandler()?.(event);
          }}>
          <table.FlexRender header={header} />
          {sorted === "asc" ? <ArrowUp size={14} aria-hidden="true" />
            : sorted === "desc" ? <ArrowDown size={14} aria-hidden="true" />
              : <ArrowUpDown size={14} aria-hidden="true" />}
        </button> : <table.FlexRender header={header} />}
      </th>;
    })}
  </tr>)}</thead>;
}
