import { isDeepStrictEqual } from "node:util";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import { operationalLog } from "./telemetry.js";

const detailFields = [
  ["elementDetails", "array"],
  ["allowedUsersAndGroups", "array"],
  ["acquireUsersAndGroups", "array"],
  ["sharedWithUsersAndGroups", "array"],
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
  private finishedAt?: number;
  private detailStartedAt?: number;
  private pages = 0;
  private listedCount = 0;
  private targetCount?: number;
  private checkedCount = 0;
  private foundCount = 0;
  private comparedCount = 0;
  private matchingObservationCount = 0;
  private readonly reads = { catalog: readCounters(), identity: readCounters() };
  private readonly catalogCoverage = detailFields.map(([field, kind]) => ({
    field, kind, missingCount: 0, nullCount: 0, emptyCount: 0, nonemptyCount: 0, invalidCount: 0,
  }));
  private readonly catalogTypes = new Map<string, number>();
  private catalogRecordCount = 0;
  private readonly comparisons = detailFields.map(([field]) => ({
    field, matchingCount: 0, differingCount: 0, listOnlyCount: 0, detailOnlyCount: 0, bothMissingCount: 0,
  }));

  constructor(private readonly mode: "broad" | "exact") {}

  catalogPage(count: number, page: number, hasContinuation: boolean, durationMs: number, totalRecords?: number) {
    if (this.finishedAt !== undefined) return;
    this.pages = page;
    this.listedCount += count;
    this.log("package_catalog_page", {
      stage: "catalog", page, pageSize: count, observedCount: this.listedCount,
      hasContinuation, durationMs: Math.round(durationMs), totalRecords,
    });
    this.logCatalogCoverage(page, count, true);
  }

  catalogFailure(page: number) {
    if (this.finishedAt === undefined && this.catalogRecordCount) this.logCatalogCoverage(page, this.catalogRecordCount, false);
  }

  private logCatalogCoverage(page: number, count: number, complete: boolean) {
    for (const coverage of this.catalogCoverage) {
      const { field, kind: _kind, ...counts } = coverage;
      this.log("package_catalog_field_coverage", { stage: "catalog", page, field, count, complete, ...counts });
    }
    for (const [actualType, count] of this.catalogTypes) {
      this.log("package_catalog_response_type", { stage: "catalog", page, actualType, count, complete });
    }
    this.beginCatalogPage();
  }

  beginCatalogPage() {
    if (this.finishedAt !== undefined) return;
    this.catalogRecordCount = 0;
    for (const coverage of this.catalogCoverage) {
      for (const key of ["missingCount", "nullCount", "emptyCount", "nonemptyCount", "invalidCount"] as const) coverage[key] = 0;
    }
    this.catalogTypes.clear();
  }

  catalogRecords(values: readonly unknown[]) {
    if (this.finishedAt !== undefined) return;
    this.catalogRecordCount += values.length;
    for (const input of values) {
      const row = isRecord(input) ? input : {};
      for (const coverage of this.catalogCoverage) {
        const { field, kind } = coverage;
        const value = row[field];
        if (value === undefined) coverage.missingCount += 1;
        else if (value === null) coverage.nullCount += 1;
        else if (kind === "array" && Array.isArray(value) || kind === "string" && typeof value === "string") {
          if (value.length === 0) coverage.emptyCount += 1;
          else coverage.nonemptyCount += 1;
        } else coverage.invalidCount += 1;
      }
      const value = row["@odata.type"];
      const type = value === undefined ? "missing" : value === null ? "null"
        : value === "#microsoft.graph.copilotPackageDetail" ? "detail"
        : value === "#microsoft.graph.copilotPackage" ? "summary" : "other";
      this.catalogTypes.set(type, (this.catalogTypes.get(type) ?? 0) + 1);
    }
  }

  startDetails(count: number) {
    if (this.finishedAt !== undefined) return;
    this.targetCount = count;
    this.detailStartedAt = performance.now();
  }

  compareDetail(summary: CopilotPackageDetail | undefined, detail: CopilotPackageDetail) {
    if (this.finishedAt !== undefined || !summary) return;
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
    if (this.finishedAt !== undefined) return;
    this.checkedCount += 1;
    if (found) this.foundCount += 1;
    if (this.checkedCount % 100 === 0) this.readSummary("identity", "package_scan_progress", "collecting");
  }

  recordAttempt(stage: PackageReadStage, durationMs: number, attempt: number, readIntervalMs: number) {
    if (this.finishedAt !== undefined) return;
    const counts = this.reads[stage];
    counts.requestCount += 1;
    if (attempt > 1) counts.retryCount += 1;
    counts.requestDurationMs += durationMs;
    counts.maxRequestDurationMs = Math.max(counts.maxRequestDurationMs, durationMs);
    counts.readIntervalMs = Math.max(counts.readIntervalMs, readIntervalMs);
  }

  recordThrottle(stage: PackageReadStage) {
    if (this.finishedAt !== undefined) return;
    this.reads[stage].throttleCount += 1;
  }

  recordWait(stage: PackageReadStage, kind: "admissionWaitMs" | "retryWaitMs", durationMs: number) {
    if (this.finishedAt !== undefined) return;
    this.reads[stage][kind] += durationMs;
  }

  finish(outcome: "collected" | "failed" | "cancelled" | "timed_out") {
    if (this.finishedAt !== undefined) return;
    this.finishedAt = performance.now();
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
    const now = this.finishedAt ?? performance.now();
    const durationMs = stage === "catalog"
      ? (this.detailStartedAt ?? now) - this.startedAt
      : now - (this.detailStartedAt ?? this.startedAt);
    this.log(event, {
      stage, outcome, pages: this.pages,
      totalRecords: stage === "catalog" ? outcome === "collected" ? this.listedCount : undefined : this.targetCount,
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
