import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InventoryMutationStages } from "../db/inventoryMutationStages.js";
import { createJobConfirmation, JobRepository } from "../db/jobs.js";
import { activateAccountSession, clearAccountSessionMutationsForTest } from "../db/sessions.js";
import { digest } from "../db/dataBounds.js";
import { AppError } from "../errors.js";
import { submitInventoryBlock } from "../routes/inventoryMutations.js";
import { unknownOrigin } from "../types/actionOrigin.js";
import type { AgentControlPreview } from "../types/agentControls.js";
import type { AuthenticatedUser } from "../types/session.js";
import { AgentControls } from "./agentControls.js";
import { capabilities } from "./capabilities.js";
import { copilotStudioQuarantineJobs } from "./copilotStudioQuarantineJobs.js";
import type { SelectionIdentity } from "./dataSelections.js";
import { reportIdentity } from "./reportIdentity.js";

const stages = vi.hoisted(() => ({
  withCurrentSelection: vi.fn<(id: string, identity: SelectionIdentity,
    work: (client: pg.PoolClient) => Promise<unknown>) => Promise<unknown>>(),
  inCurrentSelection: vi.fn(async () => undefined),
  preview: vi.fn<InventoryMutationStages["preview"]>(),
}));
vi.mock("../db/inventoryMutationStages.js", () => ({
  InventoryMutationStages: class {
    queries = stages;
    preview = stages.preview;
  },
}));
vi.mock("../db/pool.js", () => ({
  pool: {
    query: vi.fn(async () => { throw new Error("Unit tests must not query a database."); }),
    connect: vi.fn(async () => { throw new Error("Unit tests must not open a database connection."); }),
  },
  secretValue: (name: string) => name === "SESSION_SECRET" ? "synthetic-agent-controls-session-secret" : undefined,
}));
vi.mock("./operationalState.js", () => ({ requireProviderAdmissions: vi.fn() }));
vi.mock("./reportIdentity.js", () => ({ reportIdentity: vi.fn() }));
vi.mock("../routes/inventoryMutations.js", () => ({ submitInventoryBlock: vi.fn() }));

const at = new Date("2030-01-01T00:00:00Z");
const selectionId = "10000000-0000-4000-8000-000000000001";
const agentId = "20000000-0000-4000-8000-000000000001";
const recordId = `agent:${agentId}`;
const user: AuthenticatedUser = {
  tenantId: "control-tenant", homeAccountId: "control-operator",
  username: "operator@example.invalid", displayName: "Operator", roles: ["AgentControl.Admin"],
};
const identity: SelectionIdentity = {
  tenantId: user.tenantId!, principalId: user.homeAccountId, authorizationHash: "a".repeat(64), sessionEpoch: "0",
};
const binding = {
  agent_id: agentId, source_scope_id: "package-scope", source_generation_id: "package-generation",
  source_identity: "package-identity", native_id: "opaque-package", environment_id: "",
  control_revision: "canonical-generation", snapshot_id: "package-snapshot",
  authority_expires_at: new Date(at.getTime() + 600_000), source: "graph_packages",
  residual: { id: "opaque-package", displayName: "Package agent", authoringTool: "Visual Studio", isBlocked: false },
};
type TestChild =
  | { provider: "graph_packages"; recordIds: string[]; ids: string[]; confirmationHash: string }
  | { provider: "power_platform"; recordIds: string[]; resourceNativeIds: string[]; snapshotId: string; confirmationHash: string };
type TestReceipt = {
  id: string; authorization_hash: string; session_epoch: string;
  receipt: { preview: AgentControlPreview; bindingHash: string; children: TestChild[] };
  confirmation_hash: string; expires_at: Date; accepted_at: Date | null; idempotency_key: string | null;
  initiating_actor: (AuthenticatedUser & { tenantId: string }) | null; origin: typeof unknownOrigin | null;
};
function result(rows: pg.QueryResultRow[] = []): pg.QueryResult {
  return { command: "SELECT", oid: 0, fields: [], rowCount: rows.length, rows };
}

function fixture() {
  const database = new pg.Pool();
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const state: { row: TestReceipt | null; inserted: boolean } = { row: null, inserted: false };
  const query = vi.fn(async (statement: unknown, values?: unknown[]) => {
    if (typeof statement !== "string") throw new Error("Unexpected query shape");
    if (statement.startsWith("WITH selected AS")) return result([binding]);
    if (statement.startsWith("SELECT LEAST(expires_at")) return result([{ expires_at: binding.authority_expires_at }]);
    if (statement.includes("pg_advisory_xact_lock")) return result();
    if (statement.startsWith("SELECT count(*) FILTER")) return result([{ actor: 0, tenant: 0 }]);
    if (statement.startsWith("INSERT INTO agent_control_receipts")) {
      state.inserted = true;
      return result();
    }
    if (statement.startsWith("SELECT * FROM agent_control_receipts")) return result(state.row ? [state.row] : []);
    if (statement.startsWith("SELECT id FROM agent_control_receipts")) {
      return result(state.row?.idempotency_key === values?.[2] ? [{ id: state.row?.id }] : []);
    }
    if (statement.startsWith("UPDATE agent_control_receipts SET accepted_at")) {
      if (!state.row) throw new Error("Missing receipt");
      state.row.accepted_at = new Date();
      state.row.idempotency_key = String(values?.[1]);
      state.row.initiating_actor = { ...user, tenantId: identity.tenantId };
      state.row.origin = unknownOrigin;
      return result([state.row]);
    }
    throw new Error(`Unexpected control query: ${statement}`);
  });
  vi.spyOn(database, "query").mockImplementation(query);
  vi.spyOn(client, "query").mockImplementation(query);
  stages.withCurrentSelection.mockImplementation(async (_id, _identity, work) => work(client));
  vi.mocked(reportIdentity).mockResolvedValue(identity);
  vi.spyOn(capabilities, "requireAvailable").mockImplementation(async capabilityId => ({
    capabilityId, status: "available", authorized: true, fresh: true, previewQualification: "not_required", remediation: [],
  }));
  vi.spyOn(JobRepository.prototype, "getByIdempotency").mockResolvedValue(undefined);
  vi.spyOn(copilotStudioQuarantineJobs, "existingSubmission").mockResolvedValue(undefined);
  return { controls: new AgentControls(database), query, state, client };
}

function packageStage(action: "block" | "unblock" = "block"): Awaited<ReturnType<InventoryMutationStages["preview"]>> {
  return { stageId: "50000000-0000-4000-8000-000000000001", selectionId, confirmationHash: "b".repeat(64), summary: createJobConfirmation({
    actor: user, action, scope: "bulk", requestPath: "/api/agent-controls/execute",
    targets: [{ id: binding.native_id, displayName: binding.residual.displayName, prestate: { kind: "block", isBlocked: false } }],
  }).summary };
}

function packageJob(action: "block" | "unblock" = "block"): Awaited<ReturnType<typeof submitInventoryBlock>> {
  return {
    id: "40000000-0000-4000-8000-000000000001", origin: unknownOrigin,
    capabilityId: "graph.package.block.manage", tokenMode: "delegated", status: "queued",
    confirmationHash: "b".repeat(64), confirmation: packageStage(action).summary, confirmedAt: at.toISOString(),
    action, targetBlockedState: action === "block", total: 1, completed: 0, succeeded: 0, failed: 0, skipped: 0,
    inconclusive: 0, cancelled: 0, queued: 1, reconciliationRequired: 0, retryEligible: 0,
    resultRevision: "1", currentAgentName: undefined, createdAt: at.toISOString(), updatedAt: at.toISOString(), canResume: false,
  };
}

function accepted(f: ReturnType<typeof fixture>, children = true) {
  const preview: AgentControlPreview = {
    receiptId: "30000000-0000-4000-8000-000000000001", confirmationHash: "c".repeat(64),
    selectionId, action: "block", expiresAt: binding.authority_expires_at.toISOString(),
    targetCount: 1, eligibleCount: children ? 1 : 0, ineligibleCount: children ? 0 : 1,
    alreadyInStateCount: 0, targets: [{ recordId, displayName: "Package agent",
      eligible: children, reason: children ? null : "missing_platform", effects: [] }], providerAtomicity: false,
  };
  const row: TestReceipt = {
    id: preview.receiptId, authorization_hash: identity.authorizationHash, session_epoch: "0",
    receipt: { preview, bindingHash: digest(JSON.stringify([binding])), children: children ? [{
      provider: "graph_packages", recordIds: [recordId], ids: [binding.native_id], confirmationHash: "b".repeat(64),
    }] : [] },
    confirmation_hash: preview.confirmationHash, expires_at: binding.authority_expires_at,
    accepted_at: at, idempotency_key: "operation-key",
    initiating_actor: { ...user, tenantId: identity.tenantId }, origin: unknownOrigin,
  };
  f.state.row = row;
  return row;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.mocked(submitInventoryBlock).mockReset();
  stages.withCurrentSelection.mockReset();
  clearAccountSessionMutationsForTest();
  vi.useRealTimers();
});

describe("shared agent control lifecycle without external services", () => {
  it.each(["block", "unblock"] as const)("previews, accepts and reads a fresh %s without an extra enablement step", async action => {
    const f = fixture(), job = packageJob(action);
    stages.preview.mockResolvedValue(packageStage(action));
    const preview = await f.controls.preview(user, selectionId, [recordId, "report:unmanaged"], action);
    expect(preview).toMatchObject({ targetCount: 2, eligibleCount: 1, ineligibleCount: 1,
      targets: [{ recordId, eligible: true, effects: [{ provider: "graph_packages", action, id: binding.native_id }] },
        { recordId: "report:unmanaged", eligible: false, reason: "report_only", effects: [] }] });
    const row = accepted(f);
    row.id = preview.receiptId;
    row.receipt.preview = preview;
    row.confirmation_hash = preview.confirmationHash;
    row.accepted_at = null;
    row.idempotency_key = null;
    row.initiating_actor = null;
    row.origin = null;
    vi.mocked(submitInventoryBlock).mockResolvedValue(job);
    vi.mocked(JobRepository.prototype.getByIdempotency).mockResolvedValue(job);
    expect(await f.controls.execute(user, row.id, row.confirmation_hash, "operation-key")).toMatchObject({
      outcome: "partial", final: false, verified: false, children: [{ accepted: true, status: "queued", verification: "pending" }],
    });
    expect(submitInventoryBlock).toHaveBeenCalledWith(expect.anything(), user, {
      action, selectionId, ids: [binding.native_id], confirmationHash: "b".repeat(64),
      idempotencyKey: `agent-control-${row.id}-0`,
    });
    job.status = "succeeded";
    job.completed = 1;
    job.succeeded = 1;
    job.queued = 0;
    vi.setSystemTime(row.expires_at);
    expect(await f.controls.execute(user, row.id, row.confirmation_hash, "operation-key")).toMatchObject({
      outcome: "partial", final: true, verified: true,
      children: [{ accepted: true, jobId: job.id, final: true, verified: true, errorCode: null }],
    });
    expect(await f.controls.status(user, row.id)).toMatchObject({ outcome: "partial", final: true, verified: true });
    expect(submitInventoryBlock).toHaveBeenCalledOnce();
  });

  it("does not return a preview when the session changes after its selection transaction", async () => {
    const f = fixture();
    stages.withCurrentSelection.mockImplementation(async (_id, _identity, work) => {
      const value = await work(f.client);
      if (f.state.inserted) await activateAccountSession(identity.tenantId, identity.principalId, async () => undefined);
      return value;
    });
    stages.preview.mockResolvedValue(packageStage());
    await expect(f.controls.preview(user, selectionId, [recordId], "block")).rejects.toMatchObject({ status: 401 });
  });

  it("retains the initiating session generation across the execution identity read", async () => {
    const f = fixture(), row = accepted(f, false);
    vi.mocked(reportIdentity).mockImplementationOnce(async () => {
      await activateAccountSession(identity.tenantId, identity.principalId, async () => undefined);
      return identity;
    });
    await expect(f.controls.execute(user, row.id, row.confirmation_hash, "operation-key")).rejects.toMatchObject({ status: 401 });
    expect(f.query).not.toHaveBeenCalled();
  });

  it.each(["execute", "status"] as const)("fences %s after the last retained child lookup", async operation => {
    const f = fixture(), row = accepted(f);
    vi.mocked(submitInventoryBlock).mockRejectedValue(new AppError(503, "workers_busy", "Synthetic admission failure."));
    vi.mocked(JobRepository.prototype.getByIdempotency).mockImplementationOnce(async () => {
      await activateAccountSession(identity.tenantId, identity.principalId, async () => undefined);
      return undefined;
    });
    const pending = operation === "execute"
      ? f.controls.execute(user, row.id, row.confirmation_hash, "operation-key") : f.controls.status(user, row.id);
    await expect(pending).rejects.toMatchObject({ status: 401 });
  });

  it("does not return a child submission after the initiating session is superseded", async () => {
    const f = fixture(), row = accepted(f);
    vi.mocked(submitInventoryBlock).mockImplementationOnce(async () => {
      await activateAccountSession(identity.tenantId, identity.principalId, async () => undefined);
      return packageJob();
    });
    await expect(f.controls.execute(user, row.id, row.confirmation_hash, "operation-key")).rejects.toMatchObject({ status: 401 });
  });

  it.each(["execute", "status"] as const)("marks an all-ineligible %s receipt final without claiming verification", async operation => {
    const f = fixture(), row = accepted(f, false);
    const execution = operation === "execute"
      ? await f.controls.execute(user, row.id, row.confirmation_hash, "operation-key") : await f.controls.status(user, row.id);
    expect(execution).toMatchObject({ outcome: "ineligible", final: true, verified: false, ineligibleCount: 1, children: [] });
    expect(submitInventoryBlock).not.toHaveBeenCalled();
  });

  it.each([
    { operation: "execute", provider: "graph_packages" }, { operation: "status", provider: "graph_packages" },
    { operation: "execute", provider: "power_platform" }, { operation: "status", provider: "power_platform" },
  ] as const)("marks an expired missing $provider child final in $operation without admitting work", async ({ operation, provider }) => {
    const f = fixture(), row = accepted(f);
    if (provider === "power_platform") row.receipt.children = [{
      provider, recordIds: [recordId], resourceNativeIds: ["native-agent"], snapshotId: selectionId, confirmationHash: "d".repeat(64),
    }];
    vi.setSystemTime(row.expires_at);
    const execution = operation === "execute"
      ? await f.controls.execute(user, row.id, row.confirmation_hash, "operation-key") : await f.controls.status(user, row.id);
    expect(execution).toMatchObject({ outcome: "failed", final: true, verified: false,
      children: [{ accepted: false, final: true, verified: false, errorCode: "child_admission_expired" }] });
    expect(submitInventoryBlock).not.toHaveBeenCalled();
  });

  it("marks a missing child final if admission expires during a failed submission", async () => {
    const f = fixture(), row = accepted(f);
    vi.mocked(submitInventoryBlock).mockImplementationOnce(async () => {
      vi.setSystemTime(row.expires_at);
      throw new AppError(503, "workers_busy", "Synthetic admission failure.");
    });
    expect(await f.controls.execute(user, row.id, row.confirmation_hash, "operation-key")).toMatchObject({
      outcome: "failed", final: true, verified: false,
      children: [{ accepted: false, final: true, errorCode: "workers_busy" }],
    });
  });

  it.each(["queued", "succeeded"] as const)("preserves an existing %s child's own lifecycle after receipt expiry", async status => {
    const f = fixture(), row = accepted(f), job = packageJob();
    job.status = status;
    job.succeeded = status === "succeeded" ? 1 : 0;
    vi.mocked(JobRepository.prototype.getByIdempotency).mockResolvedValue(job);
    vi.setSystemTime(row.expires_at);
    expect(await f.controls.status(user, row.id)).toMatchObject({
      final: status === "succeeded", verified: status === "succeeded",
      children: [{ accepted: true, status, final: status === "succeeded", errorCode: null }],
    });
    expect(submitInventoryBlock).not.toHaveBeenCalled();
  });

  it("leaves a missing child non-final while exact admission can still be retried", async () => {
    const f = fixture(), row = accepted(f);
    expect(await f.controls.status(user, row.id)).toMatchObject({ final: false,
      children: [{ accepted: false, final: false, errorCode: "child_not_accepted" }] });
    expect(submitInventoryBlock).not.toHaveBeenCalled();
  });
});
