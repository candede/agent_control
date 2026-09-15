import { AppError } from "../errors.js";
import { parse as parseCsv } from "csv-parse/sync";
import type { CopilotAppActivity, CopilotDirectoryIdentity, CopilotLicenseAssignment, CopilotServicePlan } from "../types/copilotUsage.js";
import { graphError, type FetchLike } from "./graphPackages.js";
import { boundedProviderJson, boundedProviderText, ProviderResponseLimitError } from "./providerJson.js";
import { operationalLog } from "./telemetry.js";

const graphOrigin = "https://graph.microsoft.com";
const graphV1 = `${graphOrigin}/v1.0`;
const reportDownloadOrigins = new Set(["https://reports.office.com", "https://reportsweu.office.com"]);
const microsoft365CopilotSkus = new Map([
  ["639dec6b-bb19-468b-871c-c5c441c4b0cb", "Microsoft_365_Copilot"],
  ["a809996b-059e-42e2-9866-db24b99a9782", "M365_Copilot"],
  ["ad9c22b3-52d7-4e7e-973c-88121ea96436", "Microsoft_365_Copilot_EDU"],
]);
const microsoft365CopilotPlanIds = new Set([
  "a62f8878-de10-42f3-b68f-6149a25ceb97",
  "b95945de-b3bd-46db-8437-f2beb6ea2347",
  "3f30311c-6b1e-48a4-ab79-725b469da960",
]);
const copilotAppsPlanId = "a62f8878-de10-42f3-b68f-6149a25ceb97";
const maximumSkus = 1_000;
const skusPerQuery = 20;
// Enterprise users can carry hundreds of plans; row paging alone does not bound response bytes.
const directoryPageSize = 100;
const maximumDirectoryPageBytes = 16 * 1024 * 1024;
const maximumPages = 200;
const maximumUsers = 100_000;
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

type GraphLicenseAssignmentState = {
  skuId?: unknown;
  state?: unknown;
  error?: unknown;
  assignedByGroup?: unknown;
};

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
  department?: unknown;
  userType?: unknown;
  assignedLicenses?: unknown;
  assignedPlans?: unknown;
  licenseAssignmentStates?: unknown;
};

type GraphCollection<T> = {
  value?: T[];
  "@odata.nextLink"?: unknown;
  "@odata.count"?: unknown;
};

type GraphEndpoint = "directory" | "catalog" | "report";

export type CopilotDirectoryUser = {
  identity: CopilotDirectoryIdentity;
  licenses: CopilotLicenseAssignment[];
  servicePlans: CopilotServicePlan[];
};

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

  async listLicensedUsers(accessToken: string, signal?: AbortSignal): Promise<CopilotDirectoryUser[]> {
    const skus = await this.listCopilotSkus(accessToken, signal);
    const users = new Map<string, CopilotDirectoryUser>();
    let observedRows = 0;
    const visited = new Set<string>();
    const skuIds = [...skus.keys()];
    for (let offset = 0; offset < skuIds.length; offset += skusPerQuery) {
      const batchIds = skuIds.slice(offset, offset + skusPerQuery);
      const batchUsers = new Set<string>();
      let expectedCount: number | undefined;
      let nextUrl: string | undefined = buildLicensedUsersUrl(batchIds);
      while (nextUrl) {
        enforcePageBounds(nextUrl, visited, observedRows, maximumUsers, "Directory");
        visited.add(nextUrl);
        const page = await this.request<GraphCollection<GraphUser>>(nextUrl, accessToken, "directory", signal);
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
          const user = parseDirectoryUser(value, skus);
          if (!user || !user.licenses.some(license => batchIds.includes(license.skuId))) {
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
      }
      if (batchUsers.size !== expectedCount) {
        throw new AppError(502, "provider_count_mismatch", "Directory license totals changed or paging was incomplete; refresh usage.");
      }
    }
    operationalLog("info", "copilot_license_inventory", {
      count: users.size, pages: visited.size, observedCount: observedRows, catalogScopedCount: skus.size,
    });
    return [...users.values()];
  }

  private async listCopilotSkus(accessToken: string, signal?: AbortSignal): Promise<Map<string, string>> {
    const skus = new Map<string, string>();
    const visited = new Set<string>();
    let observedRows = 0;
    let nextUrl: string | undefined = buildSubscribedSkusUrl();
    while (nextUrl) {
      enforcePageBounds(nextUrl, visited, observedRows, maximumSkus, "License catalog");
      visited.add(nextUrl);
      const page = await this.request<GraphCollection<unknown>>(nextUrl, accessToken, "catalog", signal);
      if (!Array.isArray(page.value)) throw providerSchema("Tenant license catalog has an invalid collection.");
      observedRows += page.value.length;
      if (observedRows > maximumSkus) throw providerLimit("Tenant license catalog exceeded the result limit.");
      for (const value of page.value) {
        const sku = parseSubscribedSku(value);
        if (!sku) continue;
        const previous = skus.get(sku.skuId);
        if (previous && previous !== sku.skuPartNumber) throw providerSchema("Tenant license catalog contains conflicting SKU names.");
        skus.set(sku.skuId, sku.skuPartNumber);
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
  return `${graphV1}/subscribedSkus?$select=skuId,skuPartNumber,appliesTo,servicePlans`;
}

export function buildLicensedUsersUrl(skuIds: readonly string[]) {
  if (skuIds.length === 0 || skuIds.length > skusPerQuery) throw providerSchema("Directory SKU filter has an invalid size.");
  const url = new URL(`${graphV1}/users`);
  url.searchParams.set("$select", "id,userPrincipalName,displayName,accountEnabled,employeeType,department,userType,assignedLicenses,assignedPlans,licenseAssignmentStates");
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
  const skuPartNumber = requiredText(sku.skuPartNumber, "Tenant license SKU name", 256);
  if (sku.appliesTo !== "User" && sku.appliesTo !== "Company") throw providerSchema("Tenant license SKU scope is invalid.");
  if (!Array.isArray(sku.servicePlans) || sku.servicePlans.length > 1_000) throw providerSchema("Tenant license service plans are invalid.");
  const planIds = sku.servicePlans.map(plan => {
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw providerSchema("Tenant license service plan is invalid.");
    return requiredUuid(plan.servicePlanId, "Tenant license service plan ID");
  });
  // A bundled product qualifies by its paid productivity-app entitlement, not its name.
  return sku.appliesTo === "User" && (microsoft365CopilotSkus.has(skuId) || planIds.includes(copilotAppsPlanId))
    ? { skuId, skuPartNumber }
    : null;
}

function parseDirectoryUser(value: unknown, skus: ReadonlyMap<string, string>): CopilotDirectoryUser | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw providerSchema("Directory user entry is invalid.");
  const user = value as GraphUser;
  const id = requiredUuid(user.id, "Directory user ID").toLowerCase();
  const userPrincipalName = requiredText(user.userPrincipalName, "Directory user principal name", 320);
  const userType = optionalText(user.userType, "Directory user type", 64);
  const assigned = assignedLicenses(user.assignedLicenses);
  const copilot = assigned.filter(license => skus.has(license.skuId));
  if (copilot.length === 0) return null;
  const states = licenseStates(user.licenseAssignmentStates);
  const servicePlans = assignedPlans(user.assignedPlans);
  return {
    identity: {
      objectId: id,
      userPrincipalName,
      displayName: optionalText(user.displayName, "Directory display name", 512),
      accountEnabled: optionalBoolean(user.accountEnabled, "Directory account state"),
      userType,
      employeeType: optionalText(user.employeeType, "Directory employee type", 128),
      department: optionalText(user.department, "Directory department", 256),
    },
    licenses: copilot.map(license => ({
      skuId: license.skuId,
      skuPartNumber: skus.get(license.skuId)!,
      state: effectiveLicenseState(states.filter(state => state.skuId.toLowerCase() === license.skuId.toLowerCase())),
      disabledPlanIds: license.disabledPlans,
      assignmentStates: states.filter(state => state.skuId.toLowerCase() === license.skuId.toLowerCase()).map(state => ({
        state: state.state,
        error: state.error,
        assignedByGroup: state.assignedByGroup,
      })),
    })),
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

function licenseStates(value: unknown) {
  if (value === undefined || value === null) return [] as Array<{
    skuId: string;
    state: CopilotLicenseAssignment["assignmentStates"][number]["state"];
    error: string | null;
    assignedByGroup: string | null;
  }>;
  if (!Array.isArray(value) || value.length > 1_000) throw providerSchema("Directory license assignment states are invalid.");
  return value.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw providerSchema("Directory license assignment state is invalid.");
    const state = entry as GraphLicenseAssignmentState;
    const assignmentState = requiredText(state.state, "Directory license assignment state", 64);
    if (!["Active", "ActiveWithError", "Disabled", "Error"].includes(assignmentState)) {
      throw providerSchema("Directory license assignment state is unsupported.");
    }
    return {
      skuId: requiredUuid(state.skuId, "Directory license assignment state SKU ID"),
      state: assignmentState as CopilotLicenseAssignment["assignmentStates"][number]["state"],
      error: optionalText(state.error, "Directory license assignment error", 128),
      assignedByGroup: optionalUuid(state.assignedByGroup, "Directory assigning group ID"),
    };
  });
}

function assignedPlans(value: unknown): CopilotServicePlan[] {
  if (!Array.isArray(value) || value.length > 1_000) throw providerSchema("Directory assigned plans are invalid.");
  return value.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw providerSchema("Directory assigned plan is invalid.");
    const plan = entry as GraphAssignedPlan;
    const servicePlanId = requiredUuid(plan.servicePlanId, "Directory service plan ID");
    const service = requiredText(plan.service, "Directory service plan name", 256);
    const capabilityStatus = requiredText(plan.capabilityStatus, "Directory service plan capability status", 64);
    if (!["Enabled", "Warning", "Suspended", "Deleted", "LockedOut"].includes(capabilityStatus)) {
      throw providerSchema("Directory service plan capability status is unsupported.");
    }
    return {
      servicePlanId,
      service,
      assignedDateTime: optionalDateTime(plan.assignedDateTime, "Directory service plan assignment time"),
      capabilityStatus: capabilityStatus as CopilotServicePlan["capabilityStatus"],
    };
  }).filter(plan => microsoft365CopilotPlanIds.has(plan.servicePlanId.toLowerCase()));
}

function effectiveLicenseState(states: CopilotLicenseAssignment["assignmentStates"]): CopilotLicenseAssignment["state"] {
  if (states.some(value => value.error && value.error.toLowerCase() !== "none")
    || states.some(value => ["error", "activewitherror"].includes(value.state.toLowerCase()))) return "error";
  if (states.some(value => value.state.toLowerCase() === "active")) return "enabled";
  if (states.some(value => value.state.toLowerCase() === "disabled")) return "disabled";
  return "assigned";
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

function enforcePageBounds(url: string, visited: Set<string>, count: number, maximum: number, source: string) {
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

function optionalUuid(value: unknown, field: string) {
  if (value === undefined || value === null || value === "") return null;
  return requiredUuid(value, field);
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
