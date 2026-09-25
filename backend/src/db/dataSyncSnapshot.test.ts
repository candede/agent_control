import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { DataSyncRepository } from "./dataSync.js";

const scope = { tenantId: "snapshot-tenant", principalId: "snapshot-reader" };
const user = {
  serviceEvidenceVersion: 1,
  identity: {
    objectId: "saved-user", userPrincipalName: "saved@example.invalid", displayName: "Saved person",
    accountEnabled: true, userType: "Member", employeeType: null, companyName: null, department: null,
  },
  copilotServiceState: "enabled",
  servicePlanSet: 0,
};
const plan = {
  servicePlanId: "paid-feature", service: "M365_COPILOT_APPS", displayName: "Paid feature",
  state: "enabled", assignedDateTime: "2026-01-01T00:00:00Z", capabilityStatus: "Enabled",
};
const encoded = {
  serviceEvidenceVersion: 1, storageEncoding: "service-plan-sets-v1", servicePlanSets: [[plan]], users: [user],
};

describe("directory snapshot storage contract", () => {
  it("restores encoded evidence while preserving the existing unencoded format", async () => {
    const { servicePlanSet: _index, ...fields } = user;
    const users = [{ ...fields, servicePlans: [plan] }];
    expect(await readSnapshot(encoded)).toEqual(users);
    expect(await readSnapshot({ serviceEvidenceVersion: 1, users })).toEqual(users);
    expect(await readSnapshot({ ...encoded, servicePlanSets: [], users: [] })).toEqual([]);
  });

  it.each([
    { ...encoded, storageEncoding: "unknown" },
    { ...encoded, storageEncoding: null },
    { ...encoded, servicePlanSets: undefined },
    { ...encoded, servicePlanSets: {} },
    { ...encoded, servicePlanSets: [null] },
    { ...encoded, servicePlanSets: [[null]] },
    { ...encoded, users: [null] },
    ...[undefined, -1, 0.5, "0", 1].map(servicePlanSet => ({ ...encoded, users: [{ ...user, servicePlanSet }] })),
    { ...encoded, users: [{ ...user, servicePlans: [] }] },
    { ...encoded, users: [{ ...user, serviceEvidenceVersion: 0 }] },
    { ...encoded, users: [{ ...user, copilotServiceState: "assigned" }] },
  ])("rejects unsupported encodings or malformed references: %#", async snapshot => {
    await expect(readSnapshot(snapshot)).rejects.toMatchObject({ status: 409, code: "copilot_usage_snapshot_invalid" });
  });

  it("bounds expanded evidence before copying every referenced plan set", async () => {
    const snapshot = {
      ...encoded,
      servicePlanSets: [[{ ...plan, displayName: "é".repeat(170_000) }]],
      users: Array.from({ length: 100 }, () => ({ ...user })),
    };
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(32 * 1024 * 1024);
    await expect(readSnapshot(snapshot)).rejects.toMatchObject({ status: 413, code: "copilot_usage_snapshot_limit" });
  });

  it("keeps the directory row bound when encoded evidence is small", async () => {
    await expect(readSnapshot({ ...encoded, users: Array.from({ length: 100_001 }, () => user) }))
      .rejects.toMatchObject({ status: 413, code: "copilot_usage_snapshot_limit" });
  });

  it("rejects oversized normalized writes even when repeated feature evidence could be encoded compactly", async () => {
    const database = new pg.Pool();
    const connect = vi.spyOn(database, "connect").mockRejectedValue(new Error("Oversized writes must not reach the database."));
    const users = Array.from({ length: 100 }, () => ({
      ...user, serviceEvidenceVersion: 1 as const, copilotServiceState: "enabled" as const,
      servicePlans: [{
        ...plan, state: "enabled" as const, capabilityStatus: "Enabled" as const,
        displayName: "é".repeat(170_000),
      }],
    }));
    try {
      await expect(new DataSyncRepository(database).publishDirectory(scope, users, new Date().toISOString(), "Too large."))
        .rejects.toMatchObject({ status: 413, code: "copilot_usage_snapshot_limit" });
      expect(connect).not.toHaveBeenCalled();
    } finally {
      await database.end();
    }
  });
});

async function readSnapshot(snapshot: unknown) {
  const database = new pg.Pool();
  vi.spyOn(database, "query").mockResolvedValue({
    rows: [{ source_id: "directory", snapshot_data: snapshot }],
    rowCount: 1, command: "SELECT", oid: 0, fields: [],
  });
  try {
    return (await new DataSyncRepository(database).getDirectorySource(scope)).value;
  } finally {
    await database.end();
  }
}
