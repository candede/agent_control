import { useEffect, useRef, useState } from "react";
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

export function AccessAssignmentModal({
  context,
  agentCount,
  initialTarget = "availability",
  initialPrincipals = [],
  initialStatus,
  busy = false,
  onCancel,
  onSubmit,
}: AccessAssignmentModalProps) {
  const initialScope = getInitialAccessScope(initialStatus, initialPrincipals);
  const [target, setTarget] = useState<PackageAccessTarget>(initialTarget);
  const [mode, setMode] = useState<PackageAccessMutationMode>("replace");
  const [scope, setScope] = useState<AccessScopeSelection | undefined>(
    initialScope,
  );
  const [selected, setSelected] = useState<DirectoryPrincipal[]>([]);
  const [resolving, setResolving] = useState(
    initialScope === "specific" && initialPrincipals.length > 0,
  );
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    dialogRef.current?.focus();

    return () => {
      if (previouslyFocused instanceof HTMLElement) {
        previouslyFocused.focus();
      }
    };
  }, []);

  useEffect(() => {
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
  }, [busy, onCancel, submitting]);

  useEffect(() => {
    if (initialScope !== "specific" || initialPrincipals.length === 0) {
      return;
    }

    let cancelled = false;

    void resolveDirectoryPrincipals(initialPrincipals)
      .then((response) => {
        if (!cancelled) {
          setSelected(response.value);
        }
      })
      .catch((requestError) => {
        if (!cancelled) {
          setSelected(initialPrincipals.map(fallbackPrincipal));
          setError(errorMessage(requestError));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setResolving(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [initialPrincipals, initialScope]);

  function handleModeChange(nextMode: PackageAccessMutationMode) {
    setMode(nextMode);
    setConfirming(false);
    if (nextMode === "add") {
      setScope("specific");
    }
  }

  async function handleApply() {
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

    if (!confirming && mode === "replace") {
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

  return (
    <div
      className="modal-backdrop access-modal-backdrop"
      role="presentation"
      onClick={() => {
        if (!busy && !submitting) {
          onCancel();
        }
      }}
    >
      <section
        ref={dialogRef}
        className="access-assignment-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="access-assignment-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="access-modal-header">
          <span className="access-modal-icon">
            <ShieldCheck size={22} aria-hidden="true" />
          </span>
          <div className="access-modal-heading">
            <h2 id="access-assignment-title">Manage agent access</h2>
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
        </header>

        <div className="access-modal-body">
          <nav className="access-setting-nav" aria-label="Access setting">
            <p>Users and installation</p>
            <button
              type="button"
              aria-current={target === "availability" ? "page" : undefined}
              disabled={context === "single" && target !== "availability"}
              onClick={() => {
                setTarget("availability");
                setConfirming(false);
              }}
            >
              <strong>Available to</strong>
              <small>Who can use the agent</small>
            </button>
            <button
              type="button"
              aria-current={target === "installation" ? "page" : undefined}
              disabled={context === "single" && target !== "installation"}
              onClick={() => {
                setTarget("installation");
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
                    onClick={() => handleModeChange("add")}
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    aria-pressed={mode === "replace"}
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
                    Current:{" "}
                    {formatAccessScope(initialStatus, initialPrincipals)}
                  </span>
                ) : null}
              </legend>
              <div className="access-scope-options">
                <label className="disabled-option">
                  <input
                    type="radio"
                    name="access-scope"
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
                    name="access-scope"
                    checked={scope === "none"}
                    disabled={mode === "add"}
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
                    name="access-scope"
                    checked={scope === "specific"}
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
                aria-labelledby="assignment-workspace-title"
              >
                <div className="access-workspace-heading">
                  <div>
                    <h4 id="assignment-workspace-title">Users and groups</h4>
                    <p>
                      Add directory users or groups, then review the list below.
                    </p>
                  </div>
                  <span>{selected.length} selected</span>
                </div>
                {resolving ? (
                  <p className="access-resolving" role="status">
                    Resolving current assignments...
                  </p>
                ) : (
                  <PrincipalPicker
                    selected={selected}
                    onChange={(principals) => {
                      setSelected(principals);
                      setConfirming(false);
                    }}
                  />
                )}
              </section>
            ) : scope === "none" ? (
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
            {error ? <div className="inline-error">{error}</div> : null}
          </div>
        </div>

        <footer className="access-modal-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy || submitting}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className={scope === "none" ? "danger" : undefined}
            disabled={
              busy ||
              submitting ||
              resolving ||
              !scope ||
              scope === "all" ||
              (scope === "specific" && selected.length === 0)
            }
            onClick={() => void handleApply()}
          >
            {busy || submitting
              ? "Applying"
              : confirming
                ? "Confirm and apply"
                : "Apply"}
          </button>
        </footer>
      </section>
    </div>
  );
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
