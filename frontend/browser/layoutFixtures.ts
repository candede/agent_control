import type { Page } from "@playwright/test";
import { capabilityDefinitions } from "../../backend/src/services/capabilityRegistry";
import { workbenchActions, workbenchViews } from "../../backend/src/services/workbenchMetadata";
import { defenderHuntingTemplates } from "../../backend/src/types/defenderHunting";
import { purviewAuditPresets } from "../../backend/src/types/purviewAudit";
import { copilotUsageFixture } from "../src/test/copilotUsageFixture";
import { usageOverviewFixture } from "../src/test/usageInsightsFixture";
import { summarizeAgentAvailability } from "../../backend/src/types/agentPresentation";
import { createInventoryVerification, createUnifiedVerification } from "../src/test/inventoryVerification";
import type {
  AuditEvent, CapabilityView, DefenderHuntingCatalog, DefenderHuntingJob, DefenderHuntingRowPage,
  InventoryResourcePage, OfficialUsageAdminState, OfficialUsageAggregateView, OfficialUsageHistoryView, OfficialUsageUserView,
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
const capabilityViews: CapabilityView[] = capabilityDefinitions.map(definition => {
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
    supportedHosts: ["Teams", "Microsoft 365"], platform: "Copilot Studio", type: "Agent",
    availableTo: index === 1 ? "none" : "some", deployedTo: "none",
    sourceSystem: "graph_packages", authoringTool: "Copilot Studio", creatorType: "unknown",
    agentKind: "copilot_package", lifecycle: "unknown", identityConfidence: "exact_native", provenance: {},
    createdDateTime: "2026-08-01T00:00:00.000Z", lastModifiedDateTime: observedAt,
  })),
  count: 3, summary: { total: 3, allowed: 2, blocked: 1 },
  filteredSummary: { total: 3, allowed: 2, blocked: 1 },
  facets: {
    publishers: ["Synthetic Finance", "Synthetic Operations"].map(value => ({ value, label: value })),
    availability: [{ value: "available:some", label: "Some users" }],
    hosts: ["Teams", "Microsoft 365"].map(value => ({ value, label: value })),
    platforms: [{ value: "Copilot Studio", label: "Copilot Studio" }],
  },
  snapshot: {
    id: "11111111-1111-4111-8111-111111111111", tokenMode: "delegated", requestedIds: [],
    observedCount: 3, totalRecords: 3, pageCount: 1, observedAt, expiresAt, scopeKind: "broad",
  },
};

const graphObservation = {
  id: packages.snapshot!.id, snapshotId: packages.snapshot!.id,
  observedAt, expiresAt, current: true as const,
  tokenMode: "delegated" as const, scopeKind: "broad" as const,
  observedCount: packages.count, totalRecords: packages.count,
};
const agentSummary = { total: 3, linked: 0, graphOnly: 3, powerPlatformOnly: 0, ambiguous: 0, conflicting: 0 };
export const unifiedAgents: UnifiedAgentInventoryPage = {
  revision: "a".repeat(64),
  verification: createUnifiedVerification({ graphPackageCount: 3, powerPlatformAgentCount: 0, logicalAgentCount: 3 }, { sourceScopes: false }, layoutTime),
  value: packages.value.map(item => ({
    id: `graph_packages:${item.id}`, displayName: item.displayName,
    presence: "graph_packages", environmentId: null, packages: [item], powerPlatformResource: null,
    identity: { state: "unmatched", evidence: [], packageEvidence: [], reason: "Matching metadata has not been observed." },
    observations: { graphPackages: graphObservation, packageSnapshots: {}, powerPlatform: null },
  })),
  count: 3, offset: 0, limit: 50, summary: agentSummary, filteredSummary: agentSummary,
  facets: { environments: [], platforms: packages.facets.platforms },
  sources: {
    graphPackages: { state: "available", observation: graphObservation, error: null },
    powerPlatform: { state: "unavailable", observation: null, error: {
      source: "power_platform", code: "snapshot_unavailable", message: "Power Platform saved inventory is unavailable.",
    } },
  },
  partial: true,
  errors: [{ source: "power_platform", code: "snapshot_unavailable", message: "Power Platform saved inventory is unavailable." }],
};

const inventory: InventoryResourcePage = {
  value: ["Service desk automation", "Knowledge routing agent"].map((displayName, index) => ({
    tenantId: actor.tenantId!, nativeId: `layout-resource-${index + 1}`,
    type: "microsoft.copilotstudio/agents", location: "unitedstates", displayName,
    environmentId: "22222222-2222-4222-8222-222222222222", createdAt: observedAt, createdBy: "layout-maker",
    lastPublishedAt: observedAt, sourceSystem: "power_platform", authoringTool: "Copilot Studio",
    creatorType: "unknown", agentKind: "copilot_studio_agent", lifecycle: "published", identityConfidence: "exact_native",
    identifiers: [{ kind: "cds_bot_id", value: `33333333-3333-4333-8333-33333333333${index}` }],
    provenance: {}, details: { isQuarantined: index === 1, ownerId: "layout-maker" }, unknownFieldCount: 0,
  })),
  count: 2,
  typeCounts: [
    { type: "microsoft.copilotstudio/agents", status: "covered", count: 2 },
    { type: "microsoft.powerapps/apps", status: "not_authorized_scope", count: null },
  ],
  snapshot: {
    id: "44444444-4444-4444-8444-444444444444", roleScope: "ai", environmentScope: null,
    requestedTypes: ["microsoft.copilotstudio/agents", "microsoft.powerapps/apps"],
    coverage: [
      { type: "microsoft.copilotstudio/agents", status: "covered", count: 2 },
      { type: "microsoft.powerapps/apps", status: "not_authorized_scope", count: null },
    ],
    observedCount: 2, totalRecords: 2, pageCount: 1, unknownFieldCount: 0, observedAt, expiresAt,
    verification: createInventoryVerification(2, ["microsoft.copilotstudio/agents"], layoutTime),
  },
};

const activeSet: NonNullable<OfficialUsageAggregateView["activeSet"]> = {
  id: "55555555-5555-4555-8555-555555555555", bundleId: "66666666-6666-4666-8666-666666666666",
  reportingPeriod: { startDate: "2026-08-01", endDate: "2026-08-30", provenance: "operator_asserted" }, supersedesSetId: null,
  complete: true, kinds: ["agents", "userAgents", "users"], acceptedAt: observedAt,
  deletedAt: null, createdAt: observedAt, expiresAt,
};
const lineage: Pick<OfficialUsageAggregateView, "authority" | "availability" | "staleAfterDays" | "periodAgeDays" | "acceptedAgeDays" | "activeSet" | "lineages"> = {
  authority: "Microsoft 365 admin center Copilot Agents usage exports",
  availability: "active", staleAfterDays: 35, periodAgeDays: 13, acceptedAgeDays: 0, activeSet,
  lineages: activeSet.kinds.map((kind, index) => ({
    kind, versionId: `layout-version-${index}`, fileHash: `${index}`.repeat(64), parserVersion: "1",
    schemaVersion: "m365-observed-v1", reportingPeriod: { ...activeSet.reportingPeriod, days: 30, provenance: "operator_asserted" },
    sourceAsOfProvenance: "absent", sourceFreshness: "unknown", acceptedAt: observedAt,
    rowCount: 2, warnings: ["Source as-of is absent from this export."], reconciliation: {}, supersedesVersionId: null,
  })),
};
const topAgents: OfficialUsageAggregateView["summary"]["usage"]["topAgentsByResponses"] = packageNames.slice(0, 2).map((name, index) => ({
  id: `layout-report-agent-${index + 1}`, name, status: "Report only", responses: 120 - index * 40, activeUsers: 2,
  activeUsersBasis: "users_and_agents_distinct_identity", lastActivityDateUtc: "2026-08-30",
  creatorType: "Your org", creatorTypeSource: "agents_report", identityStatus: "unresolved",
}));
const aggregate: OfficialUsageAggregateView = {
  ...lineage, missingKinds: [],
  filters: { sortBy: "responses", sortDirection: "desc", creatorTypes: ["Your org"] },
  rankings: { mostResponses: topAgents, leastResponses: [...topAgents].reverse(), zeroResponseAgents: 0 },
  summary: {
    catalog: {
      totalAgents: 3, allowedAgents: 2, blockedAgents: 1, inactiveAgents: 1, noImportedUsageAgents: 1,
      statusDistribution: [{ name: "Allowed", value: 2 }, { name: "Blocked", value: 1 }],
      availabilityDistribution: [{ name: "Some users", value: 2 }, { name: "No users", value: 1 }],
      hostDistribution: [{ name: "Teams", value: 3 }, { name: "Microsoft 365", value: 2 }],
      publisherDistribution: [{ name: "Synthetic Operations", value: 2 }, { name: "Synthetic Finance", value: 1 }],
      platformDistribution: [{ name: "Copilot Studio", value: 3 }], typeDistribution: [{ name: "Agent", value: 3 }],
    },
    usage: {
      hasAgentUsage: true, totalResponses: 200, totalResponsesBasis: "agents_report", totalResponsesCoverage: "agents_report_only",
      totalActiveUsers: 2, totalActiveUsersBasis: "users_and_users_agents_distinct_identity",
      responseReconciliation: { status: "matching", difference: 0, sourceValues: { agents: 200, userAgents: 200, users: 200 } },
      activeUserReconciliation: { status: "matching", difference: 0, sourceValues: { users: 2, userAgents: 2 } },
      creatorTypeDistribution: [{ name: "Your org", value: 2 }],
      topAgentsByResponses: topAgents, topAgentsByActiveUsers: topAgents,
      lastActivityRange: { earliest: "2026-08-01", latest: "2026-08-30" }, activeUsersAreNonAdditive: true,
      reportedLicensedActiveUserOccurrences: null, reportedUnlicensedActiveUserOccurrences: null,
      activeUserOccurrenceNotice: "Independent non-additive source categories.",
    },
    activityWindow: {
      anchorDateUtc: "2026-08-30", activeAgents: 2, totalAgents: 2, activeUsers: 2, totalActiveUsers: 2,
      responses: 200, totalResponses: 200, responseBasis: "agents_report",
      agentDistribution: [{ name: "Active", value: 2 }], activeUserDistribution: [{ name: "Active", value: 2 }],
      creatorTypeDistribution: [{ name: "Your org", value: 2 }], topAgentsByResponses: topAgents,
    },
  },
  agents: {
    value: topAgents.map(agent => ({
      agentId: agent.id, agentName: agent.name, creatorType: agent.creatorType, activeUsersLicensed: null,
      activeUsersUnlicensed: null, activeUsersTotal: 2, responsesSentToUsers: agent.responses,
      lastActivityDateUtc: agent.lastActivityDateUtc, sourceReport: "agents", sourceReports: ["agents", "userAgents"],
      activeUsersIdentityCount: 2, activeUsersTotalBasis: "userAgents_distinct_identity",
      responseComparison: { status: "matching", difference: 0, sourceValues: { agents: agent.responses, userAgents: agent.responses } },
      creatorTypeSource: "agents_report", identityStatus: "unresolved",
    })),
    count: 2, limit: 100, offset: 0,
  },
};
const users: OfficialUsageUserView = {
  ...lineage, filters: { creatorTypes: ["Your org"], activity: "all", responsesOnly: false, lowResponseThreshold: 5, cohort: "all", sortBy: "responses", sortDirection: "desc" },
  counts: { users: 2, filteredUsers: 2, userRows: 2, accessRows: 2, reportOnlyRows: 2, totalResponsesReceived: 200, mismatchCount: 0 },
  cohorts: { zeroResponses: 0, lowResponses: 0, reviewCandidates: 0, unknownUserMetrics: 0, missingBridgeRows: 0, threshold: 5 },
  recencyAnchorDateUtc: "2026-08-30",
  decisionNotice: "Confirm license assignments and full Copilot activity before reassignment.",
  leastUsersByResponses: [],
  topUsersByResponses: ["Alex Example", "Jamie Example"].map((displayName, index) => ({
    username: `reader${index + 1}@example.invalid`, displayName, responses: 120 - index * 40, agentsUsed: 1,
    responsesSource: "users", agentsUsedSource: "users", userLastActivityDateUtc: "2026-08-30",
  })),
  users: {
    count: 2, limit: 100, offset: 0,
    value: ["Alex Example", "Jamie Example"].map((displayName, index) => ({
      username: `reader${index + 1}@example.invalid`, displayName, reportedAgentsUsed: 1,
      reportedResponsesReceived: 120 - index * 40, userLastActivityDateUtc: "2026-08-30",
      agentsAccessedTotal: 1, responseProducingAgentCount: 1, bridgeResponsesSentToUsers: 120 - index * 40,
      missingUserReport: false, hasReportMismatch: false, creatorTypes: ["Your org"],
      reviewCohort: "outside_threshold", reviewCandidate: false, licenseAssignmentStatus: "unavailable",
      rows: [{
        agentId: topAgents[index].id, agentName: topAgents[index].name, displayAgentName: topAgents[index].name,
        creatorType: "Your org", username: `reader${index + 1}@example.invalid`, responsesSentToUsers: 120 - index * 40,
        lastActivityDateUtc: "2026-08-30", packageStatus: "report-only", hasResponses: true,
        identityStatus: "unresolved", creatorTypeSource: "users_and_agents_report",
      }],
      searchableText: `${displayName} ${topAgents[index].name}`,
      datasetScope: { reportSetId: activeSet.id, usersVersionId: "layout-version-2", userAgentsVersionId: "layout-version-1" },
    })),
  },
};
const usageAdmin: OfficialUsageAdminState = { activeSetId: activeSet.id, activeRevision: 1, staging: [], sets: [activeSet] };
const usageHistory: OfficialUsageHistoryView = {
  summary: {
    importCount: 1, uniqueObservationCount: 3, observationRowCount: 6, uniquePayloadCount: 6, repeatedRowsReused: 0,
    earliestObservedAt: observedAt, latestObservedAt: observedAt,
    activityDateRange: { earliestDateUtc: "2026-08-01", latestDateUtc: "2026-08-30", provenance: "last_activity_dates", provesReportingCoverage: false },
    reportingWindows: { knownCount: 1, unknownCount: 0, overlappingKnownWindowCount: 0, additive: false },
    warning: { code: "rolling_snapshots_not_additive", message: "Report snapshots are not additive." },
  },
  bundles: {
    value: [{
      ...activeSet, isActive: true, observationCount: 3, rowCount: 6, uniquePayloadCount: 6, repeatedRowsReused: 0,
      reportingWindowKnown: true, activityRangeIsCoverage: false,
      observations: lineage.lineages.map(item => ({
        versionId: item.versionId, kind: item.kind, contentHash: item.fileHash,
        rowCount: item.rowCount, uniquePayloadCount: item.rowCount, repeatedRowsReused: 0, lineage: item,
      })),
    }],
    count: 1, limit: 10, offset: 0,
  },
};
const auditEvents: AuditEvent[] = packageNames.slice(0, 2).map((agentDisplayName, index) => ({
  id: `layout-audit-${index}`, operationId: `layout-operation-${index}`, scope: "single",
  agentId: packages.value[index].id, agentDisplayName, actor, startedAt: observedAt, completedAt: observedAt,
  status: index ? "failed" : "succeeded", action: "block", targetBlockedState: true,
  requestPath: `/api/agents/${packages.value[index].id}/block`,
  message: index ? "Provider temporarily unavailable; saved evidence remains readable." : "Package block state verified.",
}));

export const purviewJob: PurviewAuditJob = {
  id: "77777777-7777-4777-8777-777777777777", authorizationPrincipalId: actor.homeAccountId,
  resultScope: { kind: "principal", scopeId: actor.homeAccountId, configurationRevision: null },
  tokenMode: "delegated", status: "succeeded",
  filters: {
    presetId: "copilot_interactions", operations: ["CopilotInteraction"],
    startDateTime: "2026-09-12T09:00:00.000Z", endDateTime: observedAt,
    userPrincipalNames: [], ipAddresses: [], objectIds: [], administrativeUnitIds: [],
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
export const huntingJob: DefenderHuntingJob = {
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
      status: "waiting_authorization", total: 2, completed: 0, partial: false, canResume: true, canCancel: false, canReconcile: false,
      updatedAt: observedAt, href: "/power-platform" },
    { id: "layout-package-recovery", source: "package-controls", label: "Package access recovery", target: "3 exact saved package targets",
      status: "waiting_authorization", total: 3, completed: 1, partial: true, canResume: true, canCancel: true, canReconcile: true,
      updatedAt: observedAt, href: "/agents" },
    { id: purviewJob.id, source: "purview", label: "Saved Purview compliance search", target: "Copilot interactions · delegated",
      status: "succeeded", total: 1, completed: 1, partial: false, canResume: false, canCancel: false, canReconcile: false,
      updatedAt: observedAt, href: `/audit?source=purview&job=${purviewJob.id}` },
    { id: huntingJob.id, source: "defender", label: "Saved Defender agent inventory", target: "AgentsInfo · delegated",
      status: "succeeded", total: 1, completed: 1, partial: false, canResume: false, canCancel: false, canReconcile: false,
      updatedAt: observedAt, href: `/security?job=${huntingJob.id}` },
  ],
  unavailableSources: [{ source: "quarantine", code: "temporarily_unavailable" }], polledAt: observedAt, requestId: "layout-jobs-request",
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
    "/api/agents": packages,
    ...Object.fromEntries(packages.value.map(item => [`/api/agents/${encodeURIComponent(item.id)}`, item])),
    "/api/agent-inventory": { ...unifiedAgents, inventoryOverview: summarizeAgentAvailability(unifiedAgents.value) },
    "/api/data-sync/state": {
      onboardingRequired: false, usageImportRequired: false, run: null,
      sources: ["users", "graph_packages", "power_platform", "usage_reports"].map(source => ({
        source, status: "succeeded", count: 3, lastSuccessAt: observedAt, updatedAt: observedAt,
        jobId: null, message: "", canRetry: false,
      })),
    },
    "/api/agents/refresh-jobs": { value: [], lastAttemptAt: observedAt, lastSuccessAt: observedAt },
    "/api/inventory/resources": inventory, "/api/inventory/snapshots": { value: [inventory.snapshot] },
    "/api/inventory/refresh-jobs": { value: [], lastAttemptAt: observedAt, lastSuccessAt: observedAt },
    "/api/quarantine/jobs": { value: [] },
    "/api/official-usage/admin": usageAdmin, "/api/official-usage/aggregate": aggregate, "/api/official-usage/users": users,
    "/api/official-usage/history": usageHistory,
    "/api/official-usage/overview": usageOverviewFixture(),
    "/api/copilot-usage/users": copilotUsageFixture,
    "/api/audit/events": { value: auditEvents, count: auditEvents.length },
    "/api/audit-search/catalog": purviewCatalog, "/api/audit-search/jobs": { value: [purviewJob], count: 1, limit: 20, offset: 0 },
    [`/api/audit-search/jobs/${purviewJob.id}`]: purviewJob, [`/api/audit-search/jobs/${purviewJob.id}/records`]: purviewRecords,
    "/api/hunting/catalog": huntingCatalog, "/api/hunting/jobs": { value: [huntingJob], count: 1, limit: 20, offset: 0 },
    [`/api/hunting/jobs/${huntingJob.id}`]: huntingJob, [`/api/hunting/jobs/${huntingJob.id}/rows`]: huntingRows,
    "/api/workbench/jobs": jobs,
  };
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/official-usage/overview") {
      const params = new URL(route.request().url()).searchParams;
      return route.fulfill({ json: usageOverviewFixture({
        search: params.get("search") ?? undefined, startDate: params.get("startDate") ?? undefined, endDate: params.get("endDate") ?? undefined,
        sortBy: params.get("sortBy") === "agentName" ? "agentName" : "lastActivity",
        sortDirection: params.get("sortDirection") === "asc" ? "asc" : "desc",
        limit: Number(params.get("limit") ?? 25), offset: Number(params.get("offset") ?? 0),
      }) });
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
