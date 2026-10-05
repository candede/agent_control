import { randomUUID } from "node:crypto";
import { parse } from "csv-parse/sync";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { reportHttpFixture } from "../../scripts/reportHttpFixture.js";
import { schemaRegistry } from "../services/officialReportFields.js";
import { reportRuntime } from "../services/reportExportDispatcher.js";
import type { OfficialReportAccepted, OfficialReportBundlePreview, OfficialReportExportStatus } from "../types/officialReportApi.js";
import { reportExportColumns, type ReportPage } from "../types/officialReportData.js";

vi.hoisted(() => {
  delete process.env.TENANTS_JSON_FILE;
  process.env.TENANTS_JSON = JSON.stringify([{
    tenantId: "11111111-1111-1111-1111-111111111111", clientId: "22222222-2222-4222-8222-222222222222",
    clientSecret: "synthetic-route-test-secret", domains: ["example.invalid"],
  }]);
  process.env.SESSION_SECRET = "official-usage-csv-route-test-secret";
});

describe("persisted official usage CSV HTTP contracts", () => {
  let fixture: Awaited<ReturnType<typeof reportHttpFixture>>, receipt: OfficialReportAccepted;
  beforeAll(async () => {
    fixture = await reportHttpFixture();
    const bundleId = randomUUID();
    const sources = {
      agents: [
        "agent-a,=FORMULA(),Your org,1,0,5,2026-07-06",
        "agent-b,Blank source date,Your org,0,1,0,",
        "agent-c,Report only,Other,0,2,7,2026-07-06",
      ],
      userAgents: [
        "agent-a,=FORMULA(),Your org,u1@example.invalid,5,2026-07-06",
        "agent-b,Blank source date,Your org,u1@example.invalid,0,2026-07-05",
        "agent-d,Bridge only,User,u3@example.invalid,3,2026-07-06",
      ],
      users: [
        "u1@example.invalid,=PERSON(),2,5,2026-07-06",
        "u2@example.invalid,Zero responses,0,0,",
        "u4@example.invalid,Users only,0,2,2026-07-06",
      ],
    };
    for (const kind of ["agents", "userAgents", "users"] as const) {
      const body = new FormData();
      body.append("file", new Blob([`${schemaRegistry[kind].headers.join(",")}\n${sources[kind].join("\n")}\n`]), `${kind}.csv`);
      const response = await fixture.api(`/official-usage/staging?bundleId=${bundleId}`, { method: "POST", body });
      expect(response.status, await response.clone().text()).toBe(201);
    }
    const preview = await (await fixture.api(`/official-usage/bundles/${bundleId}/preview`, { method: "POST", body: "{}" })).json() as OfficialReportBundlePreview;
    const accepted = await fixture.api(`/official-usage/bundles/${bundleId}/accept`, { method: "POST",
      body: JSON.stringify({ bundleHash: preview.bundleHash, expectedActiveRevision: preview.expectedActiveRevision }) });
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    receipt = await accepted.json() as OfficialReportAccepted;
    reportRuntime(fixture.database.runtime).start();
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  async function exportSelection(kind: "official_agents" | "official_users", query = "", ids?: string[], cookie?: string) {
    const headers = cookie ? { Cookie: cookie } : undefined;
    const path = kind === "official_agents" ? "aggregate" : "users";
    const selected = await fixture.api(`/official-usage/${path}${query}`, { headers });
    expect(selected.status, await selected.clone().text()).toBe(200);
    const page = await selected.json() as ReportPage<unknown>;
    const created = await fixture.api("/data-exports", { method: "POST", headers,
      body: JSON.stringify({ selectionId: page.selection.id, kind, ...(ids ? { ids } : {}) }) });
    expect(created.status, await created.clone().text()).toBe(202);
    const { id } = await created.json() as { id: string };
    let status: OfficialReportExportStatus | undefined;
    await vi.waitFor(async () => {
      const response = await fixture.api(`/data-exports/${id}`, { headers });
      expect(response.status).toBe(200);
      status = await response.json() as OfficialReportExportStatus;
      expect(status.status).toBe("ready");
    }, { timeout: 10000, interval: 50 });
    expect(Object.keys(status!).sort()).toEqual(["bytes", "error", "expiresAt", "id", "limit", "observed", "rows", "status"]);
    const download = await fixture.api(`/data-exports/${id}/download`, { headers });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toContain("text/csv");
    expect(download.headers.get("content-disposition")).toContain(`${kind.replaceAll("_", "-")}.csv`);
    const csv = await download.text();
    expect(csv.split("\r\n")[0].replace(/^\uFEFF/, "")).toBe(reportExportColumns[kind].join(","));
    const rows = parse(csv, { columns: true, bom: true }) as Record<string, string>[];
    expect(rows).toHaveLength(status!.rows);
    // Fetch decodes the UTF-8 signature; the persisted byte count includes it.
    expect(Buffer.byteLength(csv) + 3).toBe(status!.bytes);
    const chunks = await fixture.database.runtime.query("SELECT octet_length(bytes)::int AS size FROM data_export_chunks WHERE export_id=$1 ORDER BY ordinal LIMIT 250", [id]);
    expect(chunks.rows.length).toBeGreaterThan(0);
    expect(chunks.rows.every(row => row.size <= 262144)).toBe(true);
    await vi.waitFor(async () => {
      const audits = await fixture.database.runtime.query(`SELECT action,status,scope,metadata FROM audit_events
        WHERE tenant_id=$1 AND operation_id=$2 ORDER BY id LIMIT 250`, [fixture.identity.tenantId, `data-export:${id}`]);
      expect(audits.rows).toHaveLength(4);
      expect(audits.rows.filter(row => row.status === "started")).toHaveLength(2);
      const completed = audits.rows.filter(row => row.status === "succeeded");
      expect(completed).toHaveLength(2);
      for (const audit of completed) expect(audit).toMatchObject({
        action: kind === "official_agents" ? "export-official-usage-aggregate" : "export-official-usage-users",
        status: "succeeded", scope: "bulk", metadata: { source: kind, jobId: id, rowCount: rows.length, resultingBytes: status!.bytes },
      });
    });
    return { id, page, rows, status: status! };
  }

  it("streams the frozen agent schema with formula safety, authoritative blank dates and explicit unknown companions", async () => {
    const { rows } = await exportSelection("official_agents", "?sort=responses&order=desc");
    expect(rows.map(row => row.agentId)).toEqual(["agent-c", "agent-a", "agent-d", "agent-b"]);
    expect(rows.find(row => row.agentId === "agent-a")).toMatchObject({ agentName: "'=FORMULA()", responsesSentToUsers: "5" });
    expect(rows.find(row => row.agentId === "agent-b")).toMatchObject({ lastActivityDateUtc: "Unknown", responsesUsersAndAgentsReport: "0" });
    expect(rows.find(row => row.agentId === "agent-c")).toMatchObject({ responsesUsersAndAgentsReport: "Unknown" });
    expect(rows.find(row => row.agentId === "agent-d")).toMatchObject({ responsesAgentsReport: "Unknown", activeUsersLicensed: "Unknown",
      activeUsersUnlicensed: "Unknown", responsesSentToUsers: "3" });
    for (const row of rows) expect(row).toMatchObject({ reportSetId: receipt.setId, agentsSourceFreshness: "unknown", userAgentsSourceFreshness: "unknown" });
  });

  it("writes one user row per relationship, preserves zero companions and emits one unknown row when bridge evidence is missing", async () => {
    const { rows } = await exportSelection("official_users", "?sort=name&order=asc");
    expect(rows).toHaveLength(5);
    const first = rows.filter(row => row.username === "u1@example.invalid");
    expect(first).toHaveLength(2);
    expect(first.map(row => row.responsesSentToUsers).sort()).toEqual(["0", "5"]);
    for (const row of first) expect(row).toMatchObject({ displayName: "'=PERSON()", reportedResponsesReceived: "5", reportedAgentsUsed: "2",
      agentsAccessedTotal: "2", responseProducingAgentCount: "1", missingBridgeRows: "false", missingUserReport: "false" });
    expect(rows.find(row => row.username === "u2@example.invalid")).toMatchObject({ reportedResponsesReceived: "0", responsesSentToUsers: "Unknown",
      bridgeResponsesSentToUsers: "Unknown", missingBridgeRows: "true", missingUserReport: "false", agentId: "" });
    expect(rows.find(row => row.username === "u3@example.invalid")).toMatchObject({ reportedResponsesReceived: "Unknown", reportedAgentsUsed: "Unknown",
      responsesSentToUsers: "3", missingUserReport: "true", missingBridgeRows: "false" });
    expect(rows.find(row => row.username === "u4@example.invalid")).toMatchObject({ reportedResponsesReceived: "2", responsesSentToUsers: "Unknown",
      missingBridgeRows: "true", agentId: "" });
  });

  it("keeps server filters and explicit membership pinned through a Viewer-owned durable export", async () => {
    const cookie = await fixture.sessionCookie(["AgentControl.Viewer"]);
    const { page, rows, id } = await exportSelection("official_users", "?search=U1%40&sort=name&order=desc", ["u1@example.invalid"], cookie);
    expect(page.counts.filtered).toBe(1);
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.username === "u1@example.invalid")).toBe(true);
    const explicit = await fixture.database.runtime.query("SELECT ordinal,identity FROM data_export_items WHERE export_id=$1 ORDER BY ordinal LIMIT 250", [id]);
    expect(explicit.rows).toEqual([{ ordinal: 0, identity: "u1@example.invalid" }]);
    const request = await fixture.api("/data-exports", { method: "POST", headers: { Cookie: cookie, "x-csrf-token": "invalid" },
      body: JSON.stringify({ selectionId: page.selection.id, kind: "official_users" }) });
    expect(request.status).toBe(403);
  });

  it.each(["/official-usage/users.csv", "/official-usage/aggregate.csv", "/copilot-usage/users.csv"])(
    "keeps removed buffered route %s unavailable without a redirect or attachment", async path => {
      const response = await fixture.api(path);
      expect(response.status).toBe(404);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("content-disposition")).toBeNull();
    },
  );
});
