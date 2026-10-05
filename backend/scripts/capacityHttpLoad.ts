import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ReportRow } from "../src/types/officialReportData.js";

export function capacityReportIdentity(index: number, row: ReportRow) {
  if (index === 0 && "directory" in row) return row.directory.userPrincipalName;
  if (index === 1 && "username" in row) return row.username;
  if (index === 2 && "agentId" in row) return row.agentId;
  throw new Error("capacity_report_row_shape");
}

export async function capacityHttpLoad(input: { cookie: string; action: "readers" | "download" | "browser" | "browser-platform"; exportId?: string },
  signal: AbortSignal = new AbortController().signal) {
  assert.ok(typeof input.cookie === "string" && input.cookie.length <= 8192);
  signal.throwIfAborted();
  if (input.action==="browser" || input.action==="browser-platform") {
    return (await import("./capacityBrowser.js")).capacityBrowser(input.cookie,signal,input.action==="browser-platform");
  }
  const bounded = (milliseconds: number) => AbortSignal.any([signal,AbortSignal.timeout(milliseconds)]);
  const headers = { cookie: input.cookie };
  const target = "http://test-db:8081/api";
  if (input.action === "download") {
    assert.match(input.exportId ?? "", /^[a-f0-9-]{36}$/);
    const path = `${target}/data-exports/${input.exportId}`;
    const states = [];
    for (let i = 0; i < 2; i++) {
      const status = await fetch(path, { headers, signal: bounded(20_000) });
      assert.equal(status.status, 200); states.push(await status.json());
    }
    const response = await fetch(`${path}/download`, { headers, signal: bounded(900_000) });
    assert.equal(response.status, 200);
    const digest = createHash("sha256");
    let bytes = 0, chunks = 0;
    for await (const chunk of response.body!) {
      assert.ok(chunk.byteLength <= 524288);
      digest.update(chunk); bytes += chunk.byteLength; chunks++;
      await delay(25,undefined,{ signal });
    }
    const cancelled = new AbortController();
    const disconnected = await fetch(`${path}/download`, { headers, signal: AbortSignal.any([signal,cancelled.signal]) });
    assert.equal(disconnected.status, 200);
    const reader = disconnected.body!.getReader();
    assert.ok((await reader.read()).value?.length);
    cancelled.abort();
    await reader.cancel().catch(() => {});
    await delay(1000);
    return { bytes, chunks, checksum: digest.digest("hex"), states, statusPolls: 2, disconnected: true };
  }
  assert.equal(input.action, "readers");
  const warmingAt = performance.now();
  const warming = await fetch(`${target}/agents?limit=100`, { headers, signal: bounded(20_000) });
  assert.equal(warming.status, 200, "The separately recorded cold selection must succeed before warm-reader qualification.");
  const warmingText = await warming.text();
  assert.ok(Buffer.byteLength(warmingText) <= 1048576);
  const initial = JSON.parse(warmingText);
  assert.equal(initial.counts.total, 100_000);
  assert.ok(typeof initial.selection.id === "string");
  for (const [index, row] of initial.value.entries()) assert.equal(row.id, `package-${String(index).padStart(6, "0")}`);
  const warmup = { requests: 1, milliseconds: performance.now() - warmingAt, bytes: Buffer.byteLength(warmingText),
    scope: "One separately measured cold selection; 1008 concurrent warm requests below still perform real authorization and selected-read fences." };
  const outcomes = await Promise.allSettled(Array.from({ length: 12 }, async (_, reader) => {
    let selection: string | undefined = initial.selection.id, cursor: string | undefined, offset = 0, requests = 0, failures = 0;
    let maximumBytes = 0, maximumMs = 0;
    const histogram: Record<string, number> = {}, errors: string[] = [];
    const successfulHistograms: Record<string,Record<string,number>> = {}, failedHistogram: Record<string,number> = {};
    for (let request = 0; request < 84; request++) {
      signal.throwIfAborted();
      const started = performance.now(), query = new URLSearchParams({ limit: "100" });
      if (selection) query.set("selectionId", selection);
      if (cursor) query.set("cursor", cursor);
      const detail = reader >= 10 && selection;
      const path = detail ? `/agents/package-000000/detail?selectionId=${selection}` : `/agents?${query}`;
      let succeeded = false;
      try {
        const response = await fetch(target+path, { headers, signal: bounded(20_000) });
        assert.equal(response.status, 200, `HTTP ${response.status}: ${path.split("?")[0]}`);
        const text = await response.text();
        maximumBytes = Math.max(maximumBytes, Buffer.byteLength(text));
        assert.ok(Buffer.byteLength(text) <= (detail ? 524288 : 1048576));
        const body = JSON.parse(text);
        if (!detail) {
          assert.equal(body.counts.total, 100_000);
          assert.ok(body.value.length <= 100);
          for (const [index, row] of body.value.entries()) assert.equal(row.id, `package-${String(offset+index).padStart(6,"0")}`);
          selection = body.selection.id; cursor = body.page.nextCursor ?? undefined;
          offset = cursor ? offset+body.value.length : 0;
        }
        succeeded = true;
      } catch (error) {
        signal.throwIfAborted();
        failures++;
        if (errors.length < 8) errors.push(String(error));
      }
      requests++;
      const elapsedMs = performance.now()-started;
      maximumMs = Math.max(maximumMs,elapsedMs);
      const bucket = String(Math.min(20000, Math.ceil(elapsedMs/10)*10));
      histogram[bucket] = (histogram[bucket] ?? 0)+1;
      const targetHistogram = succeeded
        ? successfulHistograms[detail ? "http-detail" : "http-inventory-page"] ??= {}
        : failedHistogram;
      targetHistogram[bucket] = (targetHistogram[bucket] ?? 0)+1;
    }
    return { reader, requests, failures, maximumBytes, maximumMs, histogram,successfulHistograms,failedHistogram,overflowBucketAtMs: 20000, errors };
  }));
  const rejected = outcomes.filter(value => value.status === "rejected");
  if (rejected.length) throw new AggregateError(rejected.map(value => value.reason),"capacity_http_load_failed");
  const readers = outcomes.map(value => (value as PromiseFulfilledResult<{
    reader: number; requests: number; failures: number; maximumBytes: number; maximumMs: number;
    histogram: Record<string,number>; successfulHistograms: Record<string,Record<string,number>>;
    failedHistogram: Record<string,number>; overflowBucketAtMs: number; errors: string[];
  }>).value);
  return { readers, warmup, requests: readers.reduce((n,r) => n+r.requests,0), failures: readers.reduce((n,r) => n+r.failures,0) };
}
