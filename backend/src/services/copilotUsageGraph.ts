import { AppError } from "../errors.js";
import { parse as parseCsv } from "csv-parse/sync";
import type { CopilotAppActivity, CopilotDirectoryIdentity, CopilotServicePlan, CopilotServiceSummaryState } from "../types/copilotUsage.js";
import { graphError, type FetchLike } from "./graphPackages.js";
import { boundedProviderJson, boundedProviderText, ProviderResponseLimitError } from "./providerJson.js";
import { operationalLog } from "./telemetry.js";
import { copilotServicePlanDefinitions, resolveCopilotServicePlan, summarizeCopilotServices, type CopilotPlanObservation } from "./copilotServicePlans.js";

const graphOrigin = "https://graph.microsoft.com";
const graphV1 = `${graphOrigin}/v1.0`;
const reportDownloadOrigins = new Set(["https://reports.office.com", "https://reportsweu.office.com"]);
const maximumSkus = 1_000;
const skusPerQuery = 20;
// Enterprise users can carry hundreds of plans; row paging alone does not bound response bytes.
const directoryPageSize = 100;
const maximumDirectoryPageBytes = 16 * 1024 * 1024;
const maximumCatalogPages = 200;
const maximumUsers = 100_000;
const maximumDirectoryPages = Math.ceil(maximumUsers / directoryPageSize);
const maximumReportRows = 100_000;
const maximumReportBytes = 64 * 1024 * 1024;
const requestTimeoutMs = 15_000;
const reportHeaders = [
  "Report Refresh Date",
  "User Principal Name",
  "Display Name",
  "Last Activity Date",
  "Copilot Chat Last Activity Date",
  "Microsoft Teams Copilot Last Activity Date",
  "Word Copilot Last Activity Date",
  "Excel Copilot Last Activity Date",
  "PowerPoint Copilot Last Activity Date",
  "Outlook Copilot Last Activity Date",
  "OneNote Copilot Last Activity Date",
  "Loop Copilot Last Activity Date",
  "Report Period",
] as const;

type GraphAssignedLicense = {
  skuId?: unknown;
  disabledPlans?: unknown;
};

type GraphAssignedPlan = {
  servicePlanId?: unknown;
  service?: unknown;
  assignedDateTime?: unknown;
  capabilityStatus?: unknown;
};

type GraphUser = {
  id?: unknown;
  userPrincipalName?: unknown;
  displayName?: unknown;
  accountEnabled?: unknown;
  employeeType?: unknown;
  companyName?: unknown;
  department?: unknown;
  userType?: unknown;
  assignedLicenses?: unknown;
  assignedPlans?: unknown;
};

type GraphCollection<T> = {
  value?: T[];
  "@odata.nextLink"?: unknown;
  "@odata.count"?: unknown;
};

type GraphEndpoint = "directory" | "catalog" | "report";

export type CopilotDirectoryUser = {
  serviceEvidenceVersion: 1;
  identity: CopilotDirectoryIdentity;
  copilotServiceState: CopilotServiceSummaryState;
  servicePlans: CopilotServicePlan[];
};

export type CopilotDirectoryProgress = (observedCount: number) => void | Promise<void>;

export type CopilotReportUser = {
  normalizedUserPrincipalName: string;
  activity: CopilotAppActivity;
};

export type CopilotReportResult = {
  users: CopilotReportUser[];
  reportRefreshDate: string | null;
};

export class CopilotUsageGraphClient {
  constructor(private readonly fetcher: FetchLike = fetch) {}

  async listCopilotUsers(accessToken: string, signal?: AbortSignal, onProgress?: CopilotDirectoryProgress): Promise<CopilotDirectoryUser[]> {
    signal?.throwIfAborted();
    const skus = await this.listCopilotSkus(accessToken, signal);
    signal?.throwIfAborted();
    const users = new Map<string, CopilotDirectoryUser>();
    let observedRows = 0;
    const visited = new Set<string>();
    const skuIds = [...skus.keys()];
    for (let offset = 0; offset < skuIds.length; offset += skusPerQuery) {
      const batchIds = skuIds.slice(offset, offset + skusPerQuery);
      const batchUsers = new Set<string>();
      let expectedCount: number | undefined;
      let nextUrl: string | undefined = buildCopilotUsersUrl(batchIds);
      while (nextUrl) {
        signal?.throwIfAborted();
        enforcePageBounds(nextUrl, visited, observedRows, maximumUsers, maximumDirectoryPages, "Directory");
        visited.add(nextUrl);
        const page = await this.request<GraphCollection<GraphUser>>(nextUrl, accessToken, "directory", signal);
        signal?.throwIfAborted();
        if (!Array.isArray(page.value)) throw providerSchema("Directory users response has an invalid collection.");
        if (expectedCount === undefined) {
          if (typeof page["@odata.count"] !== "number" || !Number.isSafeInteger(page["@odata.count"]) || page["@odata.count"] < 0) {
            throw providerSchema("Directory users response is missing a valid total count.");
          }
          expectedCount = page["@odata.count"];
          if (expectedCount > maximumUsers) {
            operationalLog("warn", "copilot_license_result_limit", { reason: "user_count", count: expectedCount, rowLimit: maximumUsers });
            throw providerLimit("Directory users exceeded the result limit.");
          }
        }
        observedRows += page.value.length;
        if (observedRows > maximumUsers) throw providerLimit("Directory users exceeded the result limit.");
        for (const value of page.value) {
          const user = parseDirectoryUser(value, skus, batchIds);
          if (!user) {
            throw providerSchema("Directory returned a user outside the requested license cohort.");
          }
          const existing = users.get(user.identity.objectId);
          if (existing && JSON.stringify(existing) !== JSON.stringify(user)) {
            throw providerSchema("Directory returned conflicting duplicate user records.");
          }
          users.set(user.identity.objectId, user);
          batchUsers.add(user.identity.objectId);
        }
        nextUrl = parseNextLink(page["@odata.nextLink"], "directory");
        operationalLog("info", "copilot_license_directory_page", {
          page: visited.size, returnedCount: page.value.length, totalRecords: expectedCount,
          observedCount: batchUsers.size, hasContinuation: Boolean(nextUrl),
        });
        await onProgress?.(users.size);
        signal?.throwIfAborted();
      }
      if (batchUsers.size !== expectedCount) {
        throw new AppError(502, "provider_count_mismatch", "Directory license totals changed or paging was incomplete; refresh usage.");
      }
    }
    if (!skuIds.length) {
      await onProgress?.(0);
      signal?.throwIfAborted();
    }
    operationalLog("info", "copilot_license_inventory", {
      count: users.size, pages: visited.size, observedCount: observedRows, catalogScopedCount: skus.size,
    });
    return [...users.values()];
  }

  private async listCopilotSkus(accessToken: string, signal?: AbortSignal): Promise<Map<string, string[]>> {
    const skus = new Map<string, string[]>();
    const visited = new Set<string>();
    let observedRows = 0;
    let nextUrl: string | undefined = buildSubscribedSkusUrl();
    while (nextUrl) {
      signal?.throwIfAborted();
      enforcePageBounds(nextUrl, visited, observedRows, maximumSkus, maximumCatalogPages, "License catalog");
      visited.add(nextUrl);
      const page = await this.request<GraphCollection<unknown>>(nextUrl, accessToken, "catalog", signal);
      signal?.throwIfAborted();
      if (!Array.isArray(page.value)) throw providerSchema("Tenant license catalog has an invalid collection.");
      observedRows += page.value.length;
      if (observedRows > maximumSkus) throw providerLimit("Tenant license catalog exceeded the result limit.");
      for (const value of page.value) {
        const sku = parseSubscribedSku(value);
        if (!sku) continue;
        const previous = skus.get(sku.skuId);
        if (previous && JSON.stringify(previous) !== JSON.stringify(sku.servicePlanIds)) {
          throw providerSchema("Tenant license catalog contains conflicting Copilot service plans.");
        }
        skus.set(sku.skuId, sku.servicePlanIds);
      }
      nextUrl = parseNextLink(page["@odata.nextLink"], "catalog");
    }
    operationalLog("info", "copilot_license_catalog", {
      observedCount: observedRows, catalogScopedCount: skus.size, pages: visited.size,
    });
    return skus;
  }

  async listAppActivity(accessToken: string, signal?: AbortSignal): Promise<CopilotReportResult> {
    const text = await this.requestText(buildCopilotReportUrl(), accessToken, signal);
    const users = parseReportCsv(text);
    const refreshDates = new Set(users.map(row => row.activity.reportRefreshDate));
    if (refreshDates.size > 1) throw providerSchema("Copilot usage report contains inconsistent refresh dates.");
    const reportRefreshDate = users.length > 0 ? users[0].activity.reportRefreshDate : null;
    return { users, reportRefreshDate };
  }

  private async request<T>(url: string, accessToken: string, kind: GraphEndpoint, signal?: AbortSignal): Promise<T> {
    validateGraphUrl(url, kind);
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await this.fetcher(url, {
      method: "GET",
      redirect: "error",
      signal: requestSignal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...(kind === "directory" ? { ConsistencyLevel: "eventual" } : {}),
      },
    });
    if (!response.ok) throw await graphError(response, requestSignal);
    try {
      return await boundedProviderJson<T>(response, requestSignal, kind === "directory" ? maximumDirectoryPageBytes : undefined);
    } catch (error) {
      if (!(error instanceof ProviderResponseLimitError)) throw error;
      operationalLog("warn", "copilot_license_response_size_limit", {
        source: kind, field: "response_bytes", length: error.observedBytes, maximumLength: error.maximumBytes,
      });
      throw new AppError(502, "provider_response_size_limit", "Microsoft Graph response exceeded the endpoint's byte limit.");
    }
  }

  private async requestText(url: string, accessToken: string, signal?: AbortSignal) {
    validateGraphUrl(url, "report");
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response = await this.fetcher(url, {
      method: "GET",
      redirect: "manual",
      signal: requestSignal,
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "text/csv, application/octet-stream" },
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      if (response.status !== 302) throw invalidReportDownloadLink();
      const downloadUrl = validateReportDownloadUrl(response.headers.get("location"));
      // The signed download URL is its own credential; never forward the Graph token.
      response = await this.fetcher(downloadUrl, {
        method: "GET",
        redirect: "manual",
        signal: requestSignal,
        headers: { Accept: "text/csv, application/octet-stream" },
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status >= 300 && response.status < 400) throw invalidReportDownloadLink();
        throw new AppError(502, "report_download_failed", "Microsoft report download failed; refresh usage to request a new download.");
      }
    }
    if (!response.ok) throw await graphError(response, requestSignal);
    return boundedProviderText(response, maximumReportBytes, requestSignal);
  }
}

export function buildSubscribedSkusUrl() {
  return `${graphV1}/subscribedSkus?$select=skuId,appliesTo,servicePlans`;
}

export function buildCopilotUsersUrl(skuIds: readonly string[]) {
  if (skuIds.length === 0 || skuIds.length > skusPerQuery) throw providerSchema("Directory SKU filter has an invalid size.");
  const url = new URL(`${graphV1}/users`);
  url.searchParams.set("$select", "id,userPrincipalName,displayName,accountEnabled,employeeType,companyName,department,userType,assignedLicenses,assignedPlans");
  url.searchParams.set("$filter", skuIds
    .map(skuId => `assignedLicenses/any(value:value/skuId eq ${skuId})`).join(" or "));
  url.searchParams.set("$count", "true");
  url.searchParams.set("$top", String(directoryPageSize));
  return url.toString();
}

export function buildCopilotReportUrl() {
  return `${graphV1}/copilot/reports/getMicrosoft365CopilotUsageUserDetail(period='D30',version='v1')`;
}

function validateReportDownloadUrl(value: string | null) {
  if (!value || value.length > 8_192) throw invalidReportDownloadLink();
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    throw invalidReportDownloadLink();
  }
  const tokens = target.searchParams.getAll("token");
  const validPath = /^\/data\/download\/[A-Za-z0-9_-]+$/.test(target.pathname)
    || (target.pathname === "/data/v1.0/download" && tokens.length === 1 && Boolean(tokens[0].trim()));
  if (!reportDownloadOrigins.has(target.origin) || target.username || target.password || target.hash || !validPath) {
    throw invalidReportDownloadLink();
  }
  return target.toString();
}

function invalidReportDownloadLink() {
  return new AppError(502, "invalid_provider_link", "Microsoft returned an unsupported report download link.");
}

export function validateGraphUrl(url: string, kind: GraphEndpoint) {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new AppError(502, "invalid_provider_link", "Microsoft Graph returned an invalid continuation link.");
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(target.pathname);
  } catch {
    throw new AppError(502, "invalid_provider_link", "Microsoft Graph returned an invalid continuation link.");
  }
  const validPath = kind === "directory"
    ? pathname === "/v1.0/users"
    : kind === "catalog"
      ? pathname === "/v1.0/subscribedSkus"
      : pathname === "/v1.0/copilot/reports/getMicrosoft365CopilotUsageUserDetail(period='D30',version='v1')";
  if (target.origin !== graphOrigin || target.username || target.password || !validPath) {
    throw new AppError(502, "invalid_provider_link", "Microsoft Graph returned a continuation link outside the documented endpoint.");
  }
}

export function normalizeCopilotIdentity(value: string) {
  return value.trim().toLowerCase();
}

function parseSubscribedSku(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw providerSchema("Tenant license SKU is invalid.");
  const sku = value as Record<string, unknown>;
  const skuId = requiredUuid(sku.skuId, "Tenant license SKU ID");
  if (sku.appliesTo !== "User" && sku.appliesTo !== "Company") throw providerSchema("Tenant license SKU scope is invalid.");
  if (!Array.isArray(sku.servicePlans) || sku.servicePlans.length > 1_000) throw providerSchema("Tenant license service plans are invalid.");
  const planIds = sku.servicePlans.map(plan => {
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw providerSchema("Tenant license service plan is invalid.");
    return requiredUuid(plan.servicePlanId, "Tenant license service plan ID");
  });
  const servicePlanIds = [...new Set(planIds.filter(id => copilotServicePlanDefinitions.has(id)))].sort();
  return sku.appliesTo === "User" && servicePlanIds.length > 0
    ? { skuId, servicePlanIds }
    : null;
}

function parseDirectoryUser(value: unknown, skus: ReadonlyMap<string, readonly string[]>, batchIds: readonly string[]): CopilotDirectoryUser | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw providerSchema("Directory user entry is invalid.");
  const user = value as GraphUser;
  const id = requiredUuid(user.id, "Directory user ID").toLowerCase();
  const userPrincipalName = requiredText(user.userPrincipalName, "Directory user principal name", 320);
  const userType = optionalText(user.userType, "Directory user type", 64);
  const assigned = assignedLicenses(user.assignedLicenses);
  const copilot = assigned.filter(license => skus.has(license.skuId));
  if (!copilot.some(license => batchIds.includes(license.skuId))) return null;
  const observations = assignedPlans(user.assignedPlans);
  const enabledPlans = new Map<string, boolean>();
  for (const license of copilot) {
    for (const planId of skus.get(license.skuId)!) {
      enabledPlans.set(planId, Boolean(enabledPlans.get(planId)) || !license.disabledPlans.includes(planId));
    }
  }
  const servicePlans = [...copilotServicePlanDefinitions.keys()].flatMap(planId => enabledPlans.has(planId)
    ? [resolveCopilotServicePlan(planId, enabledPlans.get(planId)!, observations)]
    : []);
  return {
    serviceEvidenceVersion: 1,
    identity: {
      objectId: id,
      userPrincipalName,
      displayName: optionalText(user.displayName, "Directory display name", 512),
      accountEnabled: optionalBoolean(user.accountEnabled, "Directory account state"),
      userType,
      employeeType: optionalText(user.employeeType, "Directory employee type", 128),
      companyName: optionalText(user.companyName, "Directory company name", 256),
      department: optionalText(user.department, "Directory department", 256),
    },
    copilotServiceState: summarizeCopilotServices(servicePlans),
    servicePlans,
  };
}

function assignedLicenses(value: unknown) {
  if (!Array.isArray(value)) throw providerSchema("Directory assigned licenses are invalid.");
  return value.map((entry): { skuId: string; disabledPlans: string[] } => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw providerSchema("Directory license assignment is invalid.");
    const license = entry as GraphAssignedLicense;
    const skuId = requiredUuid(license.skuId, "Directory license SKU ID");
    if (!Array.isArray(license.disabledPlans) || license.disabledPlans.length > 1_000) throw providerSchema("Directory disabled plans are invalid.");
    return { skuId, disabledPlans: license.disabledPlans.map(plan => requiredUuid(plan, "Directory disabled plan ID")) };
  });
}

function assignedPlans(value: unknown): CopilotPlanObservation[] {
  if (!Array.isArray(value) || value.length > 1_000) throw providerSchema("Directory assigned plans are invalid.");
  return value.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw providerSchema("Directory assigned plan is invalid.");
    const plan = entry as GraphAssignedPlan;
    const servicePlanId = requiredUuid(plan.servicePlanId, "Directory service plan ID");
    requiredText(plan.service, "Directory service plan name", 256);
    const capabilityStatus = requiredText(plan.capabilityStatus, "Directory service plan capability status", 64);
    if (!["Enabled", "Warning", "Suspended", "Deleted", "LockedOut"].includes(capabilityStatus)) {
      throw providerSchema("Directory service plan capability status is unsupported.");
    }
    return {
      servicePlanId,
      assignedDateTime: optionalDateTime(plan.assignedDateTime, "Directory service plan assignment time"),
      capabilityStatus: capabilityStatus as CopilotServicePlan["capabilityStatus"],
    };
  }).filter(plan => copilotServicePlanDefinitions.has(plan.servicePlanId));
}

function parseReportCsv(text: string): CopilotReportUser[] {
  let records: string[][];
  try {
    records = parseCsv(text, { bom: true, skip_empty_lines: true, relax_column_count: false }) as string[][];
  } catch {
    throw providerSchema("Copilot usage report is not valid CSV.");
  }
  if (records.length === 0) throw providerSchema("Copilot usage report is empty.");
  if (records.length - 1 > maximumReportRows) throw providerLimit("Copilot usage report exceeded the result limit.");
  const headers = records[0];
  const columnIndexes = reportHeaders.map(header => headers.indexOf(header));
  if (new Set(headers).size !== headers.length || headers.some(header => !header.trim() || header.length > 1_024)
    || columnIndexes.some(index => index < 0)) {
    throw providerSchema("Copilot usage report headers do not match the supported v1 schema.");
  }
  // Microsoft can add columns even to v1; use only the exact named v1 fields.
  return records.slice(1).map(row => parseReportUser(columnIndexes.map(index => row[index])));
}

function parseReportUser(row: string[]): CopilotReportUser {
  if (row.length !== reportHeaders.length || row.some(value => typeof value !== "string" || value.length > 1_024)) {
    throw providerSchema("Copilot usage report entry is invalid.");
  }
  const userPrincipalName = requiredText(row[1], "Copilot report user principal name", 320);
  const reportPeriod = requiredText(row[12], "Copilot report period", 16);
  if (reportPeriod !== "30") throw providerSchema("Copilot usage report returned an unexpected period.");
  return {
    normalizedUserPrincipalName: normalizeCopilotIdentity(userPrincipalName),
    activity: {
      reportRefreshDate: civilDate(row[0], "report refresh date", false)!,
      lastActivityDate: civilDate(row[3], "last activity date"),
      copilotChatLastActivityDate: civilDate(row[4], "Copilot Chat activity date"),
      microsoftTeamsCopilotLastActivityDate: civilDate(row[5], "Teams Copilot activity date"),
      wordCopilotLastActivityDate: civilDate(row[6], "Word Copilot activity date"),
      excelCopilotLastActivityDate: civilDate(row[7], "Excel Copilot activity date"),
      powerpointCopilotLastActivityDate: civilDate(row[8], "PowerPoint Copilot activity date"),
      outlookCopilotLastActivityDate: civilDate(row[9], "Outlook Copilot activity date"),
      onenoteCopilotLastActivityDate: civilDate(row[10], "OneNote Copilot activity date"),
      loopCopilotLastActivityDate: civilDate(row[11], "Loop Copilot activity date"),
    },
  };
}

function parseNextLink(value: unknown, kind: GraphEndpoint) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 8_192) throw providerSchema("Microsoft Graph continuation link is invalid.");
  validateGraphUrl(value, kind);
  return value;
}

function enforcePageBounds(url: string, visited: Set<string>, count: number, maximum: number, maximumPages: number, source: string) {
  if (visited.has(url)) throw providerSchema(`${source} returned a repeated continuation link.`);
  if (visited.size >= maximumPages || count >= maximum) throw providerLimit(`${source} exceeded the bounded page/result limit.`);
}

function requiredText(value: unknown, field: string, maximumLength: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maximumLength) throw providerSchema(`${field} is invalid.`);
  return value.trim();
}

function optionalText(value: unknown, field: string, maximumLength: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > maximumLength) throw providerSchema(`${field} is invalid.`);
  return value.trim() || null;
}

function optionalBoolean(value: unknown, field: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") throw providerSchema(`${field} is invalid.`);
  return value;
}

function requiredUuid(value: unknown, field: string) {
  const text = requiredText(value, field, 36).toLowerCase();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(text)) throw providerSchema(`${field} is invalid.`);
  return text;
}

function optionalDateTime(value: unknown, field: string) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 128 || Number.isNaN(Date.parse(value))) throw providerSchema(`${field} is invalid.`);
  return value;
}

function civilDate(value: unknown, field: string, optional = true): string | null {
  if (optional && (value === undefined || value === null || value === "")) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw providerSchema(`Copilot report ${field} is invalid.`);
  }
  if (new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw providerSchema(`Copilot report ${field} is invalid.`);
  }
  return value;
}

function providerSchema(message: string) {
  return new AppError(502, "provider_schema", message);
}

function providerLimit(message: string) {
  return new AppError(502, "provider_result_limit", message);
}
