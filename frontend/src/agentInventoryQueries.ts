import { isCancelledError, QueryClient } from "@tanstack/react-query";
import { ApiError, getUnifiedAgents, type UnifiedAgentInventoryPage, type UnifiedAgentInventoryQuery, type UnifiedAgentInventoryUnavailable } from "./api/client";

type InventoryRead = UnifiedAgentInventoryPage | UnifiedAgentInventoryUnavailable;

export class AgentInventoryQueries {
  private owner?: string;
  private family?: string;
  private selectionId?: string;
  private epoch = 0;
  private readonly positions = new Map<string, number>();
  private readonly client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 30_000, gcTime: 60_000, networkMode: "always" },
    },
  });

  async read(principalKey: string, query: UnifiedAgentInventoryQuery, signal: AbortSignal) {
    if (signal.aborted) throw abortedRead();
    const familyQuery = { ...query };
    delete familyQuery.cursor;
    delete familyQuery.selectionId;
    const family = JSON.stringify(familyQuery);
    if (this.owner !== principalKey || this.family !== family
      || query.selectionId && this.selectionId && query.selectionId !== this.selectionId) {
      this.clear();
      this.owner = principalKey;
      this.family = family;
    }
    const queryKey = ["agent-inventory", principalKey, query] as const;
    const key = JSON.stringify(queryKey);
    const epoch = this.epoch;
    const cached = this.client.getQueryData<InventoryRead>(queryKey);
    if (cached && ("state" in cached || expiry(cached) <= Date.now())) {
      await this.client.invalidateQueries({ queryKey, exact: true, refetchType: "none" });
    }
    if (signal.aborted || epoch !== this.epoch) throw abortedRead();
    const cancel = () => { void this.client.cancelQueries({ queryKey, exact: true }); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const result = await this.client.fetchQuery({
        queryKey,
        queryFn: async ({ signal: requestSignal }) => {
          const page = await getUnifiedAgents(query, { signal: requestSignal });
          if (!("state" in page) && expiry(page) <= Date.now()) {
            throw new ApiError(409, "inventory_changed", "The saved agent inventory or usage report expired. Reload Agents.");
          }
          return page;
        },
      });
      if (signal.aborted || epoch !== this.epoch) throw abortedRead();
      if ("state" in result) {
        this.client.clear();
        this.positions.clear();
        this.selectionId = undefined;
        return result;
      }
      let position = this.positions.get(key);
      const entries = this.client.getQueryCache().getAll();
      if (position === undefined && query.cursor) {
        for (const entry of entries) {
          const page = entry.state.data as UnifiedAgentInventoryPage | undefined;
          const known = this.positions.get(JSON.stringify(entry.queryKey));
          if (known === undefined || page?.selection.id !== result.selection.id) continue;
          if (page.page.nextCursor === query.cursor) { position = known + 1; break; }
          if (page.page.previousCursor === query.cursor) { position = known - 1; break; }
        }
      }
      position ??= 0;
      for (const entry of entries) {
        const entryKey = JSON.stringify(entry.queryKey);
        if (entryKey === key) continue;
        const page = entry.state.data as UnifiedAgentInventoryPage | undefined;
        const other = this.positions.get(entryKey);
        if (page?.selection.id !== result.selection.id || other === undefined || other === position || Math.abs(other - position) > 1) {
          this.client.removeQueries({ queryKey: entry.queryKey, exact: true });
          this.positions.delete(entryKey);
        }
      }
      this.positions.set(key, position);
      this.selectionId = result.selection.id;
      const retained = new Set(this.client.getQueryCache().getAll().map(entry => JSON.stringify(entry.queryKey)));
      for (const old of this.positions.keys()) if (!retained.has(old)) this.positions.delete(old);
      return result;
    } catch (error) {
      if (signal.aborted || epoch !== this.epoch || isCancelledError(error)) throw abortedRead();
      if (error instanceof ApiError && ["selection_invalidated", "inventory_changed", "unauthorized", "forbidden"].includes(error.code)) this.clear();
      throw error;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  clear() {
    this.epoch++;
    this.client.clear();
    this.owner = undefined;
    this.family = undefined;
    this.selectionId = undefined;
    this.positions.clear();
  }
}

function expiry(page: UnifiedAgentInventoryPage) {
  const timestamps = [
    page.selection.expiresAt,
    page.sources.graphPackages.observation?.expiresAt,
    page.sources.powerPlatform.observation?.expiresAt,
    page.usageContext?.reports.expiresAt,
    page.usageContext?.expiresAt,
    ...page.value.flatMap(record => [
      record.environment?.observation.expiresAt,
      record.observations.graphPackages?.expiresAt,
      record.observations.powerPlatform?.expiresAt,
      ...Object.values(record.observations.packageSnapshots).flatMap(observation => [
        observation.expiresAt, observation.identityDetails?.current ? observation.identityDetails.expiresAt : null,
      ]),
      ...record.packages.map(value => value.detailFreshness?.state === "fresh" ? value.detailFreshness.expiresAt : null),
      ...Object.values(record.people ?? {}).map(person => person?.expiresAt),
    ]),
  ].filter((value): value is string => typeof value === "string");
  const dates = timestamps.map(value => Date.parse(value));
  if (dates.some(value => !Number.isFinite(value))) {
    throw new ApiError(500, "invalid_inventory_expiry", "The saved agent inventory contains an invalid expiration timestamp.");
  }
  return Math.min(...dates);
}

function abortedRead() {
  return new ApiError(0, "request_aborted", "The request was cancelled.", { kind: "aborted" });
}
