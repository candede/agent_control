import { useCallback, useState } from "react";
import type { OfficialUsageAdminState } from "../api/client";
import { kindLabel } from "./officialUsageImportPresentation";
import { OfficialUsageHistoryPanel, type ReportHistoryAdminControls } from "./OfficialUsageHistoryPanel";
import { CumulativeAgentActivity, type ReportLocatorState } from "./CumulativeAgentActivity";

export function OfficialUsageManageReports({
  revision, state, admin, onRefresh, onViewSnapshot, locatorState, onLocatorStateChange,
}: {
  revision: number;
  state?: OfficialUsageAdminState;
  admin?: ReportHistoryAdminControls;
  onRefresh?: () => void;
  onViewSnapshot?: (setId: string | undefined) => void;
  locatorState?: ReportLocatorState;
  onLocatorStateChange?: (state: ReportLocatorState) => void;
}) {
  const [historyRead, setHistoryRead] = useState<{ revision: number; verified: boolean }>();
  const onVerificationChange = useCallback((next: boolean) => setHistoryRead({ revision, verified: next }), [revision]);
  const verified = historyRead?.revision === revision && historyRead.verified;
  const drafts = [...new Set(state?.staging.filter(stage => stage.status === "active").map(stage => stage.bundleId))];
  return (
    <section className="usage-manage-reports" aria-label="Saved reports" tabIndex={0}>
      {admin && drafts.length ? (
        <section className="usage-managed-drafts" aria-label="Staged imports">
          <h4>Staged imports</h4>
          <ul>{drafts.map(bundleId => {
            const stages = state!.staging.filter(stage => stage.bundleId === bundleId && stage.status === "active");
            return <li key={bundleId}>
              <div><strong>Draft {bundleId.slice(0, 8)}</strong><span>{stages.map(stage => kindLabel(stage.kind)).join(", ")} · not published</span></div>
              <button type="button" className="secondary" disabled={admin.busy || !admin.verified || !verified}
                onClick={() => admin.onResume(bundleId)}>Resume import<span className="sr-only"> {bundleId.slice(0, 8)}</span></button>
            </li>;
          })}</ul>
        </section>
      ) : null}
      <OfficialUsageHistoryPanel revision={revision} onSelect={onViewSnapshot} admin={admin} onRefresh={onRefresh}
        onVerificationChange={onVerificationChange} />
      {onViewSnapshot ? <CumulativeAgentActivity revision={revision} onSnapshot={onViewSnapshot}
        initialQuery={locatorState?.query} initialExpanded={locatorState?.expanded}
        onQueryChange={query => onLocatorStateChange?.({ query, expanded: true })}
        onExpandedChange={expanded => onLocatorStateChange?.({ query: locatorState?.query ?? {}, expanded })} /> : null}
    </section>
  );
}
