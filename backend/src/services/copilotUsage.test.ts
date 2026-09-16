import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { AppError } from "../errors.js";
import type { PublishedOfficialUsage, UserAgentUsageRow, UserUsageRow } from "../types/officialUsage.js";
import type { AuthenticatedUser } from "../types/session.js";
import { CopilotUsageService } from "./copilotUsage.js";
import type { CopilotDirectoryUser, CopilotReportResult, CopilotUsageGraphClient } from "./copilotUsageGraph.js";
import type { CopilotUsageAttemptStatus, CopilotUsageSnapshotSource, SavedCopilotUsageSource } from "../db/dataSync.js";

const now = new Date("2026-09-13T01:00:00.000Z");
const publication = {
  runId: "11111111-1111-4111-8111-111111111111",
  jobId: "22222222-2222-4222-8222-222222222222",
};
const user: AuthenticatedUser = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  homeAccountId: "principal",
  username: "viewer@example.com",
  displayName: "Viewer",
  roles: ["AgentControl.Viewer"],
};

describe("CopilotUsageService", () => {
  it("blocks restored provider-disabled user collection before token or Graph access", async () => {
    const graph = {
      listLicensedUsers: vi.fn(),
      listAppActivity: vi.fn(),
    } as unknown as CopilotUsageGraphClient;
    const delegatedToken = vi.fn();
    const value = new CopilotUsageService({} as pg.Pool, {
      graph,
      delegatedToken: delegatedToken as never,
      usageStore: memoryUsageStore(),
      requireProviderAdmissions: vi.fn(() => {
        throw new AppError(503, "provider_requalification_required", "Provider work is fenced.");
      }),
    });
    await expect(value.refreshUsers(user, undefined, { publication })).rejects.toMatchObject({ code: "provider_requalification_required" });
    expect(delegatedToken).not.toHaveBeenCalled();
    expect(graph.listLicensedUsers).not.toHaveBeenCalled();
    expect(graph.listAppActivity).not.toHaveBeenCalled();
  });

  it("reads saved user sources without invoking Microsoft Graph and reflects later accepted usage immediately", async () => {
    let published = emptyPublished();
    const directory = [directoryUser("11111111-1111-4111-8111-111111111111", "saved@example.com")];
    const graph = {
      listLicensedUsers: vi.fn(async () => { throw new Error("GET must not call Graph"); }),
      listAppActivity: vi.fn(async () => { throw new Error("GET must not call Graph"); }),
    } as unknown as CopilotUsageGraphClient;
    const usageStore = memoryUsageStore(directory, { users: [], reportRefreshDate: null });
    const value = new CopilotUsageService({} as pg.Pool, {
      graph,
      usageStore,
      now: () => now,
      loadPublished: vi.fn(async () => published),
    });

    expect((await value.users(user)).users[0].importedUsage).toBeNull();
    published = importedPublished(
      [{ username: "saved@example.com", displayName: "Saved", numberOfAgentsUsed: 1, agentResponsesReceived: 7 }],
      [],
    );
    expect((await value.users(user)).users[0].importedUsage).toMatchObject({ reportedResponsesReceived: 7 });
    expect(graph.listLicensedUsers).not.toHaveBeenCalled();
    expect(graph.listAppActivity).not.toHaveBeenCalled();
  });

  it("returns explicit unknown counts before a first saved-data sync", async () => {
    const value = new CopilotUsageService({} as pg.Pool, {
      usageStore: memoryUsageStore(),
      now: () => now,
      loadPublished: vi.fn(async () => emptyPublished()),
    });
    const result = await value.users(user);
    expect(result.snapshot).toMatchObject({ state: "not_synced", lastSuccessAt: null });
    expect(result.counts).toMatchObject({ licensedUsers: null, measuredActivityUsers: null });
    expect(result.users).toEqual([]);
  });

  it("distinguishes response byte limits from user-count limits and missing consent", async () => {
    const result = await service({
      directoryError: new AppError(502, "provider_response_size_limit", "Private provider details"),
      report: { users: [], reportRefreshDate: null }, published: emptyPublished(),
    }).users(user);
    expect(result.sources.directory.state).toBe("unavailable");
    expect(result.sources.directory.message).toContain("response-size safety limit, not the user-count limit");
    expect(result.sources.directory.message).toContain("additional permissions will not fix");
    expect(result.counts.licensedUsers).toBeNull();
    expect(result.users).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("Private provider details");
  });

  it("retains more than 2,000 licensed accounts when only ten have imported usage", async () => {
    const directory = Array.from({ length: 2_011 }, (_, index) => directoryUser(
      `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`, `person${index}@example.com`,
    ));
    const result = await service({
      directory, report: { users: [], reportRefreshDate: null },
      published: importedPublished(directory.slice(0, 10).map(entry => ({
        username: entry.identity.userPrincipalName, displayName: "Reported",
        numberOfAgentsUsed: 1, agentResponsesReceived: 2,
      })), []),
    }).users(user);
    expect(result.users).toHaveLength(2_011);
    expect(result.counts.licensedUsers).toBe(2_011);
    expect(result.users.filter(entry => entry.importedUsage !== null)).toHaveLength(10);
    expect(result.users.filter(entry => entry.importedUsage === null)).toHaveLength(2_001);
    expect(result.sources.directory.message).toContain("2011");
  });

  it("keeps an incomplete license count unknown and explains how to retry", async () => {
    const result = await service({
      directoryError: new AppError(502, "provider_count_mismatch", "Provider details"),
      report: { users: [], reportRefreshDate: null }, published: emptyPublished(),
    }).users(user);
    expect(result.counts.licensedUsers).toBeNull();
    expect(result.sources.directory.state).toBe("unavailable");
    expect(result.sources.directory.message).toContain("Microsoft Graph's total count");
    expect(result.sources.directory.message).toContain("refresh usage");
    expect(result.users).toEqual([]);
  });

  it("keeps licensed directory users with no imported or app usage and never turns missing into zero", async () => {
    const value = service({
      directory: [directoryUser("11111111-1111-4111-8111-111111111111", "licensed@example.com")],
      report: { users: [], reportRefreshDate: null },
      published: emptyPublished(),
    });
    const result = await value.users(user);
    expect(result.counts).toMatchObject({ licensedUsers: 1, measuredActivityUsers: null, unknownMetricsUsers: 1 });
    expect(result.sources.appActivity).toMatchObject({
      state: "partial",
      reportRefreshDate: null,
      reportVersion: "v1",
      period: { value: "D30", startDate: null, endDate: null },
    });
    expect(result.users[0]).toMatchObject({
      importedUsage: null,
      appActivity: null,
      attention: expect.arrayContaining(["agent_usage_unknown", "app_activity_unknown"]),
    });
    expect(result.users[0].attention).not.toContain("agent_usage_zero");
    expect(result.counts.needsAttentionUsers).toBe(0);
  });

  it("does not fold lookalike report identities into a licensed employee", async () => {
    const value = service({
      directory: [directoryUser("11111111-1111-4111-8111-111111111111", "person@example.com")],
      report: { users: [], reportRefreshDate: null },
      published: importedPublished(
        [{ username: "\uff50\uff45\uff52\uff53\uff4f\uff4e@example.com", displayName: "Person", numberOfAgentsUsed: 0, agentResponsesReceived: 0 }],
        [],
      ),
    });
    const result = await value.users(user);
    expect(result.users[0].importedUsage).toBeNull();
    expect(result.unresolvedImportedIdentities).toHaveLength(1);
    expect(result.users[0].attention).not.toContain("agent_usage_zero");
  });

  it("propagates unexpected failures rather than disguising them as unavailable reports", async () => {
    const failure = new Error("Programming failure");
    const value = service({ directoryError: failure, report: { users: [], reportRefreshDate: null }, published: emptyPublished() });
    await expect(value.users(user)).rejects.toBe(failure);
  });

  it("joins only unique normalized identifiers, keeps hidden report identities unmatched, and preserves creator type", async () => {
    const published = importedPublished(
      [{ username: " PERSON@EXAMPLE.COM ", displayName: "Imported", numberOfAgentsUsed: 1, agentResponsesReceived: 2, lastActivityDateUtc: "2026-09-10T00:00:00.000Z" }],
      [{ username: " PERSON@EXAMPLE.COM ", agentId: "agent-1", agentName: "First party", creatorType: "Microsoft", responsesSentToUsers: 2 }],
    );
    const value = service({
      directory: [directoryUser("11111111-1111-4111-8111-111111111111", "person@example.com")],
      report: {
        users: [appUser("A94F65B7D0C6C1D5C82B", "2026-09-12")],
        reportRefreshDate: "2026-09-13",
      },
      published,
    });
    const result = await value.users(user);
    expect(result.users[0].importedUsage).toMatchObject({
      username: " PERSON@EXAMPLE.COM ",
      creatorTypes: ["Microsoft"],
      rows: [expect.objectContaining({ creatorType: "Microsoft", creatorTypeSource: "users_and_agents_report" })],
    });
    expect(result.users[0].appActivity).toBeNull();
    expect(result.sources.appActivity).toMatchObject({ state: "partial", reportVersion: "v1" });
  });

  it("keeps ambiguous imported identities unresolved rather than guessing by display name", async () => {
    const published = importedPublished(
      [{ username: "duplicate@example.com", displayName: "Same Name", numberOfAgentsUsed: 0, agentResponsesReceived: 0 }],
      [],
    );
    const value = service({
      directory: [
        directoryUser("11111111-1111-4111-8111-111111111111", "duplicate@example.com", "Same Name"),
        directoryUser("22222222-2222-4222-8222-222222222222", "DUPLICATE@example.com", "Same Name"),
      ],
      report: { users: [], reportRefreshDate: null },
      published,
    });
    const result = await value.users(user);
    expect(result.users.every(row => row.importedUsage === null)).toBe(true);
    expect(result.unresolvedImportedIdentities).toEqual([
      expect.objectContaining({ normalizedUserPrincipalName: "duplicate@example.com", reason: "ambiguous_directory_match" }),
    ]);
  });

  it("returns independent partial source states and preserves imports when directory permission is denied", async () => {
    const published = importedPublished(
      [{ username: "orphan@example.com", displayName: "Orphan", numberOfAgentsUsed: 0, agentResponsesReceived: 0 }],
      [],
    );
    const value = service({
      directoryError: new AppError(403, "Authorization_RequestDenied", "sensitive provider text"),
      report: { users: [], reportRefreshDate: "2026-09-13" },
      published,
    });
    const result = await value.users(user);
    expect(result.sources).toMatchObject({
      directory: { state: "unavailable", message: expect.stringContaining("permission") },
      appActivity: { state: "available" },
      importedAgentUsage: { state: "available" },
    });
    expect(result.users).toEqual([]);
    expect(result.counts.licensedUsers).toBeNull();
    expect(result.sources.directory.message).toContain("LicenseAssignment.Read.All");
    expect(result.sources.directory.message).toContain("Directory Readers");
    expect(result.unresolvedImportedIdentities[0]).toMatchObject({ reason: "directory_unavailable" });
    expect(JSON.stringify(result)).not.toContain("sensitive provider text");
  });

  it("distinguishes a rejected license query from missing consent and retains a safe diagnostic code", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await service({
        directoryError: new AppError(400, "Request_UnsupportedQuery", "sensitive provider text"),
        report: { users: [], reportRefreshDate: null },
        published: emptyPublished(),
      }).users(user);
      expect(result.sources.directory.message).toContain("HTTP 400");
      expect(result.sources.directory.message).toContain("not evidence that another delegated permission is needed");
      expect(result.counts.licensedUsers).toBeNull();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"errorCode":"request_unsupportedquery"'));
      expect(JSON.stringify(result)).not.toContain("sensitive provider text");
    } finally {
      log.mockRestore();
    }
  });

  it("names the existing app permission and report-reader role while retaining licensed users", async () => {
    const result = await service({
      directory: [directoryUser("11111111-1111-4111-8111-111111111111", "licensed@example.com")],
      reportError: new AppError(403, "Forbidden", "sensitive provider text"),
      report: { users: [], reportRefreshDate: null },
      published: emptyPublished(),
    }).users(user);
    expect(result.sources.directory.state).toBe("available");
    expect(result.users).toHaveLength(1);
    expect(result.sources.appActivity.message).toContain("Reports.Read.All");
    expect(result.sources.appActivity.message).toContain("existing Entra app");
    expect(result.sources.appActivity.message).toContain("Reports Reader");
    expect(JSON.stringify(result)).not.toContain("sensitive provider text");
  });

  it.each([
    [new AppError(401, "InvalidAuthenticationToken", "sensitive text"), "Sign out and sign in"],
    [new AppError(429, "TooManyRequests", "sensitive text"), "temporarily throttled"],
    [new AppError(502, "report_download_failed", "sensitive text"), "Refresh usage to request a new download"],
    [new TypeError("fetch failed"), "HTTPS access to Microsoft Graph, reports.office.com, and reportsweu.office.com"],
    [new DOMException("sensitive text", "TimeoutError"), "timed out"],
  ])("provides actionable report recovery without hiding failures: %s", async (reportError, message) => {
    const result = await service({ reportError, report: { users: [], reportRefreshDate: null }, published: emptyPublished() }).users(user);
    expect(result.sources.appActivity.state).toBe("unavailable");
    expect(result.sources.appActivity.message).toContain(message);
    expect(JSON.stringify(result)).not.toContain("sensitive text");
  });

  it("distinguishes zero agent usage from missing metrics for a fresh import", async () => {
    const published = importedPublished(
      [{ username: "11111111-1111-4111-8111-111111111111", displayName: "Zero", numberOfAgentsUsed: 0, agentResponsesReceived: 0 }],
      [],
    );
    const value = service({
      directory: [
        directoryUser("11111111-1111-4111-8111-111111111111", "zero@example.com"),
        directoryUser("22222222-2222-4222-8222-222222222222", "missing@example.com"),
      ],
      report: {
        users: [appUser("zero@example.com", "2026-07-01"), appUser("missing@example.com", "2026-09-11")],
        reportRefreshDate: "2026-09-13",
      },
      published,
    });
    const result = await value.users(user);
    const zero = result.users.find(row => row.directory.userPrincipalName === "zero@example.com")!;
    const missing = result.users.find(row => row.directory.userPrincipalName === "missing@example.com")!;
    expect(zero.attention).toEqual(expect.arrayContaining(["agent_usage_zero", "app_activity_inactive"]));
    expect(zero.attention).not.toContain("agent_usage_unknown");
    expect(missing.attention).toContain("agent_usage_unknown");
    expect(missing.attention).not.toContain("agent_usage_zero");
    expect(result.sources.importedAgentUsage.state).toBe("available");
  });

  it("retains stale imported values as historical without ranking them as zero or low", async () => {
    const value = service({
      directory: [directoryUser("11111111-1111-4111-8111-111111111111", "historical@example.com")],
      report: { users: [], reportRefreshDate: null },
      published: importedPublished(
        [{ username: "historical@example.com", displayName: "Historical", numberOfAgentsUsed: 0, agentResponsesReceived: 0 }],
        [],
        "2026-01-01",
      ),
    });
    const result = await value.users(user);
    expect(result.sources.importedAgentUsage.state).toBe("stale");
    expect(result.users[0].importedUsage?.reportedResponsesReceived).toBe(0);
    expect(result.users[0].attention).toContain("agent_usage_unknown");
    expect(result.users[0].attention).not.toContain("agent_usage_zero");
  });

  it("keeps a blank fresh report date unknown instead of calling it inactive", async () => {
    const value = service({
      directory: [directoryUser("11111111-1111-4111-8111-111111111111", "blank@example.com")],
      report: { users: [appUser("blank@example.com", null)], reportRefreshDate: "2026-09-13" },
      published: emptyPublished(),
    });
    const result = await value.users(user);
    expect(result.users[0].appActivity).not.toBeNull();
    expect(result.users[0].attention).toContain("app_activity_unknown");
    expect(result.users[0].attention).not.toContain("app_activity_inactive");
    expect(result.counts.measuredActivityUsers).toBe(0);
  });
});

function service(options: {
  directory?: CopilotDirectoryUser[];
  directoryError?: Error;
  reportError?: Error;
  report: CopilotReportResult;
  published: PublishedOfficialUsage;
}) {
  const graph = {
    listLicensedUsers: vi.fn(async () => {
      if (options.directoryError) throw options.directoryError;
      return options.directory ?? [];
    }),
    listAppActivity: vi.fn(async () => {
      if (options.reportError) throw options.reportError;
      return options.report;
    }),
  } as unknown as CopilotUsageGraphClient;
  const usageStore = memoryUsageStore();
  const value = new CopilotUsageService({} as pg.Pool, {
    graph,
    usageStore,
    now: () => now,
    requireAvailable: vi.fn(async () => ({ authorized: true })) as never,
    delegatedToken: vi.fn(async (_principal: string, capability: string) => `${capability}-token`) as never,
    revalidateUser: vi.fn(async () => user),
    requireProviderAdmissions: vi.fn(),
    loadPublished: vi.fn(async () => options.published),
  });
  return {
    async users(authenticatedUser: AuthenticatedUser) {
      await value.refreshUsers(authenticatedUser, undefined, { publication });
      return value.users(authenticatedUser);
    },
  };
}

function memoryUsageStore(
  directoryValue?: CopilotDirectoryUser[],
  appActivityValue?: CopilotReportResult,
) {
  const sources: {
    directory: SavedCopilotUsageSource<CopilotDirectoryUser[]>;
    appActivity: SavedCopilotUsageSource<CopilotReportResult>;
  } = {
    directory: savedSource("directory", directoryValue),
    appActivity: savedSource("app_activity", appActivityValue),
  };
  return {
    getUserSources: vi.fn(async () => sources),
    publishDirectory: vi.fn(async (_scope, value: readonly CopilotDirectoryUser[], observedAt: string, message: string) => {
      sources.directory = savedSource("directory", [...value], observedAt, message);
      return "11111111-1111-4111-8111-111111111111";
    }),
    publishAppActivity: vi.fn(async (_scope, value: CopilotReportResult, observedAt: string, message: string) => {
      sources.appActivity = savedSource("app_activity", value, observedAt, message);
      return "22222222-2222-4222-8222-222222222222";
    }),
    recordUserSourceFailure: vi.fn(async (
      _scope,
      sourceId: CopilotUsageSnapshotSource,
      status: Exclude<CopilotUsageAttemptStatus, "available">,
      message: string,
      attemptedAt: string,
    ) => {
      const key = sourceId === "directory" ? "directory" : "appActivity";
      sources[key] = { ...sources[key], attemptStatus: status, message, attemptedAt };
    }),
  };
}

function savedSource<T>(
  source: CopilotUsageSnapshotSource,
  value?: T,
  observedAt = now.toISOString(),
  message = "Saved normalized source.",
): SavedCopilotUsageSource<T> {
  return {
    source,
    attemptStatus: value === undefined ? null : "available",
    message: value === undefined ? null : message,
    attemptedAt: value === undefined ? null : observedAt,
    lastSuccessAt: value === undefined ? null : observedAt,
    rowCount: value === undefined ? null : Array.isArray(value) ? value.length : "users" in (value as object) ? (value as CopilotReportResult).users.length : null,
    observedAt: value === undefined ? null : observedAt,
    value: value ?? null,
  };
}

function directoryUser(objectId: string, userPrincipalName: string, displayName = userPrincipalName): CopilotDirectoryUser {
  return {
    identity: { objectId, userPrincipalName, displayName, accountEnabled: true, userType: "Member", employeeType: "Employee", department: "Engineering" },
    licenses: [{
      skuId: "639dec6b-bb19-468b-871c-c5c441c4b0cb",
      skuPartNumber: "Microsoft_365_Copilot",
      state: "enabled",
      disabledPlanIds: [],
      assignmentStates: [{ state: "Active", error: null, assignedByGroup: null }],
    }],
    servicePlans: [{
      servicePlanId: "a62f8878-de10-42f3-b68f-6149a25ceb97",
      service: "M365_COPILOT_APPS",
      assignedDateTime: "2026-01-01T00:00:00Z",
      capabilityStatus: "Enabled",
    }],
  };
}

function appUser(normalizedUserPrincipalName: string, lastActivityDate: string | null) {
  return {
    normalizedUserPrincipalName,
    activity: {
      reportRefreshDate: "2026-09-13",
      lastActivityDate,
      copilotChatLastActivityDate: null,
      microsoftTeamsCopilotLastActivityDate: lastActivityDate,
      wordCopilotLastActivityDate: null,
      excelCopilotLastActivityDate: null,
      powerpointCopilotLastActivityDate: null,
      outlookCopilotLastActivityDate: null,
      onenoteCopilotLastActivityDate: null,
      loopCopilotLastActivityDate: null,
    },
  };
}

function emptyPublished(): PublishedOfficialUsage {
  return {
    activeRevision: 1,
    activeSet: null,
    reports: {},
    retainedCompleteSets: 0,
    retainedIncompleteSets: 0,
    hasImportHistory: false,
    activeSelectionIncomplete: false,
  };
}

function importedPublished(users: UserUsageRow[], userAgents: UserAgentUsageRow[], endDate = "2026-09-12"): PublishedOfficialUsage {
  const acceptedAt = `${endDate}T23:00:00.000Z`;
  const startDate = "2026-08-14";
  const reportBase = {
    parserVersion: "test",
    schemaVersion: "test",
    reportingPeriod: { startDate, endDate, days: 30, provenance: "source_metadata" as const },
    sourceAsOf: endDate,
    sourceAsOfProvenance: "source_metadata" as const,
    sourceFreshness: "known" as const,
    downloadedAt: acceptedAt,
    warnings: [],
  };
  const lineage = (kind: "users" | "userAgents", rowCount: number) => ({
    kind,
    versionId: `${kind}-version`,
    fileHash: "a".repeat(64),
    parserVersion: "test",
    schemaVersion: "test",
    reportingPeriod: reportBase.reportingPeriod,
    sourceAsOf: endDate,
    sourceAsOfProvenance: "source_metadata" as const,
    sourceFreshness: "known" as const,
    downloadedAt: acceptedAt,
    acceptedAt,
    rowCount,
    warnings: [],
    reconciliation: {},
    supersedesVersionId: null,
  });
  return {
    activeRevision: 1,
    activeSet: {
      id: "set-id",
      bundleId: "bundle-id",
      reportingPeriod: { startDate, endDate, provenance: "source_metadata" },
      supersedesSetId: null,
      complete: true,
      kinds: ["users", "userAgents"],
      acceptedAt,
      deletedAt: null,
      createdAt: acceptedAt,
      expiresAt: "2027-09-12T00:00:00.000Z",
    },
    reports: {
      users: { kind: "users", ...reportBase, rows: users, lineage: lineage("users", users.length) },
      userAgents: { kind: "userAgents", ...reportBase, rows: userAgents, lineage: lineage("userAgents", userAgents.length) },
    },
    retainedCompleteSets: 1,
    retainedIncompleteSets: 0,
    hasImportHistory: true,
    activeSelectionIncomplete: false,
  };
}
