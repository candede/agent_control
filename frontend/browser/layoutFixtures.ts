import type { Page } from "@playwright/test";
import { automaticRefreshFixture, isAutomaticRefreshRequest } from "./automaticRefreshFixtures";
import { capabilityDefinitions } from "../../backend/src/services/capabilityRegistry";
import { workbenchActions, workbenchViews } from "../../backend/src/services/workbenchMetadata";
import { defenderHuntingTemplates } from "../../backend/src/types/defenderHunting";
import { purviewAuditPresets } from "../../backend/src/types/purviewAudit";
import { selectedFixtureQuery, selectedFixtureRead, selectedFixtureReports, selectedHistoryPage, selectedLicensedUser, selectedOverviewPage, selectedUsersPage } from "../src/test/selectedUsageFixture";
import { historySet, overviewAgent, reportAgent, reportPage, reportUser } from "../src/test/reportDataFixture";
import type { ReportAgent, ReportMetadata, ReportPage, ReportRelationship, ReportUser } from "../../backend/src/types/officialReportData";
import { createUnifiedVerification, inventoryPageMetadata } from "../src/test/inventoryVerification";
import { projectAgentResponsibility } from "../../backend/scripts/agentResponsibilityOracle";
import { captureInventorySelection, fulfillInventoryDetail, fulfillInventoryMembers, fulfillInventoryPage, inventoryFixtureQuery } from "./selectedInventoryFixture";
import { encodeInventoryFacet } from "../../backend/src/types/inventoryFacets";
import type {
  AuditEvent, CapabilityView, DefenderHuntingCatalog, DefenderHuntingJob, DefenderHuntingRowPage,
  PackagePage, PurviewAuditCatalog, PurviewAuditJob, PurviewAuditRecordPage, SessionUser,
  WorkbenchJobsResponse, UnifiedAgentInventoryPage,
} from "../src/api/client";

export const layoutTime = "2026-09-12T10:00:00.000Z";
const observedAt = "2026-09-12T09:58:00.000Z";
const expiresAt = "2026-10-12T09:58:00.000Z";
const actor: SessionUser = {
  displayName: "Synthetic layout administrator",
  username: "layout.administrator@example.invalid",
  homeAccountId: "layout-principal", tenantId: "layout-tenant", roles: ["AgentControl.Admin"],
};
export const capabilityViews: CapabilityView[] = capabilityDefinitions.map(definition => {
  const local = definition.mode === "local";
  return {
    definition,
    decision: {
      capabilityId: definition.id, status: local ? "available" : "provider_error",
      authorized: local, fresh: true, verification: local ? "local" : "provider",
      checkedAt: observedAt, expiresAt,
      previewQualification: definition.maturity === "preview" ? "unqualified" : "not_required",
      ...(local ? {} : { evidence: { category: "provider_unavailable", phase: "provider_read" as const } }),
      remediation: local ? [] : [
        "The provider is temporarily unavailable. Authorized saved observations remain readable; open Permissions before retrying a live operation.",
      ],
    },
  };
});

const packageNames = ["Service desk assistant", "Finance policy review", "Operations knowledge companion"];
const packages: PackagePage = {
  value: packageNames.map((displayName, index) => ({
    id: `layout-package-${index + 1}`, displayName, isBlocked: index === 1,
    publisher: index === 1 ? "Synthetic Finance" : "Synthetic Operations",
    shortDescription: "Representative saved catalog observation; no live provider requests.",
    supportedHosts: ["Teams", "Microsoft 365"], platform: "Copilot Studio", type: ["firstParty", "thirdParty", "shared"][index],
    availableTo: index === 1 ? "none" : "some", deployedTo: "none",
    sourceSystem: "graph_packages", authoringTool: "Copilot Studio", creatorType: "unknown",
    agentKind: "copilot_package", lifecycle: "unknown", identityConfidence: "exact_native", provenance: {},
    createdDateTime: "2026-08-01T00:00:00.000Z", lastModifiedDateTime: observedAt,
  })),
  counts: { total: 3, scoped: 3, filtered: 3 },
  selection: { id: "11111111-1111-4111-8111-111111111111", revision: "1", evaluatedAt: observedAt, expiresAt },
  page: { limit: 50, nextCursor: null, previousCursor: null },
  freshness: { state: "current", capturedRevision: "1", sources: [] },
  mode: "delegated",
};

const graphObservation = {
  id: "22222222-2222-4222-8222-222222222222", snapshotId: "22222222-2222-4222-8222-222222222222",
  observedAt, expiresAt, current: true as const,
  tokenMode: "delegated" as const, scopeKind: "broad" as const,
  observedCount: packages.counts.total, totalRecords: packages.counts.total,
};
const agentSummary = { total: 3, linked: 0, graphOnly: 3, powerPlatformOnly: 0, ambiguous: 0, conflicting: 0 };
export const unifiedAgents: UnifiedAgentInventoryPage = {
  ...inventoryPageMetadata({ total: 3, scoped: 3, filtered: 3, packageTargets: 3 }, expiresAt),
  inventoryScope: "catalog", scopeSummary: agentSummary,
  selection: { id: "33333333-3333-4333-8333-333333333333", revision: "1", evaluatedAt: observedAt, expiresAt },
  page: { limit: 50, nextCursor: null, previousCursor: null },
  counts: { total: 3, scoped: 3, filtered: 3, packageTargets: 3 },
  verification: createUnifiedVerification({ graphPackageCount: 3, powerPlatformAgentCount: 0, logicalAgentCount: 3 }, { sourceScopes: false }, layoutTime),
  value: packages.value.map(item => ({
    id: `graph_packages:${item.id}`, displayName: item.displayName,
    presence: "graph_packages", environmentId: null, packages: [item], powerPlatformResource: null,
    identity: { state: "unmatched", evidence: [], packageEvidence: [], reason: "Matching metadata has not been observed." },
    observations: { graphPackages: graphObservation, packageSnapshots: {}, powerPlatform: null },
  })),
  summary: agentSummary, filteredSummary: agentSummary,
  inventoryOverview: { availableToUsers: 2, organizationCreated: 0, teamsAvailable: 2, createdOrAvailable: 2 },
  sources: {
    graphPackages: { state: "available", observation: graphObservation, error: null },
    powerPlatform: { state: "unavailable", observation: null, error: {
      source: "power_platform", code: "snapshot_unavailable", message: "Power Platform saved inventory is unavailable.",
    } },
  },
  partial: true,
  errors: [{ source: "power_platform", code: "snapshot_unavailable", message: "Power Platform saved inventory is unavailable." }],
};
export const inventoryFacetFixtures = { environments: [] as Array<{ value: string; label: string }>,
  platforms: [{ value: "Copilot Studio", label: "Copilot Studio" }], types: [
    { value: "firstParty", label: "1st party agents" }, { value: "thirdParty", label: "3rd party agents" },
    { value: "shared", label: "Shared in your organization" },
  ], publishers: [...new Set(packages.value.map(item => item.publisher!))].map(value => ({ value, label: value })),
  hosts: ["Teams", "Microsoft 365"].map(value => ({ value, label: value })),
  availability: ["some", "none"].map(value => ({ value, label: value })) };

export async function mockInventoryFacets(page: Page, values: Partial<Record<string, Array<{ value: string; label: string }>>>) {
  await page.route(url => url.pathname === "/api/agent-inventory/facets", route => {
    const query = new URL(route.request().url()).searchParams;
    if (!Object.hasOwn(values, query.get("field") ?? "")) return route.fallback();
    const options = values[query.get("field") ?? ""] ?? [];
    const search = (query.get("search") ?? "").toLowerCase();
    const selected = query.get("selected") === "true" ? inventoryFixtureQuery(route).get(query.get("field")!) : undefined;
    const filtered = options.filter(option => selected !== undefined
      ? encodeInventoryFacet(option.value) === selected : `${option.value} ${option.label}`.toLowerCase().includes(search));
    return route.fulfill({ json: { value: filtered.slice(0, 50), total: filtered.length, nextCursor: null } });
  });
}

const activeSet = historySet(1, { id: "55555555-5555-4555-8555-555555555555",
  bundleId: "66666666-6666-4666-8666-666666666666", reportingStart: "2026-08-01", reportingEnd: "2026-08-30", acceptedAt: observedAt });
const layoutReports: ReportMetadata = { ...selectedFixtureReports, setId: activeSet.id, activeSetId: activeSet.id,
  activeRevision: "1", historyRevision: "1", historyEpoch: "1", periodAgeDays: 13, acceptedAgeDays: 0, acceptedAt: observedAt,
  reportingPeriod: { startDate: "2026-08-01", endDate: "2026-08-30", days: 30, provenance: "operator_asserted" },
  lineages: selectedFixtureReports.lineages.map(row => ({ ...row, rowCount: row.kind === "userAgents" ? 4 : 2 })),
};
const directory = selectedUsersPage();
directory.reports = layoutReports;
directory.sources.directory.rowCount = 6;
directory.sources.directory.attemptObservedCount = 6;
directory.counts.total = 6;
directory.summary.checkedUsers = 6;
const unpaidPeople = ["Alex Example", "Jamie Example"].map((name, index) => {
  const row = selectedLicensedUser(index + 5, name, 120 - index * 40), username = `reader${index + 1}@example.invalid`;
  return { ...row, directory: { ...row.directory, userPrincipalName: username, companyName: null, department: null },
    copilotServiceState: "disabled" as const, servicePlanCount: 0, entitlement: "no_paid" as const,
    reportedUsername: username, reportedAgentsUsed: 2, relationshipCount: 2 };
});
unifiedAgents.usageContext = { revision: "b".repeat(64), reports: layoutReports, expiresAt: layoutReports.expiresAt };
const agentRows = packageNames.slice(0, 2).map((agentName, index) => reportAgent(index + 1, {
  agentId: `layout-report-agent-${index + 1}`, agentName, creatorType: "Your org", responses: 120 - index * 40,
  reportResponses: 120 - index * 40, bridgeResponses: 120 - index * 40, activeUsers: 2, relationshipCount: 2,
  licensedUserOccurrences: null, unlicensedUserOccurrences: null, lastActivityDateUtc: "2026-08-30",
}));
const agentPage = reportPage(agentRows, { reports: layoutReports, sources: directory.sources, counts: { total: 2, filtered: 2 } });
const rankings = agentRows.map(row => ({ agentId: row.agentId, name: row.agentName, responses: row.responses }));
const aggregate: ReportPage<ReportAgent> = { ...agentPage, summary: { ...agentPage.summary,
  reportedResponses: 200, bridgeResponses: 200, userReportedResponses: 200, distinctActiveReportUsers: 2,
  responseReconciliation: "matching", licensedOccurrences: null, unlicensedOccurrences: null,
}, analytics: { ...agentPage.analytics, rowCount: 2, responses: 200, agents: {
  inactive: 0, neverUsed: 0, anchorDateUtc: "2026-08-30", windowDays: 30, windowAgents: 2, windowResponses: 200,
  windowDistinctActiveUsers: 2, mostResponses: rankings, leastResponses: [...rankings].reverse(),
} } };
const users: ReportPage<ReportUser> = { ...reportPage(["Alex Example", "Jamie Example"].map((displayName, index) => reportUser(index + 1, {
  username: `reader${index + 1}@example.invalid`, displayName, objectId: unpaidPeople[index].directory.objectId, company: null, department: null, entitlement: "no_paid",
  reportedResponses: 120 - index * 40, reportedAgentsUsed: 2, bridgeResponses: 120 - index * 40,
  relationshipCount: 2, responseProducingAgentCount: 2, userLastActivityDateUtc: "2026-08-30", lastActivityDateUtc: "2026-08-30",
  hasReportMismatch: false,
})), { reports: layoutReports, sources: directory.sources, counts: { total: 2, filtered: 2 } }),
summary: { ...aggregate.summary, activeWithoutPaidUsers: 2, unknownLicenseActiveReportUsers: 0 },
analytics: { ...agentPage.analytics, rowCount: 2, responses: 200, zeroResponses: 0, unknownResponses: 0,
  review: { zero: 0, low: 0, unknown: 0 } } };
const relationshipRows: ReportRelationship[] = agentRows.flatMap((agent, index) => users.value.map((user, person) => ({
  id: `layout-relationship-${index}-${person}`, agentId: agent.agentId, agentName: agent.agentName, creatorType: agent.creatorType,
  username: user.username, responses: index ? person ? 30 : 50 : person ? 50 : 70,
  lastActivityDateUtc: "2026-08-30", identityStatus: "unresolved",
})));
const historyPage = selectedHistoryPage([activeSet], activeSet.id);
const usageHistory = { ...historyPage, reports: layoutReports, sources: directory.sources,
  analytics: { ...historyPage.analytics, history: { ...historyPage.analytics.history!, observationRows: 8, uniquePayloads: 8,
    earliestActivityDateUtc: "2026-08-01", latestActivityDateUtc: "2026-08-30",
    earliestReportingStart: "2026-08-01", latestReportingEnd: "2026-08-30" } } };
const auditEvents: AuditEvent[] = packageNames.slice(0, 2).map((agentDisplayName, index) => ({
  id: `layout-audit-${index}`, operationId: `layout-operation-${index}`, scope: "single",
  agentId: packages.value[index].id, agentDisplayName, actor, startedAt: observedAt, completedAt: observedAt,
  status: index ? "failed" : "succeeded", action: "block", targetBlockedState: true,
  requestPath: `/api/agents/${packages.value[index].id}/block`,
  message: index ? "Provider temporarily unavailable; saved evidence remains readable." : "Package block state verified.",
}));

const purviewJob: PurviewAuditJob = {
  id: "77777777-7777-4777-8777-777777777777", authorizationPrincipalId: actor.homeAccountId,
  resultScope: { kind: "principal", scopeId: actor.homeAccountId, configurationRevision: null },
  tokenMode: "delegated", status: "succeeded",
  filters: {
    presetId: "copilot_interactions", operations: ["CopilotInteraction"],
    startDateTime: "2026-09-12T09:00:00.000Z", endDateTime: observedAt,
    userPrincipalNames: [directory.value[0].directory.userPrincipalName], ipAddresses: [], objectIds: [], administrativeUnitIds: [],
  },
  displayName: "Saved Copilot compliance investigation", providerQueryId: "layout-query", providerStatus: "succeeded",
  localRequestId: "layout-purview-request", providerRequestId: "layout-provider-request", projectionVersion: 1,
  providerRequestCount: 2, activationCount: 1, pageCount: 1, providerRowCount: 1, storedRowCount: 1,
  byteCount: 512, unknownFieldCount: 0, pageComplete: true,
  observedRange: { startDateTime: observedAt, endDateTime: observedAt }, unobservedRange: null,
  qualificationId: null, cancelRequested: false, createdAt: observedAt, attemptedAt: observedAt,
  updatedAt: observedAt, finishedAt: observedAt, expiresAt, canResume: false, remoteWorkMayContinue: false,
};
const purviewCatalog: PurviewAuditCatalog = {
  presets: Object.entries(purviewAuditPresets).map(([id, preset]) => ({
    id: id as PurviewAuditJob["filters"]["presetId"], label: preset.label, service: preset.serviceFilter,
    recordTypes: preset.recordTypeFilters, operations: preset.operationFilters,
  })),
  limits: { maximumWindowHours: 168, qualificationWindowHours: 1, maximumPages: 20, maximumRows: 5000,
    maximumBytes: 8_000_000, pollsPerActivation: 6, providerRequests: 64, activations: 12 },
  evidenceNotice: "Saved compliance and security evidence, separate from official usage.",
  contentNotice: "Content not present in Purview audit. Message identifiers are metadata, not prompt or response text.",
  retentionNotice: "Saved results expire after 30 days; provider retention is separate.",
};
const purviewRecords: PurviewAuditRecordPage = {
  count: 1, limit: 100, offset: 0, job: purviewJob,
  value: [{
    projectionVersion: 1, wrapperId: "layout-record", nativeEventId: "layout-provider-event", eventDateTime: observedAt,
    auditLogRecordType: "copilotInteraction", operation: "CopilotInteraction", service: "Copilot",
    resultStatus: "Succeeded", actorUserId: "layout-reader", actorUserPrincipalName: "reader1@example.invalid",
    actorUserType: "Regular", objectId: null, clientIp: "192.0.2.10", administrativeUnits: [],
    correlationId: "layout-correlation", agentId: "layout-report-agent-1", appIdentity: null, appHost: "Teams",
    botId: null, environmentId: null, botComponentId: null, aiPluginOperationId: null,
    messages: [{ id: "layout-message-reference", isPrompt: true }], contentAvailable: false, unknownFieldCount: 0,
  }],
};
const huntingJob: DefenderHuntingJob = {
  id: "88888888-8888-4888-8888-888888888888", authorizationPrincipalId: actor.homeAccountId,
  resultScope: purviewJob.resultScope, tokenMode: "delegated", status: "succeeded",
  filters: { templateId: "agents_inventory", startDateTime: "2026-09-12T09:00:00.000Z", endDateTime: observedAt,
    agentIds: [], blueprintIds: [], actorObjectIds: [], operations: [] },
  queryVersion: 3, retainedScopeId: "layout-retained-scope", localRequestId: "layout-hunting-request", providerRequestId: "layout-provider-request",
  providerRequestCount: 1, activationCount: 1, providerRowCount: 1, storedRowCount: 1, byteCount: 512,
  complete: true, noData: false, partialReason: null, observedRange: purviewJob.observedRange, unobservedRange: null,
  snapshotId: "99999999-9999-4999-8999-999999999999", priorSuccessfulJobId: null, qualification: null,
  cancelRequested: false, createdAt: observedAt, attemptedAt: observedAt, updatedAt: observedAt, finishedAt: observedAt,
  expiresAt, canResume: false,
};
const huntingCatalog: DefenderHuntingCatalog = {
  templates: Object.entries(defenderHuntingTemplates).map(([id, template]) => ({ id: id as DefenderHuntingJob["filters"]["templateId"], ...template })),
  qualifications: [],
  retainedScopes: [{
    id: huntingJob.retainedScopeId!, resultScope: huntingJob.resultScope, tokenMode: "delegated",
    capabilityId: "defender.hunting.delegated", templateId: "agents_inventory", targetScopeHash: "a".repeat(64),
    approvedScope: { templateId: "agents_inventory", agentIds: [], blueprintIds: [], actorObjectIds: [], operations: [] },
    queryVersion: 3, contractRevision: "b".repeat(64), permissionRevision: "c".repeat(64), configurationRevision: 1,
    approvedBy: actor.homeAccountId, sourceQualificationJobId: huntingJob.id,
    approvedAt: observedAt, qualifiedAt: observedAt, expiresAt, revokedAt: null,
  }],
  limits: { maximumWindowHours: 168, qualificationWindowHours: 1, maximumRows: 200, maximumBytes: 2_000_000, providerRequests: 12, activations: 4 },
  scopeNotice: "Graph-selected Defender scope; no workspace selection.",
  contentNotice: "Messages and tool content are not retained or reconstructed.",
  readinessNotice: "Verify connector, license, role and rollout separately.",
  retentionNotice: "Local results expire after 30 days.", defenderPortalUrl: "https://security.microsoft.com/v2/advanced-hunting",
};
const huntingRows: DefenderHuntingRowPage = {
  count: 1, limit: 100, offset: 0, job: huntingJob,
  value: [{
    projectionVersion: 3, sourceTable: "AgentsInfo", observationTime: observedAt, agentId: "layout-hunting-agent",
    agentName: "Saved service desk security observation", platform: "CopilotStudio", agentDescription: null,
    version: "1.0", sourceAgentId: null, entraAgentObjectId: null, entraBlueprintId: null, observabilityId: null,
    publishedStatus: "Published", lifecycleStatus: "Active", availability: null, createdDateTime: observedAt,
    lastPublishedDateTime: observedAt, lastUpdatedDateTime: observedAt, instanceCount: 1, model: null,
    ownerCount: 1, sharedWithCount: null, permissionMetadataKeyCount: null, authenticationMetadataKeyCount: null,
    detailStates: { owners: "not_supplied", sharing: "not_supplied", permissions: "not_exposed", authentication: "not_exposed", risk: "not_exposed" },
  }],
  snapshot: {
    id: huntingJob.snapshotId!, jobId: huntingJob.id, resultScope: huntingJob.resultScope, filters: huntingJob.filters,
    sourceTable: "AgentsInfo", queryVersion: 3,
    requestedRange: { startDateTime: huntingJob.filters.startDateTime, endDateTime: huntingJob.filters.endDateTime },
    observedRange: huntingJob.observedRange, unobservedRange: null, observationTime: observedAt,
    complete: true, noData: false, partialReason: null, providerRowCount: 1, storedRowCount: 1, byteCount: 512, expiresAt,
  },
};
const jobs: WorkbenchJobsResponse = {
  value: [
    { id: "layout-inventory-refresh", source: "power-platform", label: "Power Platform inventory refresh", target: "Saved delegated resource scope",
      status: "waiting_authorization", total: 2, completed: 0, partial: false,
      updatedAt: observedAt, href: "/sync?powerPlatformJob=layout-inventory-refresh" },
  ],
  unavailableSources: [], polledAt: observedAt, requestId: "layout-jobs-request",
};

export async function mockLayoutApi(page: Page) {
  const unexpectedRequests: string[] = [];
  await page.context().route(url => !["localhost", "127.0.0.1"].includes(url.hostname), route => {
    unexpectedRequests.push(`External request: ${route.request().url()}`);
    return route.abort();
  });
  const responses: Record<string, unknown> = {
    "/api/auth/status": { authConfigured: true, callback: new URL("/api/auth/callback", process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3001").href },
    "/api/me": { user: actor, csrfToken: "layout-csrf", roleAssignmentRequired: false },
    "/api/workbench/metadata": { views: workbenchViews, actions: workbenchActions },
    "/api/capabilities": { value: capabilityViews }, "/api/capabilities/check": { value: capabilityViews },
    "/api/capabilities/check-progress": { progress: null },
    "/api/agents": packages,
    "/api/agents/bulk-jobs": { value: [] },
    ...Object.fromEntries(packages.value.map(item => [`/api/agents/${encodeURIComponent(item.id)}/detail`, item])),
    "/api/agent-inventory": unifiedAgents,
    "/api/agent-inventory/investigations/context": {
      recordId: unifiedAgents.value[0].id, displayName: unifiedAgents.value[0].displayName,
      defender: { status: "available", entraAgentIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] },
      purview: { status: "unavailable", mode: "saved_only", reason: "No exact saved audit bot identity." },
    },
    "/api/data-sync/state": {
      onboardingRequired: false, usageImportRequired: false, run: null,
      sources: ["users", "graph_packages", "power_platform", "usage_reports"].map(source => ({
        source, status: "succeeded", count: 3, lastSuccessAt: observedAt, updatedAt: observedAt,
        jobId: null, message: "", canRetry: false,
      })),
    },
    "/api/agents/refresh-jobs": { value: [], lastAttemptAt: observedAt, lastSuccessAt: observedAt },
    "/api/inventory/refresh-jobs": { value: [], lastAttemptAt: observedAt, lastSuccessAt: observedAt },
    "/api/quarantine/jobs": { value: [] },
    "/api/official-usage/aggregate": aggregate, "/api/official-usage/users": users,
    "/api/official-usage/history": usageHistory,
    "/api/copilot-usage/users": directory,
    "/api/audit/events": { value: auditEvents, count: auditEvents.length },
    "/api/audit-search/catalog": purviewCatalog, "/api/audit-search/jobs": { value: [purviewJob], count: 1, limit: 20, offset: 0 },
    [`/api/audit-search/jobs/${purviewJob.id}`]: purviewJob, [`/api/audit-search/jobs/${purviewJob.id}/records`]: purviewRecords,
    "/api/hunting/catalog": huntingCatalog, "/api/hunting/jobs": { value: [huntingJob], count: 1, limit: 20, offset: 0 },
    [`/api/hunting/jobs/${huntingJob.id}`]: huntingJob, [`/api/hunting/jobs/${huntingJob.id}/rows`]: huntingRows,
    "/api/workbench/jobs": jobs,
  };
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/agent-inventory/selections") return captureInventorySelection(route, unifiedAgents.selection);
    if (path === "/api/agents/selections") return captureInventorySelection(route, packages.selection);
    if (path === "/api/agents" && route.request().method() === "GET") {
      const query = inventoryFixtureQuery(route);
      const recordId = query.get("recordId");
      const value = recordId ? packages.value.filter(item => recordId === `graph_packages:${encodeURIComponent(item.id)}`) : packages.value;
      return route.fulfill({ json: { ...packages, value, selection: { ...packages.selection, id: query.get("selectionId") },
        counts: { total: packages.counts.total, scoped: packages.counts.scoped, filtered: value.length } } });
    }
    const detail = /^\/api\/agent-inventory\/([^/]+)\/detail$/.exec(path);
    if (detail) return fulfillInventoryDetail(route, decodeURIComponent(detail[1]));
    const members = /^\/api\/agent-inventory\/([^/]+)\/members$/.exec(path);
    if (members) return fulfillInventoryMembers(route, decodeURIComponent(members[1]));
    if (isAutomaticRefreshRequest(route.request())) {
      return route.fulfill({ json: automaticRefreshFixture({ users: observedAt, graph_packages: observedAt, power_platform: observedAt }) });
    }
    if (path === "/api/agent-inventory/facets") {
      const query = new URL(route.request().url()).searchParams, field = query.get("field");
      const options = field === "type" ? inventoryFacetFixtures.types
        : field === "platform" ? inventoryFacetFixtures.platforms
        : field === "publisher" ? inventoryFacetFixtures.publishers
        : field === "host" ? inventoryFacetFixtures.hosts
        : field === "availableTo" ? inventoryFacetFixtures.availability : inventoryFacetFixtures.environments;
      return route.fulfill({ json: { value: options, total: options.length, nextCursor: null } });
    }
    if (path === "/api/agent-inventory" && route.request().method() === "GET") {
      const recordId = inventoryFixtureQuery(route).get("recordId");
      if (recordId) {
        const value = unifiedAgents.value.filter(record => record.id === recordId);
        return fulfillInventoryPage(route, { ...unifiedAgents, value, counts: { ...unifiedAgents.counts, filtered: value.length } });
      }
      return fulfillInventoryPage(route, unifiedAgents);
    }
    if (path === "/api/agent-responsibility" && route.request().method() === "GET") {
      const query = new URL(route.request().url()).searchParams;
      const objectId = query.get("objectId") ?? undefined;
      const user = directory.value.find(user => user.directory.objectId === objectId);
      if (objectId && !user) return route.fulfill({ status: 404, json: { detail: "Exact saved person unavailable", code: "responsibility_person_unavailable" } });
      return route.fulfill({ json: projectAgentResponsibility(unifiedAgents, {
        objectId, search: query.get("search") ?? undefined, cursor: query.get("cursor") ?? undefined, limit: Number(query.get("limit") ?? 50),
      }, user ? { ...user.directory, observedAt } : undefined) });
    }
    if (path === "/api/official-usage/users" && new URL(route.request().url()).searchParams.get("licenseCohort") !== "active_without_paid") {
      unexpectedRequests.push(`Missing active_without_paid cohort: ${route.request().url()}`);
      return route.fulfill({ status: 400, json: { error: "Expected the active nonpaid cohort" } });
    }
    if (path === "/api/official-usage/overview") {
      const query = selectedFixtureQuery(route.request().url());
      const value = agentRows.filter(row => !query.search || `${row.agentName} ${row.agentId}`.toLowerCase().includes(query.search.toLowerCase()))
        .map((row, index) => overviewAgent(index + 1, { agentId: row.agentId, agentName: row.agentName, observationCount: 1, creatorTypeCount: 1,
          earliestActivityDateUtc: row.lastActivityDateUtc, lastActivityDateUtc: row.lastActivityDateUtc,
          latestSetId: activeSet.id, latestAcceptedAt: observedAt }));
      const data = selectedOverviewPage(query);
      return route.fulfill({ json: { ...data, value, counts: { total: 2, filtered: value.length },
        reports: { ...layoutReports, setId: query.setId ?? layoutReports.setId }, sources: directory.sources,
        analytics: { ...data.analytics, rowCount: value.length, overview: { ...data.analytics.overview!,
          earliestActivityDateUtc: "2026-08-30", latestActivityDateUtc: "2026-08-30" } } } });
    }
    if (route.request().method() === "GET" && path.startsWith("/api/official-usage/")) {
      const url = new URL(route.request().url()), query = selectedFixtureQuery(url.href);
      const selection = { ...aggregate.selection, id: url.searchParams.get("selectionId") ?? aggregate.selection.id };
      const reports = { ...layoutReports, setId: query.setId ?? layoutReports.setId };
      const selected = <T>(page: ReportPage<T>) => ({ ...page, selection, reports });
      if (path === "/api/official-usage/aggregate/facets" || path === "/api/official-usage/users/facets") {
        return route.fulfill({ json: { value: [{ value: url.searchParams.get("field") === "creatorType" ? "Your org" : null, count: 2 }],
          selection, counts: { total: 1, filtered: 1 }, page: { limit: 50, nextCursor: null, previousCursor: null } } });
      }
      if (path === "/api/official-usage/aggregate") {
        const value = aggregate.value.filter(row => (!query.search || row.agentName.toLowerCase().includes(query.search.toLowerCase()))
          && (!query.startDate || Boolean(row.lastActivityDateUtc && row.lastActivityDateUtc >= query.startDate))
          && (!query.endDate || Boolean(row.lastActivityDateUtc && row.lastActivityDateUtc <= query.endDate)));
        return route.fulfill({ json: selected({ ...aggregate, value, counts: { total: aggregate.counts.total, filtered: value.length },
          analytics: { ...aggregate.analytics, rowCount: value.length, responses: value.reduce((sum, row) => sum + row.responses, 0),
            agents: { ...aggregate.analytics.agents!, windowDays: query.activityWindowDays ?? 30 } } }) });
      }
      if (path === "/api/official-usage/users") {
        const value = users.value.filter(row => !query.search || `${row.displayName} ${row.username}`.toLowerCase().includes(query.search.toLowerCase()));
        return route.fulfill({ json: selected({ ...users, value, counts: { total: users.counts.total, filtered: value.length } }) });
      }
      if (path === "/api/official-usage/history") return route.fulfill({ json: selected(usageHistory) });
      const agent = /^\/api\/official-usage\/agents\/([^/]+)(?:\/(users))?$/.exec(path);
      const person = /^\/api\/official-usage\/users\/([^/]+)(?:\/(agents|directory))?$/.exec(path);
      if (agent || person) {
        const id = decodeURIComponent((agent ?? person)![1]), child = (agent ?? person)![2];
        if (child === "directory") {
          const value = unpaidPeople.find(row => row.directory.userPrincipalName === id);
          if (value) return route.fulfill({ json: { value, selection, reports, sources: directory.sources } });
        } else if (child) {
          const value = relationshipRows.filter(row => agent ? row.agentId === id : row.username === id);
          return route.fulfill({ json: selected(reportPage(value, { sources: directory.sources, counts: { total: value.length, filtered: value.length } })) });
        }
        const value = agent ? aggregate.value.find(row => row.agentId === id) : users.value.find(row => row.username === id);
        if (value) return route.fulfill({ json: { value, selection, reports, sources: directory.sources } });
      }
    }
    if (route.request().method() === "GET") {
      const read = selectedFixtureRead(route.request().url(), path === "/api/copilot-usage/users" ? directory
        : { ...directory, value: [...directory.value, ...unpaidPeople] });
      if (read) return route.fulfill({ json: read });
    }
    if (!path.startsWith("/api/")) return route.fallback();
    const method = route.request().method();
    if ((method === "GET" || (method === "POST" && path === "/api/capabilities/check")) && path in responses) {
      return route.fulfill({ json: responses[path] });
    }
    unexpectedRequests.push(`${method} ${path}`);
    return route.fulfill({ status: 501, json: { error: "Unexpected layout fixture request" } });
  });
  return unexpectedRequests;
}
