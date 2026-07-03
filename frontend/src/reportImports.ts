export type UsageReportKind = "agents" | "userAgents" | "users";

export type ParsedUsageReport =
  | AgentUsageReport
  | UserAgentUsageReport
  | UserUsageReport;

export type BaseUsageReport = {
  kind: UsageReportKind;
  fileName: string;
  importedAt: string;
  periodDays?: number;
  warnings: string[];
};

export type AgentUsageReport = BaseUsageReport & {
  kind: "agents";
  rows: AgentUsageRow[];
};

export type UserAgentUsageReport = BaseUsageReport & {
  kind: "userAgents";
  rows: UserAgentUsageRow[];
};

export type UserUsageReport = BaseUsageReport & {
  kind: "users";
  rows: UserUsageRow[];
};

export type AgentUsageRow = {
  agentId: string;
  agentName: string;
  creatorType: string;
  activeUsersLicensed: number;
  activeUsersUnlicensed: number;
  activeUsersTotal: number;
  responsesSentToUsers: number;
  lastActivityDateUtc?: string;
};

export type UserAgentUsageRow = {
  agentId: string;
  agentName: string;
  creatorType: string;
  username: string;
  responsesSentToUsers: number;
  lastActivityDateUtc?: string;
};

export type UserUsageRow = {
  username: string;
  displayName: string;
  numberOfAgentsUsed: number;
  agentResponsesReceived: number;
  lastActivityDateUtc?: string;
};

export type AgentUsageSummary = AgentUsageRow & {
  fileName: string;
  importedAt: string;
  periodDays?: number;
  sourceReport: "agents" | "userAgents";
  userRows: UserAgentUsageRow[];
};

type CsvRecord = Record<string, string>;

const agentHeaders = [
  "agent id",
  "agent name",
  "creator type",
  "active users (licensed)",
  "active users (unlicensed)",
  "responses sent to users",
  "last activity date (utc)",
];

const userAgentHeaders = [
  "agent id",
  "agent name",
  "creator type",
  "username",
  "responses sent to users",
  "last activity date (utc)",
];

const userHeaders = [
  "username",
  "display name",
  "number of agents used",
  "agent responses received",
  "last activity date (utc)",
];

export function parseUsageReport(
  fileName: string,
  text: string,
  importedAt = new Date().toISOString(),
): ParsedUsageReport {
  const table = parseCsv(text);
  const headers = table.headers.map(normalizeHeader);
  const periodDays = parsePeriodDays(fileName);
  const warnings = [...table.warnings];

  if (hasHeaders(headers, agentHeaders)) {
    return {
      kind: "agents",
      fileName,
      importedAt,
      periodDays,
      warnings,
      rows: table.records.map((record, index) =>
        parseAgentUsageRow(record, index, warnings),
      ),
    };
  }

  if (hasHeaders(headers, userAgentHeaders)) {
    return {
      kind: "userAgents",
      fileName,
      importedAt,
      periodDays,
      warnings,
      rows: table.records.map((record, index) =>
        parseUserAgentUsageRow(record, index, warnings),
      ),
    };
  }

  if (hasHeaders(headers, userHeaders)) {
    return {
      kind: "users",
      fileName,
      importedAt,
      periodDays,
      warnings,
      rows: table.records.map((record, index) =>
        parseUserUsageRow(record, index, warnings),
      ),
    };
  }

  throw new Error(
    `Could not recognize ${fileName}. Expected an Agents, Users & agents, or Users report export.`,
  );
}

function parseAgentUsageRow(
  record: CsvRecord,
  index: number,
  warnings: string[],
): AgentUsageRow {
  const agentId = parseRequiredText(record["agent id"], {
    field: "Agent ID",
    index,
    warnings,
  });
  const activeUsersLicensed = parseNumber(record["active users (licensed)"], {
    field: "Active users (licensed)",
    index,
    warnings,
  });
  const activeUsersUnlicensed = parseNumber(
    record["active users (unlicensed)"],
    {
      field: "Active users (unlicensed)",
      index,
      warnings,
    },
  );

  return {
    agentId,
    agentName: record["agent name"]?.trim() ?? "",
    creatorType: record["creator type"]?.trim() ?? "",
    activeUsersLicensed,
    activeUsersUnlicensed,
    activeUsersTotal: activeUsersLicensed + activeUsersUnlicensed,
    responsesSentToUsers: parseNumber(record["responses sent to users"], {
      field: "Responses sent to users",
      index,
      warnings,
    }),
    lastActivityDateUtc: parseReportDate(record["last activity date (utc)"], {
      field: "Last activity date (UTC)",
      index,
      warnings,
    }),
  };
}

function parseUserAgentUsageRow(
  record: CsvRecord,
  index: number,
  warnings: string[],
): UserAgentUsageRow {
  return {
    agentId: parseRequiredText(record["agent id"], {
      field: "Agent ID",
      index,
      warnings,
    }),
    agentName: record["agent name"]?.trim() ?? "",
    creatorType: record["creator type"]?.trim() ?? "",
    username: parseRequiredText(record.username, {
      field: "Username",
      index,
      warnings,
    }).toLowerCase(),
    responsesSentToUsers: parseNumber(record["responses sent to users"], {
      field: "Responses sent to users",
      index,
      warnings,
    }),
    lastActivityDateUtc: parseReportDate(record["last activity date (utc)"], {
      field: "Last activity date (UTC)",
      index,
      warnings,
    }),
  };
}

function parseUserUsageRow(
  record: CsvRecord,
  index: number,
  warnings: string[],
): UserUsageRow {
  return {
    username: parseRequiredText(record.username, {
      field: "Username",
      index,
      warnings,
    }).toLowerCase(),
    displayName: record["display name"]?.trim() ?? "",
    numberOfAgentsUsed: parseNumber(record["number of agents used"], {
      field: "Number of agents used",
      index,
      warnings,
    }),
    agentResponsesReceived: parseNumber(record["agent responses received"], {
      field: "Agent responses received",
      index,
      warnings,
    }),
    lastActivityDateUtc: parseReportDate(record["last activity date (utc)"], {
      field: "Last activity date (UTC)",
      index,
      warnings,
    }),
  };
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  const warnings: string[] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];

    if (quoted) {
      if (character === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  const [rawHeaders, ...rawRecords] = rows.filter((current) =>
    current.some((value) => value.trim()),
  );

  if (!rawHeaders) {
    throw new Error("The report file is empty.");
  }

  const headers = rawHeaders.map((header) => header.trim());
  const normalizedHeaders = headers.map(normalizeHeader);
  const records = rawRecords.map((values, index) => {
    if (values.length !== headers.length) {
      warnings.push(
        `Row ${index + 2} has ${values.length} columns; expected ${headers.length}.`,
      );
    }

    return Object.fromEntries(
      normalizedHeaders.map((header, headerIndex) => [
        header,
        values[headerIndex]?.trim() ?? "",
      ]),
    );
  });

  return { headers, records, warnings };
}

function hasHeaders(headers: string[], required: string[]) {
  return required.every((header) => headers.includes(header));
}

function normalizeHeader(value: string) {
  return value
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase();
}

function parseNumber(
  value: string | undefined,
  context: { field: string; index: number; warnings: string[] },
) {
  if (!value) {
    return 0;
  }

  const parsed = Number(value.replace(/,/g, ""));

  if (!Number.isFinite(parsed)) {
    context.warnings.push(
      `Row ${context.index + 2} has an invalid ${context.field} value: ${value}.`,
    );
    return 0;
  }

  return parsed;
}

function parseRequiredText(
  value: string | undefined,
  context: { field: string; index: number; warnings: string[] },
) {
  const parsed = value?.trim() ?? "";

  if (!parsed) {
    context.warnings.push(
      `Row ${context.index + 2} is missing ${context.field}.`,
    );
  }

  return parsed;
}

function parseReportDate(
  value: string | undefined,
  context: { field: string; index: number; warnings: string[] },
) {
  if (!value) {
    return undefined;
  }

  const match = value.trim().match(/^([A-Za-z]{3,})\s+(\d{1,2}),\s*(\d{4})$/);

  if (!match) {
    context.warnings.push(
      `Row ${context.index + 2} has an invalid ${context.field} value: ${value}.`,
    );
    return undefined;
  }

  const month = monthIndex(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);

  if (month === -1 || !isValidUtcDate(year, month, day)) {
    context.warnings.push(
      `Row ${context.index + 2} has an invalid ${context.field} value: ${value}.`,
    );
    return undefined;
  }

  return new Date(Date.UTC(year, month, day)).toISOString();
}

function isValidUtcDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month &&
    date.getUTCDate() === day
  );
}

function monthIndex(value: string) {
  return [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ].indexOf(value.slice(0, 3).toLowerCase());
}

function parsePeriodDays(fileName: string) {
  const match = fileName.match(/_(\d+)_[0-9]{4}-[0-9]{2}-[0-9]{2}T/);
  return match ? Number(match[1]) : undefined;
}
