import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { declaredRoutePolicies } from "./policy.js";

describe("route policy declarations", () => {
  it("covers every application route and requires CSRF on unsafe authenticated methods", () => {
    createApp({} as never, "artifacts/not-used");
    const expected = [
      "GET /api/health", "GET /api/ready", "GET /api/auth/status", "GET /api/diagnostics", "GET /{*path}",
      "GET /auth/login", "POST /auth/consent", "GET /auth/callback", "POST /auth/logout", "GET /me",
      "GET /capabilities", "POST /capabilities/check", "POST /capabilities/:id/probe", "PUT /capabilities/:id/configuration",
      "GET /workbench/metadata", "GET /workbench/jobs", "POST /audit/events/export.csv",
      "GET /agents", "GET /directory/principals", "POST /directory/principals/resolve", "POST /agents/details",
      "POST /agents/refresh-jobs", "POST /agents/:id/refresh-jobs", "GET /agents/refresh-jobs", "GET /agents/refresh-jobs/:id", "POST /agents/refresh-jobs/:id/resume", "POST /agents/refresh-jobs/:id/cancel", "GET /agents/snapshots", "GET /agents/export.csv", "POST /agents/export.csv",
      "GET /agents/bulk-jobs", "GET /agents/bulk-jobs/:id", "POST /agents/bulk-jobs/:id/cancel", "POST /agents/bulk-jobs/:id/reconcile", "POST /agents/bulk-jobs/:id/resume", "GET /agents/:id",
      "POST /agents/block-all", "POST /agents/block", "POST /agents/:id/block", "POST /agents/unblock-all", "POST /agents/unblock", "POST /agents/:id/unblock",
      "POST /agents/access", "PATCH /agents/:id/access", "POST /agents/mutation-canaries", "POST /agents/mutation-canaries/:id/execute", "POST /agents/mutation-preview", "GET /audit/events",
      "POST /inventory/refresh-jobs", "GET /inventory/refresh-jobs", "GET /inventory/refresh-jobs/:id", "POST /inventory/refresh-jobs/:id/resume", "POST /inventory/refresh-jobs/:id/cancel", "GET /inventory/snapshots", "GET /inventory/resources", "GET /inventory/resources/:nativeId/related", "GET /inventory/quarantine-selection", "GET /inventory/export.csv",
      "GET /quarantine/targets", "GET /quarantine/status", "POST /quarantine/preview", "POST /quarantine/jobs", "GET /quarantine/jobs", "GET /quarantine/audit", "GET /quarantine/jobs/:id",
      "POST /quarantine/jobs/:id/cancel", "POST /quarantine/jobs/:id/resume", "POST /quarantine/jobs/:id/reconcile",
      "POST /quarantine/canary-approvals", "GET /quarantine/canary-approvals", "POST /quarantine/canary-approvals/:id/execute",
      "POST /official-usage/staging", "GET /official-usage/admin", "DELETE /official-usage/staging/:id",
      "POST /official-usage/bundles/:id/preview", "POST /official-usage/bundles/:id/accept",
      "POST /official-usage/sets/:id/preview", "POST /official-usage/confirmations/:id", "POST /official-usage/legacy-cleanup-acknowledgements",
      "GET /official-usage/aggregate", "GET /official-usage/aggregate.csv", "GET /official-usage/users", "GET /official-usage/users.csv",
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