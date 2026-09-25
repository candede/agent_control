import type { Request, RequestHandler, Response, Router } from "express";
import { parse as parseCsv } from "csv-parse/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import type { InventoryRefreshJob, InventoryResourcePage, InventorySnapshot, PowerPlatformResource } from "../types/powerPlatformInventory.js";
import type { RoutePolicy } from "./policy.js";
import { inventoryExportQuery } from "./inventory.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, RequestHandler>(),
  list: vi.fn<() => Promise<InventoryResourcePage>>(),
  assertSnapshotCurrent: vi.fn(),
  startEvent: vi.fn(),
  completeEvent: vi.fn(),
  validateSession: vi.fn<ReturnType<typeof import("../services/csvExport.js").createExportPublicationValidator>>(),
  publish: vi.fn<typeof import("../services/csvExport.js").publishBoundedCsv>(),
  submitInventory: vi.fn(),
  startInventory: vi.fn(),
  getInventory: vi.fn(),
}));

vi.mock("../db/pool.js", () => ({ pool: {}, secretValue: vi.fn(() => undefined) }));
vi.mock("../db/sessions.js", () => ({
  assertCurrentStoredSession: vi.fn(), beginAccountSessionValidation: vi.fn(), commitAccountSessionValidation: vi.fn(),
}));
vi.mock("../db/powerPlatformInventory.js", () => ({
  PowerPlatformInventoryRepository: class {
    list = mocks.list;
    assertSnapshotCurrent = mocks.assertSnapshotCurrent;
  },
}));
vi.mock("../middleware/auth.js", () => ({
  requestScope: () => ({ tenantId: "tenant", principalId: "principal" }),
}));
vi.mock("../services/powerPlatformInventory.js", () => ({ powerPlatformInventory: {
  submit: mocks.submitInventory, start: mocks.startInventory, get: mocks.getInventory,
} }));
vi.mock("../services/purviewAudit.js", () => ({ purviewAudit: {} }));
vi.mock("../services/auditLog.js", () => ({
  getAuditLog: () => ({ startEvent: mocks.startEvent, completeEvent: mocks.completeEvent }),
}));
vi.mock("../services/csvExport.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/csvExport.js")>(),
  createExportPublicationValidator: () => mocks.validateSession,
  publishBoundedCsv: mocks.publish,
}));
vi.mock("./policy.js", () => ({
  policyRoute: (_router: Router, method: string, path: string, _policy: RoutePolicy, handler: RequestHandler) => {
    mocks.handlers.set(`${method} ${path}`, handler);
  },
}));

const snapshot: InventorySnapshot = {
  id: "11111111-1111-4111-8111-111111111111", roleScope: "full", environmentScope: null,
  requestedTypes: ["microsoft.copilotstudio/agents"], coverage: [],
  observedCount: 1, totalRecords: 1, pageCount: 1, unknownFieldCount: 0,
  observedAt: "2026-09-01T00:00:00Z", expiresAt: "2026-10-01T00:00:00Z",
  verification: {
    status: "verified", scope: "authorized_query", basis: "provider_total_and_saved_rows",
    checkedAt: "2026-09-01T00:00:00Z", storedCount: 1, uniqueIdentityCount: 1,
    queriedTypes: ["microsoft.copilotstudio/agents"],
  },
};
const resource: PowerPlatformResource = {
  tenantId: "tenant", nativeId: "native", type: "microsoft.copilotstudio/agents",
  displayName: "Agent", environmentId: "environment", location: null,
  createdAt: null, createdBy: null, lastPublishedAt: null, sourceSystem: "power_platform",
  authoringTool: null, creatorType: "unknown", agentKind: "agent", lifecycle: "unknown",
  identityConfidence: "exact_native", identifiers: [], provenance: {}, details: {}, unknownFieldCount: 0,
};

async function exportInventory() {
  const handler = mocks.handlers.get("get /inventory/export.csv");
  if (!handler) throw new Error("Inventory export handler was not registered.");
  const request = {
    query: { snapshotId: snapshot.id }, path: "/inventory/export.csv",
    session: { accountId: "principal", user: {
      tenantId: "tenant", homeAccountId: "principal", username: "reader@example.invalid",
      displayName: "Reader", roles: ["AgentControl.Viewer"],
    } },
  } as Request;
  await handler(request, { headersSent: false } as Response, error => { if (error) throw error; });
}

beforeEach(() => {
  mocks.list.mockReset().mockResolvedValue({ value: [resource], count: 1, snapshot });
  mocks.assertSnapshotCurrent.mockReset().mockResolvedValue(undefined);
  mocks.startEvent.mockReset().mockResolvedValue({ id: "audit-event" });
  mocks.completeEvent.mockReset().mockResolvedValue(undefined);
  mocks.validateSession.mockReset().mockImplementation(async validateSource => { await validateSource?.(); });
  mocks.publish.mockReset().mockResolvedValue(undefined);
  mocks.submitInventory.mockReset();
  mocks.startInventory.mockReset();
  mocks.getInventory.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe("Power Platform refresh admission responses", () => {
  it.each(["/inventory/refresh-jobs", "/inventory/refresh-jobs/:id/resume"])(
    "returns the persisted permission failure from %s instead of an authorization wait", async path => {
      const job: InventoryRefreshJob = {
        id: "11111111-1111-4111-8111-111111111111", status: "failed", roleScope: "full",
        requestedTypes: ["microsoft.copilotstudio/agents"], environmentScope: null,
        pageCount: 0, observedCount: 0, totalRecords: null, unknownFieldCount: 0, snapshotId: null,
        errorCode: "missing_permission", message: "Review permissions; signing in again does not grant permissions.",
        createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
        attemptedAt: null, finishedAt: "2026-09-01T00:00:00Z",
      };
      mocks.submitInventory.mockResolvedValue({ ...job, status: "waiting_authorization" });
      mocks.startInventory.mockRejectedValue(new AppError(403, "missing_permission", "Permission denied."));
      mocks.getInventory.mockResolvedValue(job);
      const handler = mocks.handlers.get(`post ${path}`)!;
      const request = {
        params: { id: job.id }, body: {}, get: () => undefined,
        session: { user: {
          tenantId: "tenant", homeAccountId: "principal", username: "reader@example.invalid",
          displayName: "Reader", roles: ["AgentControl.Viewer"],
        } },
      } as Request;
      const response = { locals: {}, status: vi.fn().mockReturnThis(), json: vi.fn() };
      await handler(request, response as Response, error => { if (error) throw error; });
      expect(response.status).toHaveBeenCalledWith(202);
      expect(response.json).toHaveBeenCalledWith(job);
      expect(mocks.getInventory).toHaveBeenCalledWith(request.session.user, job.id);
    },
  );
});

describe("Power Platform agent export", () => {
  it("parses only agent export filters and sorting", () => {
    expect(inventoryExportQuery({ environmentId: "environment", search: "Agent", sortBy: "createdAt", sortDirection: "desc" })).toEqual({
      environmentId: "environment", search: "Agent", sortBy: "createdAt", sortDirection: "desc",
    });
    expect(inventoryExportQuery({})).toEqual({
      environmentId: undefined, search: undefined, sortBy: "displayName", sortDirection: "asc",
    });
  });

  describe("CSV projection", () => {
    it("keeps source reads inside the session publication fence", async () => {
      let authorized = true;
      mocks.assertSnapshotCurrent.mockImplementationOnce(async () => { authorized = false; });
      mocks.validateSession.mockImplementation(async validateSource => {
        await validateSource?.();
        if (!authorized) throw AppError.unauthorized("The export session was revoked.");
      });

      await expect(exportInventory()).rejects.toMatchObject({ code: "unauthorized" });
      expect(mocks.assertSnapshotCurrent).toHaveBeenCalledOnce();
      expect(mocks.list).not.toHaveBeenCalled();
      expect(mocks.publish).not.toHaveBeenCalled();
      expect(mocks.completeEvent).toHaveBeenCalledWith("audit-event", { status: "failed", errorCode: "unauthorized" });
    });

    it.each(["before", "during"] as const)("stops projecting when the deadline expires %s projection", async phase => {
      const startedAt = Date.now();
      let now = startedAt;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const firstName = vi.fn(() => {
        now = startedAt + 15_000;
        return "First";
      });
      const secondName = vi.fn(() => "Second");
      mocks.list.mockImplementation(async () => {
        if (phase === "before") now = startedAt + 15_000;
        return { snapshot, count: 2, value: [
          { ...resource, get displayName() { return firstName(); } },
          { ...resource, nativeId: "second", get displayName() { return secondName(); } },
        ] };
      });

      await expect(exportInventory()).rejects.toMatchObject({ code: "export_deadline" });
      expect(firstName).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
      expect(secondName).not.toHaveBeenCalled();
      expect(mocks.publish).not.toHaveBeenCalled();
      expect(mocks.completeEvent).toHaveBeenCalledWith("audit-event", { status: "failed", errorCode: "export_deadline" });
    });

    it("stops projecting remaining bounded capability lists after exceeding the byte limit", async () => {
      const lastName = vi.fn(() => "Last");
      const value = Array.from({ length: 100 }, (_, index) => ({
        ...resource, nativeId: `native-${index}`, details: {
          connectorDetailsStatus: "complete" as const,
          distinctPowerPlatformConnectors: 1, distinctPowerPlatformConnectorsOperations: 200,
          connectors: [{ connectorId: "shared_test", operations: Array.from({ length: 200 }, (_, operation) => ({
            operationId: `${operation}`.padEnd(512, "x"),
          })) }],
        },
      }));
      value.push({ ...value[0], nativeId: "last", get displayName() { return lastName(); } });
      mocks.list.mockResolvedValue({ value, count: value.length, snapshot });

      await expect(exportInventory()).rejects.toMatchObject({ code: "export_byte_limit" });
      expect(lastName).not.toHaveBeenCalled();
      expect(mocks.publish).not.toHaveBeenCalled();
      expect(mocks.completeEvent).toHaveBeenCalledWith("audit-event", { status: "failed", errorCode: "export_byte_limit" });
    });

    it("preserves safe configured operations, provenance and snapshot context in source CSV", async () => {
      const provenance = { sourceSystem: "power_platform", path: "properties.powerPlatformConnectors", maturity: "preview" } as const;
      mocks.list.mockResolvedValue({ snapshot, count: 1, value: [{
        ...resource, displayName: "=Agent", provenance: { connectors: provenance }, details: {
          connectorDetailsStatus: "partial", distinctPowerPlatformConnectors: 1, distinctPowerPlatformConnectorsOperations: 2,
          connectors: [{ connectorId: "shared_test", operations: [{
            operationId: "read", isEnabled: false, requiresEndUserConsent: false,
            ...{ connectionIdSharedByMaker: "excluded-connection", callbackUrl: "https://excluded.invalid" },
          }] }],
        },
      }] });

      await exportInventory();

      expect(mocks.validateSession).toHaveBeenCalledOnce();
      expect(mocks.assertSnapshotCurrent).toHaveBeenCalledWith({ tenantId: "tenant", principalId: "principal" }, snapshot.id);
      expect(mocks.publish).toHaveBeenCalledOnce();
      const [, , filename, csv, options] = mocks.publish.mock.calls[0];
      expect(filename).toBe("power-platform-inventory.csv");
      const [exported] = parseCsv(csv, { columns: true, bom: true });
      expect(exported).toMatchObject({
        displayName: "'=Agent", snapshotId: snapshot.id, snapshotObservedAt: snapshot.observedAt,
        snapshotExpiresAt: snapshot.expiresAt, connectorDetailsStatus: "partial",
        reportedConnectorTotal: "1", reportedOperationTotal: "2", savedConnectorDetails: "1", savedOperationDetails: "1",
        invokedFlowContext: "unavailable_from_synced_sources",
      });
      expect(JSON.parse(exported.configuredConnectors)).toEqual([{
        connectorId: "shared_test", operations: [{ operationId: "read", isEnabled: false, requiresEndUserConsent: false }],
      }]);
      expect(JSON.parse(exported.capabilityProvenance)).toEqual({ connectors: provenance, counts: null });
      expect(csv.toString("utf8")).not.toContain("excluded");
      await options.validate();
      expect(mocks.validateSession).toHaveBeenCalledTimes(2);
      expect(mocks.assertSnapshotCurrent).toHaveBeenCalledTimes(2);
      await options.beforeEnd?.();
      expect(mocks.completeEvent).toHaveBeenCalledWith("audit-event", {
        status: "succeeded", metadata: { source: "power_platform", snapshotId: snapshot.id, resultingCount: 1, resultingBytes: csv.byteLength },
      });
    });
  });

  it.each([
    { type: "microsoft.powerplatform/environments" }, { type: "microsoft.copilotstudio/agents" },
    { excludeAgents: "true" }, { excludeAgents: "false" }, { limit: "25" }, { offset: "50" },
    { sortBy: "type" }, { environmentId: "invalid\nscope" }, { search: "x".repeat(257) },
  ])("rejects retired catalog filters or invalid agent scope %j", query => {
    expect(() => inventoryExportQuery(query)).toThrowError(expect.objectContaining({ code: "invalid_inventory_query" }));
  });
});
