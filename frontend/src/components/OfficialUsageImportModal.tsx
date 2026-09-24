import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { SyncReportRouteState } from "../workbenchRouting";
import { trapDialogFocus } from "../dialogFocus";
import { OfficialUsageImportPanel } from "./OfficialUsageImportPanel";
import { OfficialUsageManageReports } from "./OfficialUsageManageReports";
import { OfficialUsageSnapshot } from "./OfficialUsageSnapshot";
import type { ReportLocatorState } from "./CumulativeAgentActivity";
import "./officialUsage.css";

export type OfficialUsageImportModalProps = {
  route?: SyncReportRouteState;
  onRouteChange: (route: SyncReportRouteState | undefined) => void;
  canManage: boolean;
  revision: number;
  onChanged: () => void;
  onLegacyCleared?: () => void;
};

export function OfficialUsageImportModal({
  route, onRouteChange, canManage, revision, onChanged, onLegacyCleared,
}: OfficialUsageImportModalProps) {
  const open = Boolean(route);
  const importDenied = route?.view === "import" && !canManage;
  const view = importDenied ? "manage" : route?.view;
  const importActive = open && view !== "snapshot";
  const [visited, setVisited] = useState(canManage && importActive);
  const [stagingId, setStagingId] = useState(route?.stagingId);
  const [locatorState, setLocatorState] = useState<ReportLocatorState>({ query: {}, expanded: false });
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const returnTarget = useRef<HTMLElement | null>(null);
  const previousView = useRef(view);
  const lastOpenView = useRef(view);

  if (canManage && importActive && !visited) setVisited(true);
  if (route?.stagingId && route.stagingId !== stagingId) setStagingId(route.stagingId);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      const focused = document.activeElement;
      returnTarget.current = focused instanceof HTMLElement && focused !== document.body && focused !== document.documentElement && !element.contains(focused) ? focused : null;
      element.showModal();
      closeButton.current?.focus({ preventScroll: true });
    } else if (!open && element.open) element.close();
  }, [open]);

  useEffect(() => {
    if (open && view) lastOpenView.current = view;
    if (open && view !== previousView.current) closeButton.current?.focus({ preventScroll: true });
    previousView.current = view;
  }, [open, view]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [open]);

  function navigate(nextView: SyncReportRouteState["view"], reportSetId?: string) {
    onRouteChange({ view: nextView, reportSetId, activityWindowDays: nextView === "snapshot" && reportSetId ? 365 : 30 });
  }

  return (
    <dialog
      ref={dialog}
      className="official-usage-modal"
      aria-labelledby="usage-import-modal-title"
      aria-describedby="usage-import-modal-description"
      onKeyDown={event => {
        if ((event.target as HTMLElement).closest("dialog") === event.currentTarget) trapDialogFocus(event, dialog.current);
      }}
      onCancel={event => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onRouteChange(undefined);
      }}
      onClose={event => {
        if (event.target !== event.currentTarget || event.currentTarget.open) return;
        if (open) onRouteChange(undefined);
        const target = returnTarget.current;
        if (target?.isConnected) {
          target.focus({ preventScroll: true });
          if (document.activeElement === target) return;
        }
        // Direct-link dialogs have no opener; return to the matching Sync action.
        const labels = lastOpenView.current === "import" ? ["Add CSV reports", "Manage reports"] : ["Manage reports"];
        const actions = [...document.querySelectorAll<HTMLButtonElement>(".data-sync-reports button")];
        for (const label of labels) {
          const action = actions.find(button => !button.disabled && button.textContent?.trim() === label
            && !button.closest("[hidden], [inert]"));
          if (action) {
            action.focus({ preventScroll: true });
            if (document.activeElement === action) return;
          }
        }
        document.getElementById("sync-reports-heading")?.focus({ preventScroll: true });
      }}
    >
      <header className="usage-modal-header">
        <div>
          <h2 id="usage-import-modal-title">{view === "import" ? "Import CSV reports" : view === "snapshot" ? "Report snapshot" : "Manage reports"}</h2>
          <p id="usage-import-modal-description">{importDenied
            ? "An administrator (AgentControl.Admin) is required to import CSV reports. You can still inspect saved reports below."
            : view === "import"
              ? "Validate and review three CSV exports before accepting."
              : "Inspect saved report evidence without changing the tenant's current selection."}</p>
        </div>
        <button ref={closeButton} type="button" className="icon-button" aria-label="Close reports" autoFocus onClick={() => onRouteChange(undefined)}><X size={20} /></button>
        {view !== "snapshot" ? <div className="usage-modal-views" role="group" aria-label="Report workflow">
          {canManage ? <button type="button" className="secondary" aria-pressed={view === "import"} onClick={() => navigate("import")}>Add CSV reports</button> : null}
          <button type="button" className="secondary" aria-pressed={view === "manage"} onClick={() => navigate("manage")}>Manage reports</button>
        </div> : null}
      </header>
      <div className="usage-modal-content">
        {canManage && (visited || importActive) ? <div className="usage-modal-import-pane" hidden={!importActive}>
          <OfficialUsageImportPanel initialStagingId={stagingId} active={importActive} view={view === "manage" ? "manage" : "import"}
            revision={revision} onChanged={onChanged} onLegacyCleared={onLegacyCleared}
            locatorState={locatorState} onLocatorStateChange={setLocatorState}
            onViewChange={next => navigate(next)} onViewSnapshot={setId => navigate("snapshot", setId)} />
        </div> : null}
        {open && !canManage && view === "manage" ? <OfficialUsageManageReports revision={revision}
          locatorState={locatorState} onLocatorStateChange={setLocatorState}
          onViewSnapshot={setId => navigate("snapshot", setId)} /> : null}
        {open && view === "snapshot" ? <OfficialUsageSnapshot setId={route?.reportSetId}
          activityWindowDays={route?.activityWindowDays ?? 30} revision={revision}
          onBack={() => navigate("manage")} onCurrentSnapshot={() => navigate("snapshot")} /> : null}
      </div>
      <footer className="usage-modal-footer">
        <span>{canManage ? "Closing keeps your draft. Server staging can expire." : "Report inspection is read-only."}</span>
        <button type="button" className="secondary" onClick={() => onRouteChange(undefined)}>Close</button>
      </footer>
    </dialog>
  );
}
