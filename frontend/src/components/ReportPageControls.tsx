import { useId, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReportPage } from "../../../backend/src/types/officialReportData";
import type { useReportPage } from "../useReportPage";
import { usageCount } from "../usageInsights";
import { isExpiredSelection } from "../selectedRead";
import "./reportPagination.css";

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
type PageControlsProps = {
  data?: Pick<ReportPage<unknown>, "page" | "counts" | "value">; previous: () => void; next: () => void;
  loading?: boolean; disabled?: boolean; leaseEnded?: boolean; label?: string; compact?: boolean;
  goToPage?: (page: number) => boolean; placement?: "top" | "bottom";
};
export function ReportPageControls({ data, previous, next, loading = false, disabled = false, leaseEnded = false, label = "rows", compact = false, goToPage, placement = "top" }: PageControlsProps) {
  if (goToPage) return <NumberedPageControls data={data} previous={previous} next={next} loading={loading}
    disabled={disabled} leaseEnded={leaseEnded} label={label} goToPage={goToPage} placement={placement} />;
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

function visiblePages(current: number, total: number): (number | "start-gap" | "end-gap")[] {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const start = Math.max(2, Math.min(current - 1, total - 3));
  const end = Math.min(total - 1, Math.max(current + 1, 4));
  return [1, ...(start > 2 ? ["start-gap" as const] : []),
    ...Array.from({ length: end - start + 1 }, (_, index) => start + index),
    ...(end < total - 1 ? ["end-gap" as const] : []), total];
}

function NumberedPageControls({ data, previous, next, loading, disabled, leaseEnded, label = "rows", goToPage, placement }: PageControlsProps & { goToPage: (page: number) => boolean }) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const current = data?.page.number ?? 1;
  const total = data ? Math.max(1, Math.ceil(data.counts.filtered / data.page.limit)) : 1;
  const blocked = Boolean(disabled || leaseEnded || loading || !data);
  const start = data?.value.length ? (data.page.offset ?? 0) + 1 : 0;
  const end = data ? (data.page.offset ?? 0) + data.value.length : 0;
  return <nav className="copilot-users-pagination report-pagination-numbered"
    aria-label={`${label} pages${placement === "bottom" ? " (bottom)" : ""}`} aria-busy={loading}>
    <div className="report-pagination-summary" role={placement === "bottom" ? undefined : "status"} aria-atomic="true">
      <span>{data ? <>Showing <strong>{start.toLocaleString()}–{end.toLocaleString()}</strong> of{" "}
        <strong>{data.counts.filtered.toLocaleString()}</strong> {label}</> : loading ? `Loading ${label}...` : `${label} unavailable`}</span>
      <small>{data ? <>Page {current.toLocaleString()} of {total.toLocaleString()}</> : " "}</small>
      {loading && data ? <span className="sr-only">Updating {label}.</span> : null}
    </div>
    <div className="report-pagination-actions">
      <button type="button" className="secondary report-page-direction" aria-label={`Previous ${label}`}
        aria-disabled={blocked || current <= 1} onClick={() => { if (!blocked && current > 1) previous(); }}>
        <ChevronLeft size={16} aria-hidden="true" /><span>Previous</span>
      </button>
      <ol className="report-page-numbers" aria-label="Page numbers">
        {visiblePages(current, total).map(item => <li key={item}>
          {typeof item === "number" ? <button type="button" className="secondary report-page-number"
            aria-label={`Page ${item}`} aria-current={data && item === current ? "page" : undefined}
            aria-disabled={blocked || item === current} onClick={() => { if (!blocked && item !== current) goToPage(item); }}>
            {item.toLocaleString()}
          </button> : <span className="report-page-gap" aria-hidden="true">…</span>}
        </li>)}
      </ol>
      <button type="button" className="secondary report-page-direction" aria-label={`Next ${label}`}
        aria-disabled={blocked || current >= total} onClick={() => { if (!blocked && current < total) next(); }}>
        <span>Next</span><ChevronRight size={16} aria-hidden="true" />
      </button>
    </div>
    {total > 7 ? <form className="report-page-jump" onSubmit={event => {
      event.preventDefault();
      if (!blocked && event.currentTarget.reportValidity() && input.current) {
        if (goToPage(input.current.valueAsNumber)) event.currentTarget.reset();
      }
    }}>
      <label htmlFor={inputId}>Go to page</label>
      <input ref={input} id={inputId} name="pageNumber" type="number" inputMode="numeric" required
        min={1} max={total} step={1} placeholder={String(current)} readOnly={blocked} aria-disabled={blocked} />
      <button type="submit" className="secondary" aria-disabled={blocked}>Go</button>
    </form> : null}
  </nav>;
}
