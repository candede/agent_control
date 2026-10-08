import { useContext, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { hasAppRole } from "../../backend/src/types/capability";
import { isDirectoryObjectId } from "../../backend/src/types/copilotPackage";
import { resolveAgentPeople, type AppRole, type UnifiedAgentRecord } from "./api/client";
import { CapabilityContext } from "./capabilityContext";
import { capabilityExplanation, providerActionAllowed } from "./capabilityState";

const personFields = ["owner", "createdBy", "lastModifiedBy"] as const;
type PersonField = typeof personFields[number];
type SavedPeople = UnifiedAgentRecord["people"];
export type AgentPerson = {
  id: string;
  displayName?: string;
  address?: string;
  observedAt?: string;
  checkedAt?: string;
  expiresAt?: string;
  status: "resolved" | "not_found" | "lookup_failed" | "unverified";
  expired?: boolean;
  invalidId?: boolean;
};
type PeopleRead = { key: string; error?: string };

export function useAgentPeople(record: UnifiedAgentRecord, roles: AppRole[], onPeopleChanged?: () => void) {
  const capabilities = useContext(CapabilityContext);
  const [localNow, setLocalNow] = useState(Date.now);
  const now = Math.max(localNow, capabilities?.now ?? 0);
  const directory = capabilities?.views.find(view => view.definition.id === "graph.directory.read");
  const canRead = hasAppRole(roles, "AgentControl.Viewer");
  const canLookup = Boolean(canRead && providerActionAllowed(directory, false, now));
  const resource = record.powerPlatformResource;
  const identifiers = {
    owner: resource?.details.ownerId?.trim(),
    createdBy: resource?.createdBy?.trim(),
    lastModifiedBy: resource?.details.lastModifiedBy?.trim(),
  };
  const scope = JSON.stringify([
    capabilities?.user?.tenantId, capabilities?.user?.homeAccountId, [...roles].sort(),
    record.id, resource?.tenantId, record.observations.powerPlatform?.snapshotId,
    ...personFields.map(field => identifiers[field]?.toLowerCase()),
  ]);
  const fingerprint = JSON.stringify(personFields.map(field => {
    const person = record.people?.[field];
    return person ? [person.objectId.toLowerCase(), person.displayName, person.userPrincipalName, person.observedAt,
      person.status, person.checkedAt, person.expiresAt, person.errorCode] : null;
  }));
  const evidenceKey = JSON.stringify([scope, fingerprint]);
  const [attempt, setAttempt] = useState<{ key: string; count: number }>();
  const [read, setRead] = useState<PeopleRead>();
  const [persisted, setPersisted] = useState<{ key: string; value: SavedPeople }>();
  const [owner, setOwner] = useState({ key: evidenceKey, canLookup });
  if (owner.key !== evidenceKey || owner.canLookup !== canLookup) {
    setOwner({ key: evidenceKey, canLookup });
    if (owner.key !== evidenceKey || !canLookup) {
      setAttempt(undefined);
      setRead(undefined);
    }
    if (owner.key !== evidenceKey) setPersisted(undefined);
  }
  const activeOwner = useRef<typeof owner | undefined>(undefined);
  useLayoutEffect(() => {
    activeOwner.current = owner;
    return () => { activeOwner.current = undefined; };
  }, [owner]);
  const attemptCount = attempt?.key === evidenceKey ? attempt.count : 0;
  const saved = canRead ? record.people : undefined;
  const returned = canRead && persisted?.key === evidenceKey ? persisted : undefined;
  const current = returned ? returned.value : saved;
  const nextExpiry = Object.values(current ?? {}).map(person => Date.parse(person?.expiresAt ?? ""))
    .filter(expiry => Number.isFinite(expiry) && expiry > now).sort((left, right) => left - right)[0];
  useEffect(() => {
    if (nextExpiry === undefined) return;
    const updateClock = () => setLocalNow(Date.now());
    const timer = window.setTimeout(updateClock, Math.min(Math.max(nextExpiry - Date.now(), 0), 2_147_483_647));
    window.addEventListener("focus", updateClock);
    document.addEventListener("visibilitychange", updateClock);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", updateClock);
      document.removeEventListener("visibilitychange", updateClock);
    };
  }, [nextExpiry, now]);
  const people: Partial<Record<PersonField, AgentPerson>> = {};
  for (const field of personFields) {
    const id = identifiers[field];
    if (!id) continue;
    const candidate = current?.[field];
    const person = candidate?.objectId.toLowerCase() === id.toLowerCase() ? candidate : undefined;
    people[field] = {
      id, invalidId: !isDirectoryObjectId(id),
      status: person?.status ?? (person ? "resolved" : "unverified"),
      ...(person ? {
        displayName: person.displayName ?? undefined,
        address: person.userPrincipalName ?? undefined,
        observedAt: person.observedAt,
        checkedAt: person.checkedAt,
        expiresAt: person.expiresAt,
        expired: person.expiresAt !== undefined && !(Date.parse(person.expiresAt) > now),
      } : {}),
    };
  }
  const canRetry = canLookup && Object.values(people).some(person =>
    !person.invalidId && (person.status !== "resolved" || person.expired));
  const requestKey = JSON.stringify([evidenceKey, attemptCount]);
  const scoped = read?.key === requestKey ? read : undefined;
  const onChanged = useEffectEvent(() => onPeopleChanged?.());
  const ownsRequest = useEffectEvent((key: string) => key === requestKey && canLookup);
  const startLookup = useEffectEvent((signal: AbortSignal) => {
    if (!canLookup || scoped || attemptCount === 0) return;
    void resolveAgentPeople(record.id, { signal, force: true })
      .then(response => {
        if (signal.aborted || !ownsRequest(requestKey)) return;
        if (Object.entries(response.people ?? {}).some(([field, person]) => !personFields.includes(field as PersonField)
          || !person || !identifiers[field as PersonField]
          || person.objectId.toLowerCase() !== identifiers[field as PersonField]?.toLowerCase())) {
          throw new Error("Directory lookup did not return the requested agent's person identities.");
        }
        setPersisted({ key: evidenceKey, value: response.people });
        setRead({ key: requestKey });
        if (response.changed) onChanged();
      })
      .catch((failure: unknown) => {
        if (!signal.aborted && ownsRequest(requestKey)) setRead({
          key: requestKey,
          error: failure instanceof Error ? failure.message : "Agent people could not be resolved.",
        });
      });
  });

  useEffect(() => {
    const controller = new AbortController();
    startLookup(controller.signal);
    return () => controller.abort();
  }, [requestKey, canLookup]);

  const loading = canLookup && attemptCount > 0 && !scoped;
  const retryAllowed = (canRetry || Boolean(scoped?.error) && canLookup) && !loading;
  const needsAttention = Object.values(people).some(person => person.status !== "resolved" || person.expired);
  return {
    people,
    loading,
    error: scoped?.error,
    unavailable: needsAttention && !canLookup
      ? `Directory lookup is unavailable; saved evidence is retained and unverified people are shown by ID. ${directory && canRead
        ? capabilityExplanation(directory, now) : "Directory lookup is not currently available."}` : undefined,
    canRetry: retryAllowed,
    retry: () => {
      if (activeOwner.current !== owner || !retryAllowed) return;
      setAttempt(current => current?.key === evidenceKey && current.count !== attemptCount
        ? current : { key: evidenceKey, count: attemptCount + 1 });
    },
  };
}
