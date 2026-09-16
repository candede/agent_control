import { useState } from "react";
import type { UnifiedAgentInventoryPage } from "../api/client";

type Props = {
  options: UnifiedAgentInventoryPage["facets"]["environments"];
  value: string;
  loading: boolean;
  onChange: (value: string) => void;
};

export function EnvironmentFilter({ options, value, loading, onChange }: Props) {
  const [search, setSearch] = useState("");
  const normalized = search.trim().toLocaleLowerCase("en-US");
  const selected = options.find(option => option.value.toLocaleLowerCase("en-US") === value.toLocaleLowerCase("en-US"));
  const matches = options.filter(option => [option.label, option.value].some(text => text.toLocaleLowerCase("en-US").includes(normalized)));
  const choices = selected && !matches.includes(selected) ? [selected, ...matches] : matches;

  return <>
    <label>
      <span>Search environments</span>
      <input type="search" value={search} placeholder="Type part of a name or ID" onChange={event => setSearch(event.target.value)} />
    </label>
    <label>
      <span>Environment</span>
      <select
        value={selected?.value ?? value}
        className={value ? "active-filter-select" : undefined}
        aria-busy={loading}
        onChange={event => { setSearch(""); onChange(event.target.value); }}
      >
        <option value="">All environments</option>
        {value && !selected ? <option value={value}>Not in saved inventory: {value}</option> : null}
        {choices.map(option => <option key={option.value} value={option.value}>{option.label === option.value ? `Unnamed environment (${option.value})` : `${option.label} (${option.value})`}</option>)}
      </select>
    </label>
    {loading ? <span className="agent-filter-note" role="status">Loading saved environment choices...</span>
      : !options.length ? <span className="agent-filter-note" role="status">No environment choices in the saved agent inventory. Open Sync to update it.</span>
        : normalized && !matches.length ? <span className="agent-filter-note" role="status">No matching environments. Search by part of a name or ID; your current selection is unchanged.</span>
          : normalized ? <span className="agent-filter-note" role="status">{matches.length} matching environments. Select one to filter agents.</span> : null}
  </>;
}
