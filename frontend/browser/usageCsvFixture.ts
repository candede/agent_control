import { readFile } from "node:fs/promises";
import type { Download, Page, TestInfo } from "@playwright/test";
import { parse } from "csv-parse/sync";
import { buildBoundedCsv } from "../../backend/src/services/csvEncoding";

export function csvFilePayloads(files: ReadonlyArray<{ name: string; content: string }>) {
  return files.map(({ name, content }) => ({ name, mimeType: "text/csv", buffer: Buffer.from(content) }));
}

export async function captureCsvReportScreenshot(page: Page, info: TestInfo, phase: "upload" | "success" | "management") {
  const name = `csv-reports-${phase}-${info.project.name}`;
  const path = info.outputPath(`${name}.png`);
  await page.getByRole("dialog").screenshot({ path, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

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
