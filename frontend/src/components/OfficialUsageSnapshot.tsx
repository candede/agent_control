import { ReportingView } from "./ReportingView";
export function OfficialUsageSnapshot({ setId, activityWindowDays, revision, onBack }: {
  setId?: string; activityWindowDays: number; revision: number; onBack: () => void;
}) {
  return <section className="usage-snapshot" aria-label="Snapshot inspection" tabIndex={0}>
    <header className="report-section-header"><button type="button" className="secondary" onClick={onBack}>Back to reports</button>
      <p>Viewing this report does not change the selected report set.</p></header>
    <ReportingView setId={setId} activityWindowDays={activityWindowDays} revision={revision} />
  </section>;
}
