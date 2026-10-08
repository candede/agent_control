import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { reportHttpFixture } from "../../scripts/reportHttpFixture.js";
import { schemaRegistry } from "../services/officialReportFields.js";
import type { OfficialReportAccepted, OfficialReportBundlePreview, OfficialReportPreview } from "../types/officialReportApi.js";
import type { ReportHistorySet, ReportPage } from "../types/officialReportData.js";

vi.hoisted(() => {
  delete process.env.TENANTS_JSON_FILE;
  process.env.TENANTS_JSON = JSON.stringify([{
    tenantId: "11111111-1111-1111-1111-111111111111", clientId: "22222222-2222-4222-8222-222222222222",
    clientSecret: "synthetic-route-test-secret", domains: ["example.invalid"],
  }]);
  process.env.SESSION_SECRET = "official-usage-import-route-test-secret";
});

describe("native official report import HTTP contracts", () => {
  let fixture: Awaited<ReturnType<typeof reportHttpFixture>>;
  beforeAll(async () => { fixture = await reportHttpFixture(); }, 30000);
  afterAll(async () => { await fixture?.close(); });
  afterEach(async () => {
    if (!fixture) return;
    const drafts = await fixture.database.runtime.query(`SELECT id FROM official_usage_staging
      WHERE tenant_id=$1 AND actor_principal_id=$2 AND status='active' LIMIT 250`, [fixture.identity.tenantId, fixture.identity.principalId]);
    for (const draft of drafts.rows) expect((await fixture.api(`/official-usage/staging/${draft.id}`, { method: "DELETE" })).status).toBe(204);
  });
  const csv = `${schemaRegistry.agents.headers.join(",")}\nagent-1,Agent 1,Your org,1,1,4,2026-07-06\n`;
  function upload(query: URLSearchParams, fields: Array<[string, string]> = [], content = csv, fileFirst = false, headers: Record<string, string> = {}) {
    const body = new FormData();
    const addFile = () => body.append("file", new Blob([content], { type: "text/csv" }), "report.csv");
    if (fileFirst) addFile();
    for (const [key, value] of fields) body.append(key, value);
    if (!fileFirst) addFile();
    return fixture.api(`/official-usage/staging?${query}`, { method: "POST", body, headers });
  }
  async function ingestionCount() {
    return (await fixture.database.runtime.query("SELECT count(*)::int AS n FROM official_usage_ingestions WHERE tenant_id=$1 AND principal_id=$2",
      [fixture.identity.tenantId, fixture.identity.principalId])).rows[0].n as number;
  }
  async function completeBundle(marker: string, preserveSelection?: boolean) {
    const bundleId = randomUUID();
    for (const kind of ["agents", "userAgents", "users"] as const) {
      const row = kind === "agents" ? `${marker},Assistant,Your org,1,0,4,2026-07-06`
        : kind === "userAgents" ? `${marker},Assistant,Your org,${marker}@example.invalid,4,2026-07-06`
          : `${marker}@example.invalid,Person,1,4,2026-07-06`;
      const response = await upload(new URLSearchParams({ bundleId }), [], `${schemaRegistry[kind].headers.join(",")}\n${row}\n`);
      expect(response.status, await response.clone().text()).toBe(201);
    }
    const previewResponse = await fixture.api(`/official-usage/bundles/${bundleId}/preview`, { method: "POST", body: "{}" });
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as OfficialReportBundlePreview;
    expect(preview.complete).toBe(true); expect(preview.stages).toHaveLength(3);
    const response = await fixture.api(`/official-usage/bundles/${bundleId}/accept`, { method: "POST",
      body: JSON.stringify({ bundleHash: preview.bundleHash, expectedActiveRevision: preview.expectedActiveRevision, preserveSelection }) });
    expect(response.status, await response.clone().text()).toBe(200);
    return await response.json() as OfficialReportAccepted;
  }

  it("selects the first wizard report through HTTP and preserves it for later imports", async () => {
    const selected = await completeBundle(randomUUID(), true);
    for (const path of ["/official-usage/aggregate?limit=1", "/official-usage/users?limit=1"]) {
      const response = await fixture.api(path);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ reports: { setId: selected.setId, activeSetId: selected.setId } });
    }
    const saved = await completeBundle(randomUUID(), true);
    expect(saved.setId).not.toBe(selected.setId);
    expect(saved.activeRevision).toBe(selected.activeRevision);
    const response = await fixture.api(`/official-usage/aggregate?setId=${saved.setId}&limit=1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ reports: { setId: saved.setId, activeSetId: selected.setId } });
  });
  it.each(["true", "false", 0, null])("rejects non-boolean preserveSelection %j before acceptance", async preserveSelection => {
    const response = await fixture.api(`/official-usage/bundles/${randomUUID()}/accept`, { method: "POST",
      body: JSON.stringify({ bundleHash: "a".repeat(64), expectedActiveRevision: "1", preserveSelection }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_import_intent" });
  });
  it.each([undefined, "true", "false"])("parses duplicate guard %s exclusively from immutable upload intent", async guard => {
    const bundleId = randomUUID(), query = new URLSearchParams({ bundleId });
    if (guard !== undefined) query.set("rejectDuplicateKind", guard);
    const response = await upload(query); expect(response.status, await response.clone().text()).toBe(201);
    const preview = await response.json() as OfficialReportPreview;
    expect(preview).toMatchObject({ bundleId, kind: "agents", rowCount: 1, status: "active", revision: 1, sourceFreshness: "unknown" });
    expect(preview.examples).toHaveLength(1); expect(preview.storedBytes).toBeGreaterThan(0); expect(preview.wireBytes).toBe(Buffer.byteLength(csv));
    const result = await fixture.database.runtime.query("SELECT reject_duplicate_kind FROM official_usage_ingestions WHERE staging_id=$1", [preview.id]);
    expect(result.rows[0].reject_duplicate_kind).toBe(guard === "true");
  });
  it.each([false, true])("retains all declared metadata when fields follow file=%s", async fileFirst => {
    const corrected = await completeBundle(randomUUID()), bundleId = randomUUID();
    const response = await upload(new URLSearchParams({ bundleId, correctionOfSetId: corrected.setId, rejectDuplicateKind: "true" }), [
      ["reportingStart", "2026-06-07"], ["reportingEnd", "2026-07-06"], ["periodProvenance", "operator_asserted"],
      ["sourceAsOf", "2026-07-08T12:00:00Z"], ["sourceAsOfProvenance", "operator_asserted"], ["downloadedAt", "2026-07-09T12:00:00Z"],
    ], csv, fileFirst);
    expect(response.status, await response.clone().text()).toBe(201);
    const preview = await response.json() as OfficialReportPreview;
    expect(preview).toMatchObject({ bundleId, correctionOfSetId: corrected.setId, rowCount: 1,
      reportingPeriod: { startDate: "2026-06-07", endDate: "2026-07-06", provenance: "operator_asserted" },
      sourceAsOf: "2026-07-08T12:00:00.000Z", sourceAsOfProvenance: "operator_asserted", sourceFreshness: "unknown" });
    const row = (await fixture.database.runtime.query("SELECT downloaded_at FROM official_usage_staging WHERE id=$1", [preview.id])).rows[0];
    expect((row.downloaded_at as Date).toISOString()).toBe("2026-07-09T12:00:00.000Z");
  });
  it.each(["", "1", "0", "TRUE", "False", " true ", "yes", "null"])("rejects invalid duplicate guard %j before admitting ingestion", async value => {
    const before = await ingestionCount();
    const response = await upload(new URLSearchParams({ bundleId: randomUUID(), rejectDuplicateKind: value }));
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "invalid_upload_intent" });
    expect(await ingestionCount()).toBe(before);
  });
  it("rejects repeated guard query values without choosing one or admitting work", async () => {
    const before = await ingestionCount(), query = new URLSearchParams({ bundleId: randomUUID() });
    query.append("rejectDuplicateKind", "true"); query.append("rejectDuplicateKind", "false");
    const response = await upload(query); expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_upload_intent" }); expect(await ingestionCount()).toBe(before);
  });
  it.each(["bundleId", "correctionOfSetId", "rejectDuplicateKind"])("rejects old mutable multipart intent field %s", async field => {
    const response = await upload(new URLSearchParams({ bundleId: randomUUID() }), [[field, field === "rejectDuplicateKind" ? "true" : randomUUID()]]);
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "invalid_metadata" });
  });
  it("preserves the first valid draft after a duplicate-kind conflict", async () => {
    const query = new URLSearchParams({ bundleId: randomUUID(), rejectDuplicateKind: "true" });
    const firstResponse = await upload(query), first = await firstResponse.json() as OfficialReportPreview;
    expect(firstResponse.status).toBe(201);
    const second = await upload(query, [], csv.replace(",4,", ",5,"));
    expect(second.status).toBe(409); expect(await second.json()).toMatchObject({ code: "duplicate_report_kind" });
    const retained = await fixture.api(`/official-usage/staging/${first.id}`); expect(retained.status).toBe(200);
    expect(await retained.json()).toMatchObject({ id: first.id, contentHash: first.contentHash, status: "active" });
    const preview = await (await fixture.api(`/official-usage/bundles/${first.bundleId}/preview`, { method: "POST", body: "{}" })).json() as OfficialReportBundlePreview;
    expect(preview.stages.map(stage => stage.stagingId)).toEqual([first.id]);
  });
  it.each([undefined, "false"])("default and explicit false guards permit atomic replacement without a compatibility flag (%s)", async guard => {
    const query = new URLSearchParams({ bundleId: randomUUID() });
    if (guard) query.set("rejectDuplicateKind", guard);
    const first = await (await upload(query)).json() as OfficialReportPreview;
    const secondResponse = await upload(query, [], csv.replace(",4,", ",5,")), second = await secondResponse.json() as OfficialReportPreview;
    expect(secondResponse.status).toBe(201); expect(second.contentHash).not.toBe(first.contentHash);
    expect((await fixture.api(`/official-usage/staging/${first.id}`)).status).toBe(409);
    expect((await fixture.api(`/official-usage/staging/${second.id}`)).status).toBe(200);
  });
  it.each([false, true])("returns the exact frozen acceptance and does not republish duplicate=%s", async duplicate => {
    const marker = randomUUID(), first = await completeBundle(marker);
    expect(Object.keys(first).sort()).toEqual(["activeRevision", "complete", "setId"]);
    expect(first.complete).toBe(true); expect(typeof first.activeRevision).toBe("string");
    const before = await (await fixture.api("/official-usage/history?limit=1")).json() as ReportPage<ReportHistorySet>;
    const accepted = await completeBundle(duplicate ? marker : randomUUID());
    const after = await (await fixture.api("/official-usage/history?limit=1")).json() as ReportPage<ReportHistorySet>;
    if (duplicate) {
      expect(accepted).toEqual(first); expect(after.counts).toEqual(before.counts);
      expect(after.reports.historyRevision).toBe(before.reports.historyRevision);
    } else {
      expect(accepted.setId).not.toBe(first.setId);
      expect(after.counts.total).toBe(before.counts.total + 1);
      expect(BigInt(accepted.activeRevision)).toBe(BigInt(first.activeRevision) + 1n);
    }
  });
  it("keeps real Admin and CSRF policy in front of streamed admission", async () => {
    const before = await ingestionCount(), viewer = await fixture.sessionCookie(["AgentControl.Viewer"]);
    const denied = await upload(new URLSearchParams({ bundleId: randomUUID() }), [], csv, false, { Cookie: viewer });
    expect(denied.status).toBe(403);
    const csrf = await upload(new URLSearchParams({ bundleId: randomUUID() }), [], csv, false, { "x-csrf-token": "wrong" });
    expect(csrf.status).toBe(403); expect(await ingestionCount()).toBe(before);
  });
});
