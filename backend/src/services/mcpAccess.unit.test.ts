import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createApp } from "../app.js";
import { config, parseEmployeePrivacy } from "../config.js";
import { browserRequestPrincipal } from "../auth/requestPrincipal.js";
import { createBrowserCredentials } from "../auth/delegatedCredentials.js";
import { account, browserSession, epochAuthority, tenant } from "../auth/authFoundationTestSupport.js";
import { withAuthority } from "../auth/authorityContext.js";
import { activateAccountSession } from "../db/sessions.js";
import type { AppRole } from "../types/capability.js";
import { mcpAccessProfile } from "./mcpAccess.js";

const original = config.tenants, privacy = config.employeePrivacy;
beforeEach(async () => {
  config.tenants = [tenant];
  const pool = new Pool({ max: 4 });
  createApp(pool, "artifacts/not-used");
  await pool.end();
  await activateAccountSession(tenant.tenantId, account().homeAccountId, async () => {});
});
afterEach(() => { config.tenants = original; config.employeePrivacy = privacy; });

async function profile(roles: AppRole[]) {
  const session = browserSession();
  session.user!.roles = roles;
  const epochs = epochAuthority();
  const source = createBrowserCredentials(await browserRequestPrincipal(session, account(), epochs), epochs);
  return withAuthority(source, mcpAccessProfile);
}

describe("API-owned access profile", () => {
  it("has finite restricted roleless operations, no preview, provider readiness or directory data", async () => {
    const result = await profile([]);
    expect(result).toEqual({ audience: "end_user", operations: [
      { method: "POST", route: "/api/discovery/read", inputChoices: { operation: ["profile", "search", "detail", "workplace"] } },
      { method: "GET", route: "/api/mcp/access-profile" },
      { method: "POST", route: "/api/mcp/authenticated-entry" },
    ], staffPreviewAuthorized: false, privacy: { hide_employee_details: false, hide_champion_employee: false } });
  });
  it.each(["AgentControl.Viewer", "AgentControl.UsageReportUploader", "AgentControl.Admin"] as const)(
    "uses the real %s actor's hierarchy and finite capability guards", async role => {
      const result = await profile([role]);
      expect(result.audience).toBe(role === "AgentControl.Admin" ? "admin" : "adoption");
      expect(result.staffPreviewAuthorized).toBe(true);
      expect(result.operations.some(operation => operation.route === "/api/agent-controls/execute")).toBe(role === "AgentControl.Admin");
      const probes = result.operations.find(operation => operation.route === "/api/capabilities/:id/probe")!.inputChoices!.capabilityId!;
      expect(probes.includes("graph.users.read")).toBe(true);
      expect(probes.includes("graph.package.access.manage")).toBe(role === "AgentControl.Admin");
      expect(result.operations.some(operation => operation.route === "/api/me")).toBe(false);
    });
  it("rejects missing current authority rather than supplying a global catalog", () => {
    expect(mcpAccessProfile).toThrow(expect.objectContaining({ status: 401 }));
  });
  it.each([[false, false], [true, false], [false, true], [true, true]])("has independent API-owned privacy %s/%s", async (employee, champion) => {
    config.employeePrivacy = parseEmployeePrivacy({ MCP_HIDE_EMPLOYEE_DETAILS: String(employee), MCP_HIDE_CHAMPION_EMPLOYEE: String(champion) });
    expect((await profile([])).privacy).toEqual({ hide_employee_details: employee, hide_champion_employee: champion });
  });
  it("defaults only absent deployment values and rejects malformed ones", () => {
    expect(parseEmployeePrivacy({})).toEqual({ hide_employee_details: false, hide_champion_employee: false });
    for (const value of ["", "TRUE", "1", "false ", "null"]) {
      for (const key of ["MCP_HIDE_EMPLOYEE_DETAILS", "MCP_HIDE_CHAMPION_EMPLOYEE"]) expect(() => parseEmployeePrivacy({ [key]: value })).toThrow();
    }
  });
});
