import { isDeepStrictEqual } from "node:util";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import { operationalLog } from "./telemetry.js";

const detailFields = [
  ["elementDetails", "array"],
  ["allowedUsersAndGroups", "array"],
  ["acquireUsersAndGroups", "array"],
  ["longDescription", "string"],
  ["categories", "array"],
  ["sensitivity", "string"],
] as const;

export type PackageReadStage = "catalog" | "identity";

function readCounters() {
  return {
    requestCount: 0, retryCount: 0, throttleCount: 0, requestDurationMs: 0,
    maxRequestDurationMs: 0, admissionWaitMs: 0, retryWaitMs: 0, readIntervalMs: 0,
  };
}

export class PackageScanDiagnostics {
  private readonly startedAt = performance.now();
  private detailStartedAt?: number;
  private pages = 0;
  private listedCount = 0;
  private targetCount?: number;
  private checkedCount = 0;
  private foundCount = 0;
  private comparedCount = 0;
  private matchingObservationCount = 0;
  private readonly reads = { catalog: readCounters(), identity: readCounters() };
  private readonly comparisons = detailFields.map(([field]) => ({
    field, matchingCount: 0, differingCount: 0, listOnlyCount: 0, detailOnlyCount: 0, bothMissingCount: 0,
  }));

  constructor(private readonly mode: "broad" | "exact") {}

  catalogPage(values: readonly unknown[], page: number, hasContinuation: boolean, durationMs: number) {
    this.pages = page;
    this.listedCount += values.length;
    this.log("package_catalog_page", {
      stage: "catalog", page, pageSize: values.length, observedCount: this.listedCount,
      hasContinuation, durationMs: Math.round(durationMs),
    });
    const rows: Record<string, unknown>[] = values.map(value => isRecord(value) ? value : {});
    for (const [field, kind] of detailFields) {
      const counts = { missingCount: 0, nullCount: 0, emptyCount: 0, nonemptyCount: 0, invalidCount: 0 };
      for (const row of rows) {
        const value = row[field];
        if (value === undefined) counts.missingCount += 1;
        else if (value === null) counts.nullCount += 1;
        else if (kind === "array" && Array.isArray(value) || kind === "string" && typeof value === "string") {
          if (value.length === 0) counts.emptyCount += 1;
          else counts.nonemptyCount += 1;
        } else counts.invalidCount += 1;
      }
      this.log("package_catalog_field_coverage", { stage: "catalog", page, field, count: values.length, ...counts });
    }
    const types = new Map<string, number>();
    for (const row of rows) {
      const value = row["@odata.type"];
      const type = value === undefined ? "missing" : value === null ? "null"
        : value === "#microsoft.graph.copilotPackageDetail" ? "detail"
        : value === "#microsoft.graph.copilotPackage" ? "summary" : "other";
      types.set(type, (types.get(type) ?? 0) + 1);
    }
    for (const [actualType, count] of types) {
      this.log("package_catalog_response_type", { stage: "catalog", page, actualType, count });
    }
  }

  startDetails(count: number) {
    this.targetCount = count;
    this.detailStartedAt = performance.now();
  }

  compareDetail(summary: CopilotPackageDetail | undefined, detail: CopilotPackageDetail) {
    if (!summary) return;
    this.comparedCount += 1;
    if (isDeepStrictEqual(summary, detail)) this.matchingObservationCount += 1;
    for (const comparison of this.comparisons) {
      const listed = summary[comparison.field];
      const fetched = detail[comparison.field];
      if (listed === undefined && fetched === undefined) comparison.bothMissingCount += 1;
      else if (listed === undefined) comparison.detailOnlyCount += 1;
      else if (fetched === undefined) comparison.listOnlyCount += 1;
      else if (isDeepStrictEqual(listed, fetched)) comparison.matchingCount += 1;
      else comparison.differingCount += 1;
    }
  }

  completeDetail(found: boolean) {
    this.checkedCount += 1;
    if (found) this.foundCount += 1;
    if (this.checkedCount % 100 === 0) this.readSummary("identity", "package_scan_progress", "collecting");
  }

  recordAttempt(stage: PackageReadStage, durationMs: number, attempt: number, readIntervalMs: number) {
    const counts = this.reads[stage];
    counts.requestCount += 1;
    if (attempt > 1) counts.retryCount += 1;
    counts.requestDurationMs += durationMs;
    counts.maxRequestDurationMs = Math.max(counts.maxRequestDurationMs, durationMs);
    counts.readIntervalMs = Math.max(counts.readIntervalMs, readIntervalMs);
  }

  recordThrottle(stage: PackageReadStage) {
    this.reads[stage].throttleCount += 1;
  }

  recordWait(stage: PackageReadStage, kind: "admissionWaitMs" | "retryWaitMs", durationMs: number) {
    this.reads[stage][kind] += durationMs;
  }

  finish(outcome: "collected" | "failed" | "cancelled" | "timed_out") {
    if (this.mode === "broad") this.readSummary("catalog", "package_scan_summary", outcome);
    if (this.detailStartedAt !== undefined) this.readSummary("identity", "package_scan_summary", outcome);
    if (this.comparedCount === 0) return;
    for (const comparison of this.comparisons) {
      this.log("package_detail_comparison", { stage: "identity", outcome, count: this.comparedCount, ...comparison });
    }
    this.log("package_detail_comparison", {
      stage: "identity", outcome, field: "retained_observation", count: this.comparedCount,
      matchingCount: this.matchingObservationCount, differingCount: this.comparedCount - this.matchingObservationCount,
    });
  }

  private readSummary(stage: PackageReadStage, event: string, outcome: string) {
    const counts = this.reads[stage];
    const durationMs = stage === "catalog"
      ? (this.detailStartedAt ?? performance.now()) - this.startedAt
      : performance.now() - (this.detailStartedAt ?? this.startedAt);
    this.log(event, {
      stage, outcome, pages: this.pages, totalRecords: this.targetCount,
      count: stage === "catalog" ? this.listedCount : this.checkedCount,
      observedCount: stage === "catalog" ? this.listedCount : this.foundCount,
      ...counts, durationMs: Math.round(durationMs),
      requestDurationMs: Math.round(counts.requestDurationMs),
      maxRequestDurationMs: Math.round(counts.maxRequestDurationMs),
      admissionWaitMs: Math.round(counts.admissionWaitMs), retryWaitMs: Math.round(counts.retryWaitMs),
    });
  }

  private log(event: string, fields: Record<string, unknown>) {
    operationalLog("info", event, { provider: "graph_packages", schemaVersion: 1, mode: this.mode, ...fields });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
