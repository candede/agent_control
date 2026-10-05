import { AppError } from "../errors.js";

export type CsvExportBudget = {
  maximumRows: number;
  maximumBytes: number;
  deadlineAt: number;
};

export function buildBoundedCsv(columns: readonly string[], rows: Iterable<Record<string, unknown>>, budget: CsvExportBudget) {
  if (!columns.length || columns.some(column => !/^[A-Za-z][A-Za-z0-9]*$/.test(column))) {
    throw new AppError(500, "invalid_export_schema", "The export schema is invalid.");
  }
  const chunks = [Buffer.from(`\uFEFF${columns.join(",")}\r\n`, "utf8")];
  let byteCount = chunks[0].byteLength;
  let rowCount = 0;
  if (Date.now() >= budget.deadlineAt) throw new AppError(408, "export_deadline", "The export exceeded its publication deadline.");
  if (byteCount > budget.maximumBytes) throw new AppError(413, "export_byte_limit", "The export header exceeds its byte limit.");
  for (const row of rows) {
    if (Date.now() >= budget.deadlineAt) throw new AppError(408, "export_deadline", "The export exceeded its processing deadline.");
    rowCount += 1;
    if (rowCount > budget.maximumRows) throw new AppError(413, "export_row_limit", `The export exceeds the ${budget.maximumRows.toLocaleString("en-US")} row limit.`);
    const cells: string[] = [];
    byteCount += columns.length - 1 + 2;
    if (byteCount > budget.maximumBytes) throw new AppError(413, "export_byte_limit", `The export exceeds the ${budget.maximumBytes.toLocaleString("en-US")} byte limit.`);
    for (const column of columns) {
      const cell = csvValue(row[column]);
      if (Date.now() >= budget.deadlineAt) throw new AppError(408, "export_deadline", "The export exceeded its processing deadline.");
      byteCount += Buffer.byteLength(cell, "utf8");
      if (byteCount > budget.maximumBytes) throw new AppError(413, "export_byte_limit", `The export exceeds the ${budget.maximumBytes.toLocaleString("en-US")} byte limit.`);
      cells.push(cell);
    }
    chunks.push(Buffer.from(`${cells.join(",")}\r\n`, "utf8"));
  }
  const buffer = Buffer.concat(chunks, byteCount);
  if (Date.now() >= budget.deadlineAt) throw new AppError(408, "export_deadline", "The export exceeded its processing deadline.");
  return { buffer, rowCount, byteCount };
}

export function csvValue(value: unknown) {
  const text = value === null || value === undefined ? "" : typeof value === "string" ? value : String(value);
  if (!text) return "";
  const safe = /^[=+\-@\t\r\u2212]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}
