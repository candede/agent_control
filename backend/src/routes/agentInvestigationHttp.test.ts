import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { defenderHuntingRouter } from "./defenderHunting.js";
import { unifiedAgentsRouter } from "./unifiedAgents.js";
import { defenderHunting } from "../services/defenderHunting.js";
import { purviewAudit } from "../services/purviewAudit.js";
import { agentInvestigations } from "../services/agentInvestigations.js";
import { agentIdentityResolution } from "../services/agentIdentityResolution.js";
import { capabilities } from "../services/capabilities.js";

vi.mock("../middleware/auth.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../middleware/auth.js")>();
  return { ...actual,
    requireSession: ((request, _response, next) => request.session.user ? next() : next(AppError.unauthorized())) as express.RequestHandler,
    requestScope: () => ({ tenantId: "tenant-a", principalId: "reader-a" }),
  };
});
vi.mock("../services/auditLog.js", () => ({ getAuditLog: () => ({
  startEvent: vi.fn(async () => ({ id: "audit-a" })), completeEvent: vi.fn(async () => undefined),
}) }));
vi.mock("../services/csvExport.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/csvExport.js")>(),
  createExportPublicationValidator: () => async (validateSource?: () => Promise<void>) => { await validateSource?.(); },
}));
vi.mock("../services/defenderHunting.js", () => ({ defenderHunting: Object.fromEntries([
  "qualificationEvidence", "retainedScopes", "approveQualification", "startQualification", "revokeRetainedScope",
  "submit", "start", "list", "get", "cancel", "delete", "rows",
].map(key => [key, vi.fn()])) }));
vi.mock("../services/purviewAudit.js", () => ({ purviewAudit: { agentRecords: vi.fn() } }));

const id = "11111111-1111-4111-8111-111111111111";
const recordId = `agent:${id}`;
const user = { tenantId: "tenant-a", homeAccountId: "reader-a", roles: ["AgentControl.Viewer"] };
let server: Server;
let origin: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.session = { user: request.get("x-test-user") === "anonymous" ? undefined
      : { ...user, roles: request.get("x-test-user") === "unassigned" ? [] : user.roles },
    accountId: "reader-a", csrfToken: "test-csrf" } as never;
    next();
  });
  app.use("/api", defenderHuntingRouter, unifiedAgentsRouter);
  app.use(((error: AppError, _request, response, _next) => response.status(error.status ?? 500).json({ code: error.code })) as express.ErrorRequestHandler);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server?.closeAllConnections(); await new Promise<void>(resolve => server?.close(() => resolve())); });
beforeEach(() => {
  vi.clearAllMocks();
  for (const method of [defenderHunting.get, defenderHunting.submit, defenderHunting.start, defenderHunting.startQualification,
    defenderHunting.approveQualification, defenderHunting.cancel, defenderHunting.revokeRetainedScope]) {
    vi.mocked(method).mockResolvedValue({ id, tokenMode: "delegated" } as never);
  }
  vi.mocked(defenderHunting.qualificationEvidence).mockResolvedValue([]);
  vi.mocked(defenderHunting.retainedScopes).mockResolvedValue([]);
  vi.mocked(defenderHunting.list).mockResolvedValue({ count: 0, value: [], limit: 20, offset: 0 });
  vi.mocked(defenderHunting.rows).mockResolvedValue({ count: 0, value: [] } as never);
});

describe("agent investigation HTTP wiring", () => {
  it("protects explicit resolution with Viewer, CSRF, narrow capability and an exact record-only body", async () => {
    const result = { recordId, displayName: "Agent", defender: { status: "available" as const, entraAgentIds: [id] },
      purview: { status: "unavailable" as const, mode: "saved_only" as const } };
    const resolve = vi.spyOn(agentIdentityResolution, "resolve").mockResolvedValue(result);
    const available = vi.spyOn(capabilities, "requireAvailable").mockResolvedValue({
      capabilityId: "graph.agentIdentity.read", authorized: true, fresh: true, status: "available",
      verification: "on_demand", previewQualification: "not_required", remediation: [],
    });
    const url = `${origin}/api/agent-inventory/investigations/resolve`;
    const request = (body: unknown, headers = {}, query = "") => fetch(`${url}${query}`, {
      method: "POST", headers: { "content-type": "application/json", "x-csrf-token": "test-csrf", ...headers }, body: JSON.stringify(body),
    });
    try {
      expect((await request({ recordId }, { "x-test-user": "anonymous" })).status).toBe(401);
      expect((await request({ recordId }, { "x-test-user": "unassigned" })).status).toBe(403);
      expect((await request({ recordId }, { "x-csrf-token": "wrong" })).status).toBe(403);
      expect(available).not.toHaveBeenCalled();
      for (const invalid of [{ recordId, candidateId: id }, { recordId, url: "https://example.invalid" }, { recordId, tokenMode: "application" }, {}, []]) {
        expect((await request(invalid)).status).toBe(400);
      }
      expect((await request({ recordId }, {}, `?agentRecordId=${recordId}`)).status).toBe(400);
      expect(resolve).not.toHaveBeenCalled();
      const response = await request({ recordId });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual(result);
      expect(resolve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(user), recordId, expect.any(AbortSignal));
      for (const [capability] of available.mock.calls) expect(capability).toBe("graph.agentIdentity.read");
      available.mockRejectedValue(new AppError(403, "missing_permission", "Administrator pregrant required"));
      expect((await request({ recordId })).status).toBe(403);
      expect(resolve).toHaveBeenCalledOnce();
    } finally { resolve.mockRestore(); available.mockRestore(); }
  });

  it("forwards the exact agent context on every hunting GET, including export publication rechecks", async () => {
    for (const path of ["catalog", "jobs", `jobs/${id}`, `jobs/${id}/rows`, `jobs/${id}/export.csv`]) {
      const response = await fetch(`${origin}/api/hunting/${path}?agentRecordId=${encodeURIComponent(recordId)}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      await response.text();
    }
    for (const method of [defenderHunting.get, defenderHunting.list, defenderHunting.rows, defenderHunting.qualificationEvidence, defenderHunting.retainedScopes]) {
      expect(vi.mocked(method).mock.calls.length).toBeGreaterThan(0);
      for (const args of vi.mocked(method).mock.calls) expect(args.at(-1)).toBe(recordId);
    }
  });

  it.each(["body", "query"] as const)("forwards %s context through submission, qualification, resume, cancellation, delete and revoke", async location => {
    for (const [path, method, expected] of [
      ["jobs", "POST", 202], ["qualifications", "POST", 201], [`qualifications/${id}/start`, "POST", 202],
      [`jobs/${id}/resume`, "POST", 202], [`jobs/${id}/cancel`, "POST", 200], [`jobs/${id}`, "DELETE", 204],
      [`retained-scopes/${id}/revoke`, "POST", 200],
    ] as const) {
      const response = await fetch(`${origin}/api/hunting/${path}${location === "query" ? `?agentRecordId=${encodeURIComponent(recordId)}` : ""}`, { method,
        headers: { "content-type": "application/json", "x-csrf-token": "test-csrf" },
        body: JSON.stringify({ ...(location === "body" ? { agentRecordId: recordId } : {}),
          ...(path.includes("revoke") || method === "DELETE" ? { confirmation: id } : { tokenMode: "delegated", filters: {} }) }) });
      expect(response.status, path).toBe(expected); await response.text();
    }
    for (const method of [defenderHunting.submit, defenderHunting.approveQualification]) {
      expect(method).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ agentRecordId: recordId }));
    }
    for (const method of [defenderHunting.start, defenderHunting.startQualification, defenderHunting.cancel, defenderHunting.delete, defenderHunting.revokeRetainedScope]) {
      for (const args of vi.mocked(method).mock.calls) expect(args.at(-1)).toBe(recordId);
    }
  });

  it("keeps context/Purview saved reads Viewer-only and hunting mutations CSRF-protected", async () => {
    const context = vi.spyOn(agentInvestigations, "resolve").mockResolvedValue({ context: { recordId, displayName: "Agent",
      defender: { status: "unavailable", entraAgentIds: [] }, purview: { status: "unavailable", mode: "saved_only" } } });
    vi.mocked(purviewAudit.agentRecords).mockResolvedValue({ recordId, mode: "saved_only", count: 0, value: [], limit: 50, offset: 0 });
    try {
      for (const path of ["context", "purview"]) {
        const url = `${origin}/api/agent-inventory/investigations/${path}?recordId=${encodeURIComponent(recordId)}`;
        expect((await fetch(url, { headers: { "x-test-user": "anonymous" } })).status).toBe(401);
        expect((await fetch(url, { headers: { "x-test-user": "unassigned" } })).status).toBe(403);
        const response = await fetch(url);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        await response.text();
      }
      const denied = await fetch(`${origin}/api/hunting/jobs`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentRecordId: recordId, tokenMode: "delegated", filters: {} }) });
      expect(denied.status).toBe(403);
      expect(defenderHunting.submit).not.toHaveBeenCalled();
      expect(context).toHaveBeenCalledOnce();
      expect(purviewAudit.agentRecords).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(user), recordId, { limit: 50, offset: 0 });
    } finally { context.mockRestore(); }
  });
});
