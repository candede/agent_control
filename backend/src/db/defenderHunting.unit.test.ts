import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import type { DefenderHuntingFilters, DefenderHuntingQueryResult } from "../types/defenderHunting.js";
import { GraphHuntingClient, expectedHuntingSchema, validateDefenderHuntingFilters } from "../services/graphHunting.js";
import { DefenderHuntingRepository, type DefenderHuntingScope } from "./defenderHunting.js";

vi.mock("../services/operationalState.js", () => ({ requireProviderAdmissions: vi.fn() }));

const id = "11111111-1111-4111-8111-111111111111";
const scope: DefenderHuntingScope = { tenantId: "tenant-a", authorizationPrincipalId: "reader",
  resultScope: { kind: "principal", scopeId: "reader", configurationRevision: null }, tokenMode: "delegated" };
const filters: DefenderHuntingFilters = { templateId: "agents_inventory", startDateTime: "2026-09-09T10:00:00.000Z",
  endDateTime: "2026-09-09T11:00:00.000Z", agentIds: [], blueprintIds: [], actorObjectIds: [], operations: [] };
const result: DefenderHuntingQueryResult = { rows: [], providerRowCount: 0, storedRowCount: 0, byteCount: 2, complete: true, partialReason: null };
const execution = { owner: "22222222-2222-4222-8222-222222222222", version: 1 };

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const database = new pg.Pool();
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  vi.spyOn(database, "connect").mockImplementation(async () => client);
  const response = (rows: object[] = []) => ({ command: "", oid: 0, fields: [], rowCount: rows.length, rows });
  const now = new Date();
  const row = { id, authorization_principal_id: scope.authorizationPrincipalId, result_scope_id: scope.resultScope.scopeId,
    result_scope_kind: scope.resultScope.kind, result_scope_configuration_revision: null, token_mode: scope.tokenMode,
    status: "running", filters, query_version: 3, local_request_id: execution.owner,
    provider_request_id: null, provider_request_count: 1, activation_count: 1, execution_owner: execution.owner, execution_version: "1",
    provider_row_count: 0, stored_row_count: 0, byte_count: 2, result_complete: true, no_data: true, partial_reason: null,
    observed_start: null, observed_end: null, unobserved_start: null, unobserved_end: null, error_code: null, message: null,
    cancel_requested: false, created_at: now, attempted_at: now, updated_at: now, finished_at: now, expires_at: new Date(Date.now() + 60_000),
    deadline_at: new Date(Date.now() + 60_000), };
  const query = vi.fn(async (text: unknown, _values?: unknown[]) => response(typeof text === "string" && text.includes("FOR UPDATE") ? [row]
    : typeof text === "string" && text.includes("UPDATE defender_hunting_jobs SET status=") ? [{ ...row, status: "succeeded" }] : []));
  vi.spyOn(client, "query").mockImplementation(query);
  const databaseQuery = vi.fn(async (_text: unknown, _values?: unknown[]) => response());
  vi.spyOn(database, "query").mockImplementation(databaseQuery);
  return { repository: new DefenderHuntingRepository(database), query, databaseQuery, response, row, client };
}

function projectedClient(selected: DefenderHuntingFilters, overrides: Record<string, unknown>,
  headers: NonNullable<ConstructorParameters<typeof Response>[1]>["headers"] = {}) {
  const defaults = Object.fromEntries(expectedHuntingSchema(selected.templateId).map(({ name }) => [name, ""]));
  const projected = selected.templateId === "agents_inventory" ? {
    ...defaults, ObservationTime: "2026-09-09T10:30:00.000Z", AgentId: "NativeAgent", ProjectionValid: "true",
    OwnersState: "not_supplied", SharedWithState: "not_supplied", PermissionsState: "not_supplied",
    AuthenticationState: "not_supplied", RiskState: "not_exposed", ...overrides,
  } : {
    ...defaults, Timestamp: "2026-09-09T10:30:00.000Z", ActionType: selected.operations[0],
    Operation: selected.templateId === "agent_tools" ? "execute_tool" : "invoke_agent", ProjectionValid: "true",
    ConversationIdState: "null", ThreadIdState: "unavailable", ChannelNameState: "null",
    HumanUserKeyState: selected.templateId === "agent_tools" ? "unavailable" : "null",
    AgentUserKeyState: selected.templateId === "agent_tools" ? "null" : "unavailable",
    TargetAgentUserKeyState: selected.templateId === "agent_tools" ? "unavailable" : "null",
    CompletionTimeState: "null", ErrorTypeState: selected.templateId === "agent_tools" ? "unavailable" : "null",
    PlatformAgentIdState: "null", PlatformAgentTypeState: "null", ...overrides,
  };
  return new GraphHuntingClient({ fetch: vi.fn(async () => new Response(JSON.stringify({
    schema: expectedHuntingSchema(selected.templateId), results: [projected],
  }), { headers })), wait: vi.fn(), random: () => 0 });
}

describe("Defender publication transaction without a database", () => {
  it.each(["delegated", "application"] as const)("always stores an exact-target SHA-256 for current %s submissions", async tokenMode => {
    const f = fixture();
    const currentScope: DefenderHuntingScope = tokenMode === "delegated" ? scope : {
      ...scope, tokenMode, resultScope: { kind: "application", scopeId: "application-client", configurationRevision: 1 },
    };
    const query = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (text, values) => typeof text === "string" && text.includes("AS principal_count")
      ? f.response([{ principal_count: 0, tenant_count: 0 }]) : query(text, values));
    f.databaseQuery.mockResolvedValue(f.response([f.row]));
    const targets: DefenderHuntingFilters[] = [
      filters,
      { ...filters, startDateTime: "2026-09-10T10:00:00.000Z", endDateTime: "2026-09-10T11:00:00.000Z" },
      { ...filters, agentIds: [id] },
      { ...filters, entraAgentIds: [id] },
    ];
    for (const [index, selected] of targets.entries()) {
      await f.repository.submit(currentScope, { idempotencyKey: `target-hash-${index}`, filters: selected });
    }
    const inserts = f.query.mock.calls.filter(([text]) => typeof text === "string" && text.includes("INSERT INTO defender_hunting_jobs"));
    expect(inserts).toHaveLength(targets.length);
    const hashes = inserts.map(([text, values]) => {
      expect(text).toContain("target_scope_hash");
      const hash = values?.[12];
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      return hash;
    });
    expect(hashes[0]).toBe(hashes[1]);
    expect(new Set([hashes[0], hashes[2], hashes[3]]).size).toBe(3);
    await f.repository.getJob(currentScope, id);
    expect(f.databaseQuery.mock.lastCall?.[0]).toContain("previous.target_scope_hash=job.target_scope_hash");
  });

  it.each(["cancel", "delete"] as const)("denies foreign application %s under both saved and execution scopes while leaving shared reads available", async action => {
      const f = fixture();
      const applicationScope: DefenderHuntingScope = { ...scope, tokenMode: "application",
        resultScope: { kind: "application", scopeId: "application-client", configurationRevision: 1 } };
      const readScope = { tenantId: scope.tenantId, authorizationPrincipalId: scope.authorizationPrincipalId,
        resultScopes: [applicationScope.resultScope], };
      const foreign = { ...f.row, authorization_principal_id: "other-owner", result_scope_kind: "application",
        result_scope_id: "application-client", result_scope_configuration_revision: "1", token_mode: "application", status: "succeeded" };
      f.databaseQuery.mockResolvedValue(f.response([foreign]));
      await expect(f.repository.getJob(readScope, id)).resolves.toMatchObject({ authorizationPrincipalId: "other-owner" });
      f.query.mockImplementation(async text => f.response(typeof text === "string" && /^(UPDATE|DELETE)/.test(text) ? [foreign] : []));
      for (const mutationScope of [readScope, applicationScope]) {
        await expect(f.repository[action](mutationScope, id)).rejects.toMatchObject({
          status: 404, code: "not_found", message: "Hunting job was not found.",
        });
      }
      const ownerReads = f.query.mock.calls.filter(([text]) => typeof text === "string" && text.includes("FOR UPDATE"));
      expect(ownerReads).toHaveLength(2);
      for (const [text, values] of ownerReads) {
        expect(text).toContain("AND job.authorization_principal_id=$");
        expect(values?.slice(-2)).toEqual([scope.authorizationPrincipalId, id]);
      }
      expect(f.query.mock.calls.some(([text]) => typeof text === "string" && /^(UPDATE|DELETE)/.test(text))).toBe(false);
      expect(f.query).not.toHaveBeenCalledWith("COMMIT");
  });

  it.each(["cancel", "delete"] as const)("retains the owned-job state error for invalid %s without treating it as a missing foreign job", async action => {
    const f = fixture();
    f.row.status = action === "cancel" ? "succeeded" : "running";
    await expect(f.repository[action](scope, id)).rejects.toMatchObject({ status: 409, code: "hunting_job_state" });
    expect(f.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it.each(["failure", "pause"] as const)("returns the durable %s outcome without a fallible settlement reread", async outcome => {
    const f = fixture();
    const status = outcome === "failure" ? "inconclusive" : "waiting_authorization";
    const priorSuccessfulJobId = "33333333-3333-4333-8333-333333333333";
    f.databaseQuery.mockImplementation(async text => {
      if (typeof text === "string" && text.includes("FOR UPDATE")) return f.response([f.row]);
      if (typeof text === "string" && text.startsWith("UPDATE defender_hunting_jobs")) {
        return f.response([{ ...f.row, status, result_complete: false, no_data: false,
          prior_successful_job_id: priorSuccessfulJobId }]);
      }
      throw new Error("Post-settlement reads are unavailable.");
    });
    await expect(outcome === "failure" ? f.repository.fail(scope, id, execution, "provider_error", "Bounded request failed.", true)
      : f.repository.markWaitingAuthorization(scope, id, execution)).resolves.toMatchObject({
      id, status, priorSuccessfulJobId, snapshotId: null, canResume: outcome === "pause",
    });
  });

  it.each(["admission", "submission", "response"] as const)("checks %s authority in the transaction's COMMIT fence", async phase => {
    const f = fixture();
    let allowed = true;
    f.query.mockImplementation(async text => {
      if (typeof text !== "string") return f.response();
      if (text.includes("FOR UPDATE")) return f.response([f.row]);
      if (text.includes("provider_request_count=provider_request_count+1") || text.includes("provider_request_id=COALESCE")) {
        queueMicrotask(() => queueMicrotask(() => { allowed = false; }));
        return f.response([{ id }]);
      }
      return f.response();
    });
    if (phase === "submission") {
      f.query.mockImplementation(async text => {
        if (typeof text === "string" && text.includes("AS principal_count")) return f.response([{ principal_count: 0, tenant_count: 0 }]);
        if (typeof text === "string" && text.includes("INSERT INTO defender_hunting_jobs")) {
          queueMicrotask(() => queueMicrotask(() => { allowed = false; }));
        }
        return f.response();
      });
    }
    const fence = () => { if (!allowed) throw AppError.unauthorized("Authority changed before commit."); };
    await expect(phase === "admission" ? f.repository.authorizeProviderRequest(scope, id, execution, fence)
      : phase === "response" ? f.repository.recordProviderResponse(scope, id, execution, "response-request", fence)
        : f.repository.submit(scope, { idempotencyKey: "commit-fenced-submit", filters }, fence)).rejects.toMatchObject({ status: 401 });
    expect(f.query).toHaveBeenCalledWith("ROLLBACK");
    expect(f.query).not.toHaveBeenCalledWith("COMMIT");
  });

  it.each(["cancel", "delete"] as const)("rolls back %s when its mutation authority changes during the database write", async action => {
    const f = fixture();
    let allowed = true;
    const query = async (text: unknown) => {
      if (typeof text === "string" && text.includes("FOR UPDATE")) return f.response([f.row]);
      if (typeof text === "string" && /^(UPDATE|DELETE)/.test(text)) {
        allowed = false;
        return f.response([{ ...f.row, status: "cancelled" }]);
      }
      return f.response();
    };
    f.query.mockImplementation(query);
    f.databaseQuery.mockImplementation(query);
    const fence = () => { if (!allowed) throw AppError.unauthorized("Mutation authority changed."); };
    await expect(action === "cancel" ? f.repository.cancel(scope, id, fence) : f.repository.delete(scope, id, fence))
      .rejects.toMatchObject({ status: 401 });
    expect(f.query).toHaveBeenCalledWith("ROLLBACK");
    expect(f.query).not.toHaveBeenCalledWith("COMMIT");
  });

  it("returns committed cancellation and its prior-success reference without reading again", async () => {
    const f = fixture();
    const previousId = "33333333-3333-4333-8333-333333333333";
    f.query.mockImplementation(async text => f.response(typeof text === "string" && text.includes("FOR UPDATE") ? [f.row]
      : typeof text === "string" && text.startsWith("UPDATE defender_hunting_jobs AS job")
        ? [{ ...f.row, status: "cancelled", cancel_requested: true, prior_successful_job_id: previousId }] : []));
    f.databaseQuery.mockRejectedValue(new Error("Post-commit reads are unavailable."));
    await expect(f.repository.cancel(scope, id)).resolves.toMatchObject({
      id, status: "cancelled", cancelRequested: true, priorSuccessfulJobId: previousId,
    });
    expect(f.query).toHaveBeenCalledWith("COMMIT");
    expect(f.databaseQuery).not.toHaveBeenCalled();
  });

  it("checks authority after projection and immediately before COMMIT", async () => {
    const f = fixture();
    const query = f.query.getMockImplementation()!;
    let allowed = true;
    f.query.mockImplementation(async text => {
      const response = await query(text);
      if (typeof text === "string" && text.includes("UPDATE defender_hunting_jobs SET status=")) {
        Object.defineProperty(response.rows[0], "expires_at", { get: () => {
          queueMicrotask(() => { allowed = false; });
          return f.row.expires_at;
        } });
      }
      return response;
    });
    await expect(f.repository.publish(scope, id, execution, result, () => {
      if (!allowed) throw AppError.unauthorized("Authority changed before commit.");
    })).rejects.toMatchObject({ status: 401 });
    expect(f.query).toHaveBeenCalledWith("ROLLBACK");
    expect(f.query).not.toHaveBeenCalledWith("COMMIT");
  });

  it("rolls back an admission that exceeds the job deadline during its request-counter write", async () => {
    const f = fixture();
    const query = f.query.getMockImplementation()!;
    f.query.mockImplementation(async text => {
      const response = await query(text);
      if (typeof text === "string" && text.includes("provider_request_count=provider_request_count+1")) f.row.deadline_at = new Date(0);
      return response;
    });
    await expect(f.repository.authorizeProviderRequest(scope, id, execution)).rejects.toMatchObject({ code: "hunting_job_expired" });
    expect(f.query).toHaveBeenCalledWith("ROLLBACK");
    expect(f.query).not.toHaveBeenCalledWith("COMMIT");
  });

  it.each(["revoked", "expired"] as const)("withholds saved rows when the snapshot becomes %s during its read", async change => {
    const f = fixture();
    const job = await f.repository.publish(scope, id, execution, result);
    vi.spyOn(f.repository, "getJob").mockResolvedValueOnce(job).mockResolvedValueOnce(change === "revoked" ? undefined : job);
    const snapshot = { expires_at: new Date(Date.now() + 60_000) };
    f.databaseQuery.mockImplementation(async text => {
      if (typeof text === "string" && text.includes("FROM defender_hunting_snapshots snapshot")) return f.response([snapshot]);
      if (change === "expired") snapshot.expires_at = new Date(0);
      return f.response();
    });
    await expect(f.repository.listRows(scope, id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("returns its committed snapshot without a fallible post-commit read", async () => {
    const f = fixture();
    f.databaseQuery.mockRejectedValue(new Error("Read unavailable after commit."));
    await expect(f.repository.publish(scope, id, execution, result)).resolves.toMatchObject({
      id, status: "succeeded", snapshotId: expect.any(String), complete: true, noData: true,
    });
    expect(f.query).toHaveBeenCalledWith("COMMIT");
    expect(f.databaseQuery).not.toHaveBeenCalled();
  });

  it.each(["locked", "inserted"] as const)("fences durable submission after the %s write", async stage => {
    const f = fixture();
    const query = f.query.getMockImplementation()!;
    let allowed = true;
    f.query.mockImplementation(async text => {
      if (typeof text === "string" && text.includes("AS principal_count")) return f.response([{ principal_count: 0, tenant_count: 0 }]);
      const response = await query(text);
      if (typeof text === "string" && text.includes(stage === "locked" ? "pg_advisory_xact_lock" : "INSERT INTO defender_hunting_jobs")) allowed = false;
      return response;
    });
    await expect(f.repository.submit(scope, { idempotencyKey: `fenced-${stage}`, filters }, () => {
      if (!allowed) throw AppError.unauthorized("Submission authority changed.");
    })).rejects.toMatchObject({ status: 401 });
    expect(f.query).toHaveBeenCalledWith("ROLLBACK");
    expect(f.query).not.toHaveBeenCalledWith("COMMIT");
  });

  it.each([
    ["agents_inventory", "blueprintIds", "EntraBlueprintId"],
    ["agent_activity", "blueprintIds", "TargetAgentBlueprintId"],
    ["agent_activity", "blueprintIds", "AgentBlueprintId"],
    ["agent_tools", "blueprintIds", "TargetAgentBlueprintId"],
    ["agent_tools", "blueprintIds", "AgentBlueprintId"],
    ["agent_activity", "actorObjectIds", "AccountObjectId"],
    ["agent_tools", "actorObjectIds", "AccountObjectId"],
  ] as const)("publishes adapter-validated %s rows with mixed-case %s matching %s", async (templateId, filter, field) => {
    const mixedId = "ABCDEFAB-1234-4567-8ABC-ABCDEFABCDEF";
    const selected = validateDefenderHuntingFilters({ ...filters, templateId, [filter]: [mixedId],
      operations: templateId === "agents_inventory" ? [] : [templateId === "agent_tools" ? "ExecuteToolBySDK" : "InvokeAgent"],
    }, { now: new Date(filters.endDateTime) });
    const f = fixture();
    f.row.filters = selected;
    const parsed = await projectedClient(selected, { [field]: mixedId }).runQuery("fixture-token", selected);
    await f.repository.publish(scope, id, execution, parsed);
    expect(f.query).toHaveBeenCalledWith("COMMIT");
    expect(f.query).not.toHaveBeenCalledWith("ROLLBACK");
    expect(selected[filter]).toEqual([mixedId]);
  });

  it("does not substitute a human-user alias for the queried account-object actor scope", async () => {
    const actor = "abcdefab-1234-4567-8abc-abcdefabcdef";
    const selected: DefenderHuntingFilters = { ...filters, templateId: "agent_activity", operations: ["InvokeAgent"], actorObjectIds: [actor] };
    const client = projectedClient(selected, { AccountObjectId: id, HumanUserKey: actor, HumanUserKeyState: "value" });
    await expect(client.runQuery("fixture-token", selected)).rejects.toMatchObject({ code: "provider_scope_mismatch" });
    const unscoped = await client.runQuery("fixture-token", { ...selected, actorObjectIds: [] });
    const f = fixture();
    f.row.filters = selected;
    await expect(f.repository.publish(scope, id, execution, unscoped)).rejects.toMatchObject({ code: "invalid_hunting_publication" });
    expect(f.query).toHaveBeenCalledWith("ROLLBACK");
    expect(f.query).not.toHaveBeenCalledWith("COMMIT");
  });

  it.each([256, 257, 512, 513])("records optional request IDs within the repository's bound (%s characters)", async length => {
    const f = fixture();
    const query = f.query.getMockImplementation()!;
    f.query.mockImplementation(async text => typeof text === "string" && text.includes("provider_request_id=COALESCE")
      ? f.response([{ id }]) : query(text));
    const client = projectedClient(filters, {}, { "request-id": "r".repeat(length) });
    const onResponse = vi.fn((requestId: string | null) => f.repository.recordProviderResponse(scope, id, execution, requestId));
    await expect(client.runQuery("fixture-token", filters, { onResponse })).resolves.toMatchObject({ storedRowCount: 1 });
    expect(onResponse).toHaveBeenCalledWith(length <= 256 ? "r".repeat(length) : null, expect.any(AbortSignal));
    const writes = f.query.mock.calls.filter(([text]) => typeof text === "string" && text.includes("provider_request_id=COALESCE"));
    expect(writes).toHaveLength(1);
    expect(f.query).toHaveBeenCalledWith("COMMIT");
    expect(f.databaseQuery).not.toHaveBeenCalled();
  });

  it.each(["\t", "\u001b", "\u007f", "\u0085", "\u202e", "\u2029"])(
    "rejects unsafe provider correlation before persistence (%j)", async control => {
      const f = fixture();
      await expect(f.repository.recordProviderResponse(scope, id, execution, `request${control}id`))
        .rejects.toMatchObject({ code: "provider_schema" });
      expect(f.query).not.toHaveBeenCalled();
    },
  );

  it.each(["activity", "activity_alias", "inventory"] as const)("rejects %s state claims outside the adapter contract at publication", async source => {
    const selected: DefenderHuntingFilters = source !== "inventory"
      ? { ...filters, templateId: "agent_activity", operations: ["InvokeAgent"] } : filters;
    const parsed = await projectedClient(selected, {}).runQuery("fixture-token", selected);
    const row = parsed.rows[0];
    if (row.sourceTable === "CloudAppEvents") {
      if (source === "activity_alias") row.agentUserPrincipalName = "agent@example.invalid";
      else row.fieldStates.conversationThreadId = "null";
    }
    else row.detailStates.risk = "empty";
    const f = fixture();
    f.row.filters = selected;
    await expect(f.repository.publish(scope, id, execution, parsed)).rejects.toMatchObject({ code: "invalid_hunting_publication" });
    expect(f.query).toHaveBeenCalledWith("ROLLBACK");
    expect(f.query).not.toHaveBeenCalledWith("COMMIT");
  });

  it.each(["locked", "written"] as const)("rolls back when authorization changes after the %s query", async stage => {
    const f = fixture();
    let allowed = true;
    const query = f.query.getMockImplementation()!;
    f.query.mockImplementation(async text => {
      const response = await query(text);
      if (typeof text === "string" && text.includes(stage === "locked" ? "FOR UPDATE" : "UPDATE defender_hunting_jobs SET status")) allowed = false;
      return response;
    });
    const fence = vi.fn(() => { if (!allowed) throw AppError.unauthorized("Session changed."); });
    await expect(f.repository.publish(scope, id, execution, result, fence)).rejects.toMatchObject({ status: 401 });
    expect(f.query).toHaveBeenCalledWith("ROLLBACK");
    expect(f.query).not.toHaveBeenCalledWith("COMMIT");
    expect(fence).toHaveBeenCalledTimes(stage === "locked" ? 1 : 2);
    expect(f.client.release).toHaveBeenCalledOnce();
  });

  it("rolls back if the durable deadline expires during publication writes", async () => {
    const f = fixture();
    const query = f.query.getMockImplementation()!;
    f.query.mockImplementation(async text => {
      const response = await query(text);
      if (typeof text === "string" && text.includes("UPDATE defender_hunting_jobs SET status")) f.row.deadline_at = new Date(0);
      return response;
    });
    await expect(f.repository.publish(scope, id, execution, result)).rejects.toMatchObject({ code: "hunting_job_expired" });
    expect(f.query).toHaveBeenCalledWith("ROLLBACK");
    expect(f.query).not.toHaveBeenCalledWith("COMMIT");
    expect(f.client.release).toHaveBeenCalledOnce();
  });
});
