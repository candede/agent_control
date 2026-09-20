import { isCancelledError, QueryClient } from "@tanstack/react-query";
import { ApiError, getUnifiedAgents, type UnifiedAgentInventoryPage, type UnifiedAgentInventoryQuery } from "./api/client";

export class AgentInventoryQueries {
  private readonly client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 30_000, gcTime: 60_000, networkMode: "always" },
    },
  });

  async read(principalKey: string, query: UnifiedAgentInventoryQuery, signal: AbortSignal) {
    if (signal.aborted) throw abortedRead();
    const queryKey = ["agent-inventory", principalKey, query] as const;
    const cached = this.client.getQueryData<UnifiedAgentInventoryPage>(queryKey);
    if (cached && expiry(cached) <= Date.now()) {
      await this.client.invalidateQueries({ queryKey, exact: true, refetchType: "none" });
    }
    if (signal.aborted) throw abortedRead();
    const cancel = () => { void this.client.cancelQueries({ queryKey, exact: true }); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      return await this.client.fetchQuery({
        queryKey,
        queryFn: async ({ signal: requestSignal }) => {
          const page = await getUnifiedAgents(query, { signal: requestSignal });
          expiry(page);
          return page;
        },
      });
    } catch (error) {
      if (signal.aborted || isCancelledError(error)) throw abortedRead();
      throw error;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  clear() {
    this.client.clear();
  }
}

function expiry(page: UnifiedAgentInventoryPage) {
  const timestamps = [
    page.sources.graphPackages.observation?.expiresAt,
    page.sources.powerPlatform.observation?.expiresAt,
    page.usageContext?.reportSet?.expiresAt,
    page.usageContext?.expiresAt,
    ...page.value.flatMap(record => [
      record.observations.graphPackages?.expiresAt,
      record.observations.powerPlatform?.expiresAt,
      ...Object.values(record.observations.packageSnapshots).flatMap(observation => [observation.expiresAt, observation.identityDetails?.expiresAt]),
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
