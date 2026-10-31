import { useId, useState } from "react";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, ArrowUpRight, Bot, Building2, CircleAlert, LoaderCircle, MessageSquareText, Trophy, UserRound, Users, type LucideIcon } from "lucide-react";
import type { AdoptionDepartment, AdoptionDepartmentPage, AdoptionSnapshot, AdoptionSummary, AdoptionSummaryPage } from "../../../backend/src/types/adoptionDashboard";
import { adoptionChange, adoptionSnapshotLabel } from "../adoptionTrends";
import { useReportPage } from "../useReportPage";
import { usageCount, usageDate } from "../usageInsights";
import { usersRouteSearch, workbenchUrl } from "../workbenchRouting";
import { ReportFacet } from "./ReportFacet";
import { ReportPageControls, ReportReadStatus } from "./ReportPageControls";

export function DashboardPanelHeading({ id, icon: Icon, title, description }: {
  id: string; icon: LucideIcon; title: string; description: string;
}) {
  return <header className="dashboard-panel-heading">
    <span className="dashboard-panel-icon"><Icon size={25} aria-hidden="true" /></span>
    <div><h3 id={id}>{title}</h3><p>{description}</p></div>
  </header>;
}

export function DashboardInsights({ snapshot, baseline, revision, company, onCompanyChange }: {
  snapshot: AdoptionSnapshot; revision: number; company?: string | null;
  baseline?: AdoptionSnapshot;
  onCompanyChange: (value: string | null | undefined) => void;
}) {
  const read = useReportPage<AdoptionSummary, AdoptionSummaryPage>("copilot-usage/adoption/summary", {
    setId: snapshot.id, limit: 1,
  }, revision);
  const data = read.data?.value[0];
  const people = data?.organization;
  const peopleTitle = useId(), agentsTitle = useId();
  const adoptionLink = workbenchUrl("users", usersRouteSearch({ section: "adoption", view: "licenses", search: "", page: 0,
    reportSetId: snapshot.id }));
  return <>
    <DepartmentAdoption snapshot={snapshot} revision={revision} company={company} onCompanyChange={onCompanyChange} base={read} />
    <section className="dashboard-panel dashboard-panel-purple" aria-labelledby={peopleTitle}>
      <DashboardPanelHeading id={peopleTitle} icon={Users} title="People and engagement"
        description="Understand participation and find opportunities to support your people." />
      <ReportReadStatus read={read} />
      {data ? <>
        <div className="dashboard-insight-cards">
          <InsightCard icon={Users} tone="blue" label="Active paid Copilot users" value={people?.paidActiveReportUsers}
            description="People with verified paid entitlement and agent activity in this report." unit="people" />
          <InsightCard icon={CircleAlert} tone="rose" label="Users needing attention" value={people?.needsAttentionUsers}
            description="Paid users with low or no agent activity, inactive apps, or service issues." unit="people" />
          <InsightCard icon={UserRound} tone="teal" label="Active users without paid Copilot" value={people?.activeWithoutPaidUsers}
            description="People with reported agent activity and verified inactive or no paid entitlement." unit="people" />
        </div>
        <p className="dashboard-panel-note">Organization-wide. Saved report: {adoptionSnapshotLabel(snapshot)}.
          {" "}Entitlements and app activity come from saved user sources, not historical license records.
          {" "}{usageCount(people?.unresolvedIdentities)} report identities could not be matched unambiguously.</p>
      </> : null}
    </section>
    <section className="dashboard-panel dashboard-panel-gold" aria-labelledby={agentsTitle}>
      <DashboardPanelHeading id={agentsTitle} icon={Trophy} title="Agents and champions"
        description="Explore what is being used and who is helping adoption grow." />
      <div className="dashboard-insight-cards">
        <InsightCard icon={Bot} tone="purple" label="Agents being used" value={snapshot.activeAgents}
          description="Distinct reported agent IDs with positive responses in this saved report." unit="agents" />
        <InsightCard icon={MessageSquareText} tone="blue" label="Reported responses" value={snapshot.responses}
          description="Responses from the Agents export only. Companion reports are never added together." unit="responses" />
        <InsightCard icon={Trophy} tone="gold" label="Copilot champions" value={data?.champions}
          description="Up to three usage-based suggestions per company / department, not assigned roles." unit="people" />
      </div>
      <p className="dashboard-panel-note">{baseline ? <>Responses: {adoptionChange(baseline.id === snapshot.id ? undefined : baseline, snapshot, "responses").label}
        {" "}vs baseline. </> : null}Organization-wide, for the same saved report. Usage is not a direct measure of productivity or ROI.</p>
      <a className="dashboard-text-link" href={adoptionLink}>Explore groups and champions <ArrowUpRight size={15} aria-hidden="true" /></a>
    </section>
  </>;
}

function InsightCard({ icon: Icon, tone, label, value, description, unit }: {
  icon: LucideIcon; tone: string; label: string; value: number | null | undefined; description: string; unit: string;
}) {
  return <div className={`dashboard-insight-card dashboard-tone-${tone}`}>
    <span className="dashboard-insight-icon"><Icon size={24} aria-hidden="true" /></span>
    <h4>{label}</h4>
    <p>{description}</p>
    <div className="dashboard-insight-value"><strong>{value == null ? "Unknown" : usageCount(value)}</strong><span>{unit}</span></div>
  </div>;
}

function DepartmentAdoption({ snapshot, revision, company, onCompanyChange, base }: {
  snapshot: AdoptionSnapshot; revision: number; company?: string | null;
  onCompanyChange: (value: string | null | undefined) => void;
  base: ReturnType<typeof useReportPage<AdoptionSummary, AdoptionSummaryPage>>;
}) {
  const title = useId();
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const read = useReportPage<AdoptionDepartment, AdoptionDepartmentPage>("copilot-usage/adoption/departments", {
    setId: snapshot.id, company, sort: "adoptionRate", order, limit: 10,
  }, revision);
  const data = read.data;
  const [retainedLayout, setRetainedLayout] = useState<{ data: AdoptionDepartmentPage; company?: string | null }>();
  if (data && retainedLayout?.data !== data) setRetainedLayout({ data, company });
  const skeleton = read.loading && !data;
  const layoutData = data ?? (skeleton ? retainedLayout?.data : undefined);
  const layoutCompany = skeleton && retainedLayout ? retainedLayout.company : company;
  const departments = layoutData?.value ?? (skeleton ? Array.from({ length: 10 }, () => undefined) : []);
  const SortIcon = order === "desc" ? ArrowDownWideNarrow : ArrowUpNarrowWide;
  return <section className="dashboard-panel dashboard-panel-teal" aria-labelledby={title}>
    <div className="dashboard-department-heading">
      <DashboardPanelHeading id={title} icon={Building2} title="Adoption by department"
        description="See where participation is taking hold, one company at a time." />
      <ReportFacet path="copilot-usage/adoption" field="company" compact dropdown hideLabel selectionId={base.selectedData?.selection.id}
        value={company} onChange={onCompanyChange} onRestartSelection={base.restart} onSelectionInvalidated={base.invalidateSelection} />
    </div>
    <div className="dashboard-department-columns">
      <span>Department</span>
      <button type="button" className="dashboard-department-sort"
        aria-label={`Sort departments by adoption percentage, ${order === "desc" ? "highest first" : "lowest first"}`}
        title={order === "desc" ? "Sort lowest first" : "Sort highest first"} onClick={() => setOrder(order === "desc" ? "asc" : "desc")}>
        Active / saved people <SortIcon size={15} aria-hidden="true" />
      </button>
    </div>
    <ReportReadStatus read={read} quietLoading />
    {read.loading && data ? <span className="sr-only" role="status">Updating departments...</span> : null}
    <div className="dashboard-department-results" aria-busy={read.loading}>
      {skeleton ? <span className="dashboard-department-loading" aria-hidden="true">
        <LoaderCircle size={16} className="agent-refresh-spinner" /> Loading departments...
      </span> : null}
      <div className={skeleton ? "dashboard-department-placeholder" : undefined} aria-hidden={skeleton || undefined} inert={skeleton}>
      {layoutData || skeleton ? <>
      {departments.length ? <ul className="dashboard-departments" aria-label="Department adoption" aria-busy={read.loading}>
        {departments.map((department, index) => {
          const percentage = department?.activePeople != null && department.people > 0
            ? department.activePeople / department.people * 100 : null;
          const label = department?.department ?? "Department not provided";
          const href = department && !skeleton ? workbenchUrl("users", usersRouteSearch({ section: "adoption", view: "licenses", search: "", page: 0,
            reportSetId: snapshot.id, company: department.company, department: department.department })) : undefined;
          return <li key={department?.id ?? index} className={`dashboard-department dashboard-bar-${index % 8}`}>
            <a href={href} title={skeleton ? undefined : `${department?.company ?? "Company not provided"} / ${label}`}>
              <span className="dashboard-department-name">{label}</span>
              {layoutCompany === undefined ? <small><span className="dashboard-department-name">{department?.company ?? "Company not provided"}</span></small> : null}</a>
            <span className="dashboard-department-bar" aria-hidden="true"><span style={{ width: `${percentage ?? (skeleton ? 65 - index % 5 * 10 : 0)}%` }} /></span>
            <span className="dashboard-department-value">
              <strong>{percentage === null ? "Unknown" : `${percentage.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`}</strong>
              <small>{department?.activePeople == null ? "Unknown" : usageCount(department.activePeople)} / {usageCount(department?.people)}</small>
            </span>
          </li>;
        })}
      </ul> : <p className="dashboard-panel-note">No saved department members match this company.
        Choose another company or allow automatic user synchronization to finish.</p>}
      <p className="dashboard-panel-note">Positive agent responses among unambiguously matched saved directory members,
        not the full workforce. Missing or ambiguous identities are not assigned to a department.
        {" "}Directory observed: {usageDate(layoutData?.directory.observedAt)}. Report: {adoptionSnapshotLabel(snapshot)}.</p>
    </> : null}
    <ReportPageControls data={layoutData} previous={read.previous} next={read.next} loading={read.loading}
      leaseEnded={read.leaseEnded} goToPage={read.goToPage} label="departments" compact showPageNumbers />
      </div>
    </div>
  </section>;
}
