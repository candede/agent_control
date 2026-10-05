import type { ReportPage } from "../../../backend/src/types/officialReportData";
import type { useReportPage } from "../useReportPage";
import { usageCount } from "../usageInsights";

export function ReportReadStatus({ read, quietLoading = false }: { read: Pick<ReturnType<typeof useReportPage>, "loading" | "error" | "invalidated" | "retry" | "restart" | "restartable"> & { data?: unknown }; quietLoading?: boolean }) {
  if (read.invalidated) return <div role="alert" className="error-banner">This selection changed or expired. Restart to load a new consistent selection.
    {read.restartable ? <>{" "}<button type="button" onClick={read.restart}>Restart selection</button></>
      : " Close this detail and restart its parent selection."}</div>;
  if (read.error) return <div role="alert" className="error-banner">{read.error.message}
    {" "}<button type="button" onClick={read.retry}>Retry saved data</button></div>;
  return read.loading && !read.data ? <p className={quietLoading ? "sr-only" : undefined} role="status">Loading saved data...</p> : null;
}
export function ReportPageControls({ data, previous, next, loading = false, disabled = false, label = "rows", compact = false }: {
  data?: Pick<ReportPage<unknown>, "page" | "counts" | "value">; previous: () => void; next: () => void; loading?: boolean; disabled?: boolean; label?: string; compact?: boolean;
}) {
  const previousDisabled = disabled || !data?.page.previousCursor, nextDisabled = disabled || !data?.page.nextCursor;
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
