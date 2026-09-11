import { type ReactNode, useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import type {
  AppRole,
  CopilotPackageDetail,
  PackageAccessTarget,
  PackageAccessUpdate,
} from "../api/client";
import { getBuiltWithLabel } from "../agentDisplay";
import { AccessAssignmentModal } from "./AccessAssignmentModal";
import { WorkbenchActionGate } from "../workbenchActionContext";

const detailTabs = ["identities", "package", "power-platform", "reports", "audit-security", "controls"] as const;
type DetailTab = typeof detailTabs[number];

type AgentDetailModalProps = {
  agent: CopilotPackageDetail;
  activeTab?: string;
  onTabChange?: (tab: string) => void;
  roles?: AppRole[];
  onClose: () => void;
  onUpdateAccess: (update: PackageAccessUpdate) => Promise<void>;
  onSetBlocked?: (blocked: boolean) => Promise<void>;
};

type AccessSummary = {
  total: number;
  users: number;
  groups: number;
  other: number;
};

type ConnectedService = {
  value: string;
  source: string;
};

export function AgentDetailModal({
  agent,
  activeTab,
  onTabChange,
  roles = [],
  onClose,
  onUpdateAccess,
  onSetBlocked,
}: AgentDetailModalProps) {
  const [internalTab, setInternalTab] = useState<DetailTab>("identities");
  const [editingAccessTarget, setEditingAccessTarget] =
    useState<PackageAccessTarget>();
  const requestedTab = activeTab ?? internalTab;
  const selectedTab: DetailTab = detailTabs.includes(requestedTab as DetailTab) ? requestedTab as DetailTab : "identities";
  const selectTab = (tab: DetailTab) => {
    setInternalTab(tab);
    onTabChange?.(tab);
  };
  const allowedSummary = summarizeAccess(agent.allowedUsersAndGroups);
  const acquireSummary = summarizeAccess(agent.acquireUsersAndGroups);
  const connectedServices = extractConnectedServices(agent.elementDetails);
  const elementDetails = agent.elementDetails ?? [];
  const elementCount = elementDetails.reduce(
    (total, detail) => total + detail.elements.length,
    0,
  );
  const assignmentCount = allowedSummary.total + acquireSummary.total;
  const statusLabel = agent.isBlocked ? "Blocked" : "Allowed";
  const description = getAgentDescription(agent);
  const sanitizedDescriptionHtml = getSanitizedDescriptionHtml(description);
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => { window.requestAnimationFrame(() => returnFocusRef.current?.focus()); };
  }, []);
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>(`#agent-tab-${selectedTab}`)?.focus();
  }, [selectedTab]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !editingAccessTarget) {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [editingAccessTarget, onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        ref={dialogRef}
        className="detail-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-detail-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) && (event.target as HTMLElement).getAttribute("role") === "tab") {
            event.preventDefault();
            const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
            const current = tabs.indexOf(event.target as HTMLButtonElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
            tabs[next]?.focus();
            tabs[next]?.click();
            return;
          }
          if (event.key !== "Tab" || editingAccessTarget) return;
          const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')];
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}
      >
        <header className="detail-header">
          <div className="detail-title-block">
            <p className="eyebrow">Agent details</p>
            <h2 id="agent-detail-title">{agent.displayName}</h2>
          </div>
          <div className="detail-header-actions">
            <button type="button" className="secondary" onClick={onClose}>
              Close
            </button>
          </div>
        </header>

        {sanitizedDescriptionHtml ? (
          <div
            className="detail-description rich-description"
            dangerouslySetInnerHTML={{ __html: sanitizedDescriptionHtml }}
          />
        ) : (
          <p className="detail-description">{description}</p>
        )}

        <div className="detail-tabs" role="tablist" aria-label="Agent detail sources">
          {detailTabs.map(tab => <button key={tab} id={`agent-tab-${tab}`} type="button" role="tab"
            aria-selected={selectedTab === tab} aria-controls={`agent-${tab}-panel`} tabIndex={selectedTab === tab ? 0 : -1}
            onClick={() => selectTab(tab)}>{detailTabLabel(tab)}</button>)}
        </div>

        {selectedTab === "package" ? <div id="agent-package-panel" role="tabpanel" aria-labelledby="agent-tab-package" tabIndex={0}>
        <div className="detail-stat-grid">
          <SummaryStat
            label="Package block"
            value={statusLabel}
            tone={agent.isBlocked ? "danger" : "success"}
          />
          <SummaryStat
            label="Connected services"
            value={
              connectedServices.length
                ? connectedServices.length.toLocaleString()
                : "None"
            }
          />
        </div>

        <div className="detail-layout">
          <DetailSection
            title="Package details"
            countLabel={`${assignmentCount.toLocaleString()} access assignments`}
            tone="metadata"
          >
            <DetailList
              items={[
                { label: "Publisher", value: agent.publisher },
                { label: "Type", value: agent.type },
                { label: "Built with", value: getBuiltWithLabel(agent) },
                { label: "Version", value: agent.version },
                { label: "Manifest", value: agent.manifestVersion },
                {
                  label: "Last modified",
                  value: formatDate(agent.lastModifiedDateTime),
                },
                {
                  label: "Available to",
                  value: formatDetailLabel(agent.availableTo),
                },
                {
                  label: "Installed for",
                  value: formatDetailLabel(agent.deployedTo),
                },
                {
                  label: "Package owner",
                  value: "Not exposed by the Graph package detail contract",
                },
                {
                  label: "Saved observation",
                  value: formatDate(agent.observation?.observedAt),
                },
                {
                  label: "Observation expires",
                  value: formatDate(agent.observation?.expiresAt),
                },
                {
                  label: "Source",
                  value: agent.observation?.source ?? "Microsoft Graph package catalog",
                },
                {
                  label: "API maturity",
                  value: agent.observation?.apiMaturity ?? "v1.0 read; preview controls",
                },
                {
                  label: "Sensitivity",
                  value: formatDetailLabel(agent.sensitivity),
                },
                {
                  label: "Hosts",
                  value: formatList(agent.supportedHosts),
                },
                { label: "Categories", value: formatList(agent.categories) },
                {
                  label: "Element types",
                  value: formatList(agent.elementTypes),
                },
                {
                  label: "Elements",
                  value: elementDetails.length
                    ? `${elementDetails.length} groups, ${elementCount} elements`
                    : "No element metadata returned",
                },
                {
                  label: "Allowed assignments",
                  value: formatAccessSummary(allowedSummary),
                },
                {
                  label: "Acquire assignments",
                  value: formatAccessSummary(acquireSummary),
                },
                {
                  label: "Detected services",
                  value: connectedServices.length
                    ? `${connectedServices.length} detected`
                    : "None returned",
                },
                { label: "Package ID", value: agent.id, variant: "code" },
                { label: "App ID", value: agent.appId, variant: "code" },
                {
                  label: "Manifest ID",
                  value: agent.manifestId,
                  variant: "code",
                },
                { label: "Asset ID", value: agent.assetId, variant: "code" },
              ]}
            />
            {elementDetails.length ? (
              <ul className="detail-list compact-list package-elements-list">
                {elementDetails.map((detail, index) => (
                  <li key={`${detail.elementType}-${index}`}>
                    <span>{formatDetailLabel(detail.elementType)}</span>
                    <small>{detail.elements.length} elements</small>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="access-grid">
              <AccessList
                label="Available to"
                values={agent.allowedUsersAndGroups}
                onEdit={() => setEditingAccessTarget("availability")}
              />
              <AccessList
                label="Installed for"
                values={agent.acquireUsersAndGroups}
                onEdit={() => setEditingAccessTarget("installation")}
              />
            </div>
            <p className="detail-overflow-note">
              Package block is Microsoft Graph package catalog state. It is not Copilot Studio quarantine.
            </p>
          </DetailSection>

          <DetailSection
            title="Connected services"
            countLabel={`${connectedServices.length} detected`}
            tone="services"
          >
            {connectedServices.length ? (
              <ul className="detail-list service-list expanded-detail-list">
                {connectedServices.map((service) => (
                  <li key={`${service.source}-${service.value}`}>
                    <span>{service.value}</span>
                    <small>{service.source}</small>
                  </li>
                ))}
              </ul>
            ) : (
              <p>
                No connected service metadata was returned for this package.
              </p>
            )}
          </DetailSection>

        </div>
        </div> : selectedTab === "identities" ? (
          <section id="agent-identities-panel" className="detail-section metadata" role="tabpanel" aria-labelledby="agent-tab-identities" tabIndex={0}>
            <div className="detail-section-header">
              <h3>Exact package identities and provenance</h3>
              <span>{Object.keys(agent.provenance).length} fields</span>
            </div>
            <p>
              These identifiers are authorized from the exact Microsoft Graph package observation. They are not substituted as another source's native target.
            </p>
            <DetailList items={[
              { label: "Source system", value: agent.sourceSystem },
              { label: "Package ID", value: agent.id, variant: "code" },
              { label: "App ID", value: agent.appId, variant: "code" },
              { label: "Manifest ID", value: agent.manifestId, variant: "code" },
              { label: "Asset ID", value: agent.assetId, variant: "code" },
              { label: "Observed", value: formatDate(agent.observation?.observedAt) },
              { label: "Expires", value: formatDate(agent.observation?.expiresAt) },
              { label: "Native identity", value: agent.identityConfidence },
              { label: "Agent kind", value: agent.agentKind },
              { label: "Authoring tool", value: agent.authoringTool ?? "Not independently observed" },
              { label: "Creator type", value: agent.creatorType },
              { label: "Lifecycle", value: agent.lifecycle },
            ]} />
            <ul className="detail-list expanded-detail-list">
              {Object.entries(agent.provenance)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([field, provenance]) => (
                  <li key={field}>
                    <span>{field}</span>
                    <small>{provenance.sourceSystem} · {provenance.maturity} · {provenance.path}</small>
                  </li>
                ))}
            </ul>
          </section>
        ) : selectedTab === "power-platform" ? <UnavailablePanel id="power-platform" title="Power Platform data">No documented package-to-Power-Platform identifier equivalence exists. Names, app IDs, manifest IDs, asset IDs, owners, and timestamps were not used as joins. Power Platform records remain usable in their authorized inventory view.</UnavailablePanel>
          : selectedTab === "reports" ? <UnavailablePanel id="reports" title="Official reports">Official report agent IDs are report-only under the retained three-file contract. No documented exact relation to a Graph package ID exists, so no report lookup, metric substitution, or count was performed.</UnavailablePanel>
          : selectedTab === "audit-security" ? <UnavailablePanel id="audit-security" title="Audit and security">{roles.includes("AgentControl.SecurityReader") ? "SecurityReader is authorized for source views, but Purview and Defender define exact Power Platform identifier associations only. No documented exact relation to this Graph package exists, so names were not queried." : "SecurityReader is not assigned. Audit and Defender records and counts were not requested. Their source views remain independently authorized."}</UnavailablePanel>
          : <section id="agent-controls-panel" className="detail-section metadata" role="tabpanel" aria-labelledby="agent-tab-controls" tabIndex={0}><div className="detail-section-header"><h3>Native package controls</h3><span>{agent.id}</span></div><p>Block state and package access target only this exact Graph package ID. Copilot Studio quarantine remains a separate environment/CDS bot control.</p>
            {onSetBlocked ? <WorkbenchActionGate actionId={agent.isBlocked ? "packages.unblock" : "packages.block"}><button type="button" className="secondary" onClick={() => void onSetBlocked(!agent.isBlocked)}>{agent.isBlocked ? "Unblock exact package" : "Block exact package"}</button></WorkbenchActionGate> : null}
            <WorkbenchActionGate actionId="packages.access"><button type="button" className="secondary" onClick={() => setEditingAccessTarget("availability")}>Manage package availability</button></WorkbenchActionGate>
          </section>}
        {editingAccessTarget ? (
          <AccessAssignmentModal
            context="single"
            agentCount={1}
            initialTarget={editingAccessTarget}
            initialStatus={
              editingAccessTarget === "availability"
                ? agent.availableTo
                : agent.deployedTo
            }
            initialPrincipals={
              editingAccessTarget === "availability"
                ? agent.allowedUsersAndGroups
                : agent.acquireUsersAndGroups
            }
            onCancel={() => setEditingAccessTarget(undefined)}
            onSubmit={async (update) => {
              await onUpdateAccess(update);
              setEditingAccessTarget(undefined);
            }}
          />
        ) : null}
      </section>
    </div>
  );
}

function getAgentDescription(agent: CopilotPackageDetail) {
  return (
    agent.longDescription ||
    agent.shortDescription ||
    "No description provided."
  );
}

function getSanitizedDescriptionHtml(description: string) {
  if (!hasHtmlMarkup(description)) {
    return undefined;
  }

  const sanitized = DOMPurify.sanitize(description, {
    USE_PROFILES: { html: true },
  }).trim();

  return sanitized || undefined;
}

function hasHtmlMarkup(value: string) {
  return /<\/?[a-z][\s\S]*>/i.test(value);
}

function DetailSection({
  title,
  countLabel,
  tone,
  children,
}: {
  title: string;
  countLabel?: string;
  tone?:
    | "activity"
    | "governance"
    | "metadata"
    | "services"
    | "technical"
    | "usage";
  children: ReactNode;
}) {
  return (
    <section className={tone ? `detail-section ${tone}` : "detail-section"}>
      <div className="detail-section-header">
        <h3>{title}</h3>
        {countLabel ? <span>{countLabel}</span> : null}
      </div>
      {children}
    </section>
  );
}

function UnavailablePanel({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section id={`agent-${id}-panel`} className="detail-section metadata" role="tabpanel" aria-labelledby={`agent-tab-${id}`} tabIndex={0}>
    <div className="detail-section-header"><h3>{title}</h3><span>No exact association</span></div>
    <p>{children}</p>
  </section>;
}

function detailTabLabel(value: DetailTab) {
  const label = value.replaceAll("-", " ");
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

function SummaryStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "danger" | "success" | "usage";
}) {
  return (
    <div className={tone ? `summary-stat ${tone}` : "summary-stat"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

type DetailListItem = {
  label: string;
  value?: string;
  variant?: "code";
};

function DetailList({ items }: { items: DetailListItem[] }) {
  return (
    <dl className="compact-detail-list">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd className={item.variant === "code" ? "detail-code" : undefined}>
            {item.value || "Unknown"}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function summarizeAccess(
  values?: CopilotPackageDetail["allowedUsersAndGroups"],
): AccessSummary {
  const summary = { total: 0, users: 0, groups: 0, other: 0 };

  for (const entry of values ?? []) {
    summary.total += 1;
    const resourceType = entry.resourceType.toLowerCase();

    if (resourceType === "user") {
      summary.users += 1;
    } else if (resourceType === "group") {
      summary.groups += 1;
    } else {
      summary.other += 1;
    }
  }

  return summary;
}

function formatAccessSummary(summary: AccessSummary) {
  if (summary.total === 0) {
    return "No explicit assignments";
  }

  return `${summary.total} total (${summary.users} users, ${summary.groups} groups, ${summary.other} other)`;
}

function extractConnectedServices(
  elementDetails?: CopilotPackageDetail["elementDetails"],
): ConnectedService[] {
  const services = new Map<string, ConnectedService>();

  for (const detail of elementDetails ?? []) {
    for (const element of detail.elements) {
      const source = `${formatDetailLabel(detail.elementType) ?? detail.elementType} ${element.id}`;

      for (const service of extractServiceCandidates(element.definition)) {
        const key = `${source}:${service}`;
        services.set(key, { value: service, source });
      }
    }
  }

  return [...services.values()].slice(0, 20);
}

function extractServiceCandidates(definition: string) {
  const candidates = new Set<string>();
  const urlMatches = definition.matchAll(
    /https?:\/\/([^\s"'<>/]+)[^\s"'<>]*/gi,
  );

  for (const match of urlMatches) {
    candidates.add(match[1]);
  }

  const parsed = parseJson(definition);

  if (parsed !== undefined) {
    collectServiceCandidates(parsed, candidates);
  }

  return [...candidates];
}

function collectServiceCandidates(value: unknown, candidates: Set<string>) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectServiceCandidates(item, candidates);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && isServiceLikeKey(key)) {
      const candidate = item.trim();

      if (candidate && candidate.length <= 120) {
        candidates.add(candidate);
      }
    } else {
      collectServiceCandidates(item, candidates);
    }
  }
}

function isServiceLikeKey(key: string) {
  return /(api|connector|connection|endpoint|host|name|resource|service|url)/i.test(
    key,
  );
}

function parseJson(value: string) {
  const trimmed = value.trim();

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function AccessList({
  label,
  values,
  onEdit,
}: {
  label: string;
  values?: CopilotPackageDetail["allowedUsersAndGroups"];
  onEdit: () => void;
}) {
  return (
    <div className="access-list">
      <div className="access-list-header">
        <span>{label}</span>
        <WorkbenchActionGate actionId="packages.access">
        <button type="button" className="secondary" onClick={onEdit}>
          Edit
        </button>
        </WorkbenchActionGate>
      </div>
      {values?.length ? (
        <ul>
          {values.slice(0, 8).map((entry) => (
            <li key={`${entry.resourceType}-${entry.resourceId}`}>
              <strong>{formatDetailLabel(entry.resourceType)}</strong>
              <small>{entry.resourceId}</small>
            </li>
          ))}
        </ul>
      ) : (
        <p>No explicit users or groups returned.</p>
      )}
      {values && values.length > 8 ? (
        <p>{values.length - 8} more entries hidden.</p>
      ) : null}
    </div>
  );
}

function formatList(values?: string[]) {
  const labels = values
    ?.map(formatDetailLabel)
    .filter((label): label is string => Boolean(label));

  return labels?.length ? labels.join(", ") : undefined;
}

function formatDetailLabel(value?: string) {
  if (!value) {
    return undefined;
  }

  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
}

function formatDate(value?: string) {
  const date = parseDate(value);

  if (!date) {
    return undefined;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function parseDate(value?: string) {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? undefined : date;
}
