import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { retain } from "../../scripts/database.js";
import { AppError } from "../errors.js";
import { CapabilityService } from "../services/capabilities.js";
import type { AuthenticatedUser } from "../types/session.js";
import { CapabilityRepository } from "./capabilities.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => { fixture = await testDatabase(); });
afterAll(async () => { await fixture?.close(); });

const capabilityId = "graph.licenses.read";
function user(): AuthenticatedUser {
  return { tenantId: randomUUID(), homeAccountId: randomUUID(), displayName: "Fixture",
    username: "fixture@example.invalid", roles: ["AgentControl.Viewer"] };
}
function service() {
  const repository = new CapabilityRepository(fixture.runtime);
  const probes = { delegatedToken: vi.fn(async () => "fixture-token"), applicationToken: vi.fn(async () => "fixture-token"),
    packageProbe: vi.fn(async () => undefined), directoryProbe: vi.fn(async () => undefined), inventoryProbe: vi.fn(async () => undefined) };
  return { repository, probes, value: new CapabilityService(repository, probes) };
}
async function failure(value: CapabilityService, actor: AuthenticatedUser) {
  return (await value.list(actor)).find(view => view.definition.id === capabilityId)?.operationFailure;
}
async function denied(value: CapabilityService, actor: AuthenticatedUser) {
  await expect(value.observeOperation(capabilityId, actor, async () => {
    throw new AppError(403, "missing_permission", "private provider message", { httpStatus: 403, body: "private body" });
  })).rejects.toMatchObject({ code: "missing_permission" });
}

describe("persistent latest operation evidence", () => {
  it("survives service recreation, stays separate from readiness, and clears after a real success", async () => {
    const actor = user();
    const first = service();
    await denied(first.value, actor);
    const saved = await failure(first.value, actor);
    expect(saved).toMatchObject({ status: "missing_permission", evidence: { httpStatus: 403 } });
    expect(Date.parse(saved!.expiresAt) - Date.parse(saved!.checkedAt)).toBeGreaterThan(86_399_000);
    const restarted = service();
    expect(await failure(restarted.value, actor)).toEqual(saved);
    for (const probe of Object.values(restarted.probes)) expect(probe).not.toHaveBeenCalled();
    expect(await restarted.value.decision(capabilityId, actor)).toMatchObject({ authorized: true, verification: "on_demand" });
    await restarted.value.refresh(capabilityId, actor);
    expect(await failure(restarted.value, actor)).toEqual(saved);
    await restarted.value.observeOperation(capabilityId, actor, async () => "successful provider read");
    expect(await failure(restarted.value, actor)).toBeUndefined();
    const rows = await fixture.runtime.query<{ status: string; contract_revision: string; details: Record<string, unknown> }>(
      "SELECT status,contract_revision,details FROM capability_evidence WHERE tenant_id=$1 AND authorization_principal_id=$2 AND capability_id=$3",
      [actor.tenantId, actor.homeAccountId, capabilityId],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.filter(row => row.contract_revision.startsWith("operation-v1:"))).toHaveLength(1);
    expect(JSON.stringify(rows.rows)).not.toContain("private");
  });

  it("isolates principals and tenants and invalidates both readiness and operation evidence together", async () => {
    const actor = user();
    const otherPrincipal = { ...actor, homeAccountId: randomUUID() };
    const otherTenant = { ...actor, tenantId: randomUUID() };
    const { value } = service();
    await denied(value, actor);
    expect(await failure(value, otherPrincipal)).toBeUndefined();
    expect(await failure(value, otherTenant)).toBeUndefined();
    await denied(value, otherPrincipal);
    await denied(value, otherTenant);
    await value.invalidatePrincipal(actor);
    expect(await failure(value, actor)).toBeUndefined();
    expect(await failure(value, otherPrincipal)).toMatchObject({ status: "missing_permission" });
    expect(await failure(value, otherTenant)).toMatchObject({ status: "missing_permission" });
  });

  it("uses the existing expiry, retention, and capability-invalidation contracts without a new schema", async () => {
    const actor = user();
    const { value, repository } = service();
    await denied(value, actor);
    await repository.invalidateCapability(actor.tenantId!, capabilityId);
    expect(await failure(value, actor)).toBeUndefined();
    await denied(value, actor);
    await fixture.operator.query(
      "UPDATE capability_evidence SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND authorization_principal_id=$2",
      [actor.tenantId, actor.homeAccountId],
    );
    expect(await failure(value, actor)).toBeUndefined();
    await retain(fixture.operator);
    const remaining = await fixture.runtime.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM capability_evidence WHERE tenant_id=$1 AND authorization_principal_id=$2",
      [actor.tenantId, actor.homeAccountId],
    );
    expect(remaining.rows[0].count).toBe("0");
  });
});
