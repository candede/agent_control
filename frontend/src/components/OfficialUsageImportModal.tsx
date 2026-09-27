import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { SyncReportRouteState } from "../workbenchRouting";
import { trapDialogFocus } from "../dialogFocus";
import { OfficialUsageImportPanel, type OfficialUsageImportHandle } from "./OfficialUsageImportPanel";
import { OfficialUsageManageReports } from "./OfficialUsageManageReports";
import { OfficialUsageSnapshot } from "./OfficialUsageSnapshot";
import "./officialUsage.css";

type OfficialUsageImportModalProps = {
  route?: SyncReportRouteState;
  onRouteChange: (route: SyncReportRouteState | undefined) => void;
  canManage: boolean;
  revision: number;
  onChanged: () => void;
  onImported: () => void;
  onLegacyCleared?: () => void;
};

export function OfficialUsageImportModal({
  route, onRouteChange, canManage, revision, onChanged, onImported, onLegacyCleared,
}: OfficialUsageImportModalProps) {
  const open = Boolean(route);
  const importDenied = route?.view === "import" && !canManage;
  const view = importDenied ? "manage" : route?.view;
  const [resumeBundleId, setResumeBundleId] = useState<string>();
  const importer = useRef<OfficialUsageImportHandle>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const returnTarget = useRef<HTMLElement | null>(null);
  const previousView = useRef(view);
  const lastOpenView = useRef(view);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      const focused = document.activeElement;
      returnTarget.current = focused instanceof HTMLElement && focused !== document.body && focused !== document.documentElement && !element.contains(focused) ? focused : null;
      element.showModal();
      (element.querySelector<HTMLButtonElement>(".usage-upload-zone button") ?? closeButton.current ?? title.current)?.focus({ preventScroll: true });
    } else if (!open && element.open) element.close();
  }, [open]);

  useEffect(() => {
    if (open && view) lastOpenView.current = view;
    if (open && view !== previousView.current) (closeButton.current ?? title.current)?.focus({ preventScroll: true });
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

  function dismiss() {
    if (view === "import") importer.current?.dismiss();
    else onRouteChange(undefined);
  }

  return (
    <dialog
      ref={dialog}
      className={`official-usage-modal${view === "import" ? " usage-import-modal" : ""}`}
      aria-labelledby="usage-import-modal-title"
      aria-describedby={importDenied ? "usage-import-modal-description" : undefined}
      onKeyDown={event => {
        if ((event.target as HTMLElement).closest("dialog") === event.currentTarget) trapDialogFocus(event, dialog.current);
      }}
      onCancel={event => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        dismiss();
      }}
      onClose={event => {
        if (event.target !== event.currentTarget || event.currentTarget.open) return;
        setResumeBundleId(undefined);
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
          <h2 ref={title} tabIndex={-1} id="usage-import-modal-title">{view === "import" ? "Add CSV reports" : view === "snapshot" ? "Report details" : "Manage reports"}</h2>
          {importDenied ? <p id="usage-import-modal-description">
            An administrator is required to import CSV reports. You can view saved reports below.
          </p> : null}
        </div>
        {view === "manage" ? <div className="usage-modal-header-actions">
          {canManage ? <button type="button" onClick={() => { setResumeBundleId(undefined); navigate("import"); }}>Add CSV reports</button> : null}
          <button ref={closeButton} type="button" className="icon-button" aria-label="Close reports" onClick={dismiss}><X size={20} /></button>
        </div> : null}
      </header>
      <div className="usage-modal-content">
        {open && canManage && view === "import" ? <OfficialUsageImportPanel
          key={route?.stagingId ?? resumeBundleId ?? "new"} ref={importer}
          initialStagingId={route?.stagingId} initialBundleId={resumeBundleId}
          onChanged={onChanged} onCancel={() => onRouteChange(undefined)}
          onDone={() => { onRouteChange(undefined); onImported(); }} /> : null}
        {open && view === "manage" ? <OfficialUsageManageReports revision={revision} canManage={canManage}
          onChanged={onChanged} onLegacyCleared={onLegacyCleared}
          onViewSnapshot={setId => navigate("snapshot", setId)}
          onResumeImport={bundleId => { setResumeBundleId(bundleId); navigate("import"); }} /> : null}
        {open && view === "snapshot" ? <OfficialUsageSnapshot setId={route?.reportSetId}
          activityWindowDays={route?.activityWindowDays ?? 30} revision={revision}
          onBack={() => navigate("manage")} /> : null}
      </div>
    </dialog>
  );
}
