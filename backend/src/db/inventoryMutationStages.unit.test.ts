import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SelectionIdentity } from "../services/dataSelections.js";
import { unknownOrigin } from "../types/actionOrigin.js";
import { InventoryMutationStages, type StagedMutationIntent } from "./inventoryMutationStages.js";
import type { InventoryQueries } from "./inventoryQueries.js";
import { createJobConfirmation, JobRepository } from "./jobs.js";

const databases: pg.Pool[] = [];
const identity: SelectionIdentity = {
  tenantId: "tenant", principalId: "operator", authorizationHash: "a".repeat(64), sessionEpoch: "1",
};
const selectionId = "10000000-0000-4000-8000-000000000001";
const agentId = "20000000-0000-4000-8000-000000000001";
const recordId = `agent:${agentId}`;
const intent: StagedMutationIntent = {
  action: "block", scope: "bulk", requestPath: "/agents/mutation-preview",
  actor: { tenantId: identity.tenantId, homeAccountId: identity.principalId, displayName: "Operator", username: "operator@example.invalid" },
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map(database => database.end()));
});

function result(rows: pg.QueryResultRow[] = []): pg.QueryResult {
  return { command: "SELECT", rowCount: rows.length, fields: [], oid: 0, rows };
}

function fixture(ids = ["A"]) {
  const database = new pg.Pool({ max: 4 });
  databases.push(database);
  vi.spyOn(database, "connect").mockRejectedValue(new Error("Unit tests must not open a database connection."));
  const stages = new InventoryMutationStages(database);
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const at = new Date("2030-01-01T00:00:00Z");
  const source = {
    generationId: null, scopeId: null, revision: null, expiresAt: null, observedAt: null, attemptedAt: null,
    attemptStatus: null, attemptObservedCount: null, errorCode: null, message: null, rowCount: null,
    state: "unavailable" as const, reportRefreshDate: null, period: null, reportVersion: null,
  };
  const context: Parameters<Parameters<InventoryQueries["withCurrentSelection"]>[2]>[1] = {
    selectionId, expiresAt: at.getTime() + 600_000, scopeId: "scope", baselineId: "baseline", revision: "1",
    source: "inventory_canonical", query: {},
    data: {
      identity, evaluatedAt: at, query: {},
      publicationRevisions: { graph_packages: "a".repeat(64), power_platform: "b".repeat(64), users: "c".repeat(64) },
      metadata: { directory: { ...source, source: "directory" }, app_activity: { ...source, source: "app_activity" } },
      report: {
        setId: null, activeSetId: null, activeRevision: "0", historyRevision: "0", historyEpoch: "0",
        availability: "never_imported", staleAfterDays: 7, periodAgeDays: null, acceptedAgeDays: null,
        reportingPeriod: null, acceptedAt: null, expiresAt: null, lineages: [],
      },
    },
  };
  const targets = [...ids].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))).map(id => ({
    id, generation_id: "generation", source_identity: `source:${id}`, display_name: `Package ${id}`,
    agent_id: agentId, membership_count: 1,
  }));
  const saved: Array<{
    id: unknown; selection_id: unknown; intent: unknown; target_filter_hash: unknown;
    confirmation_hash?: unknown; summary?: unknown;
  }> = [];
  const state = { actorPreviews: 0, tenantPreviews: 0, validTargets: targets.length };
  const query = vi.fn(async (statement: unknown, values?: unknown[]) => {
    if (typeof statement !== "string") throw new Error("Unexpected query shape.");
    if (statement.includes("pg_advisory_xact_lock")) return result();
    if (statement.includes("AS tenant,count(*) FILTER")) {
      return result([{ actor: state.actorPreviews, tenant: state.tenantPreviews }]);
    }
    if (statement.startsWith("SELECT native_id,count(*)")) return result(targets.map(target => ({
      native_id: target.id, memberships: 1, source_generation_id: target.generation_id,
      source_identity: target.source_identity, agent_id: target.agent_id, authority_expires_at: at,
    })));
    if (statement.startsWith("SELECT residual FROM package_record_rows")) return result([{ residual: { isBlocked: false } }]);
    if (statement.startsWith("INSERT INTO inventory_mutation_stages")) {
      saved.push({ id: values?.[0], selection_id: values?.[4], intent: values?.[5], target_filter_hash: values?.[6] });
      return result();
    }
    if (statement.startsWith("INSERT INTO inventory_mutation_targets")) return result();
    if (statement.startsWith("WITH current_sources AS MATERIALIZED")) {
      return result([{ total: targets.length, valid: state.validTargets }]);
    }
    if (statement.startsWith("UPDATE inventory_mutation_stages SET target_count")) {
      const stage = saved.find(row => row.id === values?.[0]);
      if (!stage) throw new Error("Missing staged intent.");
      stage.confirmation_hash = values?.[3];
      stage.summary = values?.[4];
      return result();
    }
    if (statement.includes("SELECT id,selection_id,intent")) {
      return result(saved.filter(stage => stage.confirmation_hash === values?.[3]
        && (values?.[4] === null || stage.selection_id === values?.[4])
        && (!statement.includes("target_filter_hash=$6") || stage.target_filter_hash === values?.[5])).slice(-1));
    }
    throw new Error(`Unexpected mutation query: ${statement}`);
  });
  vi.spyOn(database, "query").mockImplementation(query);
  vi.spyOn(client, "query").mockImplementation(query);
  const selection = vi.spyOn(stages.queries, "withCurrentSelection")
    .mockImplementation((_id, _identity, work) => work(client, context));
  const count = vi.spyOn(stages.queries, "mutationTargetCount").mockResolvedValue(targets.length);
  vi.spyOn(stages.queries, "mutationTargets").mockImplementation(async (_client, _context, after) => {
    const offset = after === null ? 0 : targets.findIndex(target => target.id === after) + 1;
    return targets.slice(offset, offset + 100);
  });
  return { stages, client, context, query, selection, count, targets, state };
}

describe("mutation staging contracts without infrastructure", () => {
  it("counts the same filtered selection that preview expands", async () => {
    const { stages, context, count } = fixture();
    context.query = { search: "Package A", blocked: false };
    count.mockImplementation(async (_client, selected) => selected.query.search === "Package A" ? 1 : 2);
    const preview = await stages.preview(identity, selectionId, intent, undefined, [recordId]);

    await expect(stages.count(identity, selectionId, undefined, [recordId]))
      .resolves.toEqual({ count: preview.summary.targetCount });
  });

  it.each(["exact-first", "group-first"] as const)(
    "submits the matching criteria when equivalent previews share a confirmation hash (%s)", async order => {
      const { stages, client } = fixture();
      const exact = { ids: ["A"], recordIds: undefined };
      const group = { ids: undefined, recordIds: [recordId] };
      const [first, second] = order === "exact-first" ? [exact, group] : [group, exact];
      const original = await stages.preview(identity, selectionId, intent, first.ids, first.recordIds);
      const newer = await stages.preview(identity, selectionId, intent, second.ids, second.recordIds);
      expect(original.confirmationHash).toBe(newer.confirmationHash);
      const job: NonNullable<Awaited<ReturnType<JobRepository["get"]>>> = {
        id: "job", origin: unknownOrigin, capabilityId: "graph.package.block.manage", tokenMode: "delegated", status: "queued",
        confirmationHash: original.confirmationHash, confirmation: original.summary, confirmedAt: null, action: "block",
        targetBlockedState: true, total: 1, completed: 0, succeeded: 0, failed: 0, skipped: 0, inconclusive: 0,
        cancelled: 0, queued: 1, reconciliationRequired: 0, retryEligible: 0, resultRevision: "1",
        currentAgentName: undefined, createdAt: "2030-01-01T00:00:00Z", updatedAt: "2030-01-01T00:00:00Z", canResume: false,
      };
      const submit = vi.spyOn(JobRepository.prototype, "submitStaged").mockResolvedValue(job.id);
      vi.spyOn(JobRepository.prototype, "get").mockResolvedValue(job);
      const input = {
        ...intent, ...first, selectionId, confirmationHash: original.confirmationHash, idempotencyKey: "operation",
      };

      await expect(stages.submit(identity, input)).resolves.toEqual(job);
      expect(submit).toHaveBeenCalledWith(client, identity, original.stageId, input);
    },
  );

  it("rejects target criteria that were never previewed", async () => {
    const { stages, selection } = fixture();
    const preview = await stages.preview(identity, selectionId, intent, undefined, [recordId]);
    selection.mockClear();

    await expect(stages.submit(identity, {
      ...intent, selectionId, ids: ["A"], confirmationHash: preview.confirmationHash, idempotencyKey: "operation",
    })).rejects.toMatchObject({ code: "confirmation_mismatch" });
    expect(selection).not.toHaveBeenCalled();
  });

  it("preserves canonical confirmation hashes for opaque IDs across staging pages", async () => {
    const ids = [...Array.from({ length: 101 }, (_, index) => `package-${String(index).padStart(3, "0")}`), "A", "a", "\ue000", "😀"];
    const { stages } = fixture(ids);
    const preview = await stages.preview(identity, selectionId, intent, ids);
    const expected = createJobConfirmation({
      ...intent, targets: ids.map(id => ({ id, displayName: `Package ${id}`, prestate: { kind: "block", isBlocked: false } })),
    });

    expect(preview).toMatchObject({ confirmationHash: expected.confirmationHash, summary: expected.summary });
  });

  it.each([{ actorPreviews: 5, tenantPreviews: 5 }, { actorPreviews: 1, tenantPreviews: 40 }])(
    "enforces preview admission limits before reading targets (%j)", async counts => {
      const { stages, state, count } = fixture();
      Object.assign(state, counts);

      await expect(stages.preview(identity, selectionId, intent, ["A"]))
        .rejects.toMatchObject({ code: "mutation_preview_limit" });
      expect(count).not.toHaveBeenCalled();
    },
  );

  it("rejects ambiguous memberships and expired or changed target authority", async () => {
    const { stages, targets, state } = fixture();
    targets[0].membership_count = 2;
    await expect(stages.preview(identity, selectionId, intent, ["A"]))
      .rejects.toMatchObject({ code: "inventory_identity_ambiguous" });
    targets[0].membership_count = 1;
    state.validTargets = 0;
    await expect(stages.preview(identity, selectionId, intent, ["A"]))
      .rejects.toMatchObject({ code: "confirmation_mismatch" });
  });

  it("rejects changed target counts without publishing a confirmation", async () => {
    const { stages, count, query } = fixture();
    count.mockResolvedValue(2);

    await expect(stages.preview(identity, selectionId, intent, ["A"]))
      .rejects.toMatchObject({ code: "inventory_selection_changed" });
    expect(query.mock.calls.some(([sql]) => typeof sql === "string" && sql.startsWith("UPDATE inventory_mutation_stages"))).toBe(false);
  });

  it("rejects foreign actors before acquiring a selection", async () => {
    const { stages, selection } = fixture();

    await expect(stages.preview(identity, selectionId, {
      ...intent, actor: { ...intent.actor, homeAccountId: "another-operator" },
    }, ["A"])).rejects.toMatchObject({ code: "scope_mismatch" });
    expect(selection).not.toHaveBeenCalled();
  });
});
