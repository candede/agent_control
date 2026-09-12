import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { testDatabase, fixturePassword } from "./testDatabase.js";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { pool } from "../src/db/pool.js";
import { CapabilityRepository, capabilityContractRevision, capabilityPermissionRevision } from "../src/db/capabilities.js";
import { capabilityDefinitions } from "../src/services/capabilityRegistry.js";
import { capabilities } from "../src/services/capabilities.js";
import { GraphPackagesClient } from "../src/services/graphPackages.js";
import { DirectoryPrincipalsClient } from "../src/services/directoryPrincipals.js";
import { appRoles, type CapabilityStatus } from "../src/types/capability.js";
import { AppError } from "../src/errors.js";
import { OfficialUsageRepository } from "../src/db/officialUsage.js";
import { PowerPlatformInventoryRepository } from "../src/db/powerPlatformInventory.js";
import { buildOfficialUsageAggregateView, buildOfficialUsageUserView } from "../src/services/officialUsageViews.js";
import { CopilotStudioQuarantineClient } from "../src/services/copilotStudioQuarantine.js";
import { PowerPlatformResourceQueryClient } from "../src/services/powerPlatformResourceQuery.js";
import type { AuthenticatedUser } from "../src/types/session.js";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.TENANT_ID = "11111111-1111-1111-1111-111111111111";
  process.env.CLIENT_ID = "22222222-2222-2222-2222-222222222222";
  process.env.CLIENT_SECRET = "synthetic-browser-client-secret";
  process.env.SESSION_SECRET = "synthetic-browser-session-secret-0001";
  process.env.FRONTEND_ORIGIN = "http://localhost:3001";
  process.env.REDIRECT_URI = "http://localhost:3001/api/auth/callback";
});
const identity = vi.hoisted(() => ({ scenarios: new Map<string, string>() }));
vi.mock("../src/auth/msal.js", async original => {
  const actual = await original<typeof import("../src/auth/msal.js")>();
  return {
    ...actual,
    createAuthorizationUrl: async (flow: ReturnType<typeof actual.createAuthFlow>) => {
      const scenario = new URL(flow.returnTo, "http://localhost:3001").searchParams.get("fixture") ?? "available";
      identity.scenarios.set(flow.state, scenario);
      return flow.kind === "consent" ? `/api/auth/callback?state=${flow.state}&error=access_denied&error_description=never-render-provider-text`
        : `/api/auth/callback?state=${flow.state}&code=${flow.state}`;
    },
    redeemAuthorizationCode: async (code: string) => ({ scenario: identity.scenarios.get(code) }),
    toAuthenticatedUser: (result: { scenario: string }) => {
      const roles = result.scenario === "missing_internal_role" ? [] : result.scenario.startsWith("role-") ? appRoles.filter(role => role.endsWith(`.${result.scenario.slice(5)}`)) : [...appRoles];
      return { tenantId: "11111111-1111-1111-1111-111111111111", homeAccountId: `fixture-${result.scenario}`, displayName: "Synthetic account", username: "fixture@example.invalid", roles,
        providerRoleIds: ["d2562ede-74db-457e-a7b6-544e236ebb61"] };
    },
    acquireDelegatedToken: async (accountId: string) => {
      if (accountId === "fixture-missing_permission" || accountId === "fixture-missing_delegated_grant") throw new AppError(403, "missing_permission", "Synthetic missing permission");
      return accountId;
    },
    acquireApplicationToken: async () => "fixture-application",
    revalidateAuthenticatedUser: async (accountId: string) => {
      const scenario = accountId.replace(/^fixture-/, "");
      const roles = scenario === "missing_internal_role" ? [] : scenario.startsWith("role-") ? appRoles.filter(role => role.endsWith(`.${scenario.slice(5)}`)) : [...appRoles];
      return { tenantId: "11111111-1111-1111-1111-111111111111", homeAccountId: accountId, displayName: "Synthetic account", username: "fixture@example.invalid", roles,
        providerRoleIds: ["d2562ede-74db-457e-a7b6-544e236ebb61"] };
    },
    evictAccount: async () => undefined,
  };
});

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let application: ReturnType<typeof createApp>;
let server: Server;
const statuses: CapabilityStatus[] = ["available", "missing_permission", "missing_internal_role", "missing_role", "missing_license", "not_configured", "unsupported", "preview_disabled", "provider_error", "unknown"];
const quarantineEnvironmentId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const qualifiedQuarantineBotId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const unqualifiedQuarantineBotId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const quarantineProviderFixture = { reads: 0, writes: 0, states: new Map<string, boolean>(), updatedAt: new Map<string, string>() };
beforeAll(async () => {
  if (process.env.AGENT_CONTROL_FIXTURE_MODE !== "browser" || process.env.NODE_ENV !== "test") throw new Error("This fixture requires its disposable Docker test entry point.");
  fixture = await testDatabase();
  pool.options.database = fixture.name; pool.options.user = "agentcontrol_app"; pool.options.password = fixturePassword;
  const repository = new CapabilityRepository(fixture.runtime);
  const applicationDefinition = capabilityDefinitions.find(definition => definition.id === "graph.package.read.application")!;
  await repository.setApplicationConfiguration(config.tenantId!, applicationDefinition.id, true, true, "fixture-administrator");
  const invalidatePrincipal = capabilities.invalidatePrincipal.bind(capabilities);
  vi.spyOn(capabilities, "invalidatePrincipal").mockImplementation(async (user: AuthenticatedUser) => {
    await invalidatePrincipal(user);
    const scenario = user.homeAccountId.replace(/^fixture-/, "");
    if (![...statuses, "stale", "role-Viewer", "role-Admin"].includes(scenario)) return;
    for (const definition of capabilityDefinitions.filter(definition => definition.probe.kind === "provider_read")) {
      const configuration = await repository.configuration(config.tenantId!, definition.id);
      await repository.recordEvidence({ tenantId: config.tenantId!, principalId: definition.mode === "application" ? config.clientId! : user.homeAccountId,
        authorizationPrincipalId: user.homeAccountId, capabilityId: definition.id, resourceAudience: definition.audience, environmentId: definition.cloud,
        tokenMode: definition.mode as "delegated" | "application", permissionRevision: capabilityPermissionRevision(definition), contractRevision: capabilityContractRevision(definition), configurationRevision: configuration.revision,
      }, statuses.includes(scenario as CapabilityStatus) ? scenario as CapabilityStatus : "available", {
        category: scenario === "provider_error" ? "provider_error" : undefined,
        verification: definition.id === "powerPlatform.quarantine.read" ? "token" : "provider",
      }, scenario === "stale" ? -1000 : 240000);
    }
  });
  vi.spyOn(GraphPackagesClient.prototype, "checkCatalogAccess").mockImplementation(async token => {
    if (token === "fixture-provider_error") throw new AppError(502, "provider_error", "Synthetic provider outage");
  });
  vi.spyOn(GraphPackagesClient.prototype, "listCopilotAgents").mockImplementation(async token => {
    if (token === "fixture-provider_error") throw new AppError(502, "provider_error", "Synthetic provider outage");
    return [{ id: "synthetic-package", displayName: "Synthetic package", isBlocked: false, sourceSystem: "graph_packages", authoringTool: null, creatorType: "unknown", agentKind: "copilot_package", lifecycle: "unknown", identityConfidence: "exact_native", provenance: {} }];
  });
  vi.spyOn(GraphPackagesClient.prototype, "getPackageDetails").mockResolvedValue({ id: "synthetic-package", displayName: "Synthetic package", isBlocked: false, availableTo: "none", deployedTo: "none", allowedUsersAndGroups: [], acquireUsersAndGroups: [], sourceSystem: "graph_packages", authoringTool: null, creatorType: "unknown", agentKind: "copilot_package", lifecycle: "unknown", identityConfidence: "exact_native", provenance: {} });
  vi.spyOn(DirectoryPrincipalsClient.prototype, "search").mockResolvedValue([]);
  vi.spyOn(PowerPlatformResourceQueryClient.prototype, "checkAccess").mockResolvedValue(undefined);
  await seedQuarantineTargets(repository);
  vi.spyOn(CopilotStudioQuarantineClient.prototype, "getStatus").mockImplementation(async (_token, target, options) => {
    quarantineProviderFixture.reads += 1;
    return { ...target, isBotQuarantined: quarantineProviderFixture.states.get(target.botId) ?? false,
      lastUpdateTimeUtc: quarantineProviderFixture.updatedAt.get(target.botId) ?? "2026-09-09T10:00:00.123Z", observedAt: new Date().toISOString(), correlationId: options?.correlationId ?? randomUUID() };
  });
  vi.spyOn(CopilotStudioQuarantineClient.prototype, "setQuarantine").mockImplementation(async (_token, target, requestedState, options) => {
    quarantineProviderFixture.writes += 1;
    quarantineProviderFixture.states.set(target.botId, requestedState);
    quarantineProviderFixture.updatedAt.set(target.botId, "2026-09-10T10:00:00.456Z");
    return { ...target, isBotQuarantined: requestedState, lastUpdateTimeUtc: "2026-09-10T10:00:00.456Z", observedAt: new Date().toISOString(), correlationId: options.correlationId };
  });
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Live provider requests are forbidden in browser fixtures.");
    return realFetch(input, init);
  });
  application = createApp(fixture.runtime, resolve("../frontend/dist"));
  await new Promise<void>(done => { server = application.app.listen(3001, "0.0.0.0", done); });
  console.log(JSON.stringify({ event: "isolated_browser_fixture", origin: "http://localhost:3001", database: fixture.name, liveProviders: false }));
});
afterAll(async () => {
  application?.store.close();
  if (server) await new Promise<void>(done => server.close(() => done()));
  await pool.end(); await fixture?.close();
  vi.unstubAllGlobals();
});
it("qualifies the packaged Permission Center through Chromium and axe", async () => {
  const exitCode = await new Promise<number | null>((done, reject) => {
    const child = spawn(process.execPath, ["../node_modules/@playwright/test/cli.js", "test", "--config", "../frontend/playwright.config.ts"], { stdio: "inherit", env: process.env });
    child.once("error", reject); child.once("exit", done);
  });
  expect(exitCode).toBe(0);
  const repository = new OfficialUsageRepository(fixture.runtime);
  const viewOptions = { staleAfterDays: config.officialUsageStaleDays, now: new Date("2026-09-08T12:00:00.000Z") };
  const beforeRestart = await officialUsageFingerprint(repository, viewOptions);

  application.store.close();
  await new Promise<void>(done => server.close(() => done()));
  application = createApp(fixture.runtime, resolve("../frontend/dist"));
  await new Promise<void>(done => { server = application.app.listen(3001, "0.0.0.0", done); });

  const afterRestart = await officialUsageFingerprint(new OfficialUsageRepository(fixture.runtime), viewOptions);
  expect(afterRestart).toEqual(beforeRestart);
  expect(afterRestart.activeSetId).not.toBeNull();
  expect(afterRestart.lineage).toHaveLength(3);
  expect(afterRestart.aggregate).toMatchObject({ responses: 9, activeUsers: 1 });
  expect(afterRestart.users).toMatchObject({ count: 1, responses: 9 });
  expect((await fixture.operator.query("SELECT count(*)::int AS count FROM jobs")).rows[0].count).toBe(0);
  expect(quarantineProviderFixture.writes).toBe(1);
  expect((await fixture.operator.query("SELECT status,count(*)::int AS count FROM copilot_quarantine_jobs GROUP BY status")).rows).toEqual(expect.arrayContaining([
    { status: "succeeded", count: 1 },
  ]));
});

async function seedQuarantineTargets(capabilityRepository: CapabilityRepository) {
  const scope = { tenantId: config.tenantId!, principalId: "fixture-role-Admin" };
  const inventory = new PowerPlatformInventoryRepository(fixture.runtime);
  const job = await inventory.submit(scope, { idempotencyKey: "browser-quarantine-targets", roleScope: "full", requestedTypes: ["microsoft.copilotstudio/agents"] });
  expect(await inventory.markRunning(scope, job.id)).toBe(true);
  const targets = [
    { nativeId: "browser-qualified-agent", displayName: "Qualified browser agent", botId: qualifiedQuarantineBotId },
    { nativeId: "browser-unqualified-agent", displayName: "Unqualified browser agent", botId: unqualifiedQuarantineBotId },
  ];
  const published = await inventory.publish(scope, job.id, { resources: targets.map(target => ({
    tenantId: scope.tenantId, nativeId: target.nativeId, type: "microsoft.copilotstudio/agents" as const, location: null, displayName: target.displayName,
    environmentId: quarantineEnvironmentId, createdAt: null, createdBy: null, lastPublishedAt: "2026-09-09T09:00:00.000Z", sourceSystem: "power_platform" as const,
    authoringTool: "Copilot Studio", creatorType: "unknown" as const, agentKind: "copilot_studio_agent", lifecycle: "published" as const,
    identityConfidence: "exact_native" as const, identifiers: [{ kind: "power_platform_resource_id" as const, value: target.nativeId }, { kind: "environment_id" as const, value: quarantineEnvironmentId }, { kind: "cds_bot_id" as const, value: target.botId }],
    provenance: {}, details: { isQuarantined: false }, unknownFieldCount: 0,
  })), totalRecords: targets.length, pages: 1, unknownFieldCount: 0 });
  expect(published.snapshotId).toBeTruthy();
  const definition = capabilityDefinitions.find(value => value.id === "powerPlatform.quarantine.manage")!;
  const configuration = await capabilityRepository.configuration(scope.tenantId, definition.id);
  await fixture.operator.query(`INSERT INTO copilot_quarantine_qualifications
    (id,tenant_id,target_environment_id,target_bot_id,original_approval_id,restoration_approval_id,original_job_id,restoration_job_id,contract_revision,permission_revision,configuration_revision,auth_mode)
    VALUES(gen_random_uuid(),$1,$2,$3,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),$4,$5,$6,'delegated')`,
  [scope.tenantId, quarantineEnvironmentId, qualifiedQuarantineBotId, capabilityContractRevision(definition), capabilityPermissionRevision(definition), configuration.revision]);
  quarantineProviderFixture.states.set(qualifiedQuarantineBotId, false);
  quarantineProviderFixture.states.set(unqualifiedQuarantineBotId, false);
}

async function officialUsageFingerprint(
  repository: OfficialUsageRepository,
  options: { staleAfterDays: number; now: Date },
) {
  const published = await repository.getPublished(config.tenantId!);
  const aggregate = buildOfficialUsageAggregateView(published, [], options);
  const users = buildOfficialUsageUserView(published, options);
  return {
    activeSetId: published.activeSet?.id ?? null,
    activeRevision: published.activeRevision,
    lineage: aggregate.lineages.map(value => ({ ...value })).sort((left, right) => left.versionId.localeCompare(right.versionId)),
    aggregate: {
      responses: aggregate.summary.usage.totalResponses,
      activeUsers: aggregate.summary.usage.totalActiveUsers,
      reportAgents: aggregate.agents.count,
    },
    users: {
      count: users.users.count,
      responses: users.counts.totalResponsesReceived,
      accessRows: users.counts.accessRows,
    },
  };
}