import { useEffect, useEffectEvent, useState } from "react";
import type { AdoptionHistoryPage, AdoptionSnapshot } from "../../backend/src/types/adoptionDashboard";
import { useReportPage, useReportPrincipalScope } from "./useReportPage";
import { isExpiredSelection } from "./selectedRead";

type Collection = { owner: string; selectionId?: string; pages: AdoptionHistoryPage[] };

export function useAdoptionHistory(revision: number) {
  const read = useReportPage<AdoptionSnapshot, AdoptionHistoryPage>("official-usage/history/adoption", { limit: 100 }, revision);
  const scope = useReportPrincipalScope();
  const historyScope = JSON.stringify([scope, revision]);
  const owner = JSON.stringify([scope, revision, read.selectionRevision]);
  const [collected, setCollected] = useState<Collection>({ owner, pages: [] });
  const [completed, setCompleted] = useState<{ scope: string; collection: Collection }>();
  let current = collected.owner === owner ? collected : { owner, pages: [] };
  const data = read.data;
  if (data && !read.loading && !read.error && !read.leaseEnded) {
    if (current.selectionId !== data.selection.id) current = { owner, selectionId: data.selection.id, pages: [] };
    const index = current.pages.findIndex(page => page.page.previousCursor === data.page.previousCursor);
    if (index < 0 || current.pages[index] !== data) {
      const pages = [...current.pages];
      if (index < 0) pages.push(data);
      else pages[index] = data;
      current = { ...current, pages };
    }
  }
  if (current !== collected) setCollected(current);
  const snapshots = current.pages.flatMap(page => page.value);
  const total = current.pages[0]?.counts.filtered ?? 0;
  const inconsistent = current.pages.some(page => page.counts.filtered !== total)
    || new Set(snapshots.map(snapshot => snapshot.id)).size !== snapshots.length
    || snapshots.length > total
    || Boolean(data && !read.loading && !read.error && !data.page.nextCursor && snapshots.length !== total);
  const issue = inconsistent ? new Error("Saved report history is inconsistent. Reload the history before comparing adoption.") : null;
  const advance = useEffectEvent(() => read.next());
  useEffect(() => {
    if (data?.page.nextCursor && !read.loading && !read.error && !read.leaseEnded && !inconsistent) advance();
  }, [data, read.loading, read.error, read.leaseEnded, inconsistent]);
  const complete = Boolean(data && !data.page.nextCursor && !read.loading && !read.error && !read.leaseEnded && !issue
    && snapshots.length === total);
  const rejected = issue || read.invalidated || read.error && !isExpiredSelection(read.error);
  if (complete && completed?.collection !== current) setCompleted({ scope: historyScope, collection: current });
  else if (completed && (rejected || completed.scope !== historyScope)) setCompleted(undefined);
  const retained = !rejected && completed?.scope === historyScope ? completed.collection : undefined;
  return {
    read: issue ? { ...read, error: issue, retry: read.restart } : read,
    snapshots: complete ? snapshots : retained?.pages.flatMap(page => page.value),
    loaded: snapshots.length,
    total,
  };
}
