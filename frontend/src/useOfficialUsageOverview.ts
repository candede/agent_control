import { useMemo } from "react";
import { getOfficialUsageOverview, type OfficialUsageOverviewQuery, type OfficialUsageOverviewView } from "./api/client";
import { useSavedQuery } from "./savedQueries";

export function useOfficialUsageOverview({
  search, startDate, endDate, sortBy = "lastActivity", sortDirection = "desc", limit = 25, offset = 0,
}: OfficialUsageOverviewQuery, revision: number) {
  const query = useMemo<OfficialUsageOverviewQuery>(() => (
    { search, startDate, endDate, sortBy, sortDirection, limit, offset }
  ), [search, startDate, endDate, sortBy, sortDirection, limit, offset]);
  const validation = startDate && endDate && startDate > endDate
    ? "The activity start date must be on or before the end date." : undefined;
  const read = useSavedQuery<OfficialUsageOverviewView>({
    queryKey: ["saved", "official-usage-overview", query, revision],
    queryFn: ({ signal }) => getOfficialUsageOverview(query, { signal }),
    enabled: !validation,
  });

  return {
    data: validation || read.isFetching || read.isError ? undefined : read.data,
    error: validation ?? (read.error instanceof Error ? read.error.message
      : read.error ? "Retained agent activity could not be loaded." : undefined),
    loading: !validation && (read.isPending || read.isFetching),
    retry: () => { if (!validation) void read.refetch(); },
  };
}
