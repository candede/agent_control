// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportBundle, reportStage } from "./reportImportFixture";

const bundleId = "60000000-0000-4000-8000-000000000001";
const kinds = ["agents", "userAgents", "users"] as const;

afterEach(() => { vi.restoreAllMocks(); });

describe("import fixture receipts", () => {
  it("gives every upload its own identity without changing identical content", () => {
    const first = reportStage("agents", bundleId), second = reportStage("agents", bundleId);
    const other = reportStage("agents", "60000000-0000-4000-8000-000000000002");
    expect(new Set([first.id, second.id, other.id]).size).toBe(3);
    expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.contentHash).toBe(other.contentHash);
    expect(first.fileHash).not.toBe(reportStage("users", bundleId).fileHash);
    const changed = reportStage("agents", bundleId, { reportingPeriod: { ...first.reportingPeriod, provenance: "operator_asserted" } });
    expect(changed.contentHash).not.toBe(first.contentHash);
    expect(changed.fileHash).toBe(first.fileHash);
    expect(reportStage("agents", bundleId, { rowCount: 0 }).fileHash).not.toBe(first.fileHash);
  });

  it("copies nested upload overrides and bundle evidence instead of sharing later changes", () => {
    const original = reportStage("agents", bundleId);
    const receipt = reportStage("agents", bundleId, original);
    const preview = reportBundle([receipt], bundleId), retained = structuredClone(preview);
    original.reportingPeriod.provenance = "operator_asserted";
    original.warnings.push("later-warning");
    original.reconciliation.responses = 0;
    expect(receipt.reportingPeriod.provenance).toBe("activity_range");
    expect(receipt.warnings).not.toContain("later-warning");
    expect(receipt.reconciliation.responses).toBe(1000000);
    receipt.reconciliation.responses = 1;
    receipt.status = "accepted";
    expect(preview).toEqual(retained);
    const next = reportBundle([receipt], bundleId);
    next.stages[0].reconciliation.responses = 2;
    expect(receipt.reconciliation.responses).toBe(1);
  });

  it("hashes exactly the sorted server bundle projection, not delivery order or acceptance status", () => {
    const stages = kinds.map(kind => reportStage(kind, bundleId));
    const preview = reportBundle([...stages].reverse(), bundleId);
    expect(preview.stages.map(stage => stage.kind)).toEqual(kinds);
    expect(preview.bundleHash).toBe(createHash("sha256").update(JSON.stringify({
      bundleId, expectedActiveRevision: "4", stages: preview.stages,
    })).digest("hex"));
    expect(preview).toEqual(reportBundle(stages, bundleId));
    expect(reportBundle(stages.map(stage => ({ ...stage, status: "accepted" })), bundleId)).toEqual(preview);
  });

  it("changes the acceptance fence for a different head, stage, revision, content or reconciliation", () => {
    const stages = kinds.map(kind => reportStage(kind, bundleId));
    const preview = reportBundle(stages, bundleId);
    const changed = [
      reportBundle(stages, bundleId, "5"),
      reportBundle(stages.slice(1), bundleId),
      ...[
        { id: crypto.randomUUID() }, { revision: 2 }, { contentHash: "c".repeat(64) }, { rowCount: 2 },
        { reconciliation: { ...stages[0].reconciliation, responses: 0 } },
      ].map(change => reportBundle([{ ...stages[0], ...change }, ...stages.slice(1)], bundleId)),
    ];
    expect(changed.every(value => value.bundleHash !== preview.bundleHash)).toBe(true);
    expect(new Set(changed.map(value => value.bundleHash)).size).toBe(changed.length);
  });

  it("never manufactures a complete bundle from duplicate or foreign companion receipts", () => {
    const stages = kinds.map(kind => reportStage(kind, bundleId));
    expect(reportBundle([], bundleId).complete).toBe(false);
    expect(reportBundle(stages.slice(1), bundleId).complete).toBe(false);
    expect(reportBundle(stages, bundleId).complete).toBe(true);
    expect(() => reportBundle([...stages, reportStage("users", bundleId)], bundleId)).toThrow();
    expect(() => reportBundle([stages[0], stages[0]], bundleId)).toThrow();
    expect(() => reportBundle(stages, "another-bundle")).toThrow();
    expect(() => reportBundle([stages[0], { ...stages[1], id: stages[0].id }], bundleId)).toThrow();
  });

  it("uses one thirty-minute expiry without renewing it on readback or changing explicit failure evidence", () => {
    const first = reportStage("agents", bundleId), expiry = Date.parse(first.expiresAt);
    expect(expiry).toBeGreaterThan(Date.now());
    expect(expiry - Date.now()).toBeLessThanOrEqual(1800000);
    vi.spyOn(Date, "now").mockReturnValue(expiry + 1);
    expect(reportStage("agents", bundleId).expiresAt).toBe(first.expiresAt);
    expect(reportStage("agents", bundleId, { ...first, status: "accepted" })).toMatchObject({
      id: first.id, revision: first.revision, activeRevision: first.activeRevision, expiresAt: first.expiresAt, status: "accepted",
    });
    for (const expiresAt of ["invalid", new Date(expiry - 1800001).toISOString()]) {
      expect(reportStage("users", bundleId, { expiresAt }).expiresAt).toBe(expiresAt);
    }
  });

  it("keeps default source warnings and row totals consistent with supplied metadata", () => {
    expect(reportStage("agents", bundleId).warnings).toEqual(["source_refresh_unknown", "activity_range_not_coverage"]);
    const stage = reportStage("users", bundleId, { rowCount: 2, sourceAsOf: "2026-02-01T00:00:00.000Z",
      sourceFreshness: "known", sourceAsOfProvenance: "operator_asserted",
      reportingPeriod: { startDate: "2026-01-01", endDate: "2026-01-31", days: 31, provenance: "operator_asserted" } });
    expect(stage.reconciliation.rows).toBe(2);
    expect(stage.warnings).toEqual([]);
    expect(reportStage("agents", bundleId, { warnings: ["explicit"] }).warnings).toEqual(["explicit"]);
    expect(reportStage("users", bundleId, { rowCount: 0 }).reconciliation).toEqual({ rows: 0, responses: 0, agentsUsed: 0 });
    expect(reportStage("agents", bundleId, { rowCount: 0 }).reconciliation).toEqual({ rows: 0, responses: 0, agentsUsed: null });
  });
});
