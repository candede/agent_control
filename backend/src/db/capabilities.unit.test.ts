import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapabilityService } from "../services/capabilities.js";
import type { AuthenticatedUser } from "../types/session.js";
import { AppError } from "../errors.js";
import { CapabilityRepository } from "./capabilities.js";
import { activateAccountSession, revokeAccountSessionMutations } from "./sessions.js";

afterEach(() => vi.restoreAllMocks());

const capabilityId = "graph.package.read.application";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(pause: "configuration" | "evidence", existing: boolean) {
  const administrator: AuthenticatedUser = {
    tenantId: "synthetic-capability-tenant", homeAccountId: `configuration-${pause}-${existing}-${randomUUID()}`,
    username: "administrator@example.invalid", displayName: "Administrator", roles: ["AgentControl.Admin"],
  };
  const original = {
    configuration: existing ? {
      enabled: false, shared_data_scope: false, preview_qualified: false, revision: 7,
      updated_by: "previous-administrator", updated_at: new Date("2026-01-01T00:00:00Z"),
    } : undefined,
    evidence: [{ authorization_principal_id: "independently-current-administrator", status: "available" }],
  };
  let persisted = structuredClone(original), staged: typeof persisted | undefined;
  const started = deferred(), held = deferred();
  let paused = false, cleanupFailure: Error | undefined;
  const result = (rows: object[] = []) => ({ command: "", oid: 0, fields: [], rowCount: rows.length, rows });
  async function query(statement: unknown, values: unknown[] | undefined, transactional: boolean) {
    if (typeof statement !== "string") throw new Error("Unexpected query shape.");
    if (statement === "BEGIN") { staged = structuredClone(persisted); return result(); }
    if (statement === "COMMIT") { persisted = staged!; staged = undefined; return result(); }
    if (statement === "ROLLBACK") { staged = undefined; return result(); }
    const state = transactional ? staged! : persisted;
    let phase: typeof pause;
    let rows: object[] = [];
    if (statement.startsWith("INSERT INTO capability_configuration")) {
      state.configuration = {
        enabled: Boolean(values?.[2]), shared_data_scope: Boolean(values?.[3]), preview_qualified: false,
        revision: state.configuration ? state.configuration.revision + 1 : 1,
        updated_by: String(values?.[4]), updated_at: new Date(),
      };
      rows = [state.configuration];
      phase = "configuration";
    } else if (statement.startsWith("DELETE FROM capability_evidence") && statement.includes("capability_id=$2")) {
      state.evidence = [];
      phase = "evidence";
    } else if (statement.startsWith("DELETE FROM capability_evidence") && statement.includes("authorization_principal_id=$2")) {
      state.evidence = state.evidence.filter(row => row.authorization_principal_id !== values?.[1]);
      return result();
    } else if (statement.startsWith("SELECT enabled,shared_data_scope")) {
      return result(state.configuration ? [state.configuration] : []);
    } else throw new Error("Unexpected capability database query.");
    if (!paused && phase === pause) {
      paused = true;
      started.resolve();
      await held.promise;
      if (cleanupFailure) throw cleanupFailure;
    }
    return result(rows);
  }
  const database = new pg.Pool();
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  vi.spyOn(database, "connect").mockImplementation(async () => client);
  vi.spyOn(database, "query").mockImplementation(async (statement, values) => query(statement, values, false));
  const clientQuery = vi.spyOn(client, "query").mockImplementation(async (statement, values) => query(statement, values, true));
  const repository = new CapabilityRepository(database);
  return {
    administrator, repository, service: new CapabilityService(repository), client, clientQuery, original,
    started, held, persisted: () => persisted, failCleanup: (error: Error) => { cleanupFailure = error; },
  };
}

describe("application configuration commit ownership without a database", () => {
  describe.each(["configuration", "evidence"] as const)("authority changes during %s persistence", phase => {
    it.each((["revocation", "replacement", "invalidation"] as const).flatMap(change =>
      [false, true].map(existing => ({ change, existing }))))(
      "does not persist a stale $change write (existing configuration: $existing)", async ({ change, existing }) => {
        const f = fixture(phase, existing), actor = f.administrator;
        const pending = f.service.configureApplication(capabilityId, actor, true, true);
        const rejected = expect(pending).rejects.toMatchObject({
          status: 401, code: change === "invalidation" ? "authorization_expired" : "unauthorized",
        });
        await f.started.promise;
        const changed = change === "revocation"
          ? revokeAccountSessionMutations(actor.tenantId!, actor.homeAccountId, () => f.service.invalidatePrincipal(actor))
          : change === "replacement"
            ? activateAccountSession(actor.tenantId!, actor.homeAccountId, async () => undefined)
            : f.service.invalidatePrincipal(actor);
        f.held.resolve();
        await Promise.all([rejected, changed]);

        expect(f.persisted()).toEqual(f.original);
        expect(await f.repository.configuration(actor.tenantId!, capabilityId)).toMatchObject({
          enabled: false, sharedDataScope: false, revision: existing ? 7 : 1,
        });
        expect(f.clientQuery).toHaveBeenCalledWith("ROLLBACK");
        expect(f.clientQuery).not.toHaveBeenCalledWith("COMMIT");
        expect(f.client.release).toHaveBeenCalledOnce();
      },
    );
  });

  it("rolls back the configuration revision when evidence cleanup fails", async () => {
    const f = fixture("evidence", true), failure = new Error("Synthetic evidence cleanup failure.");
    f.failCleanup(failure);
    const pending = f.service.configureApplication(capabilityId, f.administrator, true, true);
    const rejected = expect(pending).rejects.toBe(failure);
    await f.started.promise;
    f.held.resolve();
    await rejected;

    expect(f.persisted()).toEqual(f.original);
    expect(f.clientQuery).toHaveBeenCalledWith("ROLLBACK");
    expect(f.clientQuery).not.toHaveBeenCalledWith("COMMIT");
  });

  it("commits independently current administrators in configuration queue order", async () => {
    const f = fixture("configuration", true);
    const first = f.service.configureApplication(capabilityId, f.administrator, true, true);
    await f.started.promise;
    const second = f.service.configureApplication(capabilityId,
      { ...f.administrator, homeAccountId: "independently-current-administrator" }, false, false);
    f.held.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ enabled: true, sharedDataScope: true, revision: 8 }),
      expect.objectContaining({ enabled: false, sharedDataScope: false, revision: 9 }),
    ]);
    expect(f.persisted().configuration).toMatchObject({
      enabled: false, shared_data_scope: false, revision: 9, updated_by: "independently-current-administrator",
    });
    expect(f.persisted().evidence).toEqual([]);
    expect(f.clientQuery.mock.calls.filter(([statement]) => statement === "COMMIT")).toHaveLength(2);
    expect(f.client.release).toHaveBeenCalledTimes(2);
  });
});

type EvidencePublication = "readiness" | "operation" | "audit" | "hunting";

function evidenceFixture(kind: EvidencePublication) {
  const actor: AuthenticatedUser = {
    tenantId: "synthetic-evidence-tenant", homeAccountId: `evidence-${kind}-${randomUUID()}`,
    username: "viewer@example.invalid", displayName: "Viewer", roles: ["AgentControl.Viewer"],
  };
  const observedAt = new Date();
  const original: {
    status: string; details: Record<string, unknown>; observed_at: Date; expires_at: Date; last_success_at: Date | null;
  } = {
    status: "missing_permission", details: { category: "missing_permission" },
    observed_at: observedAt, expires_at: new Date(observedAt.getTime() + 60_000), last_success_at: null,
  };
  let persisted: typeof original | undefined = structuredClone(original);
  let staged: typeof persisted;
  const started = deferred(), held = deferred();
  const result = (rows: object[] = []) => ({ command: "", oid: 0, fields: [], rowCount: rows.length, rows });
  async function query(statement: unknown, values: unknown[] | undefined, transactional: boolean) {
    if (typeof statement !== "string") throw new Error("Unexpected query shape.");
    if (statement === "BEGIN") { staged = structuredClone(persisted); return result(); }
    if (statement === "COMMIT") { persisted = staged; staged = undefined; return result(); }
    if (statement === "ROLLBACK") { staged = undefined; return result(); }
    if (statement.startsWith("SELECT enabled,shared_data_scope")) return result();
    if (statement.startsWith("SELECT status,details")) return result(persisted ? [persisted] : []);
    if (statement.startsWith("DELETE FROM capability_evidence")) { persisted = undefined; return result(); }
    if (!statement.startsWith("INSERT INTO capability_evidence")) throw new Error("Unexpected evidence database query.");
    const details = values?.[11];
    if (!details || typeof details !== "object" || Array.isArray(details) || typeof values?.[12] !== "number") {
      throw new Error("Unexpected evidence insert values.");
    }
    const now = new Date();
    const row = { status: String(values?.[10]), details: { ...details }, observed_at: now,
      expires_at: new Date(now.getTime() + values[12]), last_success_at: now };
    if (transactional) staged = row;
    else persisted = row;
    started.resolve();
    await held.promise;
    return result([row]);
  }
  const database = new pg.Pool();
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  vi.spyOn(database, "connect").mockImplementation(async () => client);
  vi.spyOn(database, "query").mockImplementation(async (statement, values) => query(statement, values, false));
  const clientQuery = vi.spyOn(client, "query").mockImplementation(async (statement, values) => query(statement, values, true));
  const service = new CapabilityService(new CapabilityRepository(database), {
    delegatedToken: async () => "synthetic-token", packageProbe: async () => [],
  });
  const controller = new AbortController();
  const publish = () => kind === "readiness"
    ? service.refresh("graph.package.read.delegated", actor, controller.signal)
    : kind === "operation"
      ? service.observeOperation("graph.licenses.read", actor, async () => "business-result", { signal: controller.signal })
      : kind === "audit"
        ? service.recordAuditProviderEvidence("purview.audit.search.delegated", actor, "available", {}, undefined, controller.signal)
        : service.recordHuntingProviderEvidence("defender.hunting.delegated", actor, "available", {}, undefined, controller.signal);
  return { actor, service, controller, publish, started, held, client, clientQuery, original, persisted: () => persisted };
}

describe.each(["readiness", "operation", "audit", "hunting"] as const)("%s evidence commit ownership without a database", kind => {
  it.each(["replacement", "revocation", "invalidation", "cancellation"] as const)(
    "does not persist evidence superseded by %s during the write", async change => {
      const f = evidenceFixture(kind);
      const pending = f.publish();
      const outcome = kind === "operation" ? expect(pending).resolves.toBe("business-result") : expect(pending).rejects.toBeInstanceOf(AppError);
      await f.started.promise;
      let changed: Promise<unknown> = Promise.resolve();
      if (change === "replacement") changed = activateAccountSession(f.actor.tenantId!, f.actor.homeAccountId, async () => undefined);
      if (change === "revocation") changed = revokeAccountSessionMutations(f.actor.tenantId!, f.actor.homeAccountId, async () => undefined);
      if (change === "invalidation") changed = f.service.invalidatePrincipal(f.actor);
      if (change === "cancellation") f.controller.abort(new AppError(499, "request_cancelled", "Synthetic cancellation."));
      f.held.resolve();
      await Promise.all([outcome, changed]);
      await vi.waitFor(() => expect(f.client.release).toHaveBeenCalledOnce());
      expect(f.persisted()).toEqual(change === "invalidation" ? undefined : f.original);
      expect(f.clientQuery).toHaveBeenCalledWith("ROLLBACK");
      expect(f.clientQuery).not.toHaveBeenCalledWith("COMMIT");
    },
  );

  it("commits current evidence and preserves the business result", async () => {
    const f = evidenceFixture(kind);
    const pending = f.publish();
    await f.started.promise;
    f.held.resolve();
    await expect(pending).resolves.toEqual(kind === "operation" ? "business-result"
      : expect.objectContaining({ status: "available", authorized: true, verification: "provider" }));
    expect(f.persisted()?.status).toBe("available");
    expect(f.clientQuery).toHaveBeenCalledWith("COMMIT");
    expect(f.client.release).toHaveBeenCalledOnce();
  });
});
