import { hashKey, isCancelledError, QueryClient, type QueryKey } from "@tanstack/react-query";
import { ApiError, getUnifiedAgents, type UnifiedAgentInventoryPage, type UnifiedAgentInventoryQuery, type UnifiedAgentInventoryUnavailable } from "./api/client";

type InventoryRead = UnifiedAgentInventoryPage | UnifiedAgentInventoryUnavailable;
type InventoryOutcome = { epoch: number; family?: InventoryFamily } & ({ data: InventoryRead } | { error: unknown });
type InventoryRequest = { controller: AbortController; promise: Promise<InventoryOutcome>; readers: number };
type InventoryFamily = { selectionId?: string; requests: Map<string, InventoryRequest> };
const cacheMs = 30_000;
const maximumFamilies = 4;

export class AgentInventoryExpiredError extends ApiError {
  constructor() {
    super(409, "inventory_changed", "The saved agent inventory or usage report expired. Reload Agents.");
  }
}

export class AgentInventoryQueries {
  private owner?: string;
  private readonly families = new Map<string, InventoryFamily>();
  private epoch = 0;
  private readonly positions = new Map<string, number>();
  private readonly client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: cacheMs, gcTime: 60_000, networkMode: "always" },
    },
  });

  private queryKey(principalKey: string, query: UnifiedAgentInventoryQuery) {
    const family = familyKey(query);
    const selected = query.selectionId ?? this.families.get(family)?.selectionId;
    const alias = selected ? this.client.getQueryCache().findAll({ queryKey: ["agent-inventory", principalKey, family] })
      .find(entry => {
        const saved = entry.state.data as InventoryRead | undefined;
        const requested = entry.queryKey[3] as UnifiedAgentInventoryQuery;
        return saved && !("state" in saved) && saved.selection.id === selected && requested.cursor === query.cursor;
      }) : undefined;
    return alias?.queryKey ?? ["agent-inventory", principalKey, family, query];
  }

  getCached(principalKey: string, query: UnifiedAgentInventoryQuery): UnifiedAgentInventoryPage | undefined {
    if (this.owner !== principalKey) return;
    const saved = this.client.getQueryCache().find({ queryKey: this.queryKey(principalKey, query), exact: true });
    const data = saved?.state.data as InventoryRead | undefined;
    if (saved?.state.status === "success" && !saved.state.isInvalidated && data && !("state" in data)
      && (!query.selectionId || data.selection.id === query.selectionId)
      && Date.now() - saved.state.dataUpdatedAt < cacheMs && expiry(data) > Date.now()) return data;
  }

  private removeFamily(family: string) {
    for (const entry of this.client.getQueryCache().findAll({ queryKey: ["agent-inventory", this.owner, family] })) {
      this.positions.delete(hashKey(entry.queryKey));
      this.client.removeQueries({ queryKey: entry.queryKey, exact: true });
    }
    this.families.delete(family);
  }

  async read(principalKey: string, query: UnifiedAgentInventoryQuery, signal: AbortSignal) {
    if (signal.aborted) throw abortedRead();
    const family = familyKey(query);
    if (this.owner !== principalKey) {
      this.clear();
      this.owner = principalKey;
    }
    const selected = this.families.get(family);
    const recapturing = !query.selectionId && selected?.selectionId !== undefined && !this.getCached(principalKey, query);
    if (recapturing || query.selectionId && selected && query.selectionId !== selected.selectionId) this.removeFamily(family);
    const familyState = this.families.get(family) ?? { selectionId: query.selectionId, requests: new Map<string, InventoryRequest>() };
    this.families.delete(family);
    this.families.set(family, familyState);
    while (this.families.size > maximumFamilies) this.removeFamily(this.families.keys().next().value!);
    const queryKey = this.queryKey(principalKey, query);
    const key = hashKey(queryKey);
    let pending = familyState.requests.get(key);
    if (!pending) {
      // Share finalization too: one invalidation must not turn a peer's real result into cancellation.
      const controller = new AbortController();
      const promise = this.fetch(principalKey, query, family, familyState, queryKey, controller.signal, recapturing);
      pending = { controller, promise, readers: 0 };
      familyState.requests.set(key, pending);
      const remove = (outcome?: InventoryOutcome) => {
        if (familyState.requests.get(key) === pending) familyState.requests.delete(key);
        if (outcome && "data" in outcome && !("state" in outcome.data)
          && outcome.epoch === this.epoch && this.families.get(family) === familyState) {
          this.retainPages(principalKey, family, familyState, key, outcome.data);
        }
      };
      void promise.then(remove, () => remove());
    }
    const request = pending;
    return new Promise<InventoryRead>((resolve, reject) => {
      let settled = false;
      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", cancel);
        request.readers--;
        complete();
      };
      const cancel = () => {
        finish(() => reject(abortedRead()));
        if (request.readers === 0 && familyState.requests.get(key) === request) {
          familyState.requests.delete(key);
          request.controller.abort();
        }
      };
      request.readers++;
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      void request.promise.then(
        outcome => finish(() => {
          if (outcome.epoch !== this.epoch || outcome.family !== this.families.get(family)) reject(abortedRead());
          else if ("error" in outcome) reject(outcome.error);
          else resolve(outcome.data);
        }),
        error => finish(() => reject(error)),
      );
    });
  }

  private async fetch(principalKey: string, query: UnifiedAgentInventoryQuery, family: string,
    familyState: InventoryFamily, queryKey: QueryKey, signal: AbortSignal, recapturing: boolean) {
    const key = hashKey(queryKey);
    const epoch = this.epoch;
    const ownsFamily = () => epoch === this.epoch && this.families.get(family) === familyState;
    // Stamp after this request's own invalidation, but before yielding to its readers.
    const complete = (outcome: { data: InventoryRead } | { error: unknown }): InventoryOutcome =>
      ({ ...outcome, epoch: this.epoch, family: this.families.get(family) });
    const cached = this.client.getQueryData<InventoryRead>(queryKey);
    if (recapturing || cached && ("state" in cached || expiry(cached) <= Date.now())) {
      await this.client.invalidateQueries({ queryKey, exact: true, refetchType: "none" });
    }
    if (signal.aborted || !ownsFamily()) throw abortedRead();
    const cancel = () => {
      if (ownsFamily()) void this.client.cancelQueries({ queryKey, exact: true });
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const result = await this.client.fetchQuery({
        queryKey,
        queryFn: async ({ signal: requestSignal }) => {
          const page = await getUnifiedAgents(query, { signal: requestSignal });
          if (!("state" in page)) assertUnexpired(page);
          return page;
        },
      });
      if (signal.aborted || !ownsFamily()) throw abortedRead();
      if ("state" in result) {
        this.removeFamily(family);
        return complete({ data: result });
      }
      assertUnexpired(result);
      let position = this.positions.get(key);
      const entries = this.client.getQueryCache().findAll({ queryKey: ["agent-inventory", principalKey, family] });
      if (position === undefined) {
        for (const entry of entries) {
          const page = entry.state.data as UnifiedAgentInventoryPage | undefined;
          const known = this.positions.get(hashKey(entry.queryKey));
          if (known === undefined || page?.selection.id !== result.selection.id) continue;
          if (query.cursor && page.page.nextCursor === query.cursor) { position = known + 1; break; }
          if (query.cursor && page.page.previousCursor === query.cursor) { position = known - 1; break; }
          const cursor = (entry.queryKey[3] as UnifiedAgentInventoryQuery).cursor;
          if (cursor && result.page.nextCursor === cursor) { position = known - 1; break; }
          if (cursor && result.page.previousCursor === cursor) { position = known + 1; break; }
        }
      }
      position ??= 0;
      this.positions.set(key, position);
      familyState.selectionId = result.selection.id;
      return complete({ data: result });
    } catch (error) {
      if (signal.aborted || !ownsFamily() || isCancelledError(error)) return complete({ error: abortedRead() });
      if (error instanceof ApiError && (error.status === 401 || error.status === 403
        || ["selection_invalidated", "inventory_changed"].includes(error.code))) this.clear();
      return complete({ error });
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  private retainPages(principalKey: string, family: string, familyState: InventoryFamily, key: string,
    result: UnifiedAgentInventoryPage) {
    const position = this.positions.get(key)!;
    for (const entry of this.client.getQueryCache().findAll({ queryKey: ["agent-inventory", principalKey, family] })) {
      const entryKey = hashKey(entry.queryKey);
      if (entryKey === key || familyState.requests.has(entryKey)) continue;
      const page = entry.state.data as UnifiedAgentInventoryPage | undefined;
      const other = this.positions.get(entryKey);
      if (page?.selection.id !== result.selection.id || other === undefined || other === position || Math.abs(other - position) > 1) {
        this.client.removeQueries({ queryKey: entry.queryKey, exact: true });
        this.positions.delete(entryKey);
      }
    }
    const retained = new Set(this.client.getQueryCache().getAll().map(entry => hashKey(entry.queryKey)));
    for (const old of this.positions.keys()) if (!retained.has(old)) this.positions.delete(old);
  }

  invalidateSelection(selectionId: string) {
    for (const [family, selected] of this.families) {
      if (selected.selectionId === selectionId) this.removeFamily(family);
    }
  }

  clear() {
    this.epoch++;
    this.client.clear();
    this.owner = undefined;
    this.families.clear();
    this.positions.clear();
  }
}

function familyKey(query: UnifiedAgentInventoryQuery) {
  const family = { ...query };
  delete family.cursor;
  delete family.selectionId;
  return hashKey([family]);
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

function assertUnexpired(page: UnifiedAgentInventoryPage) {
  if (expiry(page) <= Date.now()) {
    throw new AgentInventoryExpiredError();
  }
}

function abortedRead() {
  return new ApiError(0, "request_aborted", "The request was cancelled.", { kind: "aborted" });
}
