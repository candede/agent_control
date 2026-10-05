import { MiB } from "./capacityTelemetry.js";
import { fixtureTenant, type CapacityIdentityProfile } from "./capacityProvider.js";
import { generationInput } from "./largeTenantFixtures.js";

export const capacityBudgets = Object.freeze({
  app: { memory: 1536 * MiB, cpus: 1.5, oldSpaceMiB: 768, pool: 4 },
  postgres: { memory: 1024 * MiB, cpus: 0.5, sharedBuffers: "32MB", workMem: "4MB", maintenanceWorkMem: "64MB",
    parallelGather: 0, statementMs: 15_000 },
  controller: { memory: 1024 * MiB, cpus: 1 }, diskFree: 64 * 1024 ** 3, diskStop: 48 * 1024 ** 3,
});
export function fixtureFetch(count: number, version = 0, opposing = false, profile: CapacityIdentityProfile = "mixed", children: 0 | 10_000 = 0) {
  return (input: string | URL, init?: RequestInit) => {
    const upstream = new URL(input);
    if (!["graph.microsoft.com", "api.powerplatform.com"].includes(upstream.hostname)) throw new Error("fixture_provider_origin");
    const url = new URL("http://controller:8080/provider");
    url.searchParams.set("upstream", upstream.toString()); url.searchParams.set("count", String(count));
    url.searchParams.set("version", String(version)); url.searchParams.set("opposing", String(opposing));
    url.searchParams.set("identityProfile",profile);
    url.searchParams.set("children",String(children));
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
  return generationInput({ scope: { tenantId, kind: "principal", principalId: principal, tokenMode: "delegated", source, selector: "complete" },
    reserveBytes: (source.startsWith("inventory_") ? 1 : 8) * 1024 ** 3,
    jobKind: source === "inventory_canonical" ? "derived" : "fixture",
    deadlineAt: new Date(Date.now() + (source === "inventory_packages" ? 4*3600_000 : 30*60_000)) });
}
