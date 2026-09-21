import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { RowData } from "@tanstack/react-table";
import type { useListTable } from "../listTable";
import "./listTable.css";

export function ListTableHead<T extends RowData>({ table, titles, classes }: {
  table: ReturnType<typeof useListTable<T>>;
  titles?: Record<string, string>;
  classes?: Record<string, string>;
}) {
  return <thead>{table.getHeaderGroups().map(group => <tr key={group.id}>
    {group.headers.map(header => {
      const sorted = header.column.getIsSorted();
      const label = typeof header.column.columnDef.header === "string" ? header.column.columnDef.header : header.column.id;
      return <th key={header.id} scope="col" className={classes?.[header.column.id]} title={titles?.[header.column.id]}
        aria-label={typeof header.column.columnDef.header === "string" ? label : undefined}
        aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}>
        {header.column.getCanSort() ? <button type="button" className="table-sort-heading"
          aria-label={`Sort by ${label}`}
          title={`Sort ${header.column.getNextSortingOrder() === "desc" ? "descending" : "ascending"}`}
          onClick={header.column.getToggleSortingHandler()}>
          <table.FlexRender header={header} />
          {sorted === "asc" ? <ArrowUp size={14} aria-hidden="true" />
            : sorted === "desc" ? <ArrowDown size={14} aria-hidden="true" />
              : <ArrowUpDown size={14} aria-hidden="true" />}
        </button> : <table.FlexRender header={header} />}
      </th>;
    })}
  </tr>)}</thead>;
}
