import type { Request, Response } from "express";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { capabilities } from "../services/capabilities.js";
import { copilotStudioQuarantineControl } from "../services/copilotStudioQuarantineControl.js";
import { copilotStudioQuarantineRouter } from "./copilotStudioQuarantine.js";

vi.mock("../middleware/auth.js", async original => ({
  ...await original<typeof import("../middleware/auth.js")>(),
  requireSession: (_request: Request, _response: Response, next: () => void) => next(),
}));
const tenants = config.tenants;
beforeEach(() => { config.tenants = [{ tenantId: "tenant-a", clientId: "api-a", clientSecret: "synthetic", domains: ["example.invalid"] }]; });
afterEach(() => { config.tenants = tenants; vi.restoreAllMocks(); });

const snapshotId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const nativeId = "Native-Agent";
const status = {
  target: { resourceNativeId: nativeId, displayName: "Agent", environmentId: snapshotId, botId: snapshotId },
  direct: { isBotQuarantined: false, providerUpdatedAt: "2026-09-09T19:00:00Z", observedAt: "2026-09-09T19:01:00Z",
    correlationId: snapshotId, source: "cache" as const },
  inventory: { isQuarantined: false, quarantinedAt: null, observedAt: "2026-09-09T19:00:00Z", snapshotId },
  disagreesWithInventory: false,
};

function invoke(path: string, method: "get" | "post", roles = ["AgentControl.Admin"], csrf = true) {
  const route = copilotStudioQuarantineRouter.stack.find(layer => layer.route?.path === path && layer.route.methods[method])!.route!;
  const request = {
    session: { tenantId: "tenant-a", clientId: "api-a", accountId: "operator-a", user: { tenantId: "tenant-a", homeAccountId: "operator-a", displayName: "Operator",
      username: "operator@example.invalid", roles }, csrfToken: "synthetic-csrf" },
    query: { snapshotId, nativeId },
    body: { action: "quarantine", snapshotId, resourceNativeIds: [nativeId], confirmationHash: "e".repeat(64) },
    get: (name: string) => name.toLowerCase() === "idempotency-key" ? "saved-receipt" : csrf ? "synthetic-csrf" : undefined,
  } as unknown as Request;
  return new Promise<unknown>((resolve, reject) => {
    const response = { status: () => response, json: resolve } as unknown as Response;
    let index = 0;
    const next = (error?: unknown) => {
      if (error) { reject(error); return; }
      const layer = route.stack[index++];
      if (!layer) { reject(new Error("Route completed without a response.")); return; }
      try { Promise.resolve(layer.handle(request, response, next)).catch(reject); }
      catch (failure) { reject(failure); }
    };
    next();
  });
}

it("lets private cached status reach the service despite unavailable provider capability", async () => {
  const available = vi.spyOn(capabilities, "requireAvailable").mockRejectedValue(new AppError(403, "capability_unavailable", "Provider authority is unavailable."));
  const read = vi.spyOn(copilotStudioQuarantineControl, "status").mockResolvedValue(status);
  await expect(invoke("/quarantine/status", "get")).resolves.toBe(status);
  expect(read).toHaveBeenCalledOnce();
  expect(available).not.toHaveBeenCalled();
});

it("lets an exact saved receipt retry reach the service without preflight provider authorization", async () => {
  const available = vi.spyOn(capabilities, "requireAvailable").mockRejectedValue(new AppError(403, "capability_unavailable", "Provider authority is unavailable."));
  const receipt = { id: snapshotId, status: "succeeded" as const, action: "quarantine" as const, confirmationHash: "e".repeat(64),
    confirmation: { risk: true as const, operation: "quarantine" as const, provider: "Power Platform Copilot Studio" as const,
      endpoint: "api-version=1 botQuarantine" as const, permission: "Delegated CopilotStudio.AdminActions.Invoke" as const,
      targetCount: 1, targetSelectionHash: "f".repeat(64), actor: { id: "operator-a", displayName: "Operator", username: "operator@example.invalid" },
      packageControlIndependent: true as const, makerBehavior: "Makers can still test.", providerAtomicity: false as const, targets: [], additionalTargetCount: 0 },
    isCanary: false, total: 1, completed: 1, succeeded: 1, failed: 0, skipped: 0, inconclusive: 0, cancelled: 0,
    canResume: false, canReconcile: false, createdAt: "2026-09-09T19:00:00Z", updatedAt: "2026-09-09T19:01:00Z", results: [] };
  const submit = vi.spyOn(copilotStudioQuarantineControl, "submit").mockResolvedValue(receipt);
  await expect(invoke("/quarantine/jobs", "post")).resolves.toBe(receipt);
  expect(submit).toHaveBeenCalledOnce();
  expect(available).not.toHaveBeenCalled();
});

it.each(["role", "csrf"] as const)("still protects saved receipt retries with current %s authorization", async boundary => {
  const submit = vi.spyOn(copilotStudioQuarantineControl, "submit");
  await expect(invoke("/quarantine/jobs", "post", boundary === "role" ? ["AgentControl.Viewer"] : undefined, boundary !== "csrf"))
    .rejects.toMatchObject({ code: boundary === "role" ? "missing_internal_role" : "invalid_csrf" });
  expect(submit).not.toHaveBeenCalled();
});
