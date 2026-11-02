import { useRef, useState } from "react";
import type { OfficeFacet as Facet } from "../../../backend/src/types/officeAppAdoption";
import { encodeReportFacetValue } from "../api/reportData";
import { useOfficePage, type OfficeReadOwner } from "../useOfficeAdoption";
import { FacetDropdown } from "./FacetDropdown";
import { ReportPageControls, ReportReadStatus } from "./ReportPageControls";

export function OfficeFacet({ owner, kind, value, onChange, dropdown = false }: {
  owner: OfficeReadOwner; kind: "company" | "department"; value?: string | null;
  onChange: (value: string | null | undefined) => void; dropdown?: boolean;
}) {
  const read = useOfficePage<Facet>(owner, "facets", { kind, limit: 50 });
  const [search, setSearch] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const label = kind === "company" ? "Company" : "Department";
  const options = [{ value: "", label: `All ${kind === "company" ? "companies" : "departments"}` },
    ...(read.data?.value ?? []).filter(option => (option.value ?? "Not provided").toLowerCase().includes(search.toLowerCase()))
      .map(option => ({ value: encodeReportFacetValue(option.value), label: option.value ?? "Not provided" }))];
  const encoded = value === undefined ? "" : encodeReportFacetValue(value);
  if (encoded && !options.some(option => option.value === encoded)) options.push({ value: encoded, label: value ?? "Not provided" });
  const choose = (encoded: string) => { if (read.isCurrent()) onChange(encoded === "" ? undefined : encoded === "~null" ? null : encoded.slice(8)); };
  return <div className="inventory-facet report-facet-control">
    {dropdown ? <FacetDropdown label={label} value={encoded} options={options} disabled={!read.isCurrent()} onChange={choose} controlRef={trigger} />
      : <><label>{label}<select aria-label={label} aria-disabled={!read.isCurrent()} value={encoded} onChange={event => choose(event.target.value)}>
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select></label><input type="search" aria-label={`Search loaded ${kind} options`} placeholder={`Search loaded ${kind} options`}
        maxLength={256} value={search} onChange={event => setSearch(event.target.value)} /></>}
    <ReportReadStatus read={read} quietLoading />
    {(read.data?.page.pages ?? 0) > 1 ? <ReportPageControls {...read} compact label={`${kind} options`} /> : null}
  </div>;
}
