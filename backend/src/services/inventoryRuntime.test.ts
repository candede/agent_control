import { randomUUID } from "node:crypto";
import pg from "pg";
import session from "express-session";
import { config } from "../config.js";
import { withAuthority } from "../auth/authorityContext.js";
import { browserRequestPrincipal } from "../auth/requestPrincipal.js";
import { createBrowserCredentials } from "../auth/delegatedCredentials.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataGenerations } from "../db/dataGenerations.js";
import { InventoryGenerations } from "../db/inventoryGenerations.js";
import * as maintenance from "./maintenance.js";
import * as operationalState from "./operationalState.js";
import { InventoryRuntime } from "./inventoryRuntime.js";
import { StreamedInventory } from "./streamedInventory.js";
import { AppError } from "../errors.js";

const tenants = config.tenants;
afterEach(() => { config.tenants = tenants; vi.restoreAllMocks(); });

describe("inventory publication wakeups", () => {
  it("coalesces arrivals during an active sweep without losing the next sweep", async () => {
    const runtime = new InventoryRuntime({ options: { max: 4 } } as pg.Pool);
    let release!: (more: boolean) => void;
    const pass = vi.spyOn(runtime, "pass").mockResolvedValue(false);
    pass.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = resolve; }));
    try {
      runtime.start();
      await vi.waitFor(() => expect(pass).toHaveBeenCalledTimes(1));
      runtime.wake();
      runtime.wake();
      expect(pass).toHaveBeenCalledTimes(1);
      release(false);
      await vi.waitFor(() => expect(pass).toHaveBeenCalledTimes(2));
    } finally {
      release(false);
      await runtime.drain();
    }
  });

  it("drains bounded scope pages without waiting for the thirty-second recovery timer", async () => {
    const runtime = new InventoryRuntime({ options: { max: 4 } } as pg.Pool);
    const pass = vi.spyOn(runtime, "pass").mockResolvedValue(false)
      .mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    try {
      runtime.start();
      await vi.waitFor(() => expect(pass).toHaveBeenCalledTimes(3));
    } finally {
      await runtime.drain();
    }
  });
});

describe("inventory sweep cancellation and retention", () => {
  function fixture(progress: { scope?: string; stage?: string } = {}, assertCurrent?: () => void,
    authorize?: ConstructorParameters<typeof InventoryRuntime>[1]) {
    const database = new pg.Pool({ max: 4 });
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    const runtime = new InventoryRuntime(database, authorize, assertCurrent);
    const scopeId = randomUUID();
    const root = { scopeId, tenantId: "synthetic-tenant", baselineId: randomUUID(), revision: "1", epoch: "0", first_revision: "1" };
    vi.spyOn(maintenance, "maintenanceActive").mockReturnValue(false);
    vi.spyOn(operationalState, "readOperationalState").mockResolvedValue({
      mode: "normal", providerWorkEnabled: true, restoredFromAt: null, deletionReviewedAt: null, accessReviewedAt: null,
    });
    vi.spyOn(database, "connect").mockImplementation(async () => client);
    vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected pool query."));
    const query = vi.spyOn(client, "query").mockImplementation(async sql => {
      const statement = String(sql);
      const rows = statement.includes("pg_try_advisory_xact_lock") ? [{ acquired: true }]
        : statement.startsWith("SELECT cursor") ? [{ cursor: progress }]
          : statement.startsWith("SELECT s.id") ? [{ id: scopeId, tenant_id: root.tenantId, principal_id: "synthetic-principal" }]
            : statement.startsWith("SELECT r.scope_id") ? [root] : [];
      return { command: ["BEGIN", "COMMIT", "ROLLBACK"].includes(statement) ? statement : "SELECT",
        rows, rowCount: rows.length, fields: [], oid: 0 } satisfies pg.QueryResult;
    });
    const roots = vi.spyOn(runtime.stages, "gcSlice").mockResolvedValue({ rows: 0, removed: 0, bytes: 0 });
    const content = vi.spyOn(runtime.stages, "gcContent").mockResolvedValue({ rows: 0, bytes: 0 });
    const metadata = vi.spyOn(runtime.stages, "gcMetadataSlice").mockResolvedValue({ removed: {}, rows: 0, bytes: 0 });
    return { database, runtime, query, scopeId, root, progress, roots, content, metadata };
  }

  async function credential(f: ReturnType<typeof fixture>, principalId: string) {
    const tenant = { tenantId: f.root.tenantId, clientId: "synthetic-api", clientSecret: "synthetic", domains: ["example.invalid"] };
    config.tenants = [tenant];
    const epochs = { sessionEpoch: async () => "0" };
    const principal = await browserRequestPrincipal({ tenantId: tenant.tenantId, clientId: tenant.clientId, accountId: principalId,
      user: { tenantId: tenant.tenantId, homeAccountId: principalId, username: "operator@example.invalid",
        displayName: "Synthetic operator", roles: ["AgentControl.Viewer"] },
      signedInAt: Date.now(), rolesValidatedAt: Date.now(), cookie: new session.Cookie({ expires: new Date(Date.now() + 60_000) }) }, null, epochs);
    return createBrowserCredentials(principal, epochs);
  }
  async function retain(f: ReturnType<typeof fixture>, principalId: string, credentials?: ReturnType<typeof createBrowserCredentials>) {
    const source = credentials ?? await credential(f,principalId);
    vi.mocked(f.database.query).mockResolvedValueOnce({ command: "SELECT", rows: [], rowCount: 0, fields: [], oid: 0 })
      .mockResolvedValueOnce({ command: "SELECT", rows: [], rowCount: 0, fields: [], oid: 0 });
    await withAuthority(source, () => f.runtime.enqueue({ tenantId: f.root.tenantId, principalId }, false));
    return source;
  }

  it.each(["inventory_input_fenced","inventory_control_changed"] as const)("re-reads bounded publication after a concurrent %s fence",async code=>{
    const f=fixture();
    vi.spyOn(f.runtime,"publishControls").mockResolvedValue(0);
    vi.spyOn(f.runtime,"publishNativeControls").mockResolvedValue(0);
    vi.mocked(f.database.query).mockResolvedValue({command:"SELECT",rows:[],rowCount:0,fields:[],oid:0});
    const enqueue=vi.spyOn(f.runtime,"enqueue").mockResolvedValue(false)
      .mockRejectedValueOnce(code==="inventory_input_fenced"?new Error(code):new AppError(409,code,"Concurrent verified publication."));
    await f.runtime.settleControls({tenantId:f.root.tenantId,principalId:"synthetic-principal"},AbortSignal.timeout(1_000));
    expect(enqueue).toHaveBeenCalledTimes(2);
  });
  it("surfaces unexpected publication errors instead of retrying or clearing pending state",async()=>{
    const f=fixture(),failure=new Error("unexpected publication failure");
    const publish=vi.spyOn(f.runtime,"publishControls").mockRejectedValue(failure);
    await expect(f.runtime.settleControls({tenantId:f.root.tenantId,principalId:"synthetic-principal"},AbortSignal.timeout(1_000)))
      .rejects.toBe(failure);
    expect(publish).toHaveBeenCalledOnce();
  });

  it("does not erase a renewed pending source when an older publication loses authority", async () => {
    const f = fixture(), original = await retain(f, "synthetic-principal");
    const replacement = await credential(f,"synthetic-principal");
    vi.mocked(f.database.query).mockResolvedValue({ command: "SELECT", rows: [
      { tenant_id: f.root.tenantId, principal_id: "synthetic-principal", id: "1" },
    ], rowCount: 1, fields: [], oid: 0 });
    const publish = vi.spyOn(f.runtime, "publishControls").mockResolvedValue(0);
    publish.mockImplementationOnce(async () => { await retain(f, "synthetic-principal",replacement); original.revoke(); return 0; });
    const native = vi.spyOn(f.runtime, "publishNativeControls").mockResolvedValue(0);
    vi.spyOn(f.runtime, "collect").mockResolvedValue(false);
    await f.runtime.pass();
    replacement.assertCurrent();
    expect(native).not.toHaveBeenCalled();
    vi.spyOn(f.runtime, "enqueue").mockResolvedValue(false);
    await f.runtime.pass();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(native).toHaveBeenCalledOnce();
  });

  it("does not enqueue canonical work when the sweep is cancelled during a source read", async () => {
    const f = fixture();
    const controller = new AbortController();
    const reason = new Error("Synthetic inventory shutdown.");
    const query = vi.mocked(f.database.query);
    query.mockImplementationOnce(async () => ({ command: "SELECT", rows: [], rowCount: 0, fields: [], oid: 0 }));
    query.mockImplementationOnce(async () => {
      controller.abort(reason);
      return { command: "SELECT", rows: [f.root], rowCount: 1, fields: [], oid: 0 };
    });
    vi.spyOn(DataGenerations.prototype, "sessionEpoch").mockResolvedValue("0");
    const request = vi.spyOn(f.runtime.reconciliation, "request").mockResolvedValue({
      scopeId: f.scopeId, active: null, pendingSequence: "1",
    });

    await expect(f.runtime.enqueue({ tenantId: f.root.tenantId, principalId: "synthetic-principal" }, false, controller.signal))
      .rejects.toBe(reason);
    expect(request).not.toHaveBeenCalled();
  });

  it("rolls back a retention slice and its cursor when cancellation arrives during collection", async () => {
    const f = fixture({ scope: "00000000-0000-0000-0000-000000000000", stage: "metadata" });
    const controller = new AbortController();
    const reason = new Error("Synthetic inventory shutdown.");
    f.roots.mockImplementation(async () => { controller.abort(reason); return { rows: 0, removed: 0, bytes: 0 }; });
    f.content.mockImplementation(async () => { controller.abort(reason); return { rows: 0, bytes: 0 }; });

    await expect(f.runtime.collect(controller.signal)).rejects.toBe(reason);
    expect(f.query).toHaveBeenCalledWith("ROLLBACK");
    expect(f.query).not.toHaveBeenCalledWith("COMMIT");
  });

  it.each(["marker", "shutdown"] as const)("does not collect when %s closes admission during the state read", async closure => {
    const f = fixture();
    const state = Promise.withResolvers<operationalState.OperationalState>();
    vi.mocked(operationalState.readOperationalState).mockReturnValueOnce(state.promise);
    const collecting = f.runtime.collect();
    if (closure === "marker") vi.mocked(maintenance.maintenanceActive).mockReturnValue(true);
    else await f.runtime.drain();
    state.resolve({ mode: "normal", providerWorkEnabled: true, restoredFromAt: null,
      deletionReviewedAt: null, accessReviewedAt: null });
    await expect(collecting).resolves.toBe(false);
    expect(f.database.connect).not.toHaveBeenCalled();
    expect(f.roots).not.toHaveBeenCalled();
  });

  it.each(["retention", "package-control", "native-control"] as const)(
    "rolls back %s when maintenance closes after its write, without an injected execution fence", async stage => {
      const f = fixture();
      const close = () => vi.mocked(maintenance.maintenanceActive).mockReturnValue(true);
      if (stage === "retention") f.roots.mockImplementationOnce(async () => {
        close();
        return { rows: 0, removed: 0, bytes: 0 };
      });
      else {
        const query = f.query.getMockImplementation()!;
        f.query.mockImplementation(async (...args) => {
          const result = await query(...args);
          if (String(args[0]).startsWith(stage === "package-control"
            ? "DELETE FROM inventory_control_pending" : "DELETE FROM inventory_native_control_pending")) close();
          return result;
        });
      }
      const scope = { tenantId: f.root.tenantId, principalId: "synthetic-principal" };
      const collecting = stage === "retention" ? f.runtime.collect()
        : stage === "package-control" ? f.runtime.publishControls(scope) : f.runtime.publishNativeControls(scope);
      await expect(collecting).rejects.toMatchObject({ status: 503, code: "maintenance" });
      expect(f.query).toHaveBeenCalledWith("ROLLBACK");
      expect(f.query).not.toHaveBeenCalledWith("COMMIT");
      if (stage === "retention") {
        vi.mocked(maintenance.maintenanceActive).mockReturnValue(false);
        await expect(f.runtime.collect()).resolves.toBe(true);
        expect(f.query).toHaveBeenCalledWith("COMMIT");
      }
    },
  );

  it.each(["before", "after"] as const)("does not publish controls when maintenance closes %s asynchronous authorization", async stage => {
    const close = () => vi.mocked(maintenance.maintenanceActive).mockReturnValue(true);
    const authorize = vi.fn(async () => { if (stage === "after") close(); });
    const f = fixture({}, undefined, authorize);
    vi.mocked(f.database.query).mockResolvedValueOnce({ command: "SELECT", rows: [
      { target_id: "package", observation_id: randomUUID(), updated_at: new Date() },
    ], rowCount: 1, fields: [], oid: 0 });
    vi.spyOn(DataGenerations.prototype, "sessionEpoch").mockImplementationOnce(async () => {
      if (stage === "before") close();
      return "0";
    });
    const execute = vi.spyOn(InventoryGenerations.prototype, "execute")
      .mockRejectedValue(new Error("Unexpected publication."));
    await expect(f.runtime.publishControls({ tenantId: f.root.tenantId, principalId: "synthetic-principal" }))
      .rejects.toMatchObject({ status: 503, code: "maintenance" });
    expect(authorize).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not begin another principal's publication after persisted maintenance closes", async () => {
    const f = fixture();
    await retain(f, "first");
    await retain(f, "second");
    let closed = false;
    vi.mocked(operationalState.readOperationalState).mockImplementation(async () => ({
      mode: closed ? "maintenance" : "normal", providerWorkEnabled: true, restoredFromAt: null,
      deletionReviewedAt: null, accessReviewedAt: null,
    }));
    vi.mocked(f.database.query).mockResolvedValue({ command: "SELECT", rows: [
      { tenant_id: f.root.tenantId, principal_id: "first", id: "1" },
      { tenant_id: f.root.tenantId, principal_id: "second", id: "2" },
    ], rowCount: 2, fields: [], oid: 0 });
    const publish = vi.spyOn(f.runtime, "publishControls").mockResolvedValue(0);
    vi.spyOn(f.runtime, "publishNativeControls").mockResolvedValue(0);
    vi.spyOn(f.runtime, "enqueue").mockImplementation(async () => { closed = true; return false; });
    const collect = vi.spyOn(f.runtime, "collect").mockResolvedValue(false);
    await expect(f.runtime.pass()).resolves.toBe(false);
    expect(publish).toHaveBeenCalledExactlyOnceWith({ tenantId: f.root.tenantId, principalId: "first" }, expect.any(AbortSignal));
    expect(collect).not.toHaveBeenCalled();
  });

  it.each(["package", "native", "canonical request"] as const)(
    "does not admit the next publication slice after persisted maintenance closes during %s work", async stage => {
      const f = fixture();
      await retain(f, "synthetic-principal");
      let closed = false;
      vi.mocked(operationalState.readOperationalState).mockImplementation(async () => ({
        mode: closed ? "maintenance" : "normal", providerWorkEnabled: true, restoredFromAt: null,
        deletionReviewedAt: null, accessReviewedAt: null,
      }));
      vi.mocked(f.database.query).mockResolvedValue({ command: "SELECT", rows: [
        { tenant_id: f.root.tenantId, principal_id: "synthetic-principal", id: "1" },
      ], rowCount: 1, fields: [], oid: 0 });
      const packages = vi.spyOn(f.runtime, "publishControls").mockImplementation(async () => {
        if (stage === "package") closed = true;
        return 0;
      });
      const native = vi.spyOn(f.runtime, "publishNativeControls").mockImplementation(async () => {
        if (stage === "native") closed = true;
        return 0;
      });
      const enqueue = vi.spyOn(f.runtime, "enqueue").mockImplementation(async () => {
        if (stage === "canonical request") closed = true;
        return true;
      });
      vi.spyOn(DataGenerations.prototype, "sessionEpoch").mockResolvedValue("0");
      const run = vi.spyOn(f.runtime.reconciliation, "runNext").mockResolvedValue(null);
      vi.spyOn(f.runtime, "collect").mockResolvedValue(false);
      await expect(f.runtime.pass()).resolves.toBe(false);
      expect(packages).toHaveBeenCalledOnce();
      if (stage === "package") expect(native).not.toHaveBeenCalled();
      else expect(native).toHaveBeenCalledOnce();
      if (stage === "canonical request") expect(enqueue).toHaveBeenCalledOnce();
      else expect(enqueue).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("starts a new scope at its roots when pending controls make the cursor scope ineligible", async () => {
    const f = fixture({ scope: "00000000-0000-0000-0000-000000000000", stage: "metadata" });
    await expect(f.runtime.collect()).resolves.toBe(true);
    expect(f.roots).toHaveBeenCalledWith(f.root, expect.anything());
    expect(f.content).not.toHaveBeenCalled();
    expect(f.metadata).not.toHaveBeenCalled();
    expect(f.query.mock.calls.at(-2)?.[1]?.[0]).toBe(JSON.stringify({ scope: f.scopeId, revision: "1" }));
  });

  it("resumes metadata for the same scope without restarting its root scan", async () => {
    const f = fixture({ stage: "metadata" });
    f.progress.scope = f.scopeId;
    await expect(f.runtime.collect()).resolves.toBe(true);
    expect(f.metadata).toHaveBeenCalledWith(f.scopeId, f.root.tenantId, expect.anything());
    expect(f.roots).not.toHaveBeenCalled();
    expect(f.content).not.toHaveBeenCalled();
  });

  it("recovers orphan package controls without a source scope", async () => {
    const f = fixture();
    const scope = { tenantId: f.root.tenantId, principalId: "orphan-principal" };
    const observationId = randomUUID();
    let pending = true;
    const rows = (value: object[]): pg.QueryResult =>
      ({ command: "SELECT", rows: value, rowCount: value.length, fields: [], oid: 0 });
    vi.mocked(f.database.query).mockImplementation(async sql => {
      const statement = String(sql);
      if (statement.startsWith("SELECT tenant_id,principal_id,min(")) {
        return rows(pending && statement.includes("inventory_control_pending")
          ? [{ tenant_id: scope.tenantId, principal_id: scope.principalId, id: observationId }] : []);
      }
      if (statement.startsWith("SELECT p.target_id") || statement.startsWith("SELECT p.scope_id")
        || statement.startsWith("SELECT 1 WHERE") || statement.startsWith("SELECT r.scope_id")) return rows([]);
      throw new Error("Unexpected orphan recovery query.");
    });
    f.query.mockImplementation(async sql => {
      const statement = String(sql);
      if (statement.startsWith("DELETE FROM inventory_control_pending")) {
        pending = false;
      }
      return { ...rows([]), command: ["BEGIN", "COMMIT", "ROLLBACK"].includes(statement) ? statement : "SELECT" };
    });
    const collect = vi.spyOn(f.runtime, "collect").mockResolvedValue(false);
    const packageReadback = vi.spyOn(StreamedInventory.prototype, "controlReadback");
    const nativeReadback = vi.spyOn(StreamedInventory.prototype, "nativeControlReadback");
    const request = vi.spyOn(f.runtime.reconciliation, "request");

    await expect(f.runtime.pass()).resolves.toBe(true);
    expect(pending).toBe(false);
    expect(packageReadback).not.toHaveBeenCalled();
    expect(nativeReadback).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(collect).toHaveBeenCalledOnce();
    await expect(f.runtime.pass()).resolves.toBe(false);
  });

  it("does not wait on abandoned canonical work when no current authorized source remains", async () => {
    const f = fixture();
    vi.spyOn(f.runtime, "publishControls").mockResolvedValue(0);
    vi.spyOn(f.runtime, "publishNativeControls").mockResolvedValue(0);
    const request = vi.spyOn(f.runtime.reconciliation, "request");
    const controller = new AbortController();
    vi.mocked(f.database.query).mockImplementation(async sql => {
      const statement = String(sql);
      let pending = false;
      if (statement.includes("FROM inventory_reconciliation work")) {
        pending = !statement.includes("g.scope_epoch=s.epoch")
          || !statement.includes("g.session_epoch=s.session_epoch") || !statement.includes("g.expires_at>clock_timestamp()");
        if (pending) controller.abort(new Error("Settlement waited on unavailable source work."));
      }
      return { command: "SELECT", rows: pending ? [{}] : [], rowCount: pending ? 1 : 0, fields: [], oid: 0 };
    });

    await expect(f.runtime.settleControls({ tenantId: f.root.tenantId, principalId: "synthetic-principal" }, controller.signal))
      .resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it("continues waiting on a live canonical claim until its pending work settles", async () => {
    const f = fixture();
    vi.spyOn(f.runtime, "publishControls").mockResolvedValue(0);
    vi.spyOn(f.runtime, "publishNativeControls").mockResolvedValue(0);
    vi.spyOn(f.runtime, "enqueue").mockResolvedValue(true);
    vi.spyOn(DataGenerations.prototype, "sessionEpoch").mockResolvedValue("0");
    const run = vi.spyOn(f.runtime.reconciliation, "runNext").mockResolvedValue(null);
    let reads = 0;
    vi.mocked(f.database.query).mockImplementation(async () => {
      const pending = reads++ === 0;
      return { command: "SELECT", rows: pending ? [{}] : [], rowCount: pending ? 1 : 0, fields: [], oid: 0 };
    });

    await expect(f.runtime.settleControls({ tenantId: f.root.tenantId, principalId: "synthetic-principal" }, new AbortController().signal))
      .resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
    expect(reads).toBe(2);
  });

  it.each((["enqueue", "control-cleanup", "native-cleanup", "settlement"] as const).flatMap(stage =>
    (["cancellation", "authority loss"] as const).map(cause => ({ stage, cause }))))(
    "does not report successful $stage after $cause during its final read", async ({ stage, cause }) => {
      const reason = new Error("Synthetic publication interruption.");
      let current = true;
      const f = fixture({}, () => { if (!current) throw reason; });
      const scope = { tenantId: f.root.tenantId, principalId: "synthetic-principal" };
      const controller = new AbortController();
      vi.mocked(f.database.query).mockImplementation(async () => {
        if (cause === "cancellation") controller.abort(reason);
        else current = false;
        return { command: "SELECT", rows: stage === "enqueue" ? [{}] : [], rowCount: stage === "enqueue" ? 1 : 0, fields: [], oid: 0 };
      });
      let operation: Promise<unknown>;
      if (stage === "enqueue") operation = f.runtime.enqueue(scope, false, controller.signal);
      else if (stage === "settlement") {
        vi.spyOn(f.runtime, "publishControls").mockResolvedValue(0);
        vi.spyOn(f.runtime, "publishNativeControls").mockResolvedValue(0);
        vi.spyOn(f.runtime, "enqueue").mockResolvedValue(false);
        operation = f.runtime.settleControls(scope, controller.signal);
      } else {
        operation = stage === "control-cleanup" ? f.runtime.publishControls(scope, controller.signal)
          : f.runtime.publishNativeControls(scope, controller.signal);
      }
      await expect(operation).rejects.toBe(reason);
    },
  );
});
