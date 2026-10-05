import { AppError } from "../errors.js";
import { copilotAppActivityPeriod, copilotAppActivityReportVersion, isCopilotServiceActive, type CopilotAppActivity, type CopilotDirectoryUser, type CopilotServicePlan } from "../types/copilotUsage.js";
import { copilotServicePlanDefinitions, resolveCopilotServicePlan, summarizeCopilotServices, type CopilotPlanObservation } from "./copilotServicePlans.js";
import { normalizeCopilotIdentity } from "./copilotIdentityKey.js";

const graphOrigin = "https://graph.microsoft.com";
const graphV1 = `${graphOrigin}/v1.0`;
const reportDownloadOrigins = new Set(["https://reports.office.com", "https://reportsweu.office.com"]);
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const reportHeaders = [
  "Report Refresh Date", "User Principal Name", "Display Name", "Last Activity Date", "Copilot Chat Last Activity Date",
  "Microsoft Teams Copilot Last Activity Date", "Word Copilot Last Activity Date", "Excel Copilot Last Activity Date",
  "PowerPoint Copilot Last Activity Date", "Outlook Copilot Last Activity Date", "OneNote Copilot Last Activity Date",
  "Loop Copilot Last Activity Date", "Report Period",
] as const;
type GraphEndpoint = "directory" | "catalog" | "report";
export type DirectoryFilter = { kind: "products"; skuIds: readonly string[] } | { kind: "reported"; identities: readonly string[] };
export type CopilotReportUser = { normalizedUserPrincipalName: string; activity: CopilotAppActivity };

export function buildSubscribedSkusUrl() { return `${graphV1}/subscribedSkus?$select=skuId,appliesTo,servicePlans`; }
export function buildCopilotUsersUrl(skuIds: readonly string[]) {
  if (!skuIds.length || skuIds.length > 20) throw providerSchema("Directory SKU filter has an invalid size.");
  return buildDirectoryUsersUrl(skuIds.map(skuId => `assignedLicenses/any(value:value/skuId eq ${skuId})`).join(" or "));
}
export function buildReportedUsersUrl(identities: readonly string[]) {
  if (!identities.length || identities.length > 20) throw providerSchema("Directory identity filter has an invalid size.");
  return buildDirectoryUsersUrl(identities.map(identity =>
    `${uuidPattern.test(identity) ? "id" : "userPrincipalName"} eq '${identity.replace(/'/g, "''")}'`).join(" or "));
}
function buildDirectoryUsersUrl(filter: string) {
  const url = new URL(`${graphV1}/users`);
  url.searchParams.set("$select", "id,userPrincipalName,displayName,accountEnabled,employeeType,companyName,department,userType,assignedLicenses,assignedPlans");
  url.searchParams.set("$filter", filter); url.searchParams.set("$count", "true"); url.searchParams.set("$top", "100");
  return url.toString();
}
export function buildCopilotReportUrl() {
  return `${graphV1}/copilot/reports/getMicrosoft365CopilotUsageUserDetail(period='${copilotAppActivityPeriod}',version='${copilotAppActivityReportVersion}')`;
}
export function validateReportDownloadUrl(value: string | null) {
  if (!value || value.length > 8192) throw invalidReportDownloadLink();
  let target: URL;
  try { target = new URL(value); } catch { throw invalidReportDownloadLink(); }
  const tokens = target.searchParams.getAll("token");
  const validPath = /^\/data\/download\/[A-Za-z0-9_-]+$/.test(target.pathname)
    || (target.pathname === "/data/v1.0/download" && tokens.length === 1 && Boolean(tokens[0].trim()));
  if (!reportDownloadOrigins.has(target.origin) || target.username || target.password || target.hash || !validPath) throw invalidReportDownloadLink();
  return target.toString();
}
function invalidReportDownloadLink() { return new AppError(502, "invalid_provider_link", "Microsoft returned an unsupported report download link."); }
export function validateGraphUrl(url: string, kind: GraphEndpoint) {
  let target: URL, pathname: string;
  try { target = new URL(url); pathname = decodeURIComponent(target.pathname); }
  catch { throw new AppError(502, "invalid_provider_link", "Microsoft Graph returned an invalid continuation link."); }
  const validPath = kind === "directory" ? pathname === "/v1.0/users" : kind === "catalog" ? pathname === "/v1.0/subscribedSkus"
    : pathname === new URL(buildCopilotReportUrl()).pathname;
  if (target.origin !== graphOrigin || target.username || target.password || !validPath) {
    throw new AppError(502, "invalid_provider_link", "Microsoft Graph returned a continuation link outside the documented endpoint.");
  }
}
export function parseReportedIdentity(value: string): string | null {
  if (value.length > 320) return null;
  const identity = normalizeCopilotIdentity(value);
  if (uuidPattern.test(identity)) return identity;
  if (identity.startsWith(".") || identity.includes(".@") || identity.includes("..") || identity.length - identity.indexOf("@") - 1 > 253) return null;
  const upn = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
  return upn.test(identity) ? identity : null;
}
export function parseSubscribedSku(value: unknown) {
  const sku = object(value, "Tenant license SKU");
  const skuId = requiredUuid(sku.skuId, "Tenant license SKU ID");
  if (sku.appliesTo !== "User" && sku.appliesTo !== "Company") throw providerSchema("Tenant license SKU scope is invalid.");
  if (!Array.isArray(sku.servicePlans) || sku.servicePlans.length > 1000) throw providerSchema("Tenant license service plans are invalid.");
  const ids = sku.servicePlans.map(plan => requiredUuid(object(plan, "Tenant license service plan").servicePlanId, "Tenant license service plan ID"));
  const servicePlanIds = [...new Set(ids.filter(id => copilotServicePlanDefinitions.has(id)))].sort();
  return { skuId, servicePlanIds: sku.appliesTo === "User" ? servicePlanIds : [] };
}
export function parseDirectoryUser(value: unknown, skus: ReadonlyMap<string, readonly string[]>, filter: DirectoryFilter): CopilotDirectoryUser | null {
  const user = object(value, "Directory user entry");
  const id = requiredUuid(user.id, "Directory user ID"), upn = requiredText(user.userPrincipalName, "Directory user principal name", 320);
  const assigned = assignedLicenses(user.assignedLicenses), copilot = assigned.filter(license => skus.has(license.skuId));
  if (filter.kind === "products" ? !copilot.some(license => filter.skuIds.includes(license.skuId))
    : !filter.identities.includes(id) && !filter.identities.includes(normalizeCopilotIdentity(upn))) return null;
  const observations = assignedPlans(user.assignedPlans), enabledPlans = new Map<string, boolean>();
  for (const license of copilot) for (const planId of skus.get(license.skuId)!) {
    enabledPlans.set(planId, Boolean(enabledPlans.get(planId)) || !license.disabledPlans.includes(planId));
  }
  const servicePlans = [...copilotServicePlanDefinitions.keys()].flatMap(planId => enabledPlans.has(planId)
    ? [resolveCopilotServicePlan(planId, enabledPlans.get(planId)!, observations)] : []);
  const state = servicePlans.length ? summarizeCopilotServices(servicePlans) : "disabled";
  const copilotServiceState = assigned.some(license => !skus.has(license.skuId)) && !isCopilotServiceActive(state) ? "unknown" : state;
  return { serviceEvidenceVersion: 1, copilotServiceState, servicePlans, identity: {
    objectId: id, userPrincipalName: upn, displayName: optionalText(user.displayName, "Directory display name", 512),
    accountEnabled: optionalBoolean(user.accountEnabled, "Directory account state"), userType: optionalText(user.userType, "Directory user type", 64),
    employeeType: optionalText(user.employeeType, "Directory employee type", 128), companyName: optionalText(user.companyName, "Directory company name", 256),
    department: optionalText(user.department, "Directory department", 256),
  } };
}
function assignedLicenses(value: unknown) {
  if (!Array.isArray(value) || value.length > 1000) throw providerSchema("Directory assigned licenses are invalid.");
  return value.map(entry => {
    const license = object(entry, "Directory license assignment"), skuId = requiredUuid(license.skuId, "Directory license SKU ID");
    if (!Array.isArray(license.disabledPlans) || license.disabledPlans.length > 1000) throw providerSchema("Directory disabled plans are invalid.");
    return { skuId, disabledPlans: license.disabledPlans.map(plan => requiredUuid(plan, "Directory disabled plan ID")) };
  });
}
function assignedPlans(value: unknown): CopilotPlanObservation[] {
  if (!Array.isArray(value) || value.length > 1000) throw providerSchema("Directory assigned plans are invalid.");
  return value.map(entry => {
    const plan = object(entry, "Directory assigned plan"), servicePlanId = requiredUuid(plan.servicePlanId, "Directory service plan ID");
    requiredText(plan.service, "Directory service plan name", 256);
    const status = requiredText(plan.capabilityStatus, "Directory service plan capability status", 64);
    if (!["Enabled", "Warning", "Suspended", "Deleted", "LockedOut"].includes(status)) throw providerSchema("Directory service plan capability status is unsupported.");
    return { servicePlanId, assignedDateTime: optionalDateTime(plan.assignedDateTime, "Directory service plan assignment time"),
      capabilityStatus: status as CopilotServicePlan["capabilityStatus"] };
  }).filter(plan => copilotServicePlanDefinitions.has(plan.servicePlanId));
}
export function parseReportUser(row: string[]): CopilotReportUser {
  if (row.length !== reportHeaders.length || row.some(value => typeof value !== "string" || value.length > 1024)) throw providerSchema("Copilot usage report entry is invalid.");
  const upn = requiredText(row[1], "Copilot report user principal name", 320), period = requiredText(row[12], "Copilot report period", 16);
  if (`D${period}` !== copilotAppActivityPeriod) throw providerSchema("Copilot usage report returned an unexpected period.");
  return { normalizedUserPrincipalName: normalizeCopilotIdentity(upn), activity: {
    reportRefreshDate: civilDate(row[0], "report refresh date", false)!, lastActivityDate: civilDate(row[3], "last activity date"),
    copilotChatLastActivityDate: civilDate(row[4], "Copilot Chat activity date"), microsoftTeamsCopilotLastActivityDate: civilDate(row[5], "Teams Copilot activity date"),
    wordCopilotLastActivityDate: civilDate(row[6], "Word Copilot activity date"), excelCopilotLastActivityDate: civilDate(row[7], "Excel Copilot activity date"),
    powerpointCopilotLastActivityDate: civilDate(row[8], "PowerPoint Copilot activity date"), outlookCopilotLastActivityDate: civilDate(row[9], "Outlook Copilot activity date"),
    onenoteCopilotLastActivityDate: civilDate(row[10], "OneNote Copilot activity date"), loopCopilotLastActivityDate: civilDate(row[11], "Loop Copilot activity date"),
  } };
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw providerSchema(`${name} is invalid.`);
  return value as Record<string, unknown>;
}
function requiredText(value: unknown, field: string, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw providerSchema(`${field} is invalid.`);
  return value.trim();
}
function optionalText(value: unknown, field: string, maximum: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > maximum) throw providerSchema(`${field} is invalid.`);
  return value.trim() || null;
}
function optionalBoolean(value: unknown, field: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") throw providerSchema(`${field} is invalid.`);
  return value;
}
function requiredUuid(value: unknown, field: string) {
  const text = requiredText(value, field, 36).toLowerCase();
  if (!uuidPattern.test(text)) throw providerSchema(`${field} is invalid.`);
  return text;
}
function optionalDateTime(value: unknown, field: string) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 128 || Number.isNaN(Date.parse(value))) throw providerSchema(`${field} is invalid.`);
  return value;
}
function civilDate(value: unknown, field: string, optional = true): string | null {
  if (optional && (value === undefined || value === null || value === "")) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw providerSchema(`Copilot report ${field} is invalid.`);
  return value;
}
function providerSchema(message: string) { return new AppError(502, "provider_schema", message); }
