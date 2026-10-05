import { AppError } from "../errors.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import type { GraphPackagesClient, PackageReadOptions } from "./graphPackages.js";
import type { PowerPlatformResourceQueryClient, ResourceQueryOptions } from "./powerPlatformResourceQuery.js";
import { powerPlatformResourceTypes, type PowerPlatformResource, type PowerPlatformResourceType } from "../types/powerPlatformInventory.js";

export async function measureGraphDetails(client: GraphPackagesClient, count: number,
  options: PackageReadOptions = {}, settings: {
    workers?: number; id?: (index: number) => string; observe?: (value: CopilotPackageDetail, index: number) => void;
  } = {}) {
  const workers = settings.workers ?? 4;
  if (!Number.isSafeInteger(count) || count < 0 || count > 5_000 || !Number.isInteger(workers) || workers < 1 || workers > 4) {
    throw new Error("bounded_detail_fixture_limit");
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, ...options.signal ? [options.signal] : []]);
  let next = 0, observedCount = 0;
  await Promise.allSettled(Array.from({ length: workers }, async () => {
    try {
      for (;;) {
        signal.throwIfAborted();
        const index = next++;
        if (index >= count) return;
        const id = settings.id?.(index) ?? `package-${index}`;
        const value = await client.getPackageDetails("synthetic-detail-token", id, { ...options, signal });
        if (value.id !== id) throw new Error("detail_fixture_identity_mismatch");
        settings.observe?.(value, index);
        observedCount++;
      }
    } catch (error) { controller.abort(error); }
  }));
  signal.throwIfAborted();
  return { observedCount };
}

export async function tinyGraphCatalog(client: GraphPackagesClient, token: string, options: PackageReadOptions = {}) {
  const rows: CopilotPackageDetail[] = [], visited = new Set<string>();
  for await (const page of client.catalogPages(token, { ...options, visit: async token => {
    if (visited.has(token)) throw new AppError(502, "provider_continuation", "Repeated synthetic page.");
    if (visited.size >= 8) throw new Error("tiny_graph_fixture_page_limit");
    visited.add(token);
  } })) {
    if (rows.length + page.records.length > 100 || Buffer.byteLength(JSON.stringify(page.records)) > 1_048_576) {
      throw new Error("tiny_graph_fixture_limit");
    }
    rows.push(...page.records);
  }
  return rows;
}

export async function measureNativePages(client: PowerPlatformResourceQueryClient, token: string,
  types: readonly PowerPlatformResourceType[] = powerPlatformResourceTypes, options: ResourceQueryOptions = {},
  observe: (rows: PowerPlatformResource[], offset: number) => void = () => {}) {
  let observedCount = 0, pages = 0, totalRecords = 0, unknownFieldCount = 0;
  for await (const page of client.pages(token, types, { ...options, visit: async () => {} })) {
    if (page.records.length > 100 || Buffer.byteLength(JSON.stringify(page.records)) > 1_048_576) {
      throw new Error("native_fixture_page_limit");
    }
    observe(page.records, observedCount);
    observedCount += page.records.length;
    totalRecords = page.expectedCount ?? 0;
    unknownFieldCount += page.omittedFieldCount ?? 0;
    pages++;
  }
  return { observedCount, pages, totalRecords, unknownFieldCount };
}

export async function tinyNativePages(client: PowerPlatformResourceQueryClient, token: string,
  types: readonly PowerPlatformResourceType[] = powerPlatformResourceTypes, options: ResourceQueryOptions = {}) {
  const resources: PowerPlatformResource[] = [];
  const result = await measureNativePages(client, token, types, options, rows => {
    if (resources.length + rows.length > 100) throw new Error("tiny_native_fixture_limit");
    resources.push(...rows);
  });
  return { ...result, resources, queriedTypes: [...types], environmentScope: options.environmentId ?? null };
}
