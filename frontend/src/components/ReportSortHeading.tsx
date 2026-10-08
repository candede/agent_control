import { useLayoutEffect, useRef } from "react";
import type { ReportQuery } from "../../../backend/src/types/officialReportData";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import "./listTable.css";

export function ReportSortHeading({ label, sort, query, onChange }: {
  label: string; sort: NonNullable<ReportQuery["sort"]>; query: ReportQuery; onChange: (query: ReportQuery) => void;
}) {
  const selected = query.sort === sort;
  const action = {};
  const committed = useRef<{ action: object; changed: boolean } | undefined>(undefined);
  // A retained handler must not replay its full query into a replacement render.
  useLayoutEffect(() => {
    committed.current = { action, changed: false };
    return () => { committed.current = undefined; };
  });
  return <th scope="col" aria-sort={selected ? query.order === "asc" ? "ascending" : "descending" : "none"}>
    <button type="button" className="table-sort-heading" onClick={() => {
      if (committed.current?.action !== action || committed.current.changed) return;
      committed.current.changed = true;
      onChange({ ...query, sort,
        order: selected ? query.order === "asc" ? "desc" : "asc" : ["name", "upn", "company", "department", "creatorType"].includes(sort) ? "asc" : "desc" });
    }}>
      {label}{selected ? query.order === "asc" ? <ArrowUp size={14} aria-hidden="true" /> : <ArrowDown size={14} aria-hidden="true" />
        : <ArrowUpDown size={14} aria-hidden="true" />}
    </button>
  </th>;
}
