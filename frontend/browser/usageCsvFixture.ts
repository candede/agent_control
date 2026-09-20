import { readFile } from "node:fs/promises";
import type { Download } from "@playwright/test";
import { parse } from "csv-parse/sync";
import { buildBoundedCsv } from "../../backend/src/services/csvExport";

export function usageCsvFixture(columns: string[], rows: Array<Record<string, unknown>>) {
  return buildBoundedCsv(columns, rows, {
    maximumRows: 100_000, maximumBytes: 20_000_000, deadlineAt: Date.now() + 10_000,
  }).buffer;
}

export async function downloadedCsvRows(download: Download): Promise<Record<string, string>[]> {
  const path = await download.path();
  if (!path) throw new Error("The CSV download did not produce a readable file.");
  return parse(await readFile(path, "utf8"), { bom: true, columns: true });
}
