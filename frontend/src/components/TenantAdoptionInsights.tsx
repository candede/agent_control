import { useEffect, useId, useRef, useState } from "react";
import {
  getOfficialUsageAgentDetail,
  getOfficialUsageAggregate,
  type OfficialUsageAgentDetailView,
  type OfficialUsageAggregateView,
} from "../api/client";
import { usageCount, usageDate, usagePageLabel, userAgentMatrixUrl } from "../usageInsights";
import { UsageMetric, UsageReportContext, UsageReportRecovery } from "./UsageReportContext";
import "./agentInsights.css";

type ReadState<T> = { key: string; value: T } | { key: string; error: string };
const reportPageSize = 6;
const userPageSize = 20;

export function TenantAdoptionInsights({
  compact = false,
  dataRevision = 0,
}: {
  compact?: boolean;
  dataRevision?: number;
}) {
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<ReadState<OfficialUsageAggregateView>>();
  const [selection, setSelection] = useState<{ agentId: string; setId: string; revision: number }>();
  const searchId = useId();
  const key = JSON.stringify([search.trim(), offset, retry, dataRevision]);
  const scoped = result?.key === key ? result : undefined;
  const data = scoped && "value" in scoped ? scoped.value : undefined;
  const activeSet = data?.activeSet;
  const error = scoped && "error" in scoped ? scoped.error : undefined;
  const showExplorer = !compact || expanded;
  const selected = selection?.revision === dataRevision ? selection : undefined;
  const selectedHeading = useRef<HTMLHeadingElement>(null);
  const reportSearch = useRef<HTMLInputElement>(null);
  const exploreButton = useRef<HTMLButtonElement>(null);
  const hadSelection = useRef(false);
  const showPicker = showExplorer && !selected;

  useEffect(() => {
    if (selected) selectedHeading.current?.focus();
    else if (hadSelection.current) (reportSearch.current ?? exploreButton.current)?.focus();
    hadSelection.current = Boolean(selected);
  }, [selected]);

  useEffect(() => {
    const controller = new AbortController();
    getOfficialUsageAggregate({ search: search.trim() || undefined, limit: reportPageSize, offset }, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setResult({ key, value }); })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setResult({ key, error: error instanceof Error ? error.message : "Agent usage reports could not be loaded." });
      });
    return () => controller.abort();
  }, [key, search, offset]);

  return <section className="agent-usage-insights" aria-label="Tenant adoption insights">
    <div className="agent-insight-heading">
      <div>
        <h3>{showExplorer ? "Usage & adoption" : selected ? "Selected usage report" : "Tenant adoption snapshot"}</h3>
        <p>Understand agent adoption, then investigate users or manage access in the inventory below.</p>
      </div>
      <div className="agent-insight-actions">
        {compact ? <button ref={exploreButton} type="button" className="secondary" onClick={() => setExpanded(value => !value)}>{showExplorer ? "Hide report explorer" : "Explore usage & users"}</button> : null}
        <a href={userAgentMatrixUrl()}>User-agent matrix</a>
      </div>
      {showPicker ? <div className="agent-insight-toolbar">
        <label htmlFor={searchId}>Find a reported agent
          <input ref={reportSearch} id={searchId} type="search" value={search} maxLength={256} placeholder="Agent name, report ID or creator" onChange={event => { setSearch(event.target.value); setOffset(0); }} />
        </label>
        {search ? <button className="secondary" type="button" onClick={() => { setSearch(""); setOffset(0); }}>Browse all reported agents</button> : null}
      </div> : null}
    </div>
    {error ? <div className="error-banner" role="alert">{error} <button className="secondary" type="button" onClick={() => setRetry(value => value + 1)}>Retry usage reports</button></div> : null}
    {!scoped ? <p role="status">Loading saved adoption reports...</p> : null}
    {data ? <>
      {!selected ? <UsageReportContext data={data} /> : null}
      {!activeSet ? <UsageReportRecovery availability={data.availability} /> : <>
        {!selected ? <div className="agent-usage-metrics" aria-label="Tenant report totals">
          <UsageMetric label="Agent responses" value={data.summary.usage.totalResponses} hint="Tenant total from the Agents report" />
          <UsageMetric label="Active users" value={data.summary.usage.totalActiveUsers} hint="Distinct report identities with positive responses, not license assignments" />
          <UsageMetric label="Recently active agents" value={data.summary.activityWindow.anchorDateUtc ? data.summary.activityWindow.activeAgents : null}
            hint={data.summary.activityWindow.anchorDateUtc ? `30 days to ${usageDate(data.summary.activityWindow.anchorDateUtc)}` : "Activity dates not reported"} />
          <UsageMetric label="Response coverage" value={data.missingKinds.length ? "Incomplete" : "3 reports"} hint="Companion exports, not combined totals" />
        </div> : null}
        {!selected && data.summary.usage.responseReconciliation.status === "mismatch" ? <p className="agent-insight-note">Report totals differ. The tenant response total uses only the Agents report; companion totals are not added together.</p> : null}
        {showPicker ? <>
          {data.agents.value.length ? <div className="agent-report-candidates">
            {data.agents.value.map(agent => <button key={agent.agentId} className="agent-report-candidate" type="button"
              aria-label={`Explore report for ${agent.agentName || agent.agentId} (${agent.agentId}), ${usageCount(agent.responsesSentToUsers)} responses`}
              onClick={() => setSelection({ agentId: agent.agentId, setId: activeSet.id, revision: dataRevision })}>
              <span><strong>{agent.agentName || agent.agentId}</strong><small>{agent.creatorType || "Creator not reported"}</small><code>{agent.agentId}</code></span>
              <span><strong>{usageCount(agent.responsesSentToUsers)}</strong><small>responses</small></span>
            </button>)}
          </div> : <div className="agent-insight-empty">
            <h4>{data.agents.count ? "No reported agents on this page" : "No reported agents match this search"}</h4>
            <p>This does not establish zero usage. Try another name or browse all reported agents.</p>
            {offset > 0 ? <button type="button" className="secondary" onClick={() => setOffset(0)}>First agent page</button> : null}
          </div>}
          <div className="agent-insight-pagination" aria-label="Reported agent pages">
            <span>{usagePageLabel(data.agents, "reports")}</span>
            <button className="secondary" type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - reportPageSize))}>Previous agents</button>
            <button className="secondary" type="button" disabled={offset + reportPageSize >= data.agents.count} onClick={() => setOffset(offset + reportPageSize)}>Next agents</button>
          </div>
        </> : null}
      </>}
    </> : null}
    {selected ? <div className="agent-selected-report">
      <div className="agent-insight-heading"><h4 ref={selectedHeading} tabIndex={-1}>Selected usage report</h4><button className="secondary" type="button" onClick={() => setSelection(undefined)}>Clear report selection</button></div>
      <ReportedAgentUsage key={`${selected.setId}:${selected.agentId}`} agentId={selected.agentId} reportSetId={selected.setId} showUsers={showExplorer} />
    </div> : null}
  </section>;
}

export function ReportedAgentUsage({ agentId, reportSetId, showUsers = true }: {
  agentId: string;
  reportSetId: string;
  showUsers?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<ReadState<OfficialUsageAgentDetailView>>();
  const key = JSON.stringify([agentId, reportSetId, search.trim(), offset, retry]);
  const scoped = result?.key === key ? result : undefined;
  const data = scoped && "value" in scoped ? scoped.value : undefined;
  const error = scoped && "error" in scoped ? scoped.error : undefined;
  const searchId = useId();

  useEffect(() => {
    const controller = new AbortController();
    getOfficialUsageAgentDetail(agentId, { setId: reportSetId, search: search.trim() || undefined, limit: userPageSize, offset }, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setResult({ key, value }); })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setResult({ key, error: error instanceof Error ? error.message : "The selected agent report could not be loaded." });
      });
    return () => controller.abort();
  }, [agentId, reportSetId, search, offset, key]);

  const agent = data?.agent;
  return <section className="reported-agent-usage" aria-label={agent ? `Usage report for ${agent.agentName || agent.agentId}` : "Selected agent usage report"}>
    {showUsers ? <div className="agent-insight-toolbar"><label htmlFor={searchId}>Search reported users<input id={searchId} type="search" value={search} maxLength={256} onChange={event => { setSearch(event.target.value); setOffset(0); }} /></label></div> : null}
    {error ? <div className="error-banner" role="alert">{error} <button type="button" className="secondary" onClick={() => setRetry(value => value + 1)}>Retry agent report</button></div> : null}
    {!scoped ? <p role="status">Loading the selected agent's report...</p> : null}
    {data && agent ? <>
    <div className="agent-insight-heading">
      <div><h4>{agent.agentName || agent.agentId}</h4><p>{agent.creatorType || "Creator not reported"} <code>{agent.agentId}</code></p></div>
      <a href={userAgentMatrixUrl(agent.agentId, data.activeSet?.id)}>Open in user-agent matrix</a>
    </div>
    <UsageReportContext data={data} />
    <div className="agent-usage-metrics" aria-label="Selected agent report metrics">
      <UsageMetric label="Responses" value={agent.responsesSentToUsers} hint={agent.sourceReport === "agents" ? "Agents report total" : "Users & agents breakdown total"} />
      <UsageMetric label="Users with responses" value={agent.activeUsersIdentityCount} hint="Distinct report identities, responses > 0" />
      <UsageMetric label="Reported users" value={data.summary.reportedUsers} hint={`${usageCount(data.summary.zeroResponseUsers)} with zero responses`} />
      <UsageMetric label="Last agent activity" value={usageDate(agent.lastActivityDateUtc)} hint="Agent-wide, not a user's last interaction" />
    </div>
    {agent.responseComparison.status === "mismatch" ? <p className="agent-insight-note" role="status">Response totals differ: {usageCount(agent.responsesSentToUsers)} in the {agent.sourceReport === "agents" ? "Agents report" : "user breakdown"} and {usageCount(data.summary.userBreakdownResponses)} in Users &amp; agents. Neither total is substituted for the other.</p> : null}
    <details className="agent-insight-provenance">
      <summary>Report coverage and license categories</summary>
      <p>Licensed active-user occurrences: {usageCount(agent.activeUsersLicensed)}. Unlicensed active-user occurrences: {usageCount(agent.activeUsersUnlicensed)}. A user can appear in both categories; these are not added and do not establish current license assignments.</p>
      <p>Responses are period totals, not prompts, sessions, or a daily activity log. Missing relationships do not establish zero activity or lack of access.</p>
      <p>Report set: <code>{data.activeSet?.id ?? "Not supplied"}</code>. This report does not verify an inventory identity or authorize management actions.</p>
    </details>
    {showUsers ? <>
      {data.users.value.length ? <div className="agent-insight-table-shell" role="region" aria-label="Users of the reported agent" tabIndex={0}>
        <table className="agent-insight-table"><caption>Who used this reported agent</caption><thead><tr><th scope="col">Reported user</th><th scope="col">Responses</th><th scope="col">Activity signal</th></tr></thead>
          <tbody>{data.users.value.map(user => <tr key={user.username}>
            <th scope="row"><a href={userAgentMatrixUrl(agent.agentId, data.activeSet?.id, user.username)}>{user.displayName || user.username}</a><small>{user.username}</small></th>
            <td>{usageCount(user.responsesSentToUsers)}</td><td>{user.responsesSentToUsers > 0 ? "Using this agent" : "Zero responses reported"}</td>
          </tr>)}</tbody>
        </table>
      </div> : <div>
        <p>{data.users.count ? "No reported users on this page." : search ? "No reported users match this search." : data.summary.reportedUsers === null ? "The user-agent breakdown is not available for this report." : "No user-agent relationships were reported. This is not proof of no usage."}</p>
        {offset > 0 ? <button type="button" className="secondary" onClick={() => setOffset(0)}>First reported user page</button> : null}
      </div>}
      <div className="agent-insight-pagination" aria-label="Reported user pages">
        <span>{usagePageLabel(data.users, "reported users")}</span>
        <button type="button" className="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - userPageSize))}>Previous users</button>
        <button type="button" className="secondary" disabled={offset + userPageSize >= data.users.count} onClick={() => setOffset(offset + userPageSize)}>Next users</button>
      </div>
    </> : null}
    </> : null}
  </section>;
}
