import { useEffect, useId, useRef, useState } from "react";
import { ShieldCheck, X } from "lucide-react";
import {
  resolveDirectoryPrincipals,
  type DirectoryPrincipal,
  type PackageAccessEntity,
  type PackageAccessMutationMode,
  type PackageStatus,
  type PackageAccessTarget,
  type PackageAccessUpdate,
} from "../api/client";
import {
  formatAccessScope,
  getInitialAccessScope,
  type AccessScopeSelection,
} from "../accessScope";
import { PrincipalPicker } from "./PrincipalPicker";
import { WorkbenchActionGate } from "../workbenchActionContext";
import { useCapabilityContext } from "../capabilityContext";
import { providerActionAllowed, capabilityExplanation } from "../capabilityState";

type AccessAssignmentModalProps = {
  context: "single" | "bulk";
  agentCount: number;
  initialTarget?: PackageAccessTarget;
  initialPrincipals?: PackageAccessEntity[];
  initialStatus?: PackageStatus;
  busy?: boolean;
  onCancel: () => void;
  onSubmit: (update: PackageAccessUpdate) => Promise<void>;
};

type AccessAssignmentEditorProps = Omit<AccessAssignmentModalProps, "context" | "agentCount"> & {
  active?: boolean;
  readOnly?: boolean;
  onTargetChange: (target: PackageAccessTarget) => void;
};

export function AccessAssignmentModal(props: AccessAssignmentModalProps) {
  return <AccessAssignmentForm {...props} />;
}

export function AccessAssignmentEditor(props: AccessAssignmentEditorProps) {
  return <AccessAssignmentForm {...props} context="single" agentCount={1} inline />;
}

function AccessAssignmentForm({
  context,
  agentCount,
  initialTarget = "availability",
  initialPrincipals,
  initialStatus,
  busy = false,
  onCancel,
  onSubmit,
  inline = false,
  active = true,
  readOnly = false,
  onTargetChange,
}: AccessAssignmentModalProps & {
  inline?: boolean;
  active?: boolean;
  readOnly?: boolean;
  onTargetChange?: (target: PackageAccessTarget) => void;
}) {
  const id = useId();
  const capabilities = useCapabilityContext();
  const directory = capabilities.views.find(view => view.definition.id === "graph.directory.read");
  const directoryAllowed = providerActionAllowed(directory, false, capabilities.now);
  const [initialAccess] = useState(() => ({
    status: initialStatus,
    principals: initialPrincipals ?? [],
    principalsReported: initialPrincipals !== undefined,
    scope: getInitialAccessScope(initialStatus, initialPrincipals ?? []),
  }));
  const [target, setTarget] = useState<PackageAccessTarget>(initialTarget);
  const [mode, setMode] = useState<PackageAccessMutationMode>("replace");
  const [scope, setScope] = useState<AccessScopeSelection | undefined>(
    initialAccess.scope,
  );
  const [assignments, setAssignments] = useState(() => ({
    selected: initialAccess.principals.map(fallbackPrincipal),
    initialized: false,
  }));
  const { selected, initialized: principalsInitialized } = assignments;
  const resolving = initialAccess.scope === "specific"
    && initialAccess.principals.length > 0
    && !principalsInitialized;
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const locked = busy || submitting || readOnly;
  const [error, setError] = useState<string>();
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (inline) return;
    const previouslyFocused = document.activeElement;
    dialogRef.current?.focus();

    return () => {
      if (previouslyFocused instanceof HTMLElement) {
        previouslyFocused.focus();
      }
    };
  }, [inline]);

  useEffect(() => {
    if (inline) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy && !submitting) {
        event.stopImmediatePropagation();
        onCancel();
        return;
      }

      if (event.key === "Tab") {
        trapDialogFocus(event, dialogRef.current);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, inline, onCancel, submitting]);

  useEffect(() => {
    if (!active || readOnly || !directoryAllowed || !resolving) {
      return;
    }

    let cancelled = false;

    void resolveDirectoryPrincipals(initialAccess.principals)
      .then((response) => {
        if (!cancelled) {
          setAssignments({ selected: response.value, initialized: true });
        }
      })
      .catch((requestError) => {
        if (!cancelled) {
          setAssignments({ selected: initialAccess.principals.map(fallbackPrincipal), initialized: true });
          setError(errorMessage(requestError));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [initialAccess, resolving, directoryAllowed, active, readOnly]);

  function handleModeChange(nextMode: PackageAccessMutationMode) {
    setMode(nextMode);
    setConfirming(false);
    if (nextMode === "add") {
      setScope("specific");
    }
  }

  async function handleApply() {
    if (locked) return;
    if (!scope) {
      setError("Choose an access scope.");
      return;
    }

    if (scope === "specific" && selected.length === 0) {
      setError("Select at least one user or group.");
      return;
    }

    if (scope === "all") {
      setError("Microsoft Graph does not document an All users write payload.");
      return;
    }

    if (!inline && !confirming && mode === "replace") {
      setConfirming(true);
      return;
    }

    setError(undefined);
    setSubmitting(true);
    try {
      if (scope === "none") {
        await onSubmit({
          target,
          mode: "replace",
          scope,
          principals: [],
        });
      } else {
        await onSubmit({
          target,
          mode: context === "single" ? "replace" : mode,
          scope,
          principals: selected.map(({ resourceId, resourceType }) => ({
            resourceId,
            resourceType,
          })),
        });
      }
    } catch (requestError) {
      setError(errorMessage(requestError));
      setConfirming(false);
    } finally {
      setSubmitting(false);
    }
  }

  const content = (
      <section
        ref={dialogRef}
        className={inline ? "access-assignment-editor" : "access-assignment-modal"}
        role={inline ? "region" : "dialog"}
        aria-modal={inline ? undefined : true}
        aria-labelledby={inline ? undefined : `${id}-title`}
        aria-label={inline ? `${target === "availability" ? "Availability" : "Installation"} settings` : undefined}
        aria-busy={busy || submitting}
        tabIndex={inline ? undefined : -1}
        onClick={(event) => event.stopPropagation()}
      >
        {!inline ? <header className="access-modal-header">
          <span className="access-modal-icon">
            <ShieldCheck size={22} aria-hidden="true" />
          </span>
          <div className="access-modal-heading">
            <h2 id={`${id}-title`}>Manage agent access</h2>
            <p>
              Control who can use or install{" "}
              {agentCount === 1
                ? "this agent"
                : `the ${agentCount} selected agents`}
              .
            </p>
          </div>
          <button
            type="button"
            className="icon-button access-modal-close"
            aria-label="Close access management"
            title="Close"
            disabled={busy || submitting}
            onClick={onCancel}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </header> : null}

        <div className="access-modal-body">
          <nav className="access-setting-nav" aria-label="Access setting">
            <p>Users and installation</p>
            <button
              type="button"
              aria-current={target === "availability" ? "page" : undefined}
              disabled={busy || submitting || (!onTargetChange && context === "single" && target !== "availability")}
              onClick={() => {
                if (onTargetChange) onTargetChange("availability");
                else setTarget("availability");
                setConfirming(false);
              }}
            >
              <strong>Available to</strong>
              <small>Who can use the agent</small>
            </button>
            <button
              type="button"
              aria-current={target === "installation" ? "page" : undefined}
              disabled={busy || submitting || (!onTargetChange && context === "single" && target !== "installation")}
              onClick={() => {
                if (onTargetChange) onTargetChange("installation");
                else setTarget("installation");
                setConfirming(false);
              }}
            >
              <strong>Installed for</strong>
              <small>Who receives the agent</small>
            </button>
          </nav>

          <div className="access-form">
            <div className="access-section-heading">
              <div>
                <p className="eyebrow">
                  {target === "availability" ? "Availability" : "Installation"}
                </p>
                <h3>
                  {target === "availability"
                    ? "Select who can use this agent"
                    : "Select who this agent is installed for"}
                </h3>
                <p>
                  {target === "availability"
                    ? "Choose the users and groups that can find and use the agent."
                    : "Choose the users and groups that should receive the agent."}
                </p>
              </div>
              {context === "bulk" ? (
                <div className="access-change-control" aria-label="Change type">
                  <button
                    type="button"
                    aria-pressed={mode === "add"}
                    disabled={locked}
                    onClick={() => handleModeChange("add")}
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    aria-pressed={mode === "replace"}
                    disabled={locked}
                    onClick={() => handleModeChange("replace")}
                  >
                    Replace
                  </button>
                </div>
              ) : null}
            </div>

            <fieldset className="access-scope-fieldset">
              <legend>
                Access scope
                {context === "single" ? (
                  <span className="access-current-setting">
                    {inline ? "Saved" : "Current"}:{" "}
                    {formatAccessScope(initialAccess.status, initialAccess.principals)}
                  </span>
                ) : null}
              </legend>
              <div className="access-scope-options">
                <label className="disabled-option">
                  <input
                    type="radio"
                    name={`${id}-scope`}
                    checked={scope === "all"}
                    disabled
                    readOnly
                  />
                  <span>
                    <strong>All users</strong>
                    <small>
                      No supported Graph write payload is documented.
                    </small>
                  </span>
                </label>
                <label
                  className={mode === "add" ? "disabled-option" : undefined}
                >
                  <input
                    type="radio"
                    name={`${id}-scope`}
                    checked={scope === "none"}
                    disabled={locked || mode === "add"}
                    onChange={() => {
                      setScope("none");
                      setConfirming(false);
                    }}
                  />
                  <span>
                    <strong>No users</strong>
                    <small>Remove everyone from this setting.</small>
                  </span>
                </label>
                <label>
                  <input
                    type="radio"
                    name={`${id}-scope`}
                    checked={scope === "specific"}
                    disabled={locked}
                    onChange={() => {
                      setScope("specific");
                      setConfirming(false);
                    }}
                  />
                  <span>
                    <strong>Specific users or groups</strong>
                    <small>
                      Search the directory and build a selected list.
                    </small>
                  </span>
                </label>
              </div>
            </fieldset>

            {scope === "specific" ? (
              <section
                className="access-assignment-workspace"
                aria-labelledby={`${id}-assignments`}
              >
                <div className="access-workspace-heading">
                  <div>
                    <h4 id={`${id}-assignments`}>Users and groups</h4>
                    <p>
                      {readOnly ? "Saved assignments for this setting." : "Add directory users or groups, then review the list below."}
                    </p>
                  </div>
                  <span>{readOnly
                    ? initialAccess.principalsReported ? `${selected.length.toLocaleString()} saved` : "Not reported"
                    : `${selected.length.toLocaleString()} selected`}</span>
                </div>
                {readOnly || !directoryAllowed ? <>
                  {!readOnly ? <p role="status">{directory ? capabilityExplanation(directory, capabilities.now) : "Directory capability is unavailable."}</p> : null}
                  <AssignmentList values={readOnly && !initialAccess.principalsReported ? undefined : selected} saved={readOnly} />
                </> : resolving ? (
                  <p className="access-resolving" role="status">
                    Resolving current assignments...
                  </p>
                ) : (
                  <PrincipalPicker
                    selected={selected}
                    disabled={locked}
                    onChange={(principals) => {
                      setAssignments({ selected: principals, initialized: true });
                      setConfirming(false);
                    }}
                  />
                )}
              </section>
            ) : scope === "none" && !readOnly ? (
              <div className="access-empty-scope">
                <strong>No users will have this access.</strong>
                <p>
                  Applying this option removes the current users and groups.
                </p>
              </div>
            ) : null}

            {confirming ? (
              <div className="access-confirmation" role="alert">
                <strong>Confirm replacement</strong>
                <p>
                  This replaces{" "}
                  {target === "availability" ? "Available to" : "Installed for"}{" "}
                  on {agentCount} agent{agentCount === 1 ? "" : "s"} with{" "}
                  {scope === "none"
                    ? "no principals"
                    : `${selected.length} selected principal${selected.length === 1 ? "" : "s"}`}
                  .
                </p>
              </div>
            ) : null}
            {error ? <div className="inline-error" role="alert">{error}</div> : null}
          </div>
        </div>

        {!readOnly ? <footer className="access-modal-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy || submitting}
            onClick={onCancel}
          >
            {inline ? "Discard changes" : "Cancel"}
          </button>
          <WorkbenchActionGate actionId="packages.access">
          <button
            type="button"
            className={scope === "none" ? "danger" : undefined}
            disabled={
              busy ||
              submitting ||
              !scope ||
              scope === "all" ||
              (scope === "specific" && (!directoryAllowed || resolving || selected.length === 0))
            }
            onClick={() => void handleApply()}
          >
            {busy || submitting
              ? "Applying"
              : confirming
                ? "Confirm and apply"
                : "Apply"}
          </button>
                  </WorkbenchActionGate>
        </footer> : null}
      </section>
  );
  return inline ? content : <div
    className="modal-backdrop access-modal-backdrop"
    role="presentation"
    onClick={() => { if (!busy && !submitting) onCancel(); }}
  >{content}</div>;
}

function AssignmentList({ values, saved }: { values?: DirectoryPrincipal[]; saved: boolean }) {
  const [requestedOffset, setRequestedOffset] = useState(0);
  const count = values?.length ?? 0;
  const offset = Math.min(requestedOffset, Math.max(0, Math.ceil(count / 8) - 1) * 8);
  return <div className="agent-control-assignments" role="group" aria-label={saved ? "Saved users and groups" : "Selected users and groups"}>
    <p>{values === undefined ? "Assignments not reported" : count
      ? `${count.toLocaleString()} ${saved ? "saved" : "selected"} user or group ${count === 1 ? "assignment" : "assignments"}`
      : saved ? "No explicit user or group assignments" : "No users or groups selected"}</p>
    {count ? <ul>{values?.slice(offset, offset + 8).map((entry, index) => <li key={`${entry.resourceType}:${entry.resourceId}:${index}`}>
      <strong>{entry.displayName}</strong><span>{entry.resourceType}: {entry.resourceId}</span>
    </li>)}</ul> : null}
    {count > 8 ? <div className="agent-assignment-pages">
      <span>{offset + 1}-{Math.min(offset + 8, count)} of {count.toLocaleString()}</span>
      <button type="button" className="secondary" disabled={offset === 0} onClick={() => setRequestedOffset(offset - 8)}>Previous assignments</button>
      <button type="button" className="secondary" disabled={offset + 8 >= count} onClick={() => setRequestedOffset(offset + 8)}>Next assignments</button>
    </div> : null}
  </div>;
}

function fallbackPrincipal(entity: PackageAccessEntity): DirectoryPrincipal {
  return {
    ...entity,
    displayName: entity.resourceId,
    principalKind: "unknown",
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Access update failed.";
}

function trapDialogFocus(event: KeyboardEvent, dialog: HTMLElement | null) {
  if (!dialog) {
    return;
  }

  const focusable = [
    ...dialog.querySelectorAll<HTMLElement>(focusableSelector),
  ].filter((element) => !element.hasAttribute("disabled"));

  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;

  if (event.shiftKey && (active === first || active === dialog)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

const focusableSelector = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  '[tabindex]:not([tabindex="-1"])',
].join(",");
