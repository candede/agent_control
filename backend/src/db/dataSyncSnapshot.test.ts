import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixtureDirectoryUser } from "../../scripts/userSourceFixture.js";
import { copilotServicePlanDefinitions, resolveCopilotServicePlan } from "../services/copilotServicePlans.js";
import { directoryPlanRecord, directorySourceRecord } from "../services/userSourceRecords.js";
import type { CopilotDirectoryUser } from "../types/copilotUsage.js";
import { encodeBatch } from "./dataBounds.js";
import { DataSyncRepository } from "./dataSync.js";

function user(): CopilotDirectoryUser {
  const value = fixtureDirectoryUser("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Équipe", "person@example.invalid");
  value.copilotServiceState = "enabled";
  value.servicePlans = [...copilotServicePlanDefinitions.keys()].map(servicePlanId => resolveCopilotServicePlan(
    servicePlanId, true, [{ servicePlanId, capabilityStatus: "Enabled", assignedDateTime: "2026-01-01T00:00:00Z" }],
  ));
  return value;
}

describe("retired snapshot and native typed-evidence contracts", () => {
  it("has no snapshot codecs, whole-source writers or whole-source getters", () => {
    const names = Object.getOwnPropertyNames(DataSyncRepository.prototype);
    for (const removed of ["publishDirectory", "publishAppActivity", "getUserSources", "getDirectorySource",
      "getAppActivitySource", "readSources", "getPublished"]) expect(names).not.toContain(removed);
    const implementation = readFileSync(new URL("./dataSync.ts", import.meta.url), "utf8");
    expect(implementation).not.toMatch(/service-plan-sets-v1|storageEncoding|servicePlanSets|snapshot_data/);
  });

  it("stores all three features as independent typed children rather than an encoded parent array", () => {
    const value = user(), parent = directorySourceRecord(value);
    expect(parent).toMatchObject({ identity: value.identity.objectId, display_name: "Équipe",
      upn: "person@example.invalid", service_state: "enabled", plan_count: 3 });
    expect(parent.residual).toEqual({ evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(parent).not.toHaveProperty("servicePlans");
    expect(parent).not.toHaveProperty("servicePlanSet");
    const children = value.servicePlans.map(plan => directoryPlanRecord(parent.identity, plan));
    expect(children).toHaveLength(3);
    expect(new Set(children.map(child => child.plan_id)).size).toBe(3);
    for (const [index, child] of children.entries()) {
      expect(child).toMatchObject({ user_id: parent.identity, state: "enabled", capability_status: "Enabled",
        assigned_at: value.servicePlans[index].assignedDateTime,
        residual: { assignedDateTime: value.servicePlans[index].assignedDateTime } });
    }
    children[0].residual.assignedDateTime = null;
    expect(value.servicePlans[0].assignedDateTime).not.toBeNull();
    expect(children[1].residual.assignedDateTime).not.toBeNull();
  });

  it("canonicalizes child order without hiding evidence or identity changes", () => {
    const value = user(), first = directorySourceRecord(value);
    expect(directorySourceRecord({ ...value, servicePlans: value.servicePlans.toReversed() })).toEqual(first);
    const changed = { ...value, identity: { ...value.identity, department: "Research" } };
    expect(directorySourceRecord(changed).residual.evidenceHash).not.toBe(first.residual.evidenceHash);
    const changedPlans = { ...value, servicePlans: value.servicePlans.map((plan, index) => index ? plan : {
      ...plan, assignedDateTime: "2026-02-01T00:00:00Z",
    }) };
    expect(directorySourceRecord(changedPlans).residual.evidenceHash).not.toBe(first.residual.evidenceHash);
  });

  it.each([
    { serviceEvidenceVersion: 0 },
    { serviceEvidenceVersion: undefined },
    { copilotServiceState: "assigned" },
    { copilotServiceState: "disabled" },
    { servicePlans: undefined },
    { servicePlans: null },
  ])("rejects invalid typed parent evidence: %#", patch => {
    expect(() => directorySourceRecord({ ...user(), ...patch } as CopilotDirectoryUser))
      .toThrow(expect.objectContaining({ status: 502, code: "provider_schema" }));
  });

  it("rejects duplicate child identities and more than 1000 children before hashing", () => {
    const value = user();
    expect(() => directorySourceRecord({ ...value, servicePlans: [value.servicePlans[0],
      { ...value.servicePlans[0], servicePlanId: value.servicePlans[0].servicePlanId.toUpperCase() }] }))
      .toThrow(expect.objectContaining({ code: "provider_schema" }));
    expect(() => directorySourceRecord({ ...value,
      servicePlans: Array.from({ length: 1001 }, (_, index) => ({ ...value.servicePlans[0], servicePlanId: String(index) })) }))
      .toThrow(expect.objectContaining({ code: "provider_schema" }));
  });

  it.each([
    ["displayName", 512], ["userPrincipalName", 320], ["companyName", 256],
    ["department", 256], ["userType", 64], ["employeeType", 128],
  ] as const)("enforces the typed %s field boundary without snapshot expansion", (field, limit) => {
    const value = user();
    expect(() => directorySourceRecord({ ...value, identity: { ...value.identity, [field]: "é".repeat(limit) } })).not.toThrow();
    expect(() => directorySourceRecord({ ...value, identity: { ...value.identity, [field]: "é".repeat(limit + 1) } }))
      .toThrow(expect.objectContaining({ code: "provider_schema" }));
  });

  it("retains nullable child evidence and enforces child text bounds before storage", () => {
    const value = user(), plan = value.servicePlans[0];
    expect(directoryPlanRecord(value.identity.objectId, { ...plan, state: "unknown",
      assignedDateTime: null, capabilityStatus: null })).toMatchObject({
      state: "unknown", assigned_at: null, capability_status: null, residual: { assignedDateTime: null },
    });
    expect(() => directoryPlanRecord(value.identity.objectId, { ...plan, displayName: "é".repeat(1024) })).not.toThrow();
    expect(() => directoryPlanRecord(value.identity.objectId, { ...plan, displayName: "é".repeat(1025) }))
      .toThrow(expect.objectContaining({ code: "provider_schema" }));
  });

  it("bounds SQL batches independently of the retired 32-MiB snapshot contract", () => {
    const row = directorySourceRecord(user());
    const batch = encodeBatch(Array.from({ length: 250 }, () => row));
    expect(batch.bytes).toBeLessThanOrEqual(1024 ** 2);
    expect(() => encodeBatch(Array.from({ length: 251 }, () => row)))
      .toThrow(expect.objectContaining({ code: "data_batch_rows" }));
  });
});
