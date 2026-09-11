import { describe, expect, it, vi } from "vitest";
import { boundedProviderJson } from "./providerJson.js";
import { GraphPackagesClient, graphError } from "./graphPackages.js";
import { DirectoryPrincipalsClient } from "./directoryPrincipals.js";
import { allowlistedPackage } from "./packageObservation.js";

describe("bounded provider observations", () => {
  it("rejects oversized and malformed payloads", async () => {
    await expect(boundedProviderJson(new Response("x".repeat(2_000_001)))).rejects.toMatchObject({ code: "provider_result_limit" });
    await expect(boundedProviderJson(new Response("{"))).rejects.toMatchObject({ code: "provider_schema" });
    const error = await graphError(Response.json({ error: { code: "Forbidden", message: "denied", token: "never-return" }, raw: "never-return" }, { status: 403 }));
    expect(JSON.stringify(error.details)).not.toContain("never-return");
  });

  it("omits unknown package fields with value-free diagnostics", () => {
    const diagnostics = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(allowlistedPackage({ id: "exact", displayName: "Fixture", isBlocked: false, platform: "copilotStudio", unknown: "private" })).toMatchObject({
        id: "exact", displayName: "Fixture", isBlocked: false, sourceSystem: "graph_packages", authoringTool: "copilotStudio",
        creatorType: "unknown", agentKind: "copilot_package", lifecycle: "unknown", identityConfidence: "exact_native",
        provenance: { authoringTool: { sourceSystem: "graph_packages", path: "platform", maturity: "ga" } },
      });
      expect(diagnostics).toHaveBeenCalledWith(JSON.stringify({ event: "provider_schema_omission", provider: "graph_packages", count: 1 }));
      expect(() => allowlistedPackage({ id: 12, displayName: "Fixture", isBlocked: false })).toThrow();
    } finally { diagnostics.mockRestore(); }
  });

  it("never follows foreign pagination and bounds directory input", async () => {
    const fetcher = vi.fn(async () => Response.json({ value: [], "@odata.nextLink": "https://other.invalid/collect" }));
    await expect(new GraphPackagesClient(fetcher).listCopilotAgents("private-token")).rejects.toMatchObject({ code: "invalid_provider_link" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(new DirectoryPrincipalsClient(async () => Response.json({ value: Array.from({ length: 51 }, () => ({ id: "fixture" })) })).search("token", "fi")).rejects.toMatchObject({ code: "provider_schema" });
    const bounded = vi.fn(async () => new Response("x".repeat(2_000_001)));
    await expect(new DirectoryPrincipalsClient(bounded).resolve("token", [{ resourceId: "11111111-1111-4111-8111-111111111111", resourceType: "user" }])).rejects.toMatchObject({ code: "provider_result_limit" });
    expect(bounded.mock.calls[0]).toBeDefined();
  });
});