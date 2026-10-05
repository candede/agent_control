import { randomUUID } from "node:crypto";
import type { BeginGeneration, DirectoryRecord } from "../src/db/dataGenerations.js";
import { digest } from "../src/db/dataBounds.js";
import type { OfficialUsageReportKind } from "../src/types/officialReportRecords.js";

export function generationInput(overrides: Partial<BeginGeneration> = {}): BeginGeneration {
  const now = Date.now();
  return {
    scope: { tenantId: "synthetic-tenant", kind: "principal", principalId: "synthetic-principal", tokenMode: "delegated", source: "directory", selector: "complete" },
    schemaVersion: 1, sessionEpoch: "0", jobId: randomUUID(), jobKind: "fixture", observedAt: new Date(now),
    expiresAt: new Date(now + 86_400_000), deadlineAt: new Date(now + 1800_000), reserveBytes: 16 * 1024 ** 2, ...overrides,
  };
}
export function directoryRecord(id = "one", overrides: Partial<DirectoryRecord> = {}): DirectoryRecord {
  return {
    identity: id, upn: `${id}@example.invalid`, upn_key: `${id}@example.invalid`, display_name: id,
    sort_key: id, company: "Example", department: null, account_enabled: true, user_type: "Member", employee_type: null,
    service_state: "unknown", plan_count: 0, residual: {}, ...overrides,
  };
}
export const selectionIdentity = {
  tenantId: "synthetic-tenant", principalId: "synthetic-principal", sessionEpoch: "0", authorizationHash: digest("synthetic-viewer-authorization-epoch-1"),
};
export const licensingGolden = [
  { state: "enabled", paid: true }, { state: "warning", paid: true }, { state: "partially_enabled", paid: true },
  { state: "disabled", paid: false }, { state: "suspended", paid: false }, { state: "locked_out", paid: false },
  { state: "unknown", paid: false },
] as const;

export function officialGoldenCsvRows(): Record<OfficialUsageReportKind, readonly string[]> {
  return {
    agents: ["agent-one,One,Declarative,1,1,9,"],
    userAgents: ["agent-one,One,Declarative,exact@example.invalid,5,", "agent-one,One,Declarative,unresolved-token,4,"],
    users: ["exact@example.invalid,Exact,1,5,", "zero@example.invalid,Zero,0,0,"],
  };
}
