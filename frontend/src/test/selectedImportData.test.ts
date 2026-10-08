import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { parseSelectedCsv, selectedImportData, selectedImportMetadata } from "../../browser/selectedImportData";

const agents = "Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\n";
const bridge = "Agent ID,Agent name,Creator type,Username,Responses sent to users,Last activity date (UTC)\n";
const users = "Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\n";
const context = { setId: "10000000-0000-4000-8000-000000000001", activeSetId: "10000000-0000-4000-8000-000000000001",
  activeRevision: "2", historyRevision: "2", historyEpoch: "0", acceptedAt: "2026-09-12T14:45:00.000Z", expiresAt: "2027-03-11T14:45:00.000Z",
  evaluatedAt: "2026-09-12T14:45:00.000Z" };

describe("bounded native CSV browser fixture", () => {
  it("separates canonical observation hashes from wire bytes and download timestamps", async () => {
    const csv = users + "u,User,1,2,\nv,Other,0,0,\n";
    const first = await parseSelectedCsv(Buffer.from(csv));
    const reordered = await parseSelectedCsv(Buffer.from("\uFEFF" + users.replaceAll("\n", "\r\n") + "v,Other,0,0,\r\nu,User,1,2,\r\n"));
    expect(first.fileHash).not.toBe(reordered.fileHash);
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const payloads = [
      '{"username": "u", "displayName": "User", "numberOfAgentsUsed": 1, "agentResponsesReceived": 2}',
      '{"username": "v", "displayName": "Other", "numberOfAgentsUsed": 0, "agentResponsesReceived": 0}',
    ].map(digest).sort();
    const expected = digest(JSON.stringify({ kind: first.kind, parserVersion: first.parserVersion, schemaVersion: first.schemaVersion,
      reportingPeriod: first.reportingPeriod, sourceAsOfProvenance: "absent", sourceFreshness: "unknown" }) + payloads.join(""));
    expect(first.contentHash).toBe(expected);
    expect(reordered.contentHash).toBe(expected);
    const downloaded = await parseSelectedCsv(Buffer.from(csv), { downloadedAt: "2026-09-12T10:00:00Z" });
    expect(downloaded.contentHash).toBe(expected);
    const asserted = await parseSelectedCsv(Buffer.from(csv), {
      reportingPeriod: { startDate: "2026-08-14", endDate: "2026-09-12", provenance: "operator_asserted" },
    });
    expect(asserted.fileHash).toBe(first.fileHash);
    expect(asserted.contentHash).not.toBe(expected);
    const lineage = selectedImportMetadata([first], context).lineages[0];
    expect(lineage).toMatchObject({ contentHash: expected, versionId: first.versionId });
    expect(selectedImportMetadata([first], context).lineages[0]).toEqual(lineage);
    expect(reordered.versionId).not.toBe(first.versionId);
  });
  it("keeps relationship identity bound to payload rather than input row position", async () => {
    const rows = ["a,Assistant,Your org,u,2,\n", "b,Other,Your org,v,3,\n"];
    const project = async (input: string[]) => {
      const file = await parseSelectedCsv(Buffer.from(bridge + input.join("")));
      return selectedImportData([file], selectedImportMetadata([file], context)).relationships;
    };
    const first = await project(rows), reordered = await project([...rows].reverse());
    expect(reordered.find(row => row.agentId === "a")?.id).toBe(first[0].id);
    const changed = await project([rows[0].replace(",2,", ",4,"), rows[1]]);
    expect(changed[0].id).not.toBe(first[0].id);
    expect(changed[1].id).toBe(first[1].id);
  });
  it("evaluates stale report evidence at the pinned UTC capture instead of treating every import as new", async () => {
    const file = await parseSelectedCsv(Buffer.from(users + "u,User,1,2,2026-09-12\n"));
    for (const [evaluatedAt, periodAgeDays, availability] of [
      ["2026-10-18T23:59:59.998Z", 35, "active"],
      ["2026-10-18T23:59:59.999Z", 36, "stale"],
    ] as const) {
      expect(selectedImportMetadata([file], { ...context, acceptedAt: evaluatedAt, evaluatedAt }))
        .toMatchObject({ availability, periodAgeDays, acceptedAgeDays: 0 });
    }
    const undated = await parseSelectedCsv(Buffer.from(users + "u,User,0,0,\n"));
    expect(selectedImportMetadata([undated], { ...context, evaluatedAt: "2026-10-18T14:45:00.000Z" }))
      .toMatchObject({ availability: "stale", periodAgeDays: null, acceptedAgeDays: 36 });
    expect(selectedImportMetadata([file], context)).toMatchObject({ availability: "active", acceptedAgeDays: 0, periodAgeDays: 0 });
  });
  it("rejects incompatible observation bases instead of changing reporting provenance with input order", async () => {
    const plain = await parseSelectedCsv(Buffer.from(agents + "a,Assistant,Your org,1,0,2,2026-09-12\n"));
    const asserted = await parseSelectedCsv(Buffer.from(users + "u,User,1,2,2026-09-12\n"), {
      reportingPeriod: { startDate: "2026-08-14", endDate: "2026-09-12", provenance: "operator_asserted" },
    });
    for (const ordered of [[plain, asserted], [asserted, plain]]) {
      expect(() => selectedImportMetadata(ordered, context)).toThrowError(expect.objectContaining({ code: "incompatible_bundle", status: 409 }));
    }
  });
  it("uses the streaming parser, retains every small synthetic input row and caps preview examples at twenty", async () => {
    const file = await parseSelectedCsv(Buffer.from(users + Array.from({ length: 26 }, (_, i) => `user${i}@example.invalid,User ${i},1,2,2026-09-12\n`).join("")));
    expect(file.rowCount).toBe(26); expect(file.rows).toHaveLength(26); expect(file.examples).toHaveLength(20);
    const metadata = selectedImportMetadata([file], context), data = selectedImportData([file], metadata);
    expect(metadata.lineages[0]).toMatchObject({ rowCount: 26, sourceFreshness: "unknown", periodProvenance: "activity_range" });
    expect(data.users).toHaveLength(26);
    expect(data.summary).toMatchObject({ userReportedResponses: 52, bridgeResponses: null, reportedResponses: null, distinctActiveReportUsers: 26 });
    expect(data.observations[0].rowCount).toBe(26);
  });
  it("keeps raw source discrepancies, distinct bridge identities and bridge-only report entities without fabricating directory verification", async () => {
    const files = await Promise.all([
      parseSelectedCsv(Buffer.from(agents + "a,Assistant,Your org,2,1,10,2026-09-12\n")),
      parseSelectedCsv(Buffer.from(bridge + "a,Assistant,Your org,u@example.invalid,9,2026-09-12\nb,Bridge only,Your org,v@example.invalid,5,2026-09-12\n")),
      parseSelectedCsv(Buffer.from(users + "u@example.invalid,User,1,12,2026-09-12\n")),
    ]);
    const data = selectedImportData(files, selectedImportMetadata(files, context));
    expect(data.agents).toEqual([
      expect.objectContaining({ agentId: "a", responses: 10, reportResponses: 10, bridgeResponses: 9, activeUsers: 1, licensedUserOccurrences: 2, responseComparison: "mismatch" }),
      expect.objectContaining({ agentId: "b", responses: 5, reportResponses: null, responseSource: "userAgents", licensedUserOccurrences: null, responseComparison: "not_comparable" }),
    ]);
    expect(data.summary).toMatchObject({ reportedResponses: 10, bridgeResponses: 14, userReportedResponses: 12, distinctActiveReportUsers: 2,
      unknownLicenseActiveReportUsers: 2, activeWithoutPaidUsers: null, responseReconciliation: "mismatch" });
    expect(data.users[1]).toMatchObject({ reportedResponses: null, missingUserReport: true, objectId: null, entitlement: "unknown", hasActivity: true });
    expect(data.directory.sources.directory.state).toBe("unavailable");
    expect(data.directory.value).toEqual([]);
    expect(data.relationships).toHaveLength(2);
  });
  it("distinguishes an explicit zero metric from a missing source and preserves declared source provenance", async () => {
    const file = await parseSelectedCsv(Buffer.from(users + "u@example.invalid,User,0,0,\n"), {
      reportingPeriod: { startDate: "2026-08-14", endDate: "2026-09-12", provenance: "operator_asserted" },
      sourceAsOf: { value: "2026-09-12T00:00:00.000Z", provenance: "operator_asserted" },
    });
    const metadata = selectedImportMetadata([file], context), data = selectedImportData([file], metadata);
    expect(data.users[0]).toMatchObject({ reportedResponses: 0, reportedAgentsUsed: 0, bridgeResponses: null, hasActivity: false, reviewCohort: "zero" });
    expect(metadata.lineages[0]).toMatchObject({ sourceFreshness: "unknown", sourceAsOfProvenance: "operator_asserted", periodProvenance: "operator_asserted" });
    expect(metadata.reportingPeriod).toEqual(file.reportingPeriod);
  });
  it("preserves authoritative blank Agents dates and unknown per-entity bridge metrics when no companions exist", async () => {
    const files = await Promise.all([
      parseSelectedCsv(Buffer.from(agents + "a,Assistant,Your org,0,0,0,\nb,No companions,Your org,0,0,0,\n")),
      parseSelectedCsv(Buffer.from(bridge + "a,Assistant,Your org,u@example.invalid,0,2026-09-12\n")),
      parseSelectedCsv(Buffer.from(users + "v@example.invalid,No companions,0,0,\n")),
    ]);
    const data = selectedImportData(files, selectedImportMetadata(files, context));
    expect(data.agents[0]).toMatchObject({ lastActivityDateUtc: null, activeUsers: 0, bridgeResponses: 0 });
    expect(data.agents[1]).toMatchObject({ lastActivityDateUtc: null, activeUsers: null, bridgeResponses: null, responseComparison: "not_comparable" });
    expect(data.users.find(user => user.username === "v@example.invalid")).toMatchObject({ reportedResponses: 0, bridgeResponses: null, hasReportMismatch: false });
  });
  it.each([
    [agents, "a,Assistant,Your org,1,0,2,\na,Renamed,Your org,2,0,3,\n"],
    [users, "u@example.invalid,User,1,2,\nu@example.invalid,Renamed,2,3,\n"],
    [bridge, "a,Assistant,Your org,u@example.invalid,2,\na,Renamed,Your org,u@example.invalid,3,\n"],
  ])("rejects duplicate natural identities in %s", async (header, rows) => {
    await expect(parseSelectedCsv(Buffer.from(header + rows))).rejects.toMatchObject({ status: 400, code: "duplicate_identity" });
  });
  it("preserves case-distinct identities and distinct agent-user pairs", async () => {
    const files = await Promise.all([
      parseSelectedCsv(Buffer.from(bridge + "a,Assistant,Your org,User,2,\na,Assistant,Your org,user,3,\nb,Other,Your org,User,4,\n")),
      parseSelectedCsv(Buffer.from(users + "User,Upper,2,6,\nuser,Lower,1,3,\n")),
    ]);
    const data = selectedImportData(files, selectedImportMetadata(files, context));
    expect(data.users).toMatchObject([
      { username: "User", bridgeResponses: 6, relationshipCount: 2, hasReportMismatch: false },
      { username: "user", bridgeResponses: 3, relationshipCount: 1, hasReportMismatch: false },
    ]);
    expect(data.agents[0]).toMatchObject({ agentId: "a", activeUsers: 2 });
  });
  it("derives the selected reporting range from every companion regardless of order", async () => {
    const files = await Promise.all([
      parseSelectedCsv(Buffer.from(agents + "a,Assistant,Your org,0,0,0,\n")),
      parseSelectedCsv(Buffer.from(bridge + "a,Assistant,Your org,User,2,2026-08-14\n")),
      parseSelectedCsv(Buffer.from(users + "User,User,1,2,2026-09-12\n")),
    ]);
    for (const ordered of [files, [...files].reverse(), [files[1], files[0], files[2]]]) {
      expect(selectedImportMetadata(ordered, context).reportingPeriod)
        .toEqual({ startDate: "2026-08-14", endDate: "2026-09-12", days: 30, provenance: "activity_range" });
    }
    expect(selectedImportMetadata([files[0]], context).reportingPeriod)
      .toEqual({ startDate: null, endDate: null, days: null, provenance: "activity_range" });
    expect(selectedImportMetadata([], { ...context, setId: null, activeSetId: null, acceptedAt: null, expiresAt: null }).reportingPeriod).toBeNull();
  });
  it("does not invent completed syncs, checked-user counts or analytics for unavailable directory data", () => {
    const data = selectedImportData([], selectedImportMetadata([], { ...context, setId: null, activeSetId: null, acceptedAt: null, expiresAt: null }));
    expect(data.summary.checkedUsers).toBeNull();
    for (const source of Object.values(data.directory.sources)) {
      expect(source).toMatchObject({
        state: "unavailable", generationId: null, scopeId: null, revision: null, expiresAt: null, observedAt: null,
        attemptedAt: null, attemptStatus: null, attemptObservedCount: null, rowCount: null, errorCode: null, reportRefreshDate: null,
      });
    }
    expect(data.directory.analytics).toEqual({
      basis: "filtered_rows", rowCount: 0, responses: null, zeroResponses: null, unknownResponses: null,
      review: null, agents: null, history: null, overview: null,
    });
  });
  it("falls back to the report identity for an empty Users display name", async () => {
    const file = await parseSelectedCsv(Buffer.from(users + "User,,0,0,\n"));
    const data = selectedImportData([file], selectedImportMetadata([file], context));
    expect(data.users[0]).toMatchObject({ username: "User", displayName: "User" });
  });
  it("selects bridge-only labels deterministically without replacing authoritative blank Agents labels", async () => {
    const source = await parseSelectedCsv(Buffer.from(agents + "a,,,0,0,0,\n"));
    const rows = ["a,Zebra,Zeta,User,1,\n", "a,Alpha,Alpha,user,2,\n"];
    for (const ordered of [rows, [...rows].reverse()]) {
      const file = await parseSelectedCsv(Buffer.from(bridge + ordered.join("")));
      const bridgeOnly = selectedImportData([file], selectedImportMetadata([file], context));
      expect(bridgeOnly.agents[0]).toMatchObject({ agentId: "a", agentName: "Alpha", creatorType: "Alpha", responses: 3 });
      const files = [source, file], combined = selectedImportData(files, selectedImportMetadata(files, context));
      expect(combined.agents[0]).toMatchObject({ agentName: "", creatorType: "", responses: 0 });
    }
  });
  it("accepts the row boundary and enforces the materialized byte limit independently", async () => {
    const file = await parseSelectedCsv(Buffer.from(users + Array.from({ length: 250 }, (_, i) => `u${i},User,0,0,\n`).join("")));
    expect(file.rows).toHaveLength(250);
    const wide = "\u4e2d".repeat(500);
    const csv = bridge + Array.from({ length: 240 }, (_, i) => `${i}${wide},${wide},${wide.slice(0, 128)},${wide},0,\n`).join("");
    await expect(parseSelectedCsv(Buffer.from(csv))).rejects.toThrow("250-row/1-MiB bound");
  });
  it("rejects invalid schemas and accidental tenant-sized fixture materialization", async () => {
    await expect(parseSelectedCsv(Buffer.from("Unsupported,CSV\nwrong,shape"))).rejects.toThrow();
    await expect(parseSelectedCsv(Buffer.from(users + Array.from({ length: 251 }, (_, i) => `u${i}@example.invalid,U,0,0,\n`).join(""))))
      .rejects.toThrow("250-row/1-MiB bound");
  });
});
