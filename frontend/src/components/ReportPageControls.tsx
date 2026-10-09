import type { ReportPage } from "../../../backend/src/types/officialReportData";
import type { useReportPage } from "../useReportPage";
import { usageCount } from "../usageInsights";
import { isExpiredSelection } from "../selectedRead";

export function ReportReadStatus({ read, quietLoading = false }: { read: Pick<ReturnType<typeof useReportPage>, "loading" | "error" | "invalidated" | "retry" | "restart" | "restartable"> & { data?: unknown; leaseEnded?: boolean; renewing?: boolean }; quietLoading?: boolean }) {
  if (read.renewing) return null;
  if (read.invalidated) return <div role="alert" className="error-banner">This selection changed or expired. Restart to load a new consistent selection.
    {read.restartable ? <>{" "}<button type="button" onClick={read.restart}>Restart selection</button></>
      : " Close this detail and restart its parent selection."}</div>;
  if (read.loading && !read.data) return <p className={quietLoading ? "sr-only" : undefined} role="status">Loading saved data...</p>;
  if (read.leaseEnded && (!read.error || isExpiredSelection(read.error))) return <div role="status" className="copilot-users-notice">Showing previously loaded saved data. Load a new selection before paging, exporting or acting.
    {read.restartable ? <>{" "}<button type="button" onClick={read.restart}>Restart selection</button></>
      : " Restart its parent selection."}</div>;
  if (read.error) return <div role="alert" className="error-banner">{read.error.message}
    {" "}<button type="button" onClick={read.retry}>Retry saved data</button></div>;
  return null;
}
export function ReportPageControls({ data, previous, next, loading = false, disabled = false, leaseEnded = false, label = "rows", compact = false }: {
  data?: Pick<ReportPage<unknown>, "page" | "counts" | "value">; previous: () => void; next: () => void; loading?: boolean; disabled?: boolean; leaseEnded?: boolean; label?: string; compact?: boolean;
}) {
  const previousDisabled = disabled || leaseEnded || loading || !data?.page.previousCursor, nextDisabled = disabled || leaseEnded || loading || !data?.page.nextCursor;
  return <nav className="copilot-users-pagination" aria-label={`${label} pages`} aria-busy={loading}>
    <span role="status">{usageCount(data?.counts.filtered)} matching {label}{data ? `; ${data.value.length} on this page` : ""}</span>
    <button type="button" className="secondary" aria-disabled={previousDisabled}
      onClick={() => { if (!previousDisabled) previous(); }} aria-label={`Previous ${label}`}>
      {compact ? <span aria-hidden="true">←</span> : <>Previous {label}</>}</button>
    <button type="button" className="secondary" aria-disabled={nextDisabled}
      onClick={() => { if (!nextDisabled) next(); }} aria-label={`Next ${label}`}>
      {compact ? <span aria-hidden="true">→</span> : <>Next {label}</>}</button>
  </nav>;
}
