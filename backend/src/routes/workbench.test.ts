import { describe, expect, it } from "vitest";
import type { DataSyncRun, DataSyncSourceStatus } from "../types/dataSync.js";
import { workbenchViewIds } from "../types/workbench.js";
import { dataSyncJobSummary, defenderJobSummary, officialUsageJobSummary, packageRefreshJobSummary, powerPlatformJobSummary, purviewJobSummary } from "./workbench.js";

const source = (overrides: Partial<DataSyncSourceStatus> = {}): DataSyncSourceStatus => ({
  source: "users", status: "succeeded", jobId: null, count: 0,
  lastSuccessAt: "2026-09-15T08:00:00.000Z", updatedAt: "2026-09-15T08:00:00.000Z",
  message: "No licensed users found.", canRetry: false, ...overrides,
});
const run = (overrides: Partial<DataSyncRun> = {}): DataSyncRun => ({
  id: "sync-1", mode: "initial", status: "waiting", startedAt: "2026-09-15T08:00:00.000Z",
  updatedAt: "2026-09-15T08:00:00.000Z", completedAt: null,
  sources: [source(), source({ source: "usage_reports", status: "awaiting_upload", count: null, lastSuccessAt: null })],
  ...overrides,
});

describe("sync jobs projection", () => {
  it("counts successful zero-row sources and keeps a manual upload incomplete", () => {
    expect(dataSyncJobSummary(run())).toMatchObject({
      source: "data-sync", total: 2, completed: 1, status: "waiting",
      target: "Users, Usage reports", syncSources: ["users", "usage_reports"],
      createdAt: "2026-09-15T08:00:00.000Z", startedAt: "2026-09-15T08:00:00.000Z",
      canCancel: true, canResume: false, href: "/sync?syncRun=sync-1",
    });
    expect(dataSyncJobSummary(run())).not.toHaveProperty("completedAt");
  });

  it("reports partial source failures and exposes only explicit retry", () => {
    expect(dataSyncJobSummary(run({
      status: "partial",
      sources: [source(), source({ source: "power_platform", status: "permission_required", canRetry: true })],
    }))).toMatchObject({ partial: true, canResume: true, canReconcile: false, completed: 1 });
  });

  it("does not advertise retry while another source is still running", () => {
    expect(dataSyncJobSummary(run({
      status: "running",
      sources: [
        source({ status: "failed", canRetry: true }),
        source({ source: "power_platform", status: "running" }),
      ],
    }))).toMatchObject({ canResume: false, canCancel: true, partial: true });
  });

  it("does not offer cancellation for a completed full resync", () => {
    expect(dataSyncJobSummary(run({
      mode: "full", status: "completed", sources: [source()], completedAt: "2026-09-15T08:05:00.000Z",
    }))).toMatchObject({
      label: "Full data resync", completed: 1, total: 1, canCancel: false,
      target: "Users", syncSources: ["users"], completedAt: "2026-09-15T08:05:00.000Z",
    });
  });

  it("names every requested automatic source without adding manual uploads to the scope", () => {
    expect(dataSyncJobSummary(run({
      sources: [source(), source({ source: "graph_packages" }), source({ source: "power_platform" })],
    }))).toMatchObject({
      target: "Users, Graph packages, Power Platform",
      syncSources: ["users", "graph_packages", "power_platform"],
    });
  });
});

describe("read-source job projection", () => {
  const dates = {
    createdAt: "2026-09-15T08:00:00.000Z",
    attemptedAt: "2026-09-15T08:01:00.000Z",
    updatedAt: "2026-09-15T08:05:00.000Z",
    finishedAt: "2026-09-15T08:05:00.000Z",
  };
  const packageJob: Parameters<typeof packageRefreshJobSummary>[0] = {
    id: "package-1", authorizationPrincipalId: "viewer", tokenMode: "delegated", scopeKind: "broad",
    requestedIds: [], status: "succeeded", pageCount: 2, observedCount: 25, totalRecords: 25, snapshotId: "snapshot-1",
    ...dates,
  };
  const inventoryJob: Parameters<typeof powerPlatformJobSummary>[0] = {
    id: "inventory-1", status: "succeeded", roleScope: "full", environmentScope: null, requestedTypes: [],
    pageCount: 2, observedCount: 25, totalRecords: 25, unknownFieldCount: 0, snapshotId: "snapshot-2",
    ...dates,
  };

  it.each(["failed", "waiting_authorization", "running", "succeeded", "cancelled"] as const)("routes the exact %s Power Platform job to Sync", status => {
    expect(powerPlatformJobSummary({ ...inventoryJob, status, id: "exact/job" }).href).toBe("/sync?powerPlatformJob=exact%2Fjob");
  });

  it("uses stored provider-attempt and completion dates rather than treating admission as execution", () => {
    for (const summary of [packageRefreshJobSummary(packageJob), powerPlatformJobSummary(inventoryJob)]) {
      expect(summary).toMatchObject({
        createdAt: dates.createdAt, startedAt: dates.attemptedAt, completedAt: dates.finishedAt,
        canResume: false, canCancel: false, canReconcile: false,
      });
      expect(summary).not.toHaveProperty("syncSources");
    }
  });

  it("omits unknown dates and preserves waiting-authorization recovery actions", () => {
    const waiting = { status: "waiting_authorization" as const, attemptedAt: null, finishedAt: null };
    for (const summary of [
      packageRefreshJobSummary({ ...packageJob, ...waiting }),
      powerPlatformJobSummary({ ...inventoryJob, ...waiting }),
    ]) {
      expect(summary).not.toHaveProperty("startedAt");
      expect(summary).not.toHaveProperty("completedAt");
      expect(summary.createdAt).toBe(dates.createdAt);
      expect(summary).toMatchObject({ canResume: true, canCancel: true, canReconcile: false });
    }
  });

  it("keeps observed progress distinct from known provider targets", () => {
    const running = { status: "running" as const, observedCount: 7, totalRecords: 120, finishedAt: null };
    for (const summary of [
      packageRefreshJobSummary({ ...packageJob, ...running }),
      powerPlatformJobSummary({ ...inventoryJob, ...running }),
    ]) {
      expect(summary).toMatchObject({ completed: 7, total: 120, startedAt: dates.attemptedAt, canCancel: true, canResume: false });
      expect(summary).not.toHaveProperty("completedAt");
    }
  });
});

describe("investigation history projection", () => {
  const dates = {
    createdAt: "2026-09-15T08:00:00.000Z", attemptedAt: "2026-09-15T08:01:00.000Z",
    finishedAt: "2026-09-15T08:02:00.000Z", updatedAt: "2026-09-20T08:00:00.000Z",
    expiresAt: "2026-10-15T08:00:00.000Z",
  };
  const purview: Parameters<typeof purviewJobSummary>[0] = {
    id: "audit-1", authorizationPrincipalId: "principal",
    resultScope: { kind: "principal", scopeId: "principal", configurationRevision: null },
    tokenMode: "delegated", status: "succeeded",
    filters: {
      presetId: "copilot_interactions", startDateTime: "2026-09-15T06:00:00.000Z", endDateTime: "2026-09-15T07:00:00.000Z",
      operations: [], userPrincipalNames: ["sensitive@example.invalid"], ipAddresses: [], objectIds: [], administrativeUnitIds: [],
    },
    displayName: "Audit search", providerQueryId: "provider-query", providerStatus: "succeeded",
    localRequestId: "local-request", providerRequestId: "provider-request", projectionVersion: 1,
    providerRequestCount: 2, activationCount: 1, pageCount: 1, providerRowCount: 0, storedRowCount: 0,
    byteCount: 0, unknownFieldCount: 0, pageComplete: true, observedRange: null, unobservedRange: null,
    qualificationId: null, cancelRequested: false, canResume: false, remoteWorkMayContinue: false,
    message: "Private provider message", ...dates,
  };
  const defender: Parameters<typeof defenderJobSummary>[0] = {
    id: "hunt-1", authorizationPrincipalId: "principal",
    resultScope: { kind: "principal", scopeId: "principal", configurationRevision: null },
    tokenMode: "delegated", status: "inconclusive",
    filters: {
      templateId: "agents_inventory", startDateTime: "2026-09-15T06:00:00.000Z", endDateTime: "2026-09-15T07:00:00.000Z",
      agentIds: ["private-agent-id"], blueprintIds: [], actorObjectIds: [], operations: [],
    },
    queryVersion: 3, retainedScopeId: null, localRequestId: "local-request", providerRequestId: "provider-request",
    providerRequestCount: 1, activationCount: 1, providerRowCount: 0, storedRowCount: 0, byteCount: 0,
    complete: false, noData: false, partialReason: null, observedRange: null, unobservedRange: null,
    snapshotId: null, priorSuccessfulJobId: null, qualification: null, cancelRequested: false, canResume: false,
    message: "Private provider message", ...dates,
  };

  it("retires the Security view and sends legacy/scoped job summaries to Agents without guessing canonical identities", () => {
    expect(workbenchViewIds).not.toContain("security");
    for (const filters of [
      defender.filters,
      { ...defender.filters, agentIds: [] },
      { ...defender.filters, agentIds: [], entraAgentIds: ["11111111-1111-4111-8111-111111111111"] },
    ]) expect(defenderJobSummary({ ...defender, filters }).href).toBe("/agents");
  });

  it("routes Purview investigations through Users or Agents, never through local Audit", () => {
    expect(purviewJobSummary(purview).href).toBe("/users");
    expect(purviewJobSummary({ ...purview, filters: { ...purview.filters, userPrincipalNames: [] } }).href).toBe("/agents");
    expect(purviewJobSummary({ ...purview, filters: { ...purview.filters, userPrincipalNames: ["one@example.invalid", "two@example.invalid"] } }).href).toBe("/agents");
  });

  it("preserves creation, actual execution and completion separately from later updates", () => {
    for (const summary of [purviewJobSummary(purview), defenderJobSummary(defender)]) {
      expect(summary).toMatchObject({
        createdAt: dates.createdAt, startedAt: dates.attemptedAt, completedAt: dates.finishedAt,
        updatedAt: dates.updatedAt, completed: 0,
      });
      expect(summary).not.toHaveProperty("filters");
      expect(summary).not.toHaveProperty("message");
      expect(JSON.stringify(summary)).not.toMatch(/sensitive@example|private-agent-id|Private provider message/);
    }
  });
  it("does not infer start or completion for waiting or interrupted investigations", () => {
    const waiting = { attemptedAt: null, finishedAt: null, status: "waiting_authorization" as const, canResume: true };
    for (const summary of [purviewJobSummary({ ...purview, ...waiting }), defenderJobSummary({ ...defender, ...waiting })]) {
      expect(summary).not.toHaveProperty("startedAt");
      expect(summary).not.toHaveProperty("completedAt");
      expect(summary).toMatchObject({ createdAt: dates.createdAt, canResume: true, canCancel: true });
    }
  });

  it("preserves a confirmed zero-row result instead of marking its count unknown", () => {
    for (const summary of [
      purviewJobSummary({ ...purview, status: "succeeded", pageComplete: true }),
      defenderJobSummary({ ...defender, status: "succeeded", complete: true, noData: true }),
    ]) {
      expect(summary).toMatchObject({ total: 0, completed: 0, partial: false });
    }
  });

  it.each(["waiting_authorization", "running", "failed", "cancelled", "inconclusive", "partial"] as const)(
    "does not turn an unconfirmed zero-row count into a known empty result for %s", status => {
      for (const summary of [
        purviewJobSummary({ ...purview, status, pageComplete: false }),
        defenderJobSummary({ ...defender, status, complete: false }),
      ]) {
        expect(summary).toMatchObject({ total: null, completed: 0 });
      }
    },
  );

  it("preserves nonzero provider counts separately from retained rows for partial results", () => {
    expect(purviewJobSummary({
      ...purview, status: "partial", pageComplete: false, providerRowCount: 11, storedRowCount: 10,
    })).toMatchObject({ total: 11, completed: 10, partial: true });
    expect(defenderJobSummary({
      ...defender, status: "partial", complete: false, providerRowCount: 201, storedRowCount: 200,
    })).toMatchObject({ total: 201, completed: 200, partial: true });
  });
});

describe("CSV import history projection", () => {
  const stage: Parameters<typeof officialUsageJobSummary>[0] = {
    id: "stage-1", revision: 1, status: "active", kind: "userAgents",
    fileHash: "file-hash", contentHash: "content-hash", parserVersion: "1", schemaVersion: "1", bundleId: "bundle-1",
    correctionOfSetId: null, reportingPeriod: { startDate: "2026-09-01", endDate: "2026-09-07", provenance: "operator_asserted" },
    sourceAsOf: null, sourceAsOfProvenance: "absent", sourceFreshness: "unknown", downloadedAt: null,
    rowCount: 536, warnings: [], reconciliation: {}, activeRevision: 1,
    acceptedVersionId: null, acceptedSetId: null, acceptedAt: null,
    createdAt: "2026-09-15T08:00:00.000Z", expiresAt: "2026-09-16T08:00:00.000Z",
  };

  it("describes a file awaiting review without claiming an accepted report", () => {
    const summary = officialUsageJobSummary(stage);
    expect(summary).toMatchObject({
      label: "Users & agents CSV import", target: "Users & agents export · 536 validated rows",
      createdAt: stage.createdAt, updatedAt: stage.createdAt,
      status: "active", canCancel: true, href: "/sync?reports=import&staging=stage-1",
    });
    expect(summary).not.toHaveProperty("completedAt");
    expect(summary).not.toHaveProperty("startedAt");
    expect(summary).not.toHaveProperty("reconciliation");
  });
  it("links accepted files to the exact Sync snapshot inspector instead of reopening the import modal", () => {
    const acceptedAt = "2026-09-15T09:00:00.000Z";
    const summary = officialUsageJobSummary({ ...stage, status: "accepted", acceptedAt, acceptedSetId: "set/one" });
    expect(summary).toMatchObject({
      createdAt: stage.createdAt, completedAt: acceptedAt, updatedAt: acceptedAt,
      status: "accepted", canCancel: false, href: "/sync?reports=snapshot&snapshot=set%2Fone",
    });
    expect(summary).not.toHaveProperty("startedAt");
  });
  it.each(["discarded", "expired", "accepted"] as const)("does not invent dates or reopen a %s draft without a snapshot", status => {
    const summary = officialUsageJobSummary({ ...stage, status });
    expect(summary).toMatchObject({ canCancel: false, href: "/sync?reports=manage" });
    expect(summary).not.toHaveProperty("completedAt");
  });
  it("encodes exact staging and snapshot identifiers without letting them change the report workflow", () => {
    const id = "exact/id&reports=manage#one";
    expect(officialUsageJobSummary({ ...stage, id }).href).toBe(
      "/sync?reports=import&staging=exact%2Fid%26reports%3Dmanage%23one",
    );
    expect(officialUsageJobSummary({ ...stage, status: "accepted", acceptedSetId: id }).href).toBe(
      "/sync?reports=snapshot&snapshot=exact%2Fid%26reports%3Dmanage%23one",
    );
  });
});
