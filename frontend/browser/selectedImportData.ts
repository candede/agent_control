import { Readable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { AppError } from "../../backend/src/errors";
import { streamOfficialReport, type OfficialRow, type StreamedOfficialReport } from "../../backend/src/services/officialReportStream";
import type { OfficialUsageMetadata } from "../../backend/src/types/officialReportRecords";
import type { UserSourceMetadata } from "../../backend/src/types/userSources";
import type { ReportAgent, ReportMetadata, ReportObservation, ReportRelationship, ReportSummary, ReportUser } from "../../backend/src/types/officialReportData";
import { reportAgent, reportPage, reportUser } from "../src/test/reportDataFixture";

export type SelectedCsvFixture = StreamedOfficialReport & {
  rows: OfficialRow[]; readonly contentHash: string; readonly versionId: string;
  observation?: Pick<ReportObservation, "acceptedAt" | "supersedesVersionId">;
};
export function selectedImportRowHash(row: OfficialRow): string {
  // PostgreSQL jsonb text orders these flat, parser-owned ASCII keys by length, then bytes.
  const fields = Object.entries(row).filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  return createHash("sha256").update(`{${fields.join(", ")}}`).digest("hex");
}
export async function parseSelectedCsv(bytes: Buffer, metadata?: OfficialUsageMetadata): Promise<SelectedCsvFixture> {
  const rows: OfficialRow[] = [];
  const identities = new Set<string>();
  const report = await streamOfficialReport(Readable.from([bytes]), metadata, new AbortController().signal, {
    async batch(_kind, batch) {
      if (rows.length + batch.length > 250 || Buffer.byteLength(JSON.stringify([...rows, ...batch])) > 1024 * 1024) {
        throw new Error("The synthetic browser CSV fixture exceeds its 250-row/1-MiB bound");
      }
      for (const row of batch) {
        const identity = JSON.stringify(["agentId" in row ? row.agentId : null, "username" in row ? row.username : null]);
        if (identities.has(identity)) throw new AppError(400, "duplicate_identity", "Report contains a duplicate natural identity.");
        identities.add(identity);
      }
      rows.push(...batch);
    },
  });
  const hash = createHash("sha256").update(JSON.stringify({
    kind: report.kind, parserVersion: report.parserVersion, schemaVersion: report.schemaVersion,
    reportingPeriod: report.reportingPeriod, sourceAsOf: report.sourceAsOf,
    sourceAsOfProvenance: report.sourceAsOfProvenance, sourceFreshness: report.sourceFreshness,
  }));
  for (const payload of rows.map(selectedImportRowHash).sort()) hash.update(payload);
  return { ...report, rows, contentHash: hash.digest("hex"), versionId: randomUUID() };
}

export function selectedImportPeriod(files: readonly SelectedCsvFixture[]): ReportMetadata["reportingPeriod"] {
  const first = files[0];
  if (!first) return null;
  if (files.some(file => file.reportingPeriod.provenance !== first.reportingPeriod.provenance
    || file.sourceAsOfProvenance !== first.sourceAsOfProvenance || file.sourceAsOf !== first.sourceAsOf
    || file.reportingPeriod.provenance !== "activity_range" && (file.reportingPeriod.startDate !== first.reportingPeriod.startDate
      || file.reportingPeriod.endDate !== first.reportingPeriod.endDate))) {
    throw new AppError(409, "incompatible_bundle", "Report observation bases differ.");
  }
  const dates = files.flatMap(file => [file.reportingPeriod.startDate, file.reportingPeriod.endDate])
    .filter((date): date is string => date !== null).sort();
  const startDate = dates[0] ?? null, endDate = dates.at(-1) ?? null;
  return { startDate, endDate, days: startDate && endDate ? (Date.parse(endDate) - Date.parse(startDate)) / 86400000 + 1 : null,
    provenance: first.reportingPeriod.provenance };
}

export function selectedImportMetadata(files: readonly SelectedCsvFixture[], { evaluatedAt, ...context }:
  Pick<ReportMetadata, "setId" | "activeSetId" | "activeRevision" | "historyRevision" | "historyEpoch" | "acceptedAt" | "expiresAt">
  & { evaluatedAt: string }): ReportMetadata {
  const reportingPeriod = selectedImportPeriod(files);
  const age = (date: string | null) => date === null ? null : Math.max(0, Math.floor((Date.parse(evaluatedAt) - Date.parse(date)) / 86400000));
  const periodAgeDays = age(reportingPeriod?.endDate ? `${reportingPeriod.endDate}T23:59:59.999Z` : null), acceptedAgeDays = age(context.acceptedAt);
  const staleAfterDays = 35, stale = (periodAgeDays ?? 0) > staleAfterDays || (acceptedAgeDays ?? 0) > staleAfterDays;
  return { ...context, availability: context.setId ? stale ? "stale" : "active" : "never_imported", staleAfterDays, periodAgeDays, acceptedAgeDays,
    reportingPeriod,
    lineages: [...files].sort((a, b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0).map(file => ({ kind: file.kind, versionId: file.versionId,
      contentHash: file.contentHash, rowCount: file.rowCount, sourceAsOf: file.sourceAsOf ?? null, sourceAsOfProvenance: file.sourceAsOfProvenance,
      sourceFreshness: file.sourceFreshness, periodProvenance: file.reportingPeriod.provenance })) };
}

export function selectedImportData(files: readonly SelectedCsvFixture[], metadata: ReportMetadata) {
  const agentsFile = files.find(file => file.kind === "agents"), bridgeFile = files.find(file => file.kind === "userAgents");
  const usersFile = files.find(file => file.kind === "users");
  const rawAgents = agentsFile?.rows.filter(row => "activeUsersLicensed" in row) ?? [];
  const rawLinks = bridgeFile?.rows.filter(row => "agentId" in row && "username" in row) ?? [];
  const rawUsers = usersFile?.rows.filter(row => "agentResponsesReceived" in row) ?? [];
  const relationships: ReportRelationship[] = rawLinks.map(row => ({
    id: selectedImportRowHash(row), agentId: row.agentId, agentName: row.agentName, creatorType: row.creatorType,
    username: row.username, responses: row.responsesSentToUsers, lastActivityDateUtc: row.lastActivityDateUtc?.slice(0, 10) ?? null, identityStatus: "unresolved",
  }));
  const agentIds = [...new Set([...rawAgents.map(row => row.agentId), ...relationships.map(row => row.agentId)])];
  const agents: ReportAgent[] = agentIds.map((agentId, index) => {
    const source = rawAgents.find(row => row.agentId === agentId), links = relationships.filter(row => row.agentId === agentId);
    const bridge = links.length ? links.reduce((sum, row) => sum + row.responses, 0) : null;
    const dates = [source?.lastActivityDateUtc?.slice(0, 10), ...links.map(row => row.lastActivityDateUtc)].filter((date): date is string => Boolean(date)).sort();
    return reportAgent(index, {
      agentId, agentName: source?.agentName ?? links.map(row => row.agentName).sort()[0] ?? agentId,
      creatorType: source?.creatorType ?? links.map(row => row.creatorType).sort()[0] ?? "",
      responses: source?.responsesSentToUsers ?? bridge ?? 0, responseSource: source ? "agents" : "userAgents",
      reportResponses: source?.responsesSentToUsers ?? null, bridgeResponses: bridge, relationshipCount: links.length,
      responseComparison: !source || bridge === null ? "not_comparable" : source.responsesSentToUsers === bridge ? "matching" : "mismatch",
      licensedUserOccurrences: source?.activeUsersLicensed ?? null, unlicensedUserOccurrences: source?.activeUsersUnlicensed ?? null,
      activeUsers: links.length ? new Set(links.filter(row => row.responses > 0).map(row => row.username)).size : null,
      activeUsersBasis: links.length ? "userAgents_distinct_identity" : "unknown",
      lastActivityDateUtc: source ? source.lastActivityDateUtc?.slice(0, 10) ?? null : dates.at(-1) ?? null,
    });
  });
  const usernames = [...new Set([...rawUsers.map(row => row.username), ...relationships.map(row => row.username)])];
  const users: ReportUser[] = usernames.map((username, index) => {
    const source = rawUsers.find(row => row.username === username), links = relationships.filter(row => row.username === username);
    const bridge = links.length ? links.reduce((sum, row) => sum + row.responses, 0) : null;
    const dates = [source?.lastActivityDateUtc?.slice(0, 10), ...links.map(row => row.lastActivityDateUtc)].filter((date): date is string => Boolean(date)).sort();
    return reportUser(index, {
      username, displayName: source?.displayName || username, objectId: null, entitlement: "unknown", company: null, department: null,
      reportedResponses: source?.agentResponsesReceived ?? null, reportedAgentsUsed: source?.numberOfAgentsUsed ?? null,
      bridgeResponses: bridge, relationshipCount: links.length, responseProducingAgentCount: links.filter(row => row.responses > 0).length,
      userLastActivityDateUtc: source?.lastActivityDateUtc?.slice(0, 10) ?? null, lastActivityDateUtc: dates.at(-1) ?? null,
      hasActivity: (source?.agentResponsesReceived ?? 0) > 0 || (bridge ?? 0) > 0, missingUserReport: !source,
      hasReportMismatch: Boolean(source && bridge !== null && (source.agentResponsesReceived !== bridge || source.numberOfAgentsUsed !== links.length)),
      reviewCohort: !source ? "unknown" : source.agentResponsesReceived === 0 ? "zero" : source.agentResponsesReceived <= 5 ? "low" : "outside",
    });
  });
  const reportedResponses = agentsFile ? rawAgents.reduce((sum, row) => sum + row.responsesSentToUsers, 0) : null;
  const bridgeResponses = bridgeFile ? relationships.reduce((sum, row) => sum + row.responses, 0) : null;
  const userResponses = usersFile ? rawUsers.reduce((sum, row) => sum + row.agentResponsesReceived, 0) : null;
  const totals = [reportedResponses, bridgeResponses, userResponses].filter((value): value is number => value !== null);
  const summary: ReportSummary = {
    checkedUsers: null, licensedUsers: null, measuredActivityUsers: null, needsAttentionUsers: null, usingAgentsUsers: null,
    noAgentActivityUsers: null, unknownMetricsUsers: null, unresolvedIdentities: usernames.length, activeWithoutPaidUsers: null,
    paidActiveReportUsers: null, unknownLicenseActiveReportUsers: users.filter(row => row.hasActivity).length,
    reportedResponses, bridgeResponses, userReportedResponses: userResponses,
    distinctActiveReportUsers: metadata.setId ? users.filter(row => row.hasActivity).length : null,
    licensedOccurrences: agentsFile ? rawAgents.reduce((sum, row) => sum + row.activeUsersLicensed, 0) : null,
    unlicensedOccurrences: agentsFile ? rawAgents.reduce((sum, row) => sum + row.activeUsersUnlicensed, 0) : null,
    responseReconciliation: totals.length < 2 ? "not_comparable" : Math.max(...totals) === Math.min(...totals) ? "matching" : "mismatch",
    activeUsersAreNonAdditive: true,
  };
  const observations: ReportObservation[] = metadata.lineages.map(lineage => {
    const file = files.find(file => file.versionId === lineage.versionId);
    const acceptedAt = file?.observation?.acceptedAt ?? metadata.acceptedAt;
    if (!file || !acceptedAt) throw new Error("Selected CSV observations require their exact accepted receipt.");
    return { versionId: lineage.versionId, kind: lineage.kind, contentHash: lineage.contentHash, rowCount: lineage.rowCount,
      acceptedAt, sourceAsOf: lineage.sourceAsOf, sourceAsOfProvenance: lineage.sourceAsOfProvenance,
      sourceFreshness: lineage.sourceFreshness, supersedesVersionId: file.observation?.supersedesVersionId ?? null };
  });
  const directory = reportPage([], { reports: metadata, summary, counts: { total: 0, filtered: 0 },
    analytics: { basis: "filtered_rows", rowCount: 0, responses: null, zeroResponses: null, unknownResponses: null,
      review: null, agents: null, history: null, overview: null } });
  const unavailable = (source: UserSourceMetadata["source"]): UserSourceMetadata => ({
    source, state: "unavailable", generationId: null, scopeId: null, revision: null, expiresAt: null, observedAt: null,
    attemptedAt: null, attemptStatus: null, attemptObservedCount: null, errorCode: null, rowCount: null,
    message: "Run Users sync to verify licensing.", reportRefreshDate: null,
    period: source === "app_activity" ? "D28" : null, reportVersion: source === "app_activity" ? "v2" : null,
  });
  directory.sources = { directory: unavailable("directory"), app_activity: unavailable("app_activity") };
  return { agents, users, relationships, summary, observations, directory };
}
