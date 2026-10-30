import { MiB } from "./capacityTelemetry.js";
import { fixtureTenant, type CapacityIdentityProfile } from "./capacityProvider.js";
import { capacityWithCleanup } from "./capacityBackground.js";
import { generationInput } from "./largeTenantFixtures.js";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type pg from "pg";
import type { AuthenticatedUser } from "../src/types/session.js";

export const capacityBudgets = Object.freeze({
  app: { memory: 1536 * MiB, cpus: 1.5, oldSpaceMiB: 768, pool: 4 },
  postgres: { memory: 1024 * MiB, cpus: 0.5, sharedBuffers: "32MB", workMem: "4MB", maintenanceWorkMem: "64MB",
    parallelGather: 0, statementMs: 15_000 },
  controller: { memory: 1024 * MiB, cpus: 1 }, diskFree: 64 * 1024 ** 3, diskStop: 48 * 1024 ** 3,
});
export function fixtureFetch(count: number, version = 0, opposing = false, profile: CapacityIdentityProfile = "mixed",
  children: 0 | 10_000 = 0, tenantId?: string) {
  return (input: string | URL, init?: RequestInit) => {
    const upstream = new URL(input);
    if (!["graph.microsoft.com", "api.powerplatform.com"].includes(upstream.hostname)) throw new Error("fixture_provider_origin");
    const url = new URL("http://controller:8080/provider");
    url.searchParams.set("upstream", upstream.toString()); url.searchParams.set("count", String(count));
    url.searchParams.set("version", String(version)); url.searchParams.set("opposing", String(opposing));
    url.searchParams.set("identityProfile",profile);
    url.searchParams.set("children",String(children));
    if (tenantId !== undefined) url.searchParams.set("tenantId",tenantId);
    const headers = new Headers(init?.headers); headers.delete("authorization");
    return fetch(url, { ...init, headers, redirect: "error" }).then(response => {
      if (response.redirected || new URL(response.url).origin !== "http://controller:8080") throw new Error("fixture_transport_redirect");
      const mapped = new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers });
      Object.defineProperty(mapped, "url", { value: upstream.toString() });
      return mapped;
    });
  };
}
export function capacityInput(principal: string, source = "inventory_packages", tenantId = fixtureTenant) {
  return generationInput({ scope: { tenantId, kind: "tenant", principalId: null, tokenMode: "tenant", source, selector: "complete" },
    actorPrincipalId: principal,
    reserveBytes: (source.startsWith("inventory_") ? 1 : 8) * 1024 ** 3,
    jobKind: source === "inventory_canonical" ? "derived" : "fixture",
    deadlineAt: new Date(Date.now() + (source === "inventory_packages" ? 4*3600_000 : 30*60_000)) });
}

export async function capacityInitialSync(database: pg.Pool, user: AuthenticatedUser, count: number) {
  assert.equal(process.env.AGENT_CONTROL_ISOLATED_TESTS,"1");
  assert.equal(process.env.PGHOST,"test-postgres");
  assert.equal(database.options.host,"test-postgres");
  assert.match(String(database.options.database),/^agentcontrol_test_[a-f0-9]{32}$/);
  assert.equal(user.tenantId,fixtureTenant);
  assert.ok(Number.isInteger(count) && count>0 && count<=100_000);
  const { DataSyncService } = await import("../src/services/dataSync.js");
  const { DataSyncRepository } = await import("../src/db/dataSync.js");
  const { OfficialReportStatusRepository } = await import("../src/db/officialReportStatus.js");
  const { PackageInventoryService } = await import("../src/services/packageInventory.js");
  const { PackageRefreshJobs } = await import("../src/db/packageRefreshJobs.js");
  const { PowerPlatformInventoryService } = await import("../src/services/powerPlatformInventory.js");
  const { PowerPlatformRefreshJobs } = await import("../src/db/powerPlatformRefreshJobs.js");
  const { CopilotUsageService } = await import("../src/services/copilotUsage.js");
  const { AgentPeopleService } = await import("../src/services/agentPeople.js");
  const { DirectoryPrincipalsClient } = await import("../src/services/directoryPrincipals.js");
  const { StreamedInventory } = await import("../src/services/streamedInventory.js");
  const { GraphPackagesClient, packageInventoryReadPolicy } = await import("../src/services/graphPackages.js");
  const { PowerPlatformResourceQueryClient } = await import("../src/services/powerPlatformResourceQuery.js");
  const { UserSourceProvider } = await import("../src/services/userSourceProvider.js");
  const { InventoryRuntime } = await import("../src/services/inventoryRuntime.js");
  const { DataGenerations } = await import("../src/db/dataGenerations.js");
  const { beginAccountSessionValidation,assertAccountSessionValidation } = await import("../src/db/sessions.js");
  type Authorization = Pick<NonNullable<ConstructorParameters<typeof PackageInventoryService>[1]>,
    "delegatedToken"|"revalidateUser"|"requireAvailable"|"observeOperation"|"beginOperationValidation">;
  const authorization: Authorization = {
    delegatedToken: async () => "synthetic-capacity",
    revalidateUser: async (tenant,principal) => {
      assert.equal(tenant,user.tenantId); assert.equal(principal,user.homeAccountId); return user;
    },
    requireAvailable: async capabilityId => ({ capabilityId,status: "available",authorized: true,fresh: true,
      previewQualification: "not_required",remediation: [] }),
    observeOperation: async (_capability,_user,operation) => operation(() => {}),
    beginOperationValidation: (_capability,actor) => {
      assert.ok(actor.tenantId);
      assert.equal(actor.tenantId,user.tenantId); assert.equal(actor.homeAccountId,user.homeAccountId);
      const captured = beginAccountSessionValidation(actor.tenantId,actor.homeAccountId);
      return () => assertAccountSessionValidation(captured);
    },
  };
  const provider = fixtureFetch(count), streams = (pool: pg.Pool) => new StreamedInventory(pool,
    new GraphPackagesClient(provider,packageInventoryReadPolicy),new PowerPlatformResourceQueryClient(provider));
  const packages = new PackageInventoryService(new PackageRefreshJobs(database),{
    ...authorization,streams,applicationPrincipalId: () => undefined,
    applicationToken: async () => { throw new Error("capacity_initial_sync_application_token"); },
    requireApplicationDataScope: async () => { throw new Error("capacity_initial_sync_application_scope"); },
    wait: (milliseconds,signal) => delay(milliseconds,undefined,{ signal }),
  });
  const powerPlatform = new PowerPlatformInventoryService(new PowerPlatformRefreshJobs(database),{ ...authorization,streams });
  const sync = new DataSyncService(database,{
    repository: new DataSyncRepository(database),officialUsage: new OfficialReportStatusRepository(database),
    packages,powerPlatform,copilotUsage: new CopilotUsageService(database,{ ...authorization,provider: new UserSourceProvider(provider) }),
    agentPeople: new AgentPeopleService(database,{ ...authorization,directory: new DirectoryPrincipalsClient(provider) }),
    wait: (milliseconds,signal) => delay(milliseconds,undefined,{ signal }),
  });
  const started = performance.now(), deadline = AbortSignal.timeout(30*60_000);
  return capacityWithCleanup(async () => {
    const run = await sync.start(user,{ mode: "initial" });
    for (;;) {
      deadline.throwIfAborted();
      const state = await sync.state(user);
      if (state.run?.id===run.id && state.run.status!=="running") {
        assert.equal(state.run.status,"completed",JSON.stringify(state));
        assert.equal(state.onboardingRequired,false,JSON.stringify(state));
        const scope = { tenantId: user.tenantId!,principalId: user.homeAccountId };
        const validation = beginAccountSessionValidation(scope.tenantId,scope.principalId);
        const runtime = new InventoryRuntime(database,async () => assertAccountSessionValidation(validation));
        await runtime.enqueue(scope,false);
        const input = capacityInput(scope.principalId,"inventory_canonical",scope.tenantId);
        input.sessionEpoch = await new DataGenerations(database).sessionEpoch(scope.tenantId,scope.principalId);
        const canonical = await runtime.reconciliation.runNext(input,async () => assertAccountSessionValidation(validation));
        assert.ok(canonical,"Genuine canonical publication must complete before the UI starts.");
        return { runId: run.id,status: state.run.status,onboardingRequired: state.onboardingRequired,
          sources: state.sources,canonical,elapsedMs: performance.now()-started,
          scope: "Real existing sync orchestration, source services, publication and saved markers with synthetic provider transport; no readiness or admission bypass." };
      }
      await delay(500,undefined,{ signal: deadline });
    }
  },async () => {
    const results = await Promise.allSettled([sync.drain()]);
    results.push(...await Promise.allSettled([packages.drain(),powerPlatform.drain()]));
    const failures = results.filter(result => result.status==="rejected").map(result => result.reason);
    if (failures.length) throw new AggregateError(failures,"capacity_initial_sync_cleanup");
  });
}
