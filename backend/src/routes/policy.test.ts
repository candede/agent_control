import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { declaredRoutePolicies } from "./policy.js";

describe("route policy declarations", () => {
  it("covers every application route and requires CSRF on unsafe authenticated methods", () => {
    createApp({} as never, "artifacts/not-used");
    const expected = [
      "GET /api/health", "GET /api/ready", "GET /api/auth/status", "GET /api/diagnostics", "GET /{*path}", "GET /security",
      "GET /auth/login", "POST /auth/login", "POST /auth/consent", "GET /auth/callback", "POST /auth/logout", "GET /me",
      "GET /capabilities", "GET /capabilities/check-progress", "POST /capabilities/check", "POST /capabilities/:id/probe", "PUT /capabilities/:id/configuration",
      "GET /workbench/metadata", "GET /workbench/jobs", "POST /audit/events/export.csv",
      "GET /agent-inventory", "POST /agent-inventory/export.csv", "GET /agents", "GET /directory/principals", "POST /directory/principals/resolve", "POST /agents/details",
      "POST /agent-inventory/people/resolve", "GET /agent-responsibility",
      "GET /agent-inventory/investigations/context", "GET /agent-inventory/investigations/purview",
      "POST /agent-inventory/investigations/resolve",
      "GET /agent-inventory/:recordId/usage-candidates", "POST /agent-inventory/:recordId/usage-associations", "DELETE /agent-inventory/:recordId/usage-associations",
      "GET /data-sync/state", "GET /data-sync/runs/:id", "POST /data-sync/runs", "POST /data-sync/auto-refresh",
      "POST /data-sync/runs/:id/retry", "POST /data-sync/runs/:id/cancel",
      "POST /agents/refresh-jobs", "POST /agents/:id/refresh-jobs", "GET /agents/refresh-jobs", "GET /agents/refresh-jobs/:id", "POST /agents/refresh-jobs/:id/resume", "POST /agents/refresh-jobs/:id/cancel", "GET /agents/snapshots", "GET /agents/export.csv", "POST /agents/export.csv",
      "GET /agents/bulk-jobs", "GET /agents/bulk-jobs/:id", "POST /agents/bulk-jobs/:id/cancel", "POST /agents/bulk-jobs/:id/reconcile", "POST /agents/bulk-jobs/:id/resume", "GET /agents/:id",
      "POST /agents/block-all", "POST /agents/block", "POST /agents/:id/block", "POST /agents/unblock-all", "POST /agents/unblock", "POST /agents/:id/unblock",
      "POST /agents/access", "PATCH /agents/:id/access", "POST /agents/mutation-canaries", "POST /agents/mutation-canaries/:id/execute", "POST /agents/mutation-preview", "GET /audit/events",
      "POST /inventory/refresh-jobs", "GET /inventory/refresh-jobs", "GET /inventory/refresh-jobs/:id", "POST /inventory/refresh-jobs/:id/resume", "POST /inventory/refresh-jobs/:id/cancel", "GET /inventory/resources/:nativeId/related", "GET /inventory/quarantine-selection", "GET /inventory/export.csv",
      "GET /quarantine/status", "POST /quarantine/preview", "POST /quarantine/jobs", "GET /quarantine/jobs", "GET /quarantine/audit", "GET /quarantine/jobs/:id",
      "POST /quarantine/jobs/:id/cancel", "POST /quarantine/jobs/:id/resume", "POST /quarantine/jobs/:id/reconcile",
      "POST /quarantine/canary-approvals", "GET /quarantine/canary-approvals", "POST /quarantine/canary-approvals/:id/execute",
      "GET /copilot-usage/users",
      "POST /official-usage/staging", "GET /official-usage/admin", "GET /official-usage/history", "GET /official-usage/overview", "DELETE /official-usage/staging/:id",
      "POST /official-usage/bundles/:id/preview", "POST /official-usage/bundles/:id/accept",
      "POST /official-usage/sets/:id/preview", "POST /official-usage/confirmations/:id", "POST /official-usage/legacy-cleanup-acknowledgements",
      "GET /official-usage/aggregate", "GET /official-usage/aggregate.csv", "GET /official-usage/agents/:agentId", "GET /official-usage/users", "GET /official-usage/users.csv",
      "GET /audit-search/catalog", "POST /audit-search/qualifications", "POST /audit-search/qualifications/:id/start",
      "POST /audit-search/jobs", "GET /audit-search/jobs", "GET /audit-search/jobs/:id", "POST /audit-search/jobs/:id/resume",
      "POST /audit-search/jobs/:id/cancel", "DELETE /audit-search/jobs/:id", "GET /audit-search/jobs/:id/records", "GET /audit-search/jobs/:id/export.csv",
      "GET /hunting/catalog", "POST /hunting/qualifications", "POST /hunting/qualifications/:id/start",
      "POST /hunting/jobs", "GET /hunting/jobs", "GET /hunting/jobs/:id", "POST /hunting/jobs/:id/resume",
      "POST /hunting/jobs/:id/cancel", "DELETE /hunting/jobs/:id", "GET /hunting/jobs/:id/rows", "GET /hunting/jobs/:id/export.csv",
      "POST /hunting/retained-scopes/:id/revoke",
    ];
    expect([...declaredRoutePolicies.keys()].sort()).toEqual(expected.sort());
    for (const [key, policy] of declaredRoutePolicies) {
      if (policy.access === "authenticated" && !key.startsWith("GET ")) expect(policy.csrf).toBe(true);
      if (policy.access === "authenticated") expect(policy.dataClass.length).toBeGreaterThan(0);
    }
  });

  it("requires directory-read authorization, Viewer access and CSRF for persisted people resolution", () => {
    expect(declaredRoutePolicies.get("POST /agent-inventory/people/resolve")).toEqual({
      access: "authenticated", dataClass: "directory", roles: ["AgentControl.Viewer"],
      capabilityId: "graph.directory.read", csrf: true,
    });
  });

  it("keeps the retired consent endpoint session-, Viewer- and CSRF-protected without a provider capability", () => {
    expect(declaredRoutePolicies.get("POST /auth/consent")).toEqual({
      access: "authenticated", dataClass: "identity", roles: ["AgentControl.Viewer"], csrf: true,
    });
    expect(declaredRoutePolicies.get("GET /auth/login")).toEqual({ access: "public", dataClass: "identity" });
    expect(declaredRoutePolicies.get("POST /auth/login")).toEqual({ access: "public", dataClass: "identity" });
    expect(declaredRoutePolicies.get("GET /auth/callback")).toEqual({ access: "public", dataClass: "identity" });
  });

  it("requires only saved private Viewer authorization for responsibility, not provider lookup capability", () => {
    expect(declaredRoutePolicies.get("GET /agent-responsibility")).toEqual({
      access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"],
    });
  });

  it("keeps investigation reads private and Viewer-authorized without provider calls", () => {
    expect(declaredRoutePolicies.get("POST /agent-inventory/investigations/resolve")).toEqual({
      access: "authenticated", dataClass: "directory", roles: ["AgentControl.Viewer"], csrf: true, capabilityId: "graph.agentIdentity.read",
    });
    for (const route of ["context", "purview"]) {
      expect(declaredRoutePolicies.get(`GET /agent-inventory/investigations/${route}`)).toMatchObject({
        access: "authenticated", roles: ["AgentControl.Viewer"],
      });
      expect(declaredRoutePolicies.get(`GET /agent-inventory/investigations/${route}`)?.capabilityId).toBeUndefined();
    }
  });

  it("does not allow direct route registration outside the policy helper", () => {
    const routeFiles = readdirSync(fileURLToPath(new URL(".", import.meta.url)), { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && entry.name !== "policy.ts")
      .map(entry => `./${entry.name}`);
    for (const relative of ["../app.ts", ...routeFiles]) {
      const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
      const routerNames = [...source.matchAll(/\b(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:Router|express)\s*\(/g)].map(match => match[1]);
      for (const routerName of routerNames) {
        expect(source).not.toMatch(new RegExp(`\\b${routerName}\\s*\\.\\s*(?:get|post|put|patch|delete|route)\\s*\\(`));
      }
      expect(source).not.toMatch(/\b(?:Router|express)\s*\([^)]*\)\s*\.\s*(?:get|post|put|patch|delete|route)\s*\(/);
    }
  });
});