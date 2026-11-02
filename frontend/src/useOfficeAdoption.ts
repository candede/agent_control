import { useContext, useEffect, useEffectEvent, useRef, useState } from "react";
import { hashKey, useQuery } from "@tanstack/react-query";
import type { OfficeContext, OfficePage, OfficePerson, OfficeQuery } from "../../backend/src/types/officeAppAdoption";
import { ApiError } from "./api/client";
import { officeAdoption, type OfficePageRequest } from "./api/officeAppAdoption";
import { PublicationContext } from "./publicationContext";
import { useSavedQueryClient } from "./savedQueries";
import { useReportPrincipalScope } from "./useReportPage";
import { acceptSelectedRead, isExpiredSelection, selectedReadRemaining, useSelectedReadLease, withdrawsSelectedRead } from "./selectedRead";
import { useBrowserAvailability } from "./useBrowserAvailability";

export function validateOfficeContext(context: OfficeContext, query: OfficeQuery, startedAt: number, selectionId?: string) {
  acceptSelectedRead(context, startedAt);
  if (hashKey([context.query]) !== hashKey([query])
    || selectionId && context.selection.id !== selectionId
    || query.officeSnapshot && context.observation?.id !== query.officeSnapshot
    || query.officeBaseline && context.baseline?.id !== query.officeBaseline) {
    throw new ApiError(409, "selection_invalidated", "Office evidence does not match the requested observation and filters.");
  }
  return context;
}

export function useOfficeAdoption(query: OfficeQuery, revision: number, onRecover: (notice: string) => void) {
  const principal = useReportPrincipalScope(), client = useSavedQueryClient();
  const publication = useContext(PublicationContext), available = useBrowserAvailability();
  const publicationRevision = publication?.revisions?.users;
  const scope = hashKey([principal, query]);
  const [capture, setCapture] = useState({ scope, sequence: 0, selectionId: undefined as string | undefined });
  const current = capture.scope === scope ? capture : { scope, sequence: 0, selectionId: undefined };
  if (capture.scope !== scope) setCapture(current);
  const [rejected, setRejected] = useState<{ scope: string; error: Error }>();
  const key = ["saved", "office-context", scope, current.sequence, current.selectionId, revision];
  const read = useQuery<OfficeContext>({
    queryKey: key, gcTime: 0, staleTime: Infinity, structuralSharing: false, retry: false,
    placeholderData: (previous, old) => old?.queryKey[2] === scope ? previous : undefined,
    queryFn: async ({ signal }) => {
      const startedAt = performance.now();
      const result = await officeAdoption.context({ ...query, selectionId: current.selectionId }, signal);
      signal.throwIfAborted();
      return validateOfficeContext(result, query, startedAt, current.selectionId);
    },
  }, client);
  const active = useSelectedReadLease(read.data?.selection);
  const expired = Boolean(read.data && !active) || isExpiredSelection(read.error);
  const failure = rejected?.scope === scope ? rejected.error : read.error;
  const invalidated = Boolean(failure && withdrawsSelectedRead(failure));
  const data = invalidated ? undefined : read.data;
  const restart = () => {
    setRejected(undefined);
    setCapture({ scope, sequence: current.sequence + 1, selectionId: undefined });
  };
  const renew = useEffectEvent(restart);
  const recover = useEffectEvent(onRecover);
  const recovery = useRef<string | undefined>(undefined);
  useEffect(() => { recovery.current = undefined; }, [scope]);
  useEffect(() => {
    if (!failure || read.isFetching) return;
    const badPin = failure instanceof ApiError && (failure.code === "invalid_office_baseline"
      || failure.code === "selection_invalidated" && !isExpiredSelection(failure));
    if (badPin && (query.officeSnapshot || query.officeBaseline) && recovery.current !== scope) {
      recovery.current = scope;
      recover("The selected Office observation or baseline was corrected, removed, or is no longer retained. Showing Latest instead.");
    }
  }, [failure, query.officeBaseline, query.officeSnapshot, read.isFetching, scope]);
  const observed = useRef<{ scope: string; revision?: string; selection?: string } | undefined>(undefined);
  useEffect(() => {
    if (read.isFetching || invalidated) return;
    if (expired) {
      if (!available) return;
      let active = true;
      queueMicrotask(() => { if (active) renew(); });
      return () => { active = false; };
    }
    if (!data || read.isError) return;
    const prior = observed.current?.scope === scope ? observed.current : undefined;
    if (publicationRevision && prior?.revision !== publicationRevision) {
      observed.current = { scope, revision: publicationRevision, selection: data.selection.id };
      if (data.selection.publicationRevisions.users === publicationRevision) return;
      let active = true;
      queueMicrotask(() => { if (active) setCapture({ scope, sequence: current.sequence + 1,
        selectionId: query.officeSnapshot ? data.selection.id : undefined }); });
      return () => { active = false; };
    }
  }, [available, current.sequence, data, expired, invalidated, publicationRevision, query.officeSnapshot, read.isError, read.isFetching, scope]);
  const admit = useEffectEvent((context: OfficeContext) => publication?.admit(context.selection.publicationRevisions));
  useEffect(() => { if (data && !read.isPlaceholderData) admit(data); }, [data, read.isPlaceholderData]);
  return {
    context: data, query, scope, principal,
    loading: read.isFetching || expired && available, renewing: Boolean(data && (read.isFetching || expired && available)),
    error: failure, invalidated, leaseEnded: expired, data, restartable: true,
    restart, retry: () => { setRejected(undefined); void read.refetch(); },
    invalidateSelection: (error: Error) => {
      if (isExpiredSelection(error)) { restart(); return; }
      setRejected({ scope, error });
      void client.cancelQueries({ queryKey: ["saved", "office-context", scope] });
    },
    isCurrent: () => {
      const cached = client.getQueryState<OfficeContext>(key);
      return Boolean(data && !failure && !invalidated && !read.isPlaceholderData
        && cached?.status === "success" && cached.fetchStatus === "idle" && !cached.isInvalidated
        && cached.data === data && selectedReadRemaining(data.selection) > 0);
    },
  };
}
export type OfficeReadOwner = ReturnType<typeof useOfficeAdoption>;

function validateOfficePanelContext(context: OfficeContext, owner: OfficeReadOwner, startedAt: number, selectionId?: string) {
  validateOfficeContext(context, owner.query, startedAt, selectionId);
  if (context.observation?.id !== owner.context?.observation?.id || context.baseline?.id !== owner.context?.baseline?.id) {
    throw new ApiError(409, "selection_invalidated", "Office panels returned different observations.");
  }
}

export function useOfficeSummary(owner: OfficeReadOwner) {
  return useOfficeRead(owner, "summary", (query, signal) => officeAdoption.summary(query, signal));
}

function useOfficeRead<T extends { context: OfficeContext }>(
  owner: OfficeReadOwner, resource: string,
  load: (query: OfficePageRequest, signal: AbortSignal) => Promise<T>, paging: Omit<OfficePageRequest, keyof OfficeQuery | "selectionId"> = {},
  enabled = true,
) {
  const client = useSavedQueryClient(), context = owner.context;
  const selectionId = context?.selection.id;
  const key = ["saved", "office-read", owner.scope, selectionId, resource, paging, context?.selection.validatedAt];
  const read = useQuery<T>({
    queryKey: key, enabled: enabled && Boolean(context) && !owner.invalidated && !owner.leaseEnded,
    gcTime: 0, staleTime: Infinity, structuralSharing: false, retry: false,
    placeholderData: (previous, old) => old?.queryKey[2] === owner.scope && old.queryKey[4] === resource
      && previous?.context.observation?.id === context?.observation?.id ? previous : undefined,
    queryFn: async ({ signal }) => {
      const startedAt = performance.now();
      const result = await load({ ...owner.query, selectionId, ...paging }, signal);
      signal.throwIfAborted();
      validateOfficePanelContext(result.context, owner, startedAt, selectionId);
      return result;
    },
  }, client);
  const reject = useEffectEvent((error: Error) => owner.invalidateSelection(error));
  useEffect(() => {
    if (read.error && (isExpiredSelection(read.error) || withdrawsSelectedRead(read.error))) reject(read.error);
  }, [read.error]);
  const data = owner.invalidated || read.error && withdrawsSelectedRead(read.error) ? undefined : read.data;
  return {
    data, loading: enabled && (read.isFetching || owner.loading), error: read.error,
    invalidated: owner.invalidated, leaseEnded: owner.leaseEnded, renewing: owner.renewing,
    restartable: true, restart: owner.restart, retry: () => { void read.refetch(); },
    isCurrent: () => {
      const cached = client.getQueryState<T>(key);
      return enabled && owner.isCurrent() && Boolean(data && !read.isPlaceholderData && !read.error
        && cached?.status === "success" && cached.fetchStatus === "idle" && !cached.isInvalidated
        && cached.data === data && selectedReadRemaining(data.context.selection) > 0);
    },
  };
}

type PageResource = "groups" | "departments" | "history" | "facets" | "people";
export function useOfficePage<T>(owner: OfficeReadOwner, resource: PageResource, options: {
  groupId?: string; kind?: "company" | "department"; limit?: number; pageNumber?: number; enabled?: boolean;
} = {}) {
  const limit = options.limit ?? (resource === "groups" ? 5 : 50);
  const scope = hashKey([owner.principal, owner.query, resource, options.groupId, options.kind, limit]);
  const [lastPage, setLastPage] = useState<{ scope: string; data: OfficePage<T> }>();
  const selectionId = owner.context?.selection.id;
  const [navigation, setNavigation] = useState<{ scope: string; selectionId?: string; cursor?: string; number: number; anchor?: string; requestedPage?: number }>({
    scope, selectionId, number: options.pageNumber ?? 1, requestedPage: options.pageNumber,
  });
  let current = navigation;
  if (navigation.scope !== scope || navigation.selectionId !== selectionId || navigation.requestedPage !== options.pageNumber) {
    const sameScope = navigation.scope === scope;
    const number = options.pageNumber ?? (sameScope ? navigation.number : 1);
    current = sameScope && navigation.selectionId === selectionId && options.pageNumber === navigation.number
      ? { ...navigation, requestedPage: options.pageNumber }
      : { scope, selectionId, number, requestedPage: options.pageNumber,
      ...(resource === "groups" && sameScope && navigation.selectionId !== selectionId
        && lastPage?.scope === scope && (options.pageNumber === undefined || options.pageNumber === lastPage.data.page.number)
        ? { anchor: lastPage.data.page.anchor ?? undefined } : {}) };
    setNavigation(current);
  }
  const request = current.cursor ? { limit, cursor: current.cursor }
    : current.anchor ? { limit, anchor: current.anchor } : { limit, pageNumber: current.number };
  const read = useOfficeRead<OfficePage<T>>(owner, `${resource}:${options.groupId ?? options.kind ?? ""}`, async (query, signal) => {
    const result = resource === "people" ? await officeAdoption.people(options.groupId!, query, signal)
      : resource === "facets" ? await officeAdoption.facets(options.kind!, query, signal)
        : await officeAdoption[resource](query, signal);
    return result as OfficePage<T>;
  }, request, options.enabled !== false);
  if (read.data && !read.loading && !read.error && read.data.context.selection.id === selectionId && lastPage?.data !== read.data) {
    setLastPage({ scope, data: read.data });
  }
  const move = (pageNumber: number, cursor?: string | null) => {
    if (!read.isCurrent() || !read.data || !Number.isSafeInteger(pageNumber) || pageNumber < 1
      || pageNumber > Math.max(1, read.data.page.pages) || pageNumber === read.data.page.number) return false;
    setNavigation({ scope, number: pageNumber, cursor: cursor ?? undefined,
      selectionId, requestedPage: options.pageNumber });
    return true;
  };
  return { ...read, goToPage: (number: number) => move(number),
    next: () => move((read.data?.page.number ?? 1) + 1, read.data?.page.nextCursor),
    previous: () => move((read.data?.page.number ?? 1) - 1, read.data?.page.previousCursor) };
}

export function useOfficeHistory(owner: OfficeReadOwner) {
  const read = useOfficeRead(owner, "complete-history", async (query, signal) => {
    const points = [];
    let cursor: string | undefined, total: number | undefined;
    const seen = new Set<string>();
    const seenDates = new Set<string>();
    do {
      const startedAt = performance.now();
      const page = await officeAdoption.history({ ...query, limit: 100, cursor }, signal);
      signal.throwIfAborted();
      validateOfficePanelContext(page.context, owner, startedAt, query.selectionId);
      total ??= page.counts.filtered;
      if (page.counts.filtered !== total || points.length + page.value.length > total
        || page.value.some(point => point.observation.reportRefreshDate > (owner.context?.observation?.reportRefreshDate ?? ""))) {
        throw new ApiError(502, "invalid_response", "Office history pages are inconsistent.");
      }
      for (const point of page.value) {
        if (seen.has(point.observation.id) || seenDates.has(point.observation.reportRefreshDate)) {
          throw new ApiError(502, "invalid_response", "Office history pages are inconsistent.");
        }
        points.push(point);
        seen.add(point.observation.id);
        seenDates.add(point.observation.reportRefreshDate);
      }
      cursor = page.page.nextCursor ?? undefined;
      if (cursor && !page.value.length) throw new ApiError(502, "invalid_response", "Office history paging did not advance.");
    } while (cursor);
    if (points.length !== total) throw new ApiError(502, "invalid_response", "Office history is incomplete.");
    return { value: points, context: owner.context! };
  });
  return read;
}

export type AcceptedOfficePerson = {
  person: OfficePerson; observationId: string; principal: OfficeReadOwner["principal"]; query: OfficeQuery;
};

export function useOfficePerson(owner: OfficeReadOwner, groupId: string, identity: string, accepted?: AcceptedOfficePerson) {
  return useOfficeRead(owner, `person:${groupId}:${identity}`, async (query, signal) => {
    if (!/^[a-f0-9]{64}$/.test(groupId)) throw new ApiError(400, "invalid_office_query", "This Office person bookmark needs its saved group context.");
    const filters = { ...owner.query }, acceptedFilters = { ...accepted?.query };
    delete filters.officeSnapshot;
    delete acceptedFilters.officeSnapshot;
    if (accepted && hashKey([accepted.principal]) === hashKey([owner.principal])
      && hashKey([filters]) === hashKey([acceptedFilters])
      && accepted.observationId === owner.context?.observation?.id
      && accepted.person.identity === identity && accepted.person.groupId === groupId) {
      signal.throwIfAborted();
      return { value: accepted.person, context: owner.context! };
    }
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const startedAt = performance.now();
      const page = await officeAdoption.people(groupId, { ...query, limit: 100, cursor }, signal);
      signal.throwIfAborted();
      validateOfficePanelContext(page.context, owner, startedAt, query.selectionId);
      const person: OfficePerson | undefined = page.value.find(person => person.identity === identity);
      if (person) return { value: person, context: page.context };
      if (page.page.nextCursor && (!page.value.length || seen.has(page.page.nextCursor))) {
        throw new ApiError(502, "invalid_response", "Office person paging did not advance.");
      }
      cursor = page.page.nextCursor ?? undefined;
      if (cursor) seen.add(cursor);
    } while (cursor);
    throw new ApiError(404, "data_record_not_found", "This person does not belong to the selected Office observation and filters.");
  });
}
