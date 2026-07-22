import { type ReactNode, useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import type {
  CopilotPackageDetail,
  PackageAccessTarget,
  PackageAccessUpdate,
} from "../api/client";
import { getBuiltWithLabel } from "../agentDisplay";
import type { AgentUsageSummary, UserAgentUsageRow } from "../reportImports";
import { AccessAssignmentModal } from "./AccessAssignmentModal";

type AgentDetailModalProps = {
  agent: CopilotPackageDetail;
  usage?: AgentUsageSummary;
  userRows: UserAgentUsageRow[];
  onClose: () => void;
  onUpdateAccess: (update: PackageAccessUpdate) => Promise<void>;
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
  usage,
  userRows,
  onClose,
  onUpdateAccess,
}: AgentDetailModalProps) {
  const [editingAccessTarget, setEditingAccessTarget] =
    useState<PackageAccessTarget>();
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
  const visibleUserRows = userRows.slice(0, 6);
  const hiddenUserRows = userRows.length - visibleUserRows.length;
  const description = getAgentDescription(agent);
  const sanitizedDescriptionHtml = getSanitizedDescriptionHtml(description);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();

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

        <div className="detail-stat-grid">
          <SummaryStat
            label="Status"
            value={statusLabel}
            tone={agent.isBlocked ? "danger" : "success"}
          />
          <SummaryStat
            label="Active users"
            value={
              usage ? usage.activeUsersTotal.toLocaleString() : "No import"
            }
            tone="usage"
          />
          <SummaryStat
            label="Responses sent"
            value={
              usage ? usage.responsesSentToUsers.toLocaleString() : "No import"
            }
            tone="usage"
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
          </DetailSection>

          <DetailSection
            title="Usage import"
            countLabel={
              usage ? formatReportKind(usage.sourceReport) : "No import"
            }
            tone="usage"
          >
            <div className="detail-grid">
              <DetailItem
                label="Report Agent ID"
                value={usage?.agentId}
                variant="code"
              />
              <DetailItem label="Report agent name" value={usage?.agentName} />
              <DetailItem label="Creator type" value={usage?.creatorType} />
              <DetailItem
                label="Last activity"
                value={formatReportDate(usage?.lastActivityDateUtc)}
              />
              <DetailItem
                label="Licensed users"
                value={usage?.activeUsersLicensed.toLocaleString()}
              />
              <DetailItem
                label="Unlicensed users"
                value={usage?.activeUsersUnlicensed.toLocaleString()}
              />
            </div>
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

          <DetailSection
            title="User activity"
            countLabel={`${userRows.length.toLocaleString()} rows`}
            tone="activity"
          >
            {visibleUserRows.length ? (
              <ul className="detail-list user-activity-list expanded-detail-list">
                {visibleUserRows.map((row, index) => (
                  <li key={`${row.agentId}-${row.username}-${index}`}>
                    <span>{row.username}</span>
                    <small>
                      {row.responsesSentToUsers.toLocaleString()} responses,
                      last activity{" "}
                      {formatReportDate(row.lastActivityDateUtc) ?? "Unknown"}
                    </small>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No user-agent report rows imported for this package.</p>
            )}
            {hiddenUserRows > 0 ? (
              <p className="detail-overflow-note">
                {hiddenUserRows.toLocaleString()} more user rows hidden.
              </p>
            ) : null}
          </DetailSection>
        </div>
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

function DetailItem({
  label,
  value,
  variant,
}: {
  label: string;
  value?: string;
  variant?: "code";
}) {
  return (
    <div className="detail-item">
      <span>{label}</span>
      <strong className={variant === "code" ? "detail-code" : undefined}>
        {value || "Unknown"}
      </strong>
    </div>
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
        <button type="button" className="secondary" onClick={onEdit}>
          Edit
        </button>
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

function formatReportDate(value?: string) {
  const date = parseDate(value);

  if (!date) {
    return undefined;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(date);
}

function parseDate(value?: string) {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? undefined : date;
}

function formatReportKind(kind: AgentUsageSummary["sourceReport"]) {
  if (kind === "agents") {
    return "Agents";
  }

  return "Users & agents";
}
