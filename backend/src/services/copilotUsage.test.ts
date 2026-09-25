import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { AppError } from "../errors.js";
import type { PublishedOfficialUsage, UserAgentUsageRow, UserUsageRow } from "../types/officialUsage.js";
import type { AuthenticatedUser } from "../types/session.js";
import { CopilotUsageService } from "./copilotUsage.js";
import { capabilities } from "./capabilities.js";
import {
  buildCopilotUsersUrl,
  buildSubscribedSkusUrl,
  CopilotUsageGraphClient,
  type CopilotDirectoryUser,
  type CopilotReportResult,
} from "./copilotUsageGraph.js";
import type { CopilotUsageSnapshotSource, DataSyncRepository, SavedCopilotUsageSource } from "../db/dataSync.js";
import { activateAccountSession, revokeAccountSessionMutations } from "../db/sessions.js";
import type { FetchLike } from "./graphPackages.js";
import { buildOfficialUsageUserView } from "./officialUsageViews.js";

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

beforeEach(() => { vi.spyOn(capabilities, "observeOperation").mockImplementation(async (_id, _user, operation) => operation(() => undefined)); });
afterEach(() => vi.restoreAllMocks());

describe("CopilotUsageService", () => {
  it("refreshes automatic directory evidence at 15 minutes and activity only at six hours", async () => {
    const harness = refreshHarness([]);
    const sources = await harness.usageStore.getUserSources();
    sources.appActivity = savedSource("app_activity", { users: [], reportRefreshDate: null });
    await harness.value.refreshUsers(user, undefined, { publication, automatic: true });
    expect(harness.graph.listCopilotUsers).not.toHaveBeenCalled();
    expect(harness.graph.listAppActivity).not.toHaveBeenCalled();
    sources.directory.observedAt = new Date(now.getTime() - 15 * 60_000 + 1).toISOString();
    await harness.value.refreshUsers(user, undefined, { publication, automatic: true });
    expect(harness.graph.listCopilotUsers).not.toHaveBeenCalled();
    sources.directory.observedAt = new Date(now.getTime() - 15 * 60_000).toISOString();
    sources.appActivity.observedAt = new Date(now.getTime() - 6 * 60 * 60_000 + 1).toISOString();
    await harness.value.refreshUsers(user, undefined, { publication, automatic: true });
    expect(harness.graph.listCopilotUsers).toHaveBeenCalledOnce();
    expect(harness.graph.listAppActivity).not.toHaveBeenCalled();
    sources.appActivity.observedAt = new Date(now.getTime() - 6 * 60 * 60_000).toISOString();
    await harness.value.refreshUsers(user, undefined, { publication, automatic: true });
    expect(harness.graph.listCopilotUsers).toHaveBeenCalledOnce();
    expect(harness.graph.listAppActivity).toHaveBeenCalledOnce();
  });

  it("collects missing automatic snapshots and backs off errors without reporting false success", async () => {
    const harness = refreshHarness();
    harness.graph.listAppActivity.mockRejectedValueOnce(new AppError(403, "missing_permission", "Report read denied."));
    expect(await harness.value.refreshUsers(user, undefined, { publication, automatic: true })).toMatchObject({ status: "partial" });
    expect(harness.graph.listCopilotUsers).toHaveBeenCalledOnce();
    expect(harness.graph.listAppActivity).toHaveBeenCalledOnce();
    expect(await harness.value.refreshUsers(user, undefined, { publication, automatic: true })).toMatchObject({ status: "partial" });
    expect(harness.graph.listAppActivity).toHaveBeenCalledOnce();
    const saved = await harness.usageStore.getUserSources();
    saved.appActivity.attemptedAt = new Date(now.getTime() - 15 * 60_000).toISOString();
    expect(await harness.value.refreshUsers(user, undefined, { publication, automatic: true })).toMatchObject({ status: "succeeded" });
    expect(harness.graph.listAppActivity).toHaveBeenCalledTimes(2);
  });

  it.each(["directory", "appActivity"] as const)(
    "retries an authentication-blocked %s subsource after sign-in without bypassing permission cooldowns", async source => {
      const harness = refreshHarness([]);
      const saved = await harness.usageStore.getUserSources();
      saved.appActivity = savedSource("app_activity", { users: [], reportRefreshDate: null });
      saved[source].attemptedAt = new Date(now.getTime() - 1000).toISOString();
      saved[source].attemptStatus = "permission_required";
      await harness.value.refreshUsers(user, undefined, { publication, automatic: true, signedInAt: now.getTime() });
      expect(harness.graph.listCopilotUsers).not.toHaveBeenCalled();
      expect(harness.graph.listAppActivity).not.toHaveBeenCalled();
      saved[source].attemptStatus = "waiting_authorization";
      await harness.value.refreshUsers(user, undefined, { publication, automatic: true });
      expect(harness.graph.listCopilotUsers).not.toHaveBeenCalled();
      expect(harness.graph.listAppActivity).not.toHaveBeenCalled();
      await harness.value.refreshUsers(user, undefined, { publication, automatic: true, signedInAt: now.getTime() });
      expect(source === "directory" ? harness.graph.listCopilotUsers : harness.graph.listAppActivity).toHaveBeenCalledOnce();
      await harness.value.refreshUsers(user, undefined, { publication, automatic: true, signedInAt: now.getTime() });
      expect(source === "directory" ? harness.graph.listCopilotUsers : harness.graph.listAppActivity).toHaveBeenCalledOnce();
    },
  );

  it("verifies active report identities during sync and moves a newly paid user out of unpaid activity", async () => {
    const published = importedPublished([
      { username: "person@example.com", displayName: "Person", numberOfAgentsUsed: 1, agentResponsesReceived: 8 },
      { username: "zero@example.com", displayName: "Zero", numberOfAgentsUsed: 0, agentResponsesReceived: 0 },
    ], [
      { username: "bridge@example.com", agentId: "agent-a", agentName: "Agent", creatorType: "Custom", responsesSentToUsers: 2 },
    ], "2026-01-01");
    const person = directoryUser("11111111-1111-4111-8111-111111111111", "person@example.com");
    person.copilotServiceState = "disabled";
    person.servicePlans = [];
    const graph = {
      listCopilotUsers: vi.fn<CopilotUsageGraphClient["listCopilotUsers"]>().mockImplementation(async () => [structuredClone(person)]),
      listAppActivity: vi.fn(async () => ({ users: [], reportRefreshDate: null })),
    };
    const usageStore = memoryUsageStore();
    const value = new CopilotUsageService({} as pg.Pool, {
      graph: graph as unknown as CopilotUsageGraphClient, usageStore, now: () => now,
      loadPublished: vi.fn(async () => published),
      requireAvailable: vi.fn(async () => ({ authorized: true })) as never,
      delegatedToken: vi.fn(async () => "directory-token") as never,
      revalidateUser: vi.fn(async () => user), requireProviderAdmissions: vi.fn(),
    });
    await value.refreshUsers(user, undefined, { publication });
    expect(graph.listCopilotUsers).toHaveBeenLastCalledWith(
      "directory-token", undefined, expect.any(Function), expect.arrayContaining(["person@example.com", "bridge@example.com"]),
    );
    expect(graph.listCopilotUsers.mock.calls[0][3]).not.toContain("zero@example.com");
    const source = async () => (await usageStore.getUserSources()).directory;
    const unpaid = async () => buildOfficialUsageUserView(published, {
      staleAfterDays: 35, licenseCohort: "active_without_paid", licenseDirectory: await source(),
    });
    expect(await unpaid()).toMatchObject({ users: { count: 1 }, licenseCoverage: { unpaidUsers: 1, unknownUsers: 1 } });
    expect((await value.users(user)).counts.licensedUsers).toBe(0);
    person.copilotServiceState = "enabled";
    person.servicePlans = directoryUser(person.identity.objectId, person.identity.userPrincipalName).servicePlans;
    await value.refreshUsers(user, undefined, { publication });
    expect(await unpaid()).toMatchObject({ users: { count: 0 }, licenseCoverage: { paidUsers: 1, unpaidUsers: 0 } });
    expect((await value.users(user)).counts.licensedUsers).toBe(1);
    expect(graph.listCopilotUsers).toHaveBeenCalledTimes(2);
    expect(usageStore.publishDirectory).toHaveBeenCalledTimes(2);
  });

  it("blocks restored provider-disabled user collection before token or Graph access", async () => {
    const graph = {
      listCopilotUsers: vi.fn(),
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
    expect(graph.listCopilotUsers).not.toHaveBeenCalled();
    expect(graph.listAppActivity).not.toHaveBeenCalled();
  });

  it("surfaces report-read failures without publishing an incomplete license-verification snapshot", async () => {
    const usageStore = memoryUsageStore([directoryUser("11111111-1111-4111-8111-111111111111", "saved@example.com")]);
    const graph = {
      listCopilotUsers: vi.fn<CopilotUsageGraphClient["listCopilotUsers"]>().mockResolvedValue([]),
      listAppActivity: vi.fn(async () => ({ users: [], reportRefreshDate: null })),
    };
    const value = new CopilotUsageService({} as pg.Pool, {
      graph: graph as unknown as CopilotUsageGraphClient, usageStore, now: () => now,
      loadPublished: vi.fn(async () => { throw new AppError(503, "report_unavailable", "Saved report unavailable."); }),
      requireAvailable: vi.fn(async () => ({ authorized: true })) as never,
      delegatedToken: vi.fn(async () => "directory-token") as never,
      revalidateUser: vi.fn(async () => user), requireProviderAdmissions: vi.fn(),
    });
    expect(await value.refreshUsers(user, undefined, { publication })).toMatchObject({ status: "partial" });
    expect(graph.listCopilotUsers).not.toHaveBeenCalled();
    expect(usageStore.publishDirectory).not.toHaveBeenCalled();
    const saved = (await usageStore.getUserSources()).directory;
    expect(saved).toMatchObject({ attemptStatus: "failed", value: [{ identity: { userPrincipalName: "saved@example.com" } }] });
    expect(saved.message).toContain("could not verify active report identities");
    expect((await value.users(user)).counts.licensedUsers).toBeNull();
  });

  it("reads saved user sources without invoking Microsoft Graph and reflects later accepted usage immediately", async () => {
    let published = emptyPublished();
    const directory = [directoryUser("11111111-1111-4111-8111-111111111111", "saved@example.com")];
    const graph = {
      listCopilotUsers: vi.fn(async () => { throw new Error("GET must not call Graph"); }),
      listAppActivity: vi.fn(async () => { throw new Error("GET must not call Graph"); }),
    } as unknown as CopilotUsageGraphClient;
    const usageStore = memoryUsageStore(directory, { users: [], reportRefreshDate: null });
    const value = new CopilotUsageService({} as pg.Pool, {
      graph,
      usageStore,
      now: () => now,
      loadPublished: vi.fn(async () => published),
    });

    const savedUser = (await value.users(user)).users[0];
    expect(savedUser.importedUsage).toBeNull();
    expect(savedUser.directory).toMatchObject({ companyName: "Contoso Health", department: "Engineering" });
    published = importedPublished(
      [{ username: "saved@example.com", displayName: "Saved", numberOfAgentsUsed: 1, agentResponsesReceived: 7 }],
      [],
    );
    expect((await value.users(user)).users[0].importedUsage).toMatchObject({ reportedResponsesReceived: 7 });
    expect(graph.listCopilotUsers).not.toHaveBeenCalled();
    expect(graph.listAppActivity).not.toHaveBeenCalled();
  });

  it("counts active paid M365 Copilot licenses separately from product-assignment candidates and basic Chat", async () => {
    const states = ["enabled", "warning", "partially_enabled", "disabled", "suspended", "locked_out", "unknown"] as const;
    const directory = states.map((state, index) => {
      const row = directoryUser(`11111111-1111-4111-8111-${String(index).padStart(12, "0")}`, `${state}@example.com`);
      row.copilotServiceState = state;
      if (state === "partially_enabled") row.servicePlans.push({
        servicePlanId: "b95945de-b3bd-46db-8437-f2beb6ea2347",
        service: "M365_COPILOT_TEAMS", displayName: "Microsoft 365 Copilot in Microsoft Teams",
        state: "disabled", capabilityStatus: "Deleted", assignedDateTime: null,
      });
      else row.servicePlans[0].state = state;
      return row;
    });
    const harness = refreshHarness(directory);
    const result = await harness.value.users(user);
    expect(result.counts).toMatchObject({
      licensedUsers: 3,
      measuredActivityUsers: null,
      needsAttentionUsers: 2,
      unknownMetricsUsers: 3,
    });
    expect(result.users).toHaveLength(7);
    expect(result.users.find(value => value.copilotServiceState === "disabled")?.attention).toContain("copilot_service_disabled");
    expect(result.users.find(value => value.copilotServiceState === "unknown")?.attention).toContain("copilot_service_unknown");
    expect(result.users.find(value => value.copilotServiceState === "partially_enabled")?.attention).toContain("copilot_service_partial");
    expect(result.users.find(value => value.copilotServiceState === "warning")?.attention).toContain("copilot_service_warning");
    expect(JSON.stringify(result.users)).not.toMatch(/skuId|skuPartNumber|assignmentStates|licenses/);
    expect(result.sources.directory.message).toContain("Checked 7 directory users from products containing paid M365 Copilot and exact active report identities");
    expect(result.sources.directory.message).toContain("not the total number of tenant accounts");
    expect(result.notices).toContain("Active M365 Copilot licensed users counts only users with at least one verified active paid feature, including usable grace-period features. Active describes paid-feature availability, not recent usage or account sign-in status.");
    expect(result.notices.some(notice => notice.includes("Basic access and usage are not measured here"))).toBe(true);
    expect(harness.graph.listCopilotUsers).not.toHaveBeenCalled();
  });

  it("excludes inactive and unverified candidates from every paid-license adoption count without discarding their reported activity", async () => {
    const directory = [
      directoryUser("11111111-1111-4111-8111-111111111111", "licensed-measured@example.com"),
      directoryUser("22222222-2222-4222-8222-222222222222", "licensed-unknown-usage@example.com"),
      directoryUser("33333333-3333-4333-8333-333333333333", "copilot-disabled-in-bundle@example.com"),
      directoryUser("44444444-4444-4444-8444-444444444444", "entitlement-unverified@example.com"),
    ];
    directory[2].copilotServiceState = directory[2].servicePlans[0].state = "disabled";
    directory[3].copilotServiceState = directory[3].servicePlans[0].state = "unknown";
    directory[3].servicePlans[0].capabilityStatus = null;
    const result = await service({
      directory,
      report: {
        users: [
          appUser("licensed-measured@example.com", "2026-09-12"),
          appUser("copilot-disabled-in-bundle@example.com", "2026-09-12"),
        ],
        reportRefreshDate: "2026-09-13",
      },
      published: importedPublished([
        { username: "licensed-measured@example.com", displayName: "Licensed", numberOfAgentsUsed: 1, agentResponsesReceived: 20 },
        { username: "copilot-disabled-in-bundle@example.com", displayName: "Bundle only", numberOfAgentsUsed: 2, agentResponsesReceived: 1_000 },
        { username: "entitlement-unverified@example.com", displayName: "Unverified", numberOfAgentsUsed: 3, agentResponsesReceived: 2_000 },
      ], []),
    }).users(user);

    expect(result.counts).toEqual({
      licensedUsers: 2,
      measuredActivityUsers: 1,
      needsAttentionUsers: 0,
      unknownMetricsUsers: 1,
      unresolvedImportedIdentities: 0,
    });
    expect(result.users).toHaveLength(4);
    expect(result.users.find(entry => entry.directory.userPrincipalName === "copilot-disabled-in-bundle@example.com"))
      .toMatchObject({
        copilotServiceState: "disabled",
        servicePlans: [expect.objectContaining({ state: "disabled", capabilityStatus: "Enabled" })],
        importedUsage: { reportedResponsesReceived: 1_000 },
        appActivity: { lastActivityDate: "2026-09-12" },
        attention: expect.arrayContaining(["copilot_service_disabled"]),
      });
  });

  it("keeps 3,993 checked E7 candidates distinct from 2,206 effectively licensed users through bulk discovery and saved reads", async () => {
    const bundleId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const plans = [
      { servicePlanId: "a62f8878-de10-42f3-b68f-6149a25ceb97", service: "M365_COPILOT_APPS" },
      { servicePlanId: "b95945de-b3bd-46db-8437-f2beb6ea2347", service: "M365_COPILOT_TEAMS" },
      { servicePlanId: "3f30311c-6b1e-48a4-ab79-725b469da960", service: "M365_COPILOT_BUSINESS_CHAT" },
    ];
    const planIds = plans.map(plan => plan.servicePlanId);
    const candidates = Array.from({ length: 3_993 }, (_, index) => ({
      id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
      userPrincipalName: `bundle-user-${index}@example.com`,
      assignedLicenses: [{ skuId: bundleId, disabledPlans: index < 2_206 ? [] : planIds }],
      assignedPlans: plans.map(plan => ({
        ...plan, capabilityStatus: "Enabled", assignedDateTime: "2026-09-12T00:00:00Z",
      })),
    }));
    const usersUrl = buildCopilotUsersUrl([bundleId]);
    const fetcher = vi.fn<FetchLike>(async input => {
      const url = new URL(String(input));
      if (url.href === buildSubscribedSkusUrl()) return Response.json({
        value: [{
          skuId: bundleId, skuPartNumber: "MICROSOFT_365_E7", appliesTo: "User",
          servicePlans: planIds.map(servicePlanId => ({ servicePlanId })),
        }],
      });
      if (url.pathname !== "/v1.0/users") throw new Error("Unexpected Graph request in the bulk entitlement regression.");
      const start = Number(url.searchParams.get("$skiptoken") ?? "0");
      const end = start + 100;
      return Response.json({
        "@odata.count": candidates.length,
        value: candidates.slice(start, end),
        ...(end < candidates.length ? { "@odata.nextLink": `${usersUrl}&$skiptoken=${end}` } : {}),
      });
    });
    const client = new CopilotUsageGraphClient(fetcher);
    const harness = refreshHarness();
    harness.graph.listCopilotUsers.mockImplementation((...args) => client.listCopilotUsers(...args));

    const refresh = await harness.value.refreshUsers(user, undefined, { publication });
    const result = await harness.value.users(user);
    expect(result.users).toHaveLength(3_993);
    expect(result.counts).toMatchObject({
      licensedUsers: 2_206,
      measuredActivityUsers: null,
      needsAttentionUsers: 0,
      unknownMetricsUsers: 2_206,
    });
    expect(result.users.find(entry => entry.directory.userPrincipalName === "bundle-user-2206@example.com"))
      .toMatchObject({
        copilotServiceState: "disabled",
        servicePlans: planIds.map(servicePlanId => expect.objectContaining({
          servicePlanId, state: "disabled", capabilityStatus: "Enabled",
        })),
      });
    expect(refresh).toMatchObject({ status: "succeeded", count: 3_993 });
    expect(refresh.message).toContain("Directory users checked: 3993. Active M365 Copilot licensed users: 2206.");
    expect(fetcher).toHaveBeenCalledTimes(41);
    await harness.value.users(user);
    expect(fetcher).toHaveBeenCalledTimes(41);
  });

  it("reports zero active licenses without hiding a checked bundle user whose Copilot is not enabled", async () => {
    const candidate = directoryUser("11111111-1111-4111-8111-111111111111", "bundle-only@example.com");
    candidate.copilotServiceState = candidate.servicePlans[0].state = "disabled";
    const harness = refreshHarness();
    harness.graph.listCopilotUsers.mockResolvedValueOnce([candidate]);
    const refresh = await harness.value.refreshUsers(user, undefined, { publication });
    const result = await harness.value.users(user);

    expect(refresh).toMatchObject({ status: "succeeded", count: 1 });
    expect(refresh.message).toContain("Directory users checked: 1. Active M365 Copilot licensed users: 0.");
    expect(result.sources.directory.state).toBe("available");
    expect(result.counts).toMatchObject({ licensedUsers: 0, needsAttentionUsers: 0, unknownMetricsUsers: 0 });
    expect(result.users).toHaveLength(1);
    expect(result.users[0].copilotServiceState).toBe("disabled");
  });

  it("withholds every current paid-license metric when a failed refresh retains mixed last-saved candidates", async () => {
    const directory = [
      directoryUser("11111111-1111-4111-8111-111111111111", "last-saved-active@example.com"),
      directoryUser("22222222-2222-4222-8222-222222222222", "last-saved-inactive@example.com"),
    ];
    directory[1].copilotServiceState = directory[1].servicePlans[0].state = "disabled";
    const harness = refreshHarness(directory);
    harness.graph.listCopilotUsers.mockRejectedValueOnce(new AppError(403, "Authorization_RequestDenied", "Access denied"));

    expect(await harness.value.refreshUsers(user, undefined, { publication })).toMatchObject({ status: "partial" });
    const result = await harness.value.users(user);
    expect(result.sources.directory.state).toBe("partial");
    expect(result.sources.directory.message).toContain("Retained saved data");
    expect(result.counts).toMatchObject({
      licensedUsers: null, measuredActivityUsers: null, needsAttentionUsers: null, unknownMetricsUsers: null,
    });
    expect(result.users).toHaveLength(2);
  });

  it("retains the prior directory snapshot when Graph changes its count on a continuation", async () => {
    const previous = directoryUser("11111111-1111-4111-8111-111111111111", "saved@example.com");
    const skuId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const row = {
      id: "22222222-2222-4222-8222-222222222222",
      userPrincipalName: "new@example.com",
      assignedLicenses: [{ skuId, disabledPlans: [] }],
      assignedPlans: previous.servicePlans,
    };
    const usersUrl = buildCopilotUsersUrl([skuId]);
    const fetcher = vi.fn<FetchLike>()
      .mockResolvedValueOnce(Response.json({
        value: [{ skuId, appliesTo: "User", servicePlans: previous.servicePlans }],
      }))
      .mockResolvedValueOnce(Response.json({
        value: [row], "@odata.count": 1, "@odata.nextLink": `${usersUrl}&$skiptoken=next`,
      }))
      .mockResolvedValueOnce(Response.json({ value: [row], "@odata.count": 2 }));
    const client = new CopilotUsageGraphClient(fetcher);
    const harness = refreshHarness([previous]);
    harness.graph.listCopilotUsers.mockImplementation((...args) => client.listCopilotUsers(...args));

    expect(await harness.value.refreshUsers(user, undefined, { publication })).toMatchObject({ status: "partial" });
    expect(harness.usageStore.publishDirectory).not.toHaveBeenCalled();
    expect(harness.usageStore.publishAppActivity).toHaveBeenCalledOnce();
    const result = await harness.value.users(user);
    expect(result.sources.directory).toMatchObject({ state: "partial", message: expect.stringContaining("invalid response") });
    expect(result.users.map(value => value.directory)).toEqual([previous.identity]);
    expect(result.counts.licensedUsers).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not include report-only activity in paid-license counts or infer basic access from an unmatched identity", async () => {
    const result = await service({
      directory: [directoryUser("11111111-1111-4111-8111-111111111111", "paid@example.com")],
      report: { users: [appUser("reported-only@example.com", "2026-09-12")], reportRefreshDate: "2026-09-13" },
      published: importedPublished([
        { username: "paid@example.com", displayName: "Paid", numberOfAgentsUsed: 0, agentResponsesReceived: 0 },
        { username: "reported-only@example.com", displayName: "Reported only", numberOfAgentsUsed: 2, agentResponsesReceived: 500 },
      ], []),
    }).users(user);
    expect(result.users).toHaveLength(1);
    expect(result.users[0].directory.userPrincipalName).toBe("paid@example.com");
    expect(result.counts).toMatchObject({ licensedUsers: 1, measuredActivityUsers: 0, unresolvedImportedIdentities: 1 });
    expect(result.users[0].appActivity).toBeNull();
    expect(result.unresolvedImportedIdentities).toEqual([expect.objectContaining({
      normalizedUserPrincipalName: "reported-only@example.com",
      reason: "no_exact_directory_match",
      importedUsage: expect.objectContaining({ reportedResponsesReceived: 500 }),
    })]);
  });

  it("starts with no retained users after a cache reset and rebuilds both sources through Users sync", async () => {
    const current = directoryUser("11111111-1111-4111-8111-111111111111", "saved@example.com");
    const harness = refreshHarness();
    const result = await harness.value.users(user);
    expect(result.sources.directory.state).toBe("unavailable");
    expect(result.snapshot?.state).toBe("not_synced");
    expect(result.counts.licensedUsers).toBeNull();
    expect(result.users).toEqual([]);
    expect(harness.graph.listCopilotUsers).not.toHaveBeenCalled();

    harness.graph.listCopilotUsers.mockResolvedValueOnce([current]);
    expect(await harness.value.refreshUsers(user, undefined, { publication, incompleteOnly: true }))
      .toMatchObject({
        status: "succeeded", count: 1,
        message: "Saved M365 Copilot feature evidence and app-activity sources. Directory users checked: 1. Active M365 Copilot licensed users: 1. All matching directory pages were verified. Checked users are not the tenant headcount or a count of basic Copilot Chat users.",
      });
    expect(harness.graph.listCopilotUsers).toHaveBeenCalledOnce();
    expect(harness.graph.listAppActivity).toHaveBeenCalledOnce();
    const refreshed = await harness.value.users(user);
    expect(refreshed.sources.directory.state).toBe("available");
    expect(refreshed.counts.licensedUsers).toBe(1);
    expect(refreshed.users[0].copilotServiceState).toBe("enabled");
  });

  it("surfaces a failed resync's permission error without reviving deleted users", async () => {
    const harness = refreshHarness();
    harness.graph.listCopilotUsers.mockRejectedValueOnce(new AppError(403, "Authorization_RequestDenied", "Access denied"));
    await harness.value.refreshUsers(user, undefined, { publication, incompleteOnly: true });
    const result = await harness.value.users(user);
    expect(result.sources.directory).toMatchObject({
      state: "unavailable", message: expect.stringContaining("User.Read.All and LicenseAssignment.Read.All"),
    });
    expect(result.counts.licensedUsers).toBeNull();
    expect(result.users).toEqual([]);
  });

  it("reports a verified zero only after a fresh successful empty Users sync", async () => {
    const harness = refreshHarness();
    const before = await harness.value.users(user);
    expect(before.sources.directory.state).toBe("unavailable");
    expect(before.counts.licensedUsers).toBeNull();
    expect(before.users).toEqual([]);
    await harness.value.refreshUsers(user, undefined, { publication, incompleteOnly: true });
    expect(harness.graph.listCopilotUsers).toHaveBeenCalledOnce();
    const after = await harness.value.users(user);
    expect(after.sources.directory.state).toBe("available");
    expect(after.counts.licensedUsers).toBe(0);
  });

  it.each(["directory", "appActivity", "both"] as const)("recollects expired snapshots on an incomplete-only retry: %s", async expired => {
    const harness = refreshHarness([directoryUser("11111111-1111-4111-8111-111111111111", "saved@example.com")]);
    const saved = await harness.usageStore.getUserSources();
    saved.appActivity = savedSource("app_activity", { users: [], reportRefreshDate: null });
    if (expired !== "appActivity") saved.directory = { ...saved.directory, value: null, observedAt: null };
    if (expired !== "directory") saved.appActivity = { ...saved.appActivity, value: null, observedAt: null };
    const preserved = expired === "directory" ? saved.appActivity : saved.directory;
    const unavailable = await harness.value.users(user);
    if (expired !== "appActivity") expect(unavailable.sources.directory).toMatchObject({
      state: "unavailable", message: expect.stringContaining("expired or is no longer available"),
    });
    if (expired !== "directory") expect(unavailable.sources.appActivity).toMatchObject({
      state: "unavailable", message: expect.stringContaining("expired or is no longer available"),
    });

    expect(await harness.value.refreshUsers(user, undefined, { publication, incompleteOnly: true }))
      .toMatchObject({ status: "succeeded", count: expired === "appActivity" ? 1 : 0 });
    expect(harness.graph.listCopilotUsers).toHaveBeenCalledTimes(expired === "appActivity" ? 0 : 1);
    expect(harness.graph.listAppActivity).toHaveBeenCalledTimes(expired === "directory" ? 0 : 1);
    expect(saved.directory.value).not.toBeNull();
    expect(saved.appActivity.value).not.toBeNull();
    if (expired === "directory") expect(saved.appActivity).toBe(preserved);
    if (expired === "appActivity") expect(saved.directory).toBe(preserved);

    harness.graph.listCopilotUsers.mockClear();
    harness.graph.listAppActivity.mockClear();
    expect(await harness.value.refreshUsers(user, undefined, { publication, incompleteOnly: true }))
      .toMatchObject({ status: "succeeded" });
    expect(harness.graph.listCopilotUsers).not.toHaveBeenCalled();
    expect(harness.graph.listAppActivity).not.toHaveBeenCalled();
  });

  it.each([null, "Engineering"])("preserves nullable organization attributes from a current service snapshot: %s", async department => {
    const savedUser = directoryUser("11111111-1111-4111-8111-111111111111", "saved@example.com");
    savedUser.identity.companyName = null;
    savedUser.identity.department = department;
    const harness = refreshHarness([savedUser]);
    const result = await harness.value.users(user);
    expect(result.counts.licensedUsers).toBe(1);
    expect(result.users).toHaveLength(1);
    expect(result.users[0].directory).toEqual(savedUser.identity);
    expect(result.users[0].copilotServiceState).toEqual(savedUser.copilotServiceState);
    expect(result.users[0].servicePlans).toEqual(savedUser.servicePlans);
    expect(harness.graph.listCopilotUsers).not.toHaveBeenCalled();
    expect(harness.graph.listAppActivity).not.toHaveBeenCalled();
  });

  it("publishes and reads licensed organization metadata unchanged through the saved directory snapshot", async () => {
    const directory = [directoryUser("11111111-1111-4111-8111-111111111111", "saved@example.com")];
    const graph = {
      listCopilotUsers: vi.fn(async () => directory),
      listAppActivity: vi.fn(async () => ({ users: [], reportRefreshDate: null })),
    } as unknown as CopilotUsageGraphClient;
    const usageStore = memoryUsageStore();
    const value = new CopilotUsageService({} as pg.Pool, {
      graph,
      usageStore,
      now: () => now,
      requireAvailable: vi.fn(async () => ({ authorized: true })) as never,
      delegatedToken: vi.fn(async () => "directory-token") as never,
      revalidateUser: vi.fn(async () => user),
      requireProviderAdmissions: vi.fn(),
      loadPublished: vi.fn(async () => emptyPublished()),
    });
    await value.refreshUsers(user, undefined, { publication });
    expect(usageStore.publishDirectory).toHaveBeenCalledWith(
      { tenantId: user.tenantId, principalId: user.homeAccountId },
      [expect.objectContaining({ identity: expect.objectContaining({ companyName: "Contoso Health", department: "Engineering" }) })],
      now.toISOString(), expect.any(String), publication,
    );
    expect((await value.users(user)).users[0].directory).toEqual(directory[0].identity);
    expect(graph.listCopilotUsers).toHaveBeenCalledOnce();
  });

  it("forwards awaited count-only directory progress before publishing the completed snapshot", async () => {
    const harness = refreshHarness();
    const directory = [
      directoryUser("11111111-1111-4111-8111-111111111111", "one@example.com"),
      directoryUser("22222222-2222-4222-8222-222222222222", "two@example.com"),
    ];
    const progress = vi.fn(async (_count: number) => {
      expect(harness.usageStore.publishDirectory).not.toHaveBeenCalled();
    });
    harness.graph.listCopilotUsers.mockImplementationOnce(async (_token, _signal, onProgress) => {
      await onProgress?.(1);
      await onProgress?.(2);
      return directory;
    });
    const signal = new AbortController().signal;
    expect(await harness.value.refreshUsers(user, signal, { publication, onDirectoryProgress: progress }))
      .toMatchObject({ status: "succeeded", count: 2 });
    expect(harness.graph.listCopilotUsers).toHaveBeenCalledWith("directory-token", signal, expect.any(Function), []);
    expect(progress.mock.calls).toEqual([[1], [2]]);
    expect(harness.usageStore.publishDirectory).toHaveBeenCalledOnce();
  });

  it.each([null, 2])("keeps saved Users data but reports only current-attempt observations after a directory failure: %s", async observedCount => {
    const saved = [
      directoryUser("11111111-1111-4111-8111-111111111111", "saved@example.com"),
      directoryUser("22222222-2222-4222-8222-222222222222", "saved-two@example.com"),
      directoryUser("33333333-3333-4333-8333-333333333333", "saved-three@example.com"),
    ];
    const harness = refreshHarness(saved);
    harness.graph.listCopilotUsers.mockImplementationOnce(async (_token, _signal, onProgress) => {
      if (observedCount !== null) await onProgress?.(observedCount);
      throw new AppError(502, "provider_error", "Directory page unavailable.");
    });
    expect(await harness.value.refreshUsers(user, undefined, { publication })).toMatchObject({
      status: "partial", count: observedCount,
    });
    expect((await harness.usageStore.getUserSources()).directory).toMatchObject({
      attemptStatus: "failed", rowCount: 3, value: saved,
    });
    expect(harness.usageStore.publishDirectory).not.toHaveBeenCalled();
  });

  it("does not count preserved directory data as observed by an app-activity-only retry", async () => {
    const harness = refreshHarness([directoryUser("11111111-1111-4111-8111-111111111111", "saved@example.com")]);
    harness.graph.listAppActivity.mockRejectedValueOnce(new AppError(403, "missing_permission", "Reports permission unavailable."));
    const progress = vi.fn();
    expect(await harness.value.refreshUsers(user, undefined, { publication, incompleteOnly: true, onDirectoryProgress: progress }))
      .toMatchObject({ status: "partial", count: null });
    expect(harness.graph.listCopilotUsers).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
    expect(await harness.value.refreshUsers(user, undefined, { publication, incompleteOnly: true }))
      .toMatchObject({ status: "succeeded", count: 1 });
  });

  it.each([
    new Error("Progress persistence unavailable."),
    new AppError(409, "data_sync_publication_superseded", "Attempt ownership changed."),
  ])("surfaces progress callback errors rather than swallowing them as provider failures: %s", async error => {
    const harness = refreshHarness();
    harness.graph.listCopilotUsers.mockImplementationOnce(async (_token, _signal, onProgress) => {
      await onProgress?.(1);
      return [];
    });
    await expect(harness.value.refreshUsers(user, undefined, {
      publication, onDirectoryProgress: async () => { throw error; },
    })).rejects.toBe(error);
    expect(harness.usageStore.publishDirectory).not.toHaveBeenCalled();
    expect(harness.usageStore.recordUserSourceFailure.mock.calls.some(call => call[1] === "directory")).toBe(false);
  });

  it.each(["directory", "app_activity"] as const)("joins the other source before surfacing an unexpected %s failure", async failedSource => {
    const harness = refreshHarness();
    const pending = Promise.withResolvers<void>();
    const failure = new Error("Source processing failed.");
    const fail = vi.fn(async () => { throw failure; });
    if (failedSource === "directory") {
      harness.graph.listCopilotUsers.mockImplementationOnce(fail);
      harness.graph.listAppActivity.mockImplementationOnce(async () => {
        await pending.promise;
        return { users: [], reportRefreshDate: null };
      });
    } else {
      harness.graph.listAppActivity.mockImplementationOnce(fail);
      harness.graph.listCopilotUsers.mockImplementationOnce(async () => {
        await pending.promise;
        return [];
      });
    }
    let finished = false;
    const refresh = harness.value.refreshUsers(user, undefined, { publication })
      .catch(error => error).finally(() => { finished = true; });
    try {
      await vi.waitFor(() => expect(fail).toHaveBeenCalledOnce());
      expect(finished).toBe(false);
    } finally {
      pending.resolve();
      expect(await refresh).toBe(failure);
    }
    expect(failedSource === "directory" ? harness.usageStore.publishAppActivity : harness.usageStore.publishDirectory)
      .toHaveBeenCalledOnce();
  });

  it.each(["revalidation", "capability", "token", "publication-revalidation", "publication-capability"] as const)(
    "stops after cancellation during %s without acquiring another token or publishing", async boundary => {
      const harness = refreshHarness([]);
      const controller = new AbortController();
      const failure = new Error("User collection cancelled.");
      const cancel = () => controller.abort(failure);
      if (boundary === "revalidation") harness.revalidateUser.mockImplementationOnce(async () => { cancel(); return user; });
      if (boundary === "capability") harness.requireAvailable.mockImplementationOnce(async () => { cancel(); return { authorized: true }; });
      if (boundary === "token") harness.delegatedToken.mockImplementationOnce(async () => { cancel(); return "late-token"; });
      if (boundary === "publication-revalidation") harness.revalidateUser
        .mockResolvedValueOnce(user).mockImplementationOnce(async () => { cancel(); return user; });
      if (boundary === "publication-capability") harness.requireAvailable
        .mockResolvedValueOnce({ authorized: true }).mockImplementationOnce(async () => { cancel(); return { authorized: true }; });

      await expect(harness.value.refreshUsers(user, controller.signal, { publication, incompleteOnly: true })).rejects.toBe(failure);
      expect(harness.delegatedToken).toHaveBeenCalledTimes(["revalidation", "capability"].includes(boundary) ? 0 : 1);
      expect(harness.graph.listAppActivity).toHaveBeenCalledTimes(boundary.startsWith("publication-") ? 1 : 0);
      expect(harness.requireAvailable).toHaveBeenCalledTimes(boundary === "revalidation" ? 0 : boundary === "publication-capability" ? 2 : 1);
      expect(harness.usageStore.publishAppActivity).not.toHaveBeenCalled();
      expect(harness.usageStore.recordUserSourceFailure).not.toHaveBeenCalled();
    },
  );

  it.each((["directory", "app_activity"] as const).flatMap(source =>
    (["capability", "token", "provider", "publication-capability"] as const).map(boundary => ({ source, boundary })),
  ))(
    "fences a revoked session across $source $boundary even without an abort signal", async ({ source, boundary }) => {
      const harness = refreshHarness(source === "app_activity" ? [] : undefined);
      if (source === "directory") {
        (await harness.usageStore.getUserSources()).appActivity = savedSource("app_activity", { users: [], reportRefreshDate: null });
      }
      let revocation: Promise<void> | undefined;
      const revoke = () => { revocation = revokeAccountSessionMutations(user.tenantId!, user.homeAccountId, async () => undefined); };
      if (boundary === "capability") harness.requireAvailable.mockImplementationOnce(async () => { revoke(); return { authorized: true }; });
      if (boundary === "token") harness.delegatedToken.mockImplementationOnce(async () => { revoke(); return "late-token"; });
      const changeSession = async () => {
        revoke();
        await revocation;
        await activateAccountSession(user.tenantId!, user.homeAccountId, async () => undefined);
      };
      if (boundary === "provider" && source === "app_activity") harness.graph.listAppActivity.mockImplementationOnce(async () => {
        await changeSession();
        return { users: [], reportRefreshDate: null };
      });
      if (boundary === "provider" && source === "directory") harness.graph.listCopilotUsers.mockImplementationOnce(async () => {
        await changeSession();
        return [];
      });
      if (boundary === "publication-capability") harness.requireAvailable
        .mockResolvedValueOnce({ authorized: true }).mockImplementationOnce(async () => { revoke(); return { authorized: true }; });
      try {
        await expect(harness.value.refreshUsers(user, undefined, { publication, incompleteOnly: true }))
          .rejects.toMatchObject({ status: 401 });
        expect(harness.delegatedToken).toHaveBeenCalledTimes(boundary === "capability" ? 0 : 1);
        expect(source === "directory" ? harness.graph.listCopilotUsers : harness.graph.listAppActivity)
          .toHaveBeenCalledTimes(["capability", "token"].includes(boundary) ? 0 : 1);
        expect(harness.usageStore.publishDirectory).not.toHaveBeenCalled();
        expect(harness.usageStore.publishAppActivity).not.toHaveBeenCalled();
        expect(harness.usageStore.recordUserSourceFailure).not.toHaveBeenCalled();
      } finally {
        await revocation;
        await activateAccountSession(user.tenantId!, user.homeAccountId, async () => undefined);
      }
    },
  );

  it("honors cancellation during an awaited progress callback before directory publication", async () => {
    const harness = refreshHarness();
    const controller = new AbortController();
    const error = new Error("User collection cancelled.");
    harness.graph.listCopilotUsers.mockImplementationOnce(async (_token, _signal, onProgress) => {
      await onProgress?.(1);
      return [];
    });
    await expect(harness.value.refreshUsers(user, controller.signal, {
      publication,
      onDirectoryProgress: async () => {
        await Promise.resolve();
        controller.abort(error);
      },
    })).rejects.toBe(error);
    expect(harness.usageStore.publishDirectory).not.toHaveBeenCalled();
    expect(harness.usageStore.recordUserSourceFailure).not.toHaveBeenCalled();
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

  it("retains all 30,001 paid-license accounts in the saved API response when only ten have imported usage", async () => {
    const directory = Array.from({ length: 30_001 }, (_, index) => directoryUser(
      `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`, `person${index}@example.com`,
    ));
    const result = await service({
      directory, report: { users: [], reportRefreshDate: null },
      published: importedPublished(directory.slice(0, 10).map(entry => ({
        username: entry.identity.userPrincipalName, displayName: "Reported",
        numberOfAgentsUsed: 1, agentResponsesReceived: 2,
      })), []),
    }).users(user);
    expect(result.users).toHaveLength(30_001);
    expect(result.counts.licensedUsers).toBe(30_001);
    expect(result.users.filter(entry => entry.importedUsage !== null)).toHaveLength(10);
    expect(result.users.filter(entry => entry.importedUsage === null)).toHaveLength(29_991);
    expect(result.sources.directory.message).toContain("30001");
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

  it.each(["report", "directory"] as const)("does not join another alias of a %s-ambiguous identity", async ambiguity => {
    const person = directoryUser("11111111-1111-4111-8111-111111111111", "person@example.com");
    const duplicate = directoryUser("22222222-2222-4222-8222-222222222222", "PERSON@example.com");
    const control = directoryUser("33333333-3333-4333-8333-333333333333", "control@example.com");
    const directory = ambiguity === "directory" ? [person, duplicate, control] : [person, control];
    const importedIdentities = [
      person.identity.userPrincipalName,
      ambiguity === "directory" ? duplicate.identity.objectId : duplicate.identity.userPrincipalName,
      person.identity.objectId,
      control.identity.userPrincipalName,
    ];
    const appIdentities = importedIdentities.map(identity => identity.toLowerCase());
    for (const reverse of [false, true]) {
      const result = await service({
        directory: reverse ? [...directory].reverse() : directory,
        report: {
          users: (reverse ? [...appIdentities].reverse() : appIdentities).map(identity => appUser(identity, "2026-09-12")),
          reportRefreshDate: "2026-09-13",
        },
        published: importedPublished(
          (reverse ? [...importedIdentities].reverse() : importedIdentities).map(username => ({
            username, displayName: username, numberOfAgentsUsed: 1, agentResponsesReceived: 9,
          })),
          [],
        ),
      }).users(user);

      const conflicted = result.users.filter(row => row.directory.objectId !== control.identity.objectId);
      expect(conflicted.every(row => row.importedUsage === null && row.appActivity === null)).toBe(true);
      expect(conflicted.every(row => row.attention.includes("agent_usage_unknown") && row.attention.includes("app_activity_unknown"))).toBe(true);
      expect(result.users.find(row => row.directory.objectId === control.identity.objectId)).toMatchObject({
        importedUsage: { username: "control@example.com" },
        appActivity: { lastActivityDate: "2026-09-12" },
      });
      expect(result.unresolvedImportedIdentities).toHaveLength(3);
      expect(result.unresolvedImportedIdentities.every(row => row.reason === "ambiguous_directory_match")).toBe(true);
      expect(result.counts.measuredActivityUsers).toBe(1);
      expect(result.sources.appActivity.state).toBe("partial");
    }
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
    const observations = vi.mocked(capabilities.observeOperation);
    const index = observations.mock.calls.findIndex(([id]) => id === "graph.licenses.read");
    expect(observations.mock.calls.filter(([id]) => id === "graph.licenses.read")).toHaveLength(1);
    expect(observations.mock.calls[index][1]).toMatchObject({ tenantId: user.tenantId, homeAccountId: user.homeAccountId });
    await expect(observations.mock.results[index].value).rejects.toMatchObject({ code: "Authorization_RequestDenied" });
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
    const observations = vi.mocked(capabilities.observeOperation);
    const index = observations.mock.calls.findIndex(([id]) => id === "reports.copilotUsage.read");
    expect(observations.mock.calls.filter(([id]) => id === "reports.copilotUsage.read")).toHaveLength(1);
    await expect(observations.mock.results[index].value).rejects.toMatchObject({ code: "Forbidden" });
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

  it.each([false, true])("ages saved app activity on reads independently of fresh imported usage: %s", async withImport => {
    const directory = [
      directoryUser("11111111-1111-4111-8111-111111111111", "active@example.com"),
      directoryUser("22222222-2222-4222-8222-222222222222", "inactive@example.com"),
    ];
    const report = {
      users: [appUser("active@example.com", "2026-09-12"), appUser("inactive@example.com", "2026-07-01")],
      reportRefreshDate: "2026-09-13",
    };
    let readAt = now;
    const harness = refreshHarness(directory);
    const value = new CopilotUsageService({} as pg.Pool, {
      usageStore: memoryUsageStore(directory, report),
      graph: harness.graph as unknown as CopilotUsageGraphClient,
      now: () => readAt,
      loadPublished: vi.fn(async () => withImport ? importedPublished([
        { username: "inactive@example.com", displayName: "Imported", numberOfAgentsUsed: 1, agentResponsesReceived: 10 },
      ], []) : emptyPublished()),
    });

    const fresh = await value.users(user);
    expect(fresh.sources.appActivity.state).toBe("available");
    expect(fresh.counts.measuredActivityUsers).toBe(withImport ? 2 : 1);
    expect(fresh.counts.needsAttentionUsers).toBe(1);
    readAt = new Date("2026-09-17T23:59:59.998Z");
    expect((await value.users(user)).sources.appActivity.state).toBe("available");
    readAt = new Date("2026-09-17T23:59:59.999Z");
    const stale = await value.users(user);
    expect(stale.generatedAt).toBe(readAt.toISOString());
    expect(stale.sources.appActivity).toMatchObject({
      state: "stale", fetchedAt: now.toISOString(), reportRefreshDate: report.reportRefreshDate,
    });
    expect(stale.snapshot).toEqual(fresh.snapshot);
    expect(stale.users.map(row => row.appActivity)).toEqual(fresh.users.map(row => row.appActivity));
    expect(stale.users.every(row => row.attention.includes("app_activity_unknown"))).toBe(true);
    expect(stale.users.every(row => !row.attention.includes("app_activity_inactive"))).toBe(true);
    expect(stale.counts).toMatchObject({
      licensedUsers: 2, measuredActivityUsers: withImport ? 1 : null, needsAttentionUsers: 0, unknownMetricsUsers: 2,
    });
    if (withImport) expect(stale.sources.importedAgentUsage.state).toBe("available");
    expect(harness.graph.listCopilotUsers).not.toHaveBeenCalled();
    expect(harness.graph.listAppActivity).not.toHaveBeenCalled();
  });

  it("preserves stale app-report labeling when the latest refresh failed", async () => {
    const harness = refreshHarness([directoryUser("11111111-1111-4111-8111-111111111111", "saved@example.com")]);
    const saved = await harness.usageStore.getUserSources();
    const report = appUser("saved@example.com", "2026-07-01");
    report.activity.reportRefreshDate = "2026-08-01";
    saved.appActivity = {
      ...savedSource("app_activity", { users: [report], reportRefreshDate: "2026-08-01" }),
      attemptStatus: "failed",
      message: "The latest app refresh failed.",
    };
    const result = await harness.value.users(user);
    expect(result.sources.appActivity).toMatchObject({
      state: "stale",
      message: expect.stringContaining("The latest app refresh failed."),
    });
    expect(result.sources.appActivity.message).toContain("older than 3 days");
    expect(result.users[0].attention).toContain("app_activity_unknown");
    expect(result.counts.measuredActivityUsers).toBeNull();
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
    listCopilotUsers: vi.fn(async () => {
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

function refreshHarness(directory?: CopilotDirectoryUser[]) {
  const usageStore = memoryUsageStore(directory);
  const graph = {
    listCopilotUsers: vi.fn<CopilotUsageGraphClient["listCopilotUsers"]>().mockResolvedValue([]),
    listAppActivity: vi.fn<CopilotUsageGraphClient["listAppActivity"]>().mockResolvedValue({ users: [], reportRefreshDate: null }),
  };
  const requireAvailable = vi.fn(async () => ({ authorized: true }));
  const delegatedToken = vi.fn(async () => "directory-token");
  const revalidateUser = vi.fn(async () => user);
  const value = new CopilotUsageService({} as pg.Pool, {
    graph: graph as unknown as CopilotUsageGraphClient,
    usageStore,
    now: () => now,
    requireAvailable: requireAvailable as never,
    delegatedToken: delegatedToken as never,
    revalidateUser,
    requireProviderAdmissions: vi.fn(),
    loadPublished: vi.fn(async () => emptyPublished()),
  });
  return { value, usageStore, graph, requireAvailable, delegatedToken, revalidateUser };
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
    publishDirectory: vi.fn<DataSyncRepository["publishDirectory"]>(async (_scope, value, observedAt, message) => {
      sources.directory = savedSource("directory", JSON.parse(JSON.stringify(value)) as CopilotDirectoryUser[], observedAt, message);
      return "11111111-1111-4111-8111-111111111111";
    }),
    publishAppActivity: vi.fn<DataSyncRepository["publishAppActivity"]>(async (_scope, value, observedAt, message) => {
      sources.appActivity = savedSource("app_activity", value, observedAt, message);
      return "22222222-2222-4222-8222-222222222222";
    }),
    recordUserSourceFailure: vi.fn<DataSyncRepository["recordUserSourceFailure"]>(async (
      _scope,
      sourceId,
      status,
      message,
      attemptedAt,
    ) => {
      const failure = { attemptStatus: status, message, attemptedAt };
      if (sourceId === "directory") sources.directory = { ...sources.directory, ...failure };
      else sources.appActivity = { ...sources.appActivity, ...failure };
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
    serviceEvidenceVersion: 1,
    identity: { objectId, userPrincipalName, displayName, accountEnabled: true, userType: "Member", employeeType: "Employee", companyName: "Contoso Health", department: "Engineering" },
    copilotServiceState: "enabled",
    servicePlans: [{
      servicePlanId: "a62f8878-de10-42f3-b68f-6149a25ceb97",
      service: "M365_COPILOT_APPS",
      displayName: "Microsoft 365 Copilot in Productivity Apps",
      state: "enabled",
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
