import type {
  AgentUsageRow,
  OfficialUsageMetadata,
  OfficialUsageReportBase,
  OfficialUsageReportKind,
  UserAgentUsageRow,
  UserUsageRow,
} from "../types/officialReportRecords.js";

export const officialUsageParserVersion = "1";

export class OfficialUsageValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const schemaRegistry = {
  agents: {
    version: "m365-agents-observed-v1",
    headers: [
      "agent id",
      "agent name",
      "creator type",
      "active users (licensed)",
      "active users (unlicensed)",
      "responses sent to users",
      "last activity date (utc)",
    ],
  },
  userAgents: {
    version: "m365-users-agents-observed-v1",
    headers: [
      "agent id",
      "agent name",
      "creator type",
      "username",
      "responses sent to users",
      "last activity date (utc)",
    ],
  },
  users: {
    version: "m365-users-observed-v1",
    headers: [
      "username",
      "display name",
      "number of agents used",
      "agent responses received",
      "last activity date (utc)",
    ],
  },
} as const satisfies Record<
  OfficialUsageReportKind,
  { version: string; headers: readonly string[] }
>;

export function reportBase(
  schema: OfficialUsageReportKind,
  metadata: OfficialUsageMetadata | undefined,
  rows: ReadonlyArray<{ lastActivityDateUtc?: string }>,
): Omit<OfficialUsageReportBase, "kind"> {
  const provenance = validateMetadata(metadata, rows);
  return {
    parserVersion: officialUsageParserVersion,
    schemaVersion: schemaRegistry[schema].version,
    reportingPeriod: provenance.reportingPeriod,
    sourceAsOf: provenance.sourceAsOf,
    sourceAsOfProvenance: provenance.sourceAsOfProvenance,
    sourceFreshness: provenance.sourceFreshness,
    downloadedAt: provenance.downloadedAt,
    warnings: [],
  };
}

export function identifySchema(headers: string[]): OfficialUsageReportKind {
  const suppliedHeaders = new Set(headers);
  for (const [kind, schema] of Object.entries(schemaRegistry) as Array<
    [OfficialUsageReportKind, (typeof schemaRegistry)[OfficialUsageReportKind]]
  >) {
    if (headers.length === schema.headers.length && schema.headers.every(header => suppliedHeaders.has(header))) {
      return kind;
    }
  }
  const closest = (Object.entries(schemaRegistry) as Array<[OfficialUsageReportKind, (typeof schemaRegistry)[OfficialUsageReportKind]]>)
    .map(([kind, schema]) => {
      const expectedHeaders: ReadonlySet<string> = new Set(schema.headers);
      return { kind, schema, difference: schema.headers.filter(header => !suppliedHeaders.has(header)).length + headers.filter(header => !expectedHeaders.has(header)).length };
    })
    .sort((left, right) => left.difference - right.difference || left.kind.localeCompare(right.kind))[0];
  const missing = closest.schema.headers.filter(header => !suppliedHeaders.has(header));
  const missingText = missing.length ? ` Missing expected columns: ${missing.join(", ")}.` : "";
  throw new OfficialUsageValidationError("schema_drift", `The CSV headers do not exactly match a supported Microsoft export schema.${missingText} Supplied column values were not retained.`);
}

export function parseAgentRow(record: Record<string, string>, index: number): AgentUsageRow {
  const activeUsersLicensed = requiredCount(record, "active users (licensed)", index);
  const activeUsersUnlicensed = requiredCount(record, "active users (unlicensed)", index);
  return {
    agentId: requiredAgentId(record, index),
    agentName: optionalText(record, "agent name", index, 512),
    creatorType: optionalText(record, "creator type", index, 128),
    activeUsersLicensed,
    activeUsersUnlicensed,
    responsesSentToUsers: requiredCount(record, "responses sent to users", index),
    lastActivityDateUtc: optionalDate(record, "last activity date (utc)", index),
  };
}

export function parseUserAgentRow(record: Record<string, string>, index: number): UserAgentUsageRow {
  return {
    agentId: requiredAgentId(record, index),
    agentName: optionalText(record, "agent name", index, 512),
    creatorType: optionalText(record, "creator type", index, 128),
    username: requiredText(record, "username", index, 512),
    responsesSentToUsers: requiredCount(record, "responses sent to users", index),
    lastActivityDateUtc: optionalDate(record, "last activity date (utc)", index),
  };
}

export function parseUserRow(record: Record<string, string>, index: number): UserUsageRow {
  return {
    username: requiredText(record, "username", index, 512),
    displayName: optionalText(record, "display name", index, 512),
    numberOfAgentsUsed: requiredCount(record, "number of agents used", index),
    agentResponsesReceived: requiredCount(record, "agent responses received", index),
    lastActivityDateUtc: optionalDate(record, "last activity date (utc)", index),
  };
}

function requiredCount(record: Record<string, string>, field: string, index: number) {
  const value = record[field];
  if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(value)) {
    throw rowError(index, "invalid_number", `has an invalid ${field} value`);
  }
  const parsed = Number(value.replaceAll(",", ""));
  if (!Number.isSafeInteger(parsed)) {
    throw rowError(index, "invalid_number", `has an invalid ${field} value`);
  }
  return parsed;
}

function requiredText(record: Record<string, string>, field: string, index: number, maxLength: number) {
  const value = optionalText(record, field, index, maxLength);
  if (!value) {
    throw rowError(index, "missing_required_value", `is missing ${field}`);
  }
  return value;
}

function requiredAgentId(record: Record<string, string>, index: number) {
  const value = requiredText(record, "agent id", index, 512);
  if (/[\t\r\n]/.test(value)) {
    throw rowError(index, "invalid_identifier", "has an invalid agent id value");
  }
  return value;
}

function optionalText(record: Record<string, string>, field: string, index: number, maxLength: number) {
  const value = record[field]?.trim() ?? "";
  if (value.length > maxLength) {
    throw rowError(index, "field_limit_exceeded", `exceeds the value limit for ${field}`);
  }
  return value;
}

function optionalDate(record: Record<string, string>, field: string, index: number) {
  const value = record[field]?.trim();
  if (!value) return undefined;
  const parts = parseReportDateParts(value);
  if (!parts || !isValidUtcDate(parts.year, parts.month, parts.day)) {
    throw rowError(index, "invalid_date", `has an invalid ${field} value`);
  }
  return new Date(Date.UTC(parts.year, parts.month, parts.day)).toISOString();
}

function parseReportDateParts(value: string) {
  const normalized = value.trim().replace(/\s+/g, " ");
  const monthFirst = normalized.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s*(\d{4})$/);
  if (monthFirst) {
    const month = monthIndex(monthFirst[1]);
    return month < 0 ? undefined : { year: Number(monthFirst[3]), month, day: Number(monthFirst[2]) };
  }
  const dayFirst = normalized.match(/^(\d{1,2})\s+([A-Za-z]{3,})\.?[,]?\s*(\d{4})$/);
  if (dayFirst) {
    const month = monthIndex(dayFirst[2]);
    return month < 0 ? undefined : { year: Number(dayFirst[3]), month, day: Number(dayFirst[1]) };
  }
  const iso = normalized.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  return iso ? { year: Number(iso[1]), month: Number(iso[2]) - 1, day: Number(iso[3]) } : undefined;
}

function validateMetadata(
  metadata: OfficialUsageMetadata | undefined,
  rows: ReadonlyArray<{ lastActivityDateUtc?: string }>,
): Pick<OfficialUsageReportBase,
  "reportingPeriod" | "sourceAsOf" | "sourceAsOfProvenance" | "sourceFreshness" | "downloadedAt"> {
  if (metadata !== undefined && (!metadata || typeof metadata !== "object")) {
    throw new OfficialUsageValidationError("invalid_metadata", "The report metadata must be an object.");
  }
  if (metadata?.reportingPeriod?.provenance === "source_metadata" || metadata?.sourceAsOf?.provenance === "source_metadata") {
    throw new OfficialUsageValidationError("unverified_source_metadata", "These CSV schemas do not contain report-period or source-as-of metadata; operator input cannot claim source metadata provenance.");
  }
  if (metadata?.reportingPeriod && metadata.reportingPeriod.provenance !== "operator_asserted") {
    throw new OfficialUsageValidationError("invalid_metadata", "The reporting period provenance is invalid.");
  }
  if (metadata?.sourceAsOf && metadata.sourceAsOf.provenance !== "operator_asserted") {
    throw new OfficialUsageValidationError("invalid_metadata", "The source as-of provenance is invalid.");
  }
  const reportingPeriod = metadata?.reportingPeriod
    ? validateExplicitReportingPeriod(metadata.reportingPeriod)
    : observedActivityRange(rows);
  const sourceAsOf = metadata?.sourceAsOf
    ? parseInstant(metadata.sourceAsOf.value, "source as-of")
    : undefined;
  const downloadedAt = metadata?.downloadedAt
    ? parseInstant(metadata.downloadedAt, "download time")
    : undefined;
  const sourceAsOfProvenance = metadata?.sourceAsOf?.provenance ?? "absent";
  return {
    reportingPeriod,
    sourceAsOf,
    sourceAsOfProvenance,
    sourceFreshness: "unknown" as const,
    downloadedAt,
  };
}

function validateExplicitReportingPeriod(metadata: NonNullable<OfficialUsageMetadata["reportingPeriod"]>) {
  const startDate = parseIsoDate(metadata.startDate, "reporting period start");
  const endDate = parseIsoDate(metadata.endDate, "reporting period end");
  if (Date.parse(startDate) > Date.parse(endDate)) {
    throw new OfficialUsageValidationError("invalid_reporting_period", "The reporting period start must not follow its end.");
  }
  const days = inclusiveDays(startDate, endDate);
  if (days !== 7 && days !== 30) {
    throw new OfficialUsageValidationError("invalid_reporting_period", "The Microsoft Copilot Agents report period must be exactly 7 or 30 days.");
  }
  return { startDate, endDate, days, provenance: metadata.provenance };
}

function observedActivityRange(rows: ReadonlyArray<{ lastActivityDateUtc?: string }>): OfficialUsageReportBase["reportingPeriod"] {
  const dates = rows.flatMap(row => row.lastActivityDateUtc ? [row.lastActivityDateUtc.slice(0, 10)] : []);
  if (!dates.length) {
    return { startDate: null, endDate: null, days: null, provenance: "activity_range" };
  }
  dates.sort();
  const startDate = dates[0];
  const endDate = dates[dates.length - 1];
  return { startDate, endDate, days: inclusiveDays(startDate, endDate), provenance: "activity_range" };
}

function inclusiveDays(startDate: string, endDate: string) {
  return Math.floor((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000) + 1;
}

function parseIsoDate(value: string, label: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match || !isValidUtcDate(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) {
    throw new OfficialUsageValidationError("invalid_metadata", `The ${label} must be a valid YYYY-MM-DD date.`);
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function parseInstant(value: string, label: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/);
  if (!match || !isValidUtcDate(Number(match[1]), Number(match[2]) - 1, Number(match[3])) ||
      Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59 || !validOffset(match[8])) {
    throw new OfficialUsageValidationError("invalid_metadata", `The ${label} must be an unambiguous ISO 8601 timestamp with a timezone.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new OfficialUsageValidationError("invalid_metadata", `The ${label} must be a valid timestamp.`);
  }
  return new Date(parsed).toISOString();
}

function validOffset(value: string) {
  if (value === "Z") return true;
  const hours = Number(value.slice(1, 3));
  const minutes = Number(value.slice(4, 6));
  return hours <= 14 && minutes <= 59 && (hours < 14 || minutes === 0);
}

export function normalizeHeader(value: string) {
  return value.replace(/^\uFEFF/, "").trim().toLowerCase();
}

function rowError(index: number, code: string, message: string) {
  return new OfficialUsageValidationError(code, `Row ${index + 2} ${message}.`);
}

function isValidUtcDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day;
}

function monthIndex(value: string) {
  const month = value.toLowerCase();
  if (month === "sept") return 8;
  return ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
    .findIndex(name => month === name || month === name.slice(0, 3));
}