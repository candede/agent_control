import { parse } from "csv-parse/sync";
import type {
  AgentUsageRow,
  OfficialUsageMetadata,
  OfficialUsageReportBase,
  OfficialUsageReportKind,
  ParsedOfficialUsageReport,
  UserAgentUsageRow,
  UserUsageRow,
} from "../types/officialUsage.js";

export const officialUsageParserVersion = "1";

export type OfficialUsageParserLimits = {
  maxBytes: number;
  maxRows: number;
  maxFieldBytes: number;
};

export class OfficialUsageValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const defaultLimits: OfficialUsageParserLimits = {
  maxBytes: 8 * 1024 * 1024,
  maxRows: 50_000,
  maxFieldBytes: 4_096,
};

const schemaRegistry = {
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

export function parseOfficialUsageReport(
  bytes: Uint8Array,
  metadata: OfficialUsageMetadata,
  limits: OfficialUsageParserLimits = defaultLimits,
): ParsedOfficialUsageReport {
  validateLimits(limits);
  if (bytes.byteLength === 0) {
    throw new OfficialUsageValidationError("empty_report", "The report file is empty.");
  }
  if (bytes.byteLength > limits.maxBytes) {
    throw new OfficialUsageValidationError("report_too_large", "The report exceeds the configured byte limit.");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new OfficialUsageValidationError("invalid_utf8", "The report must be valid UTF-8.");
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(text)) {
    throw new OfficialUsageValidationError("invalid_content", "The report contains unsupported control characters.");
  }

  let table: string[][];
  try {
    table = parse(text, {
      bom: true,
      columns: false,
      max_record_size: limits.maxFieldBytes * 16,
      relax_column_count: false,
      skip_empty_lines: true,
      trim: true,
    }) as string[][];
  } catch {
    throw new OfficialUsageValidationError("malformed_csv", "The report is not well-formed CSV.");
  }

  if (table.length === 0) {
    throw new OfficialUsageValidationError("empty_report", "The report file is empty.");
  }
  if (table.length - 1 > limits.maxRows) {
    throw new OfficialUsageValidationError("row_limit_exceeded", "The report exceeds the configured row limit.");
  }

  const headers = table[0].map(normalizeHeader);
  if (new Set(headers).size !== headers.length) {
    throw new OfficialUsageValidationError("duplicate_header", "The report contains duplicate normalized headers.");
  }
  const schema = identifySchema(headers);
  const records = table.slice(1).map((values, index) => {
    if (values.length !== headers.length) {
      throw rowError(index, "column_count", "has a different column count than the header");
    }
    const record = Object.fromEntries(headers.map((header, column) => [header, values[column]]));
    for (const [header, value] of Object.entries(record)) {
      if (Buffer.byteLength(value, "utf8") > limits.maxFieldBytes) {
        throw rowError(index, "field_limit_exceeded", `exceeds the field limit for ${header}`);
      }
    }
    return record;
  });
  const provenance = validateMetadata(metadata);
  const common = {
    parserVersion: officialUsageParserVersion,
    schemaVersion: schemaRegistry[schema].version,
    reportingPeriod: provenance.reportingPeriod,
    sourceAsOf: provenance.sourceAsOf,
    sourceAsOfProvenance: provenance.sourceAsOfProvenance,
    sourceFreshness: provenance.sourceFreshness,
    downloadedAt: provenance.downloadedAt,
    warnings: [] as string[],
  };

  if (schema === "agents") {
    const report = { ...common, kind: schema, rows: records.map(parseAgentRow) };
    validateUnique(report.rows, row => row.agentId, "agent ID");
    safeSum(report.rows.map(row => row.responsesSentToUsers));
    return report;
  }
  if (schema === "userAgents") {
    const report = { ...common, kind: schema, rows: records.map(parseUserAgentRow) };
    validateUnique(report.rows, row => `${row.agentId}\u0000${row.username}`, "agent and username pair");
    safeSum(report.rows.map(row => row.responsesSentToUsers));
    return report;
  }
  const report = { ...common, kind: schema, rows: records.map(parseUserRow) };
  validateUnique(report.rows, row => row.username, "username");
  safeSum(report.rows.flatMap(row => [row.numberOfAgentsUsed, row.agentResponsesReceived]));
  return report;
}

function identifySchema(headers: string[]): OfficialUsageReportKind {
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

function parseAgentRow(record: Record<string, string>, index: number): AgentUsageRow {
  const activeUsersLicensed = requiredCount(record, "active users (licensed)", index);
  const activeUsersUnlicensed = requiredCount(record, "active users (unlicensed)", index);
  return {
    agentId: requiredText(record, "agent id", index, 512),
    agentName: optionalText(record, "agent name", index, 512),
    creatorType: optionalText(record, "creator type", index, 128),
    activeUsersLicensed,
    activeUsersUnlicensed,
    responsesSentToUsers: requiredCount(record, "responses sent to users", index),
    lastActivityDateUtc: optionalDate(record, "last activity date (utc)", index),
  };
}

function parseUserAgentRow(record: Record<string, string>, index: number): UserAgentUsageRow {
  return {
    agentId: requiredText(record, "agent id", index, 512),
    agentName: optionalText(record, "agent name", index, 512),
    creatorType: optionalText(record, "creator type", index, 128),
    username: requiredText(record, "username", index, 512),
    responsesSentToUsers: requiredCount(record, "responses sent to users", index),
    lastActivityDateUtc: optionalDate(record, "last activity date (utc)", index),
  };
}

function parseUserRow(record: Record<string, string>, index: number): UserUsageRow {
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
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw rowError(index, "invalid_number", `has an invalid ${field} value`);
  }
  const parsed = Number(value);
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

function validateMetadata(metadata: OfficialUsageMetadata): Pick<OfficialUsageReportBase,
  "reportingPeriod" | "sourceAsOf" | "sourceAsOfProvenance" | "sourceFreshness" | "downloadedAt"> {
  const startDate = parseIsoDate(metadata.reportingPeriod.startDate, "reporting period start");
  const endDate = parseIsoDate(metadata.reportingPeriod.endDate, "reporting period end");
  if (Date.parse(startDate) > Date.parse(endDate)) {
    throw new OfficialUsageValidationError("invalid_reporting_period", "The reporting period start must not follow its end.");
  }
  const days = Math.floor((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000) + 1;
  if (days !== 7 && days !== 30) {
    throw new OfficialUsageValidationError("invalid_reporting_period", "The Microsoft Copilot Agents report period must be exactly 7 or 30 days.");
  }
  if (metadata.reportingPeriod.provenance !== "operator_asserted" || metadata.sourceAsOf?.provenance === "source_metadata") {
    throw new OfficialUsageValidationError("unverified_source_metadata", "These CSV schemas do not contain report-period or source-as-of metadata; operator input cannot claim source metadata provenance.");
  }
  const sourceAsOf = metadata.sourceAsOf
    ? parseInstant(metadata.sourceAsOf.value, "source as-of")
    : undefined;
  const downloadedAt = metadata.downloadedAt
    ? parseInstant(metadata.downloadedAt, "download time")
    : undefined;
  const sourceAsOfProvenance = metadata.sourceAsOf?.provenance ?? "absent";
  return {
    reportingPeriod: { startDate, endDate, days, provenance: metadata.reportingPeriod.provenance },
    sourceAsOf,
    sourceAsOfProvenance,
    sourceFreshness: "unknown" as const,
    downloadedAt,
  };
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

function validateUnique<T>(rows: readonly T[], identity: (row: T) => string, label: string) {
  const identities = new Set<string>();
  for (const row of rows) {
    const value = identity(row);
    if (identities.has(value)) {
      throw new OfficialUsageValidationError("duplicate_identity", `The report contains a duplicate ${label}; identities are case-sensitive within one dataset.`);
    }
    identities.add(value);
  }
}

function safeSum(values: readonly number[]) {
  values.reduce((total, value) => safeAdd(total, value), 0);
}

function safeAdd(left: number, right: number) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new OfficialUsageValidationError("numeric_overflow", "The report's numeric totals exceed the supported safe integer range.");
  }
  return result;
}

function validateLimits(limits: OfficialUsageParserLimits) {
  if (![limits.maxBytes, limits.maxRows, limits.maxFieldBytes].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error("Official usage parser limits must be positive integers.");
  }
}

function normalizeHeader(value: string) {
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
  return ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(value.slice(0, 3).toLowerCase());
}