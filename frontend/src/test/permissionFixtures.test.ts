import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fixtureLoginUrl,
  isExternalFixtureRequest,
  isPackageMutationRequest,
  isUnexpectedPermissionCommand,
  permissionLayoutRequestKind,
} from "../../browser/permissionFixtures";
import {
  blockAgent, blockAgents, blockAllAgents, checkCapabilities, getCapabilities, getCurrentUser, stageOfficialUsageReport,
  startPackageRefresh, submitPurviewAuditSearch, unblockAgent, unblockAgents, unblockAllAgents,
} from "../api/client";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("permission browser fixture boundaries", () => {
  it.each([undefined, "", "production"])("rejects login without the fixture marker (%s)", mode => {
    vi.stubEnv("AGENT_CONTROL_FIXTURE_MODE", mode);
    expect(() => fixtureLoginUrl("unknown")).toThrow("isolated synthetic-auth fixture");
  });

  it.each([
    "https://localhost:3001", "http://example.invalid:3001", "http://localhost.example.invalid",
    "http://localhost:3001/app", "http://localhost:3001/?fixture=browser", "http://localhost:3001/#app",
    "http://synthetic@localhost:3001",
  ])("rejects a non-fixture origin (%s)", origin => {
    vi.stubEnv("AGENT_CONTROL_FIXTURE_MODE", "browser");
    vi.stubEnv("PLAYWRIGHT_BASE_URL", origin);
    expect(() => fixtureLoginUrl("unknown")).toThrow("plain HTTP loopback origin");
  });

  it.each(["http://localhost:3001", "http://127.0.0.1:43123"])("keeps the configured loopback origin and exact scenario (%s)", origin => {
    vi.stubEnv("AGENT_CONTROL_FIXTURE_MODE", "browser");
    vi.stubEnv("PLAYWRIGHT_BASE_URL", origin);
    const login = new URL(fixtureLoginUrl("scenario & role=Viewer"));
    expect(login.origin).toBe(origin);
    expect(login.pathname).toBe("/api/auth/login");
    const returnTo = new URL(login.searchParams.get("returnTo")!, origin);
    expect(returnTo.pathname).toBe("/permissions");
    expect([...returnTo.searchParams]).toEqual([["fixture", "scenario & role=Viewer"]]);
    expect(isExternalFixtureRequest(login)).toBe(false);
  });

  it("blocks outbound fixture requests", () => {
    expect(isExternalFixtureRequest(new URL("https://example.invalid/api"))).toBe(true);
    expect(isExternalFixtureRequest(new URL("http://localhost.example.invalid/api"))).toBe(true);
  });
});

describe("permission layout request contract", () => {
  it.each([
    ["GET", "/api/capabilities", "catalog"],
    ["POST", "/api/capabilities/check", "automatic-check"],
    ["POST", "/api/capabilities/check?retry=failed", "retry-failed"],
  ])("classifies %s %s as %s", (method, path, kind) => {
    expect(permissionLayoutRequestKind(method, new URL(path, "http://localhost:3001"))).toBe(kind);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])("rejects %s catalog requests", method => {
    expect(permissionLayoutRequestKind(method, new URL("http://localhost:3001/api/capabilities"))).toBeUndefined();
  });

  it.each(["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])("rejects %s check requests", method => {
    expect(permissionLayoutRequestKind(method, new URL("http://localhost:3001/api/capabilities/check?retry=failed"))).toBeUndefined();
  });

  it.each(["retry=all", "retry=", "retry=failed&retry=failed", "retry=failed&force=true", "force=true"])(
    "rejects unsupported check options (%s)", query => {
      expect(permissionLayoutRequestKind("POST", new URL(`http://localhost:3001/api/capabilities/check?${query}`))).toBeUndefined();
    },
  );

  it("does not let a catalog read or unrelated command recover a failed check", () => {
    expect(permissionLayoutRequestKind("GET", new URL("http://localhost:3001/api/capabilities?retry=failed"))).toBe("catalog");
    expect(permissionLayoutRequestKind("POST", new URL("http://localhost:3001/api/capabilities/example/probe?retry=failed"))).toBeUndefined();
  });

  it("distinguishes the current API client's catalog, automatic check and explicit retry", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ value: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await getCapabilities();
    await checkCapabilities();
    await checkCapabilities({ retryFailed: true });
    expect(fetchMock.mock.calls.map(([url, init]) =>
      permissionLayoutRequestKind(init?.method ?? "GET", new URL(String(url), "http://localhost:3001")),
    )).toEqual(["catalog", "automatic-check", "retry-failed"]);
  });
});

describe("permission browser request sentinels", () => {
  it.each(["/api/capabilities/check", "/api/data-sync/auto-refresh", "/api/auth/consent", "/api/auth/logout"])("permits only the expected POST command %s", path => {
    expect(isUnexpectedPermissionCommand("POST", path)).toBe(false);
    expect(isUnexpectedPermissionCommand("DELETE", path)).toBe(true);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("detects unexpected %s API commands without a stale endpoint allowlist", method => {
    for (const path of [
      "/api/audit-search/jobs", "/api/official-usage/staging", "/api/inventory/refresh-jobs",
      "/api/data-sync/runs", "/api/new-provider/jobs", "/API/audit-search/jobs", "/Api/Agents/package/Block/",
    ]) {
      expect(isUnexpectedPermissionCommand(method, path)).toBe(true);
    }
  });

  it.each(["/permissions", "/apiary/jobs", "/api-assets/app.js"])("ignores non-API paths (%s)", path => {
    expect(isUnexpectedPermissionCommand("POST", path)).toBe(false);
  });

  it("permits saved reads and does not count previews as package writes", () => {
    for (const path of [
      "/api/agents", "/api/audit-search/jobs", "/api/agents/package/block",
      "/API/AGENTS/package/BLOCK/", "/api/agents/bulk-jobs/job/resume", "/api/agents/mutation-canaries/canary/execute",
    ]) {
      expect(isUnexpectedPermissionCommand("GET", path)).toBe(false);
      expect(isPackageMutationRequest("GET", path)).toBe(false);
    }
    for (const path of [
      "/api/agents/mutation-preview", "/api/agents/refresh-jobs", "/api/agents/package/refresh-jobs",
      "/api/agents/bulk-jobs/job/reconcile", "/API/AGENTS/bulk-jobs/job/RECONCILE/",
      "/api/agents/bulk-jobs/job/cancel", "/api/agents/mutation-canaries",
      "/api/agents/refresh-jobs/job/resume", "/api/agents/package/block/extra", "/api/agents/package/block//",
    ]) {
      expect(isPackageMutationRequest("POST", path)).toBe(false);
    }
  });

  it.each([
    ["POST", "/api/agents/package/block/"],
    ["POST", "/API/AGENTS/package/BLOCK"],
    ["POST", "/Api/Agents/package%2Fencoded/Unblock/"],
    ["POST", "/API/AGENTS/BLOCK/"],
    ["POST", "/api/agents/Unblock/"],
    ["POST", "/API/AGENTS/BLOCK-ALL/"],
    ["POST", "/api/agents/unblock-all/"],
    ["PATCH", "/Api/Agents/package/Access/"],
    ["POST", "/API/AGENTS/ACCESS/"],
  ])("detects Express-compatible mutation paths (%s %s)", (method, path) => {
    expect(isPackageMutationRequest(method, path)).toBe(true);
  });

  it.each([
    "/api/agents/bulk-jobs/job/resume",
    "/API/AGENTS/bulk-jobs/job/RESUME/",
    "/api/agents/mutation-canaries/canary/execute",
    "/Api/Agents/Mutation-Canaries/canary/Execute/",
  ])("detects commands that dispatch package writes (%s)", path => {
    expect(isPackageMutationRequest("POST", path)).toBe(true);
    expect(isUnexpectedPermissionCommand("POST", path)).toBe(true);
  });

  it.each(["POST", "PUT", "PATCH"])("detects single and bulk %s access changes", method => {
    expect(isPackageMutationRequest(method, "/api/agents/access")).toBe(true);
    expect(isPackageMutationRequest(method, "/api/agents/package/access")).toBe(true);
  });

  it("detects current API-client workload and mutation URLs, including encoded package IDs", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(Response.json({ user: {}, csrfToken: "synthetic-csrf" }));
    await getCurrentUser();
    fetchMock.mockClear();

    await submitPurviewAuditSearch("delegated", {
      presetId: "copilot_interactions", operations: ["CopilotInteraction"],
      startDateTime: "2026-09-08T12:00:00.000Z", endDateTime: "2026-09-08T13:00:00.000Z",
      userPrincipalNames: [], ipAddresses: [], objectIds: [], administrativeUnitIds: [],
    });
    await stageOfficialUsageReport(new File(["synthetic"], "agents.csv"), { bundleId: "synthetic-bundle" });
    await startPackageRefresh("delegated", { idempotencyKey: "synthetic-key" });
    await blockAgent("package/encoded", "confirmation");
    await unblockAgent("package/encoded", "confirmation");
    await blockAgents(["package"], "confirmation");
    await unblockAgents(["package"], "confirmation");
    await blockAllAgents("confirmation");
    await unblockAllAgents("confirmation");

    const requests = fetchMock.mock.calls.map(([url, init]) => ({
      path: new URL(String(url), "http://localhost:3001").pathname, method: init?.method ?? "GET",
    }));
    expect(requests).toHaveLength(9);
    expect(requests.every(({ method, path }) => isUnexpectedPermissionCommand(method, path))).toBe(true);
    expect(requests.filter(({ method, path }) => isPackageMutationRequest(method, path))).toHaveLength(6);
  });
});
