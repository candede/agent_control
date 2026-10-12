import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { fixtureDirectoryUser } from "../../scripts/userSourceFixture.js";
import { copilotServicePlanDefinitions, resolveCopilotServicePlan } from "../services/copilotServicePlans.js";
import { activitySourceRecord, directoryPlanRecord, directorySourceRecord } from "../services/userSourceRecords.js";
import { parseReportUser } from "../services/userSourceGraphFields.js";
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

  it("canonicalizes both parent and child Graph GUIDs and equivalent assignment instants", () => {
    const value = user(), plan = value.servicePlans[0];
    const canonical = directoryPlanRecord(value.identity.objectId, plan);
    const equivalent = { ...plan, servicePlanId: plan.servicePlanId.toUpperCase(),
      assignedDateTime: "2026-01-01T01:00:00.0000000+01:00" };
    expect(directoryPlanRecord(value.identity.objectId.toUpperCase(), equivalent)).toEqual(canonical);
    expect(directorySourceRecord({ ...value, identity: { ...value.identity, objectId: value.identity.objectId.toUpperCase() },
      servicePlans: [equivalent, ...value.servicePlans.slice(1)] })).toEqual(directorySourceRecord(value));
  });

  it.each(["root-accessor", "identity-accessor", "plan-accessor", "array-accessor", "array-method",
    "root-proxy", "identity-proxy", "plan-proxy", "array-proxy", "revoked-proxy", "inherited", "sparse"] as const)(
    "rejects %s directory evidence without executing customer code", boundary => {
      let value = user();
      const trap = vi.fn(() => { throw new Error("Source evidence must not execute customer code."); });
      if (boundary === "root-accessor") Object.defineProperty(value, "identity", { get: trap });
      if (boundary === "identity-accessor") Object.defineProperty(value.identity, "displayName", { get: trap });
      if (boundary === "plan-accessor") Object.defineProperty(value.servicePlans[0], "servicePlanId", { get: trap });
      if (boundary === "array-accessor") Object.defineProperty(value.servicePlans, "0", { get: trap });
      if (boundary === "array-method") Object.defineProperty(value.servicePlans, "map", { value: trap });
      const handler = { get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap, ownKeys: trap };
      if (boundary === "root-proxy") value = new Proxy(value, handler);
      if (boundary === "identity-proxy") value.identity = new Proxy(value.identity, handler);
      if (boundary === "plan-proxy") value.servicePlans[0] = new Proxy(value.servicePlans[0], handler);
      if (boundary === "array-proxy") value.servicePlans = new Proxy(value.servicePlans, handler);
      if (boundary === "revoked-proxy") {
        const proxy = Proxy.revocable(value, {});
        proxy.revoke();
        value = proxy.proxy;
      }
      if (boundary === "inherited") value = Object.create(value);
      if (boundary === "sparse") delete value.servicePlans[0];
      const error = (() => { try { directorySourceRecord(value); } catch (failure) { return failure; } })();
      expect(trap).not.toHaveBeenCalled();
      expect(error).toMatchObject({ status: 502, code: "provider_schema" });
    },
  );

  it.each(["not-a-guid", " a62f8878-de10-42f3-b68f-6149a25ceb97", "a62f8878-de10-42f3-b68f-6149a25ceb97 "])(
    "rejects nonexact typed child GUIDs before hashing: %j", servicePlanId => {
      const value = user(), plan = { ...value.servicePlans[0], servicePlanId };
      expect(() => directoryPlanRecord(value.identity.objectId, plan)).toThrow(expect.objectContaining({ code: "provider_schema" }));
      expect(() => directorySourceRecord({ ...value, servicePlans: [plan] })).toThrow(expect.objectContaining({ code: "provider_schema" }));
      expect(() => directoryPlanRecord(servicePlanId, value.servicePlans[0])).toThrow(expect.objectContaining({ code: "provider_schema" }));
    },
  );

  it("rejects coercion-backed assignment values before constructing a date", () => {
    const value = user(), plan = value.servicePlans[0];
    const coerce = vi.fn(() => "2026-01-01T00:00:00Z");
    Object.defineProperty(plan, "assignedDateTime", { value: { [Symbol.toPrimitive]: coerce } });
    expect(() => directoryPlanRecord(value.identity.objectId, plan)).toThrow(expect.objectContaining({ code: "provider_schema" }));
    expect(() => directorySourceRecord(value)).toThrow(expect.objectContaining({ code: "provider_schema" }));
    expect(coerce).not.toHaveBeenCalled();
  });

  it("accepts frozen own-data evidence with null prototypes without changing its hash", () => {
    const value = user(), expected = directorySourceRecord(value);
    for (const object of [value, value.identity, ...value.servicePlans]) {
      Object.setPrototypeOf(object, null);
      Object.freeze(object);
    }
    Object.freeze(value.servicePlans);
    expect(directorySourceRecord(value)).toEqual(expected);
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

  it.each(["0000-12-31T23:00:00.000Z", "0000-12-31T23:30:00-01:00", "+010000-01-01T00:30:00.000Z",
    "", "2026-01-01", "2026-01-01T00:00:00", "2026-02-30T00:00:00Z", "2026-01-01T24:00:00Z",
    "0001-01-01T00:00:00+01:00", "9999-12-31T23:30:00-01:00"])(
    "rejects assignment evidence without a genuine storage-safe instant: %s", assignedDateTime => {
      const value = user(), plan = { ...value.servicePlans[0], assignedDateTime };
      expect(() => directoryPlanRecord(value.identity.objectId, plan))
        .toThrow(expect.objectContaining({ status: 502, code: "provider_schema" }));
      expect(() => directorySourceRecord({ ...value, servicePlans: [plan] }))
        .toThrow(expect.objectContaining({ status: 502, code: "provider_schema" }));
    },
  );

  it.each(["\ud800", "\udfff", "\0"])("rejects non-storage-safe directory text %j without rejecting Unicode pairs", invalid => {
    const value = user();
    expect(() => directorySourceRecord({ ...value, identity: { ...value.identity, displayName: `Person${invalid}` } }))
      .toThrow(expect.objectContaining({ code: "provider_schema" }));
    expect(() => directoryPlanRecord(value.identity.objectId, { ...value.servicePlans[0], displayName: invalid }))
      .toThrow(expect.objectContaining({ code: "provider_schema" }));
    expect(directorySourceRecord({ ...value, identity: { ...value.identity, displayName: "Person😀" } }).display_name).toBe("Person😀");
  });

  it("keeps lowercasing expansion within storage bounds without changing identity normalization", () => {
    const value = user(), upn = `${"İ".repeat(200)}@example.invalid`;
    expect(directorySourceRecord({ ...value, identity: { ...value.identity, userPrincipalName: upn } }).upn_key).toBe(upn.toLowerCase());
    expect(() => directorySourceRecord({ ...value, identity: { ...value.identity, userPrincipalName: "İ".repeat(320) } }))
      .toThrow(expect.objectContaining({ code: "provider_schema" }));
  });

  it.each([NaN, Infinity, -1, 0.5, 100_001, Number.MAX_SAFE_INTEGER])("rejects unbounded or noninteger activity ordinals: %s", ordinal => {
    const row = parseReportUser(["2026-10-10", "Person@example.invalid", "Person", "", "", "", "", "", "", "", "", "", "28"]);
    expect(() => activitySourceRecord(row, ordinal)).toThrow(expect.objectContaining({ code: "provider_schema" }));
    expect(activitySourceRecord(row, 0).identity).toBe("000000");
    expect(activitySourceRecord(row, 100_000).identity).toBe("100000");
  });

  it.each(["2026-02-30", "0000-01-01", "2026-01-01T00:00:00Z", "", undefined])(
    "validates direct activity evidence before staging: %j", lastActivityDate => {
      const row = parseReportUser(["2026-10-10", "Person@example.invalid", "Person", "", "", "", "", "", "", "", "", "", "28"]);
      Object.defineProperty(row.activity, "lastActivityDate", { value: lastActivityDate });
      expect(() => activitySourceRecord(row, 1)).toThrow(expect.objectContaining({ code: "provider_schema" }));
    },
  );

  it("rejects accessor-backed activity dates without invoking them", () => {
    const row = parseReportUser(["2026-10-10", "Person@example.invalid", "Person", "", "", "", "", "", "", "", "", "", "28"]);
    const getter = vi.fn(() => "2026-10-10");
    Object.defineProperty(row.activity, "reportRefreshDate", { get: getter });
    expect(() => activitySourceRecord(row, 1)).toThrow(expect.objectContaining({ code: "provider_schema" }));
    expect(getter).not.toHaveBeenCalled();
  });

  it("bounds SQL batches independently of the retired 32-MiB snapshot contract", () => {
    const row = directorySourceRecord(user());
    const batch = encodeBatch(Array.from({ length: 250 }, () => row));
    expect(batch.bytes).toBeLessThanOrEqual(1024 ** 2);
    expect(() => encodeBatch(Array.from({ length: 251 }, () => row)))
      .toThrow(expect.objectContaining({ code: "data_batch_rows" }));
  });
});
