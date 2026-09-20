import { useEffect, useMemo, useState } from "react";
import { getOfficialUsageOverview, type OfficialUsageOverviewQuery, type OfficialUsageOverviewView } from "./api/client";

type ReadState = { key: object; value: OfficialUsageOverviewView } | { key: object; error: string };

export function useOfficialUsageOverview({
  search, startDate, endDate, sortBy = "lastActivity", sortDirection = "desc", limit = 25, offset = 0,
}: OfficialUsageOverviewQuery, revision: number) {
  const [read, setRead] = useState<ReadState>();
  const [attempt, setAttempt] = useState(0);
  const key = useMemo(() => ({
    query: { search, startDate, endDate, sortBy, sortDirection, limit, offset }, revision, attempt,
  }), [search, startDate, endDate, sortBy, sortDirection, limit, offset, revision, attempt]);
  const validation = startDate && endDate && startDate > endDate
    ? "The activity start date must be on or before the end date." : undefined;
  const scoped = read?.key === key ? read : undefined;

  useEffect(() => {
    if (validation) return;
    const controller = new AbortController();
    void getOfficialUsageOverview(key.query, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setRead({ key, value });
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setRead({
        key, error: failure instanceof Error ? failure.message : "Retained agent activity could not be loaded.",
      });
    });
    return () => controller.abort();
  }, [key, validation]);

  return {
    data: !validation && scoped && "value" in scoped ? scoped.value : undefined,
    error: validation ?? (scoped && "error" in scoped ? scoped.error : undefined),
    loading: !validation && !scoped,
    retry: () => setAttempt(value => value + 1),
  };
}
