import type { CopilotPackage, CopilotPackageDetail } from "./api/client";
import { getBuiltWithLabel } from "./agentDisplay";
import type { AgentUsageSummary } from "./reportImports";

type AgentExportRow = {
  packageId: string;
  displayName: string;
  status: string;
  publisher: string;
  type: string;
  shortDescription: string;
  version: string;
  manifestVersion: string;
  platform: string;
  supportedHosts: string;
  availableTo: string;
  deployedTo: string;
  sensitivity: string;
  categories: string;
  elementTypes: string;
  lastModified: string;
  reportAgentId: string;
  reportAgentName: string;
  creatorType: string;
  activeUsersLicensed: string;
  activeUsersUnlicensed: string;
  activeUsersTotal: string;
  responsesSentToUsers: string;
  lastActivity: string;
  usageSource: string;
  usageReportPeriodDays: string;
  usageReportFile: string;
  usageImportedAt: string;
  userAgentRows: string;
  appId: string;
  manifestId: string;
  assetId: string;
  allowedUsersAndGroups: string;
  acquireUsersAndGroups: string;
  elementDetails: string;
  detailError: string;
};

const csvHeaders: Array<{ key: keyof AgentExportRow; label: string }> = [
  { key: "packageId", label: "Package ID" },
  { key: "displayName", label: "Display name" },
  { key: "status", label: "Status" },
  { key: "publisher", label: "Publisher" },
  { key: "type", label: "Type" },
  { key: "shortDescription", label: "Short description" },
  { key: "version", label: "Version" },
  { key: "manifestVersion", label: "Manifest version" },
  { key: "platform", label: "Built with" },
  { key: "supportedHosts", label: "Supported hosts" },
  { key: "availableTo", label: "Available to" },
  { key: "deployedTo", label: "Acquired for" },
  { key: "sensitivity", label: "Sensitivity" },
  { key: "categories", label: "Categories" },
  { key: "elementTypes", label: "Element types" },
  { key: "lastModified", label: "Last modified" },
  { key: "reportAgentId", label: "Report Agent ID" },
  { key: "reportAgentName", label: "Report agent name" },
  { key: "creatorType", label: "Creator type" },
  { key: "activeUsersLicensed", label: "Active users licensed" },
  { key: "activeUsersUnlicensed", label: "Active users unlicensed" },
  { key: "activeUsersTotal", label: "Active users total" },
  { key: "responsesSentToUsers", label: "Responses sent to users" },
  { key: "lastActivity", label: "Last activity date UTC" },
  { key: "usageSource", label: "Usage source" },
  { key: "usageReportPeriodDays", label: "Usage report period days" },
  { key: "usageReportFile", label: "Usage report file" },
  { key: "usageImportedAt", label: "Usage imported at" },
  { key: "userAgentRows", label: "User-agent rows" },
  { key: "appId", label: "App ID" },
  { key: "manifestId", label: "Manifest ID" },
  { key: "assetId", label: "Asset ID" },
  { key: "allowedUsersAndGroups", label: "Allowed users and groups" },
  { key: "acquireUsersAndGroups", label: "Acquire users and groups" },
  { key: "elementDetails", label: "Element details" },
  { key: "detailError", label: "Detail error" },
];

export function toAgentExportRow(
  agent: CopilotPackage | CopilotPackageDetail,
  detailError = "",
  usage?: AgentUsageSummary,
): AgentExportRow {
  const detail = agent as CopilotPackageDetail;

  return {
    packageId: agent.id,
    displayName: agent.displayName,
    status: agent.isBlocked ? "Blocked" : "Allowed",
    publisher: agent.publisher ?? "",
    type: formatDetailLabel(agent.type) ?? "",
    shortDescription: agent.shortDescription ?? "",
    version: agent.version ?? "",
    manifestVersion: agent.manifestVersion ?? "",
    platform: getBuiltWithLabel(agent) ?? "",
    supportedHosts: formatList(agent.supportedHosts) ?? "",
    availableTo: formatDetailLabel(agent.availableTo) ?? "",
    deployedTo: formatDetailLabel(agent.deployedTo) ?? "",
    sensitivity: formatDetailLabel(detail.sensitivity) ?? "",
    categories: formatList(detail.categories) ?? "",
    elementTypes: formatList(agent.elementTypes) ?? "",
    lastModified: formatDate(agent.lastModifiedDateTime) ?? "",
    reportAgentId: usage?.agentId ?? "",
    reportAgentName: usage?.agentName ?? "",
    creatorType: usage?.creatorType ?? "",
    activeUsersLicensed: usage?.activeUsersLicensed.toString() ?? "",
    activeUsersUnlicensed: usage?.activeUsersUnlicensed.toString() ?? "",
    activeUsersTotal: usage?.activeUsersTotal.toString() ?? "",
    responsesSentToUsers: usage?.responsesSentToUsers.toString() ?? "",
    lastActivity: formatReportDate(usage?.lastActivityDateUtc) ?? "",
    usageSource: usage ? formatReportKind(usage.sourceReport) : "",
    usageReportPeriodDays: usage?.periodDays?.toString() ?? "",
    usageReportFile: usage?.fileName ?? "",
    usageImportedAt: formatDate(usage?.importedAt) ?? "",
    userAgentRows: usage?.userRows.length.toString() ?? "",
    appId: agent.appId ?? "",
    manifestId: agent.manifestId ?? "",
    assetId: agent.assetId ?? "",
    allowedUsersAndGroups: formatAccessEntries(detail.allowedUsersAndGroups),
    acquireUsersAndGroups: formatAccessEntries(detail.acquireUsersAndGroups),
    elementDetails: formatElementDetails(detail.elementDetails),
    detailError,
  };
}

export function toCsv(rows: AgentExportRow[]) {
  const header = csvHeaders.map((header) => csvCell(header.label)).join(",");
  const body = rows.map((row) =>
    csvHeaders.map((header) => csvCell(row[header.key])).join(","),
  );

  return [header, ...body].join("\r\n");
}

export function getExportFilename(
  isFiltered: boolean,
  mode: "fast" | "full" = "full",
) {
  const modeSuffix = mode === "fast" ? "-fast" : "";
  const filteredSuffix = isFiltered ? "-filtered" : "";

  return `copilot-agents${modeSuffix}${filteredSuffix}-${formatExportTimestamp()}.csv`;
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  window.setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 0);
}

function formatAccessEntries(
  values?: CopilotPackageDetail["allowedUsersAndGroups"],
) {
  return (
    values
      ?.map(
        (entry) =>
          `${formatDetailLabel(entry.resourceType) ?? entry.resourceType}:${entry.resourceId}`,
      )
      .join("; ") ?? ""
  );
}

function formatElementDetails(values?: CopilotPackageDetail["elementDetails"]) {
  return (
    values
      ?.map(
        (detail) =>
          `${formatDetailLabel(detail.elementType) ?? detail.elementType}:${detail.elements.length}`,
      )
      .join("; ") ?? ""
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

function csvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function formatExportTimestamp(date = new Date()) {
  const pad = (value: number) => value.toString().padStart(2, "0");

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}-${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(
    date.getSeconds(),
  )}`;
}
