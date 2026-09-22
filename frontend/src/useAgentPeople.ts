import { useContext, useEffect, useEffectEvent, useState } from "react";
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
  status: "resolved" | "not_found" | "lookup_failed" | "unverified";
  expired?: boolean;
  invalidId?: boolean;
};
type PeopleRead = { key: string; evidenceKey: string; attemptCount: number; error?: string };

export function useAgentPeople(record: UnifiedAgentRecord, roles: AppRole[], onPeopleChanged?: () => void) {
  const capabilities = useContext(CapabilityContext);
  const [initialNow] = useState(Date.now);
  const directory = capabilities?.views.find(view => view.definition.id === "graph.directory.read");
  const canRead = hasAppRole(roles, "AgentControl.Viewer");
  const canLookup = Boolean(canRead && providerActionAllowed(directory, false, capabilities?.now));
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
  const now = capabilities?.now ?? initialNow;
  const fingerprint = JSON.stringify(personFields.map(field => record.people?.[field]));
  const evidenceKey = JSON.stringify([scope, fingerprint]);
  const [attempt, setAttempt] = useState<{ key: string; count: number }>();
  const [read, setRead] = useState<PeopleRead>();
  const [persisted, setPersisted] = useState<{ key: string; value: SavedPeople }>();
  const attemptCount = attempt?.key === evidenceKey ? attempt.count : 0;
  const saved = canRead ? record.people : undefined;
  const returned = canRead && persisted?.key === evidenceKey ? persisted : undefined;
  const current = returned ? returned.value : saved;
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
        expired: person.expiresAt !== undefined && !(Date.parse(person.expiresAt) > now),
      } : {}),
    };
  }
  const needsLookup = Object.values(people).some(person =>
    !person.invalidId && (person.status === "unverified" && !returned || person.expired));
  const canRetry = canLookup && Object.values(people).some(person =>
    !person.invalidId && (person.status !== "resolved" || person.expired));
  const requestKey = JSON.stringify([evidenceKey, attemptCount, ...personFields.map(field => Boolean(people[field]?.expired))]);
  const scoped = read?.key === requestKey ? read : undefined;
  // A completed explicit retry must not turn later expiry/permission changes into forced retries.
  const force = attemptCount > 0 && !(read?.evidenceKey === evidenceKey && read.attemptCount === attemptCount);
  const onChanged = useEffectEvent(() => onPeopleChanged?.());
  const ownsRequest = useEffectEvent((key: string) => key === requestKey && canLookup);
  const startLookup = useEffectEvent((signal: AbortSignal) => {
    if (!canLookup || scoped || (!needsLookup && !force)) return;
    void resolveAgentPeople(record.id, { signal, ...(force ? { force: true } : {}) })
      .then(response => {
        if (signal.aborted || !ownsRequest(requestKey)) return;
        if (Object.entries(response.people ?? {}).some(([field, person]) => !personFields.includes(field as PersonField)
          || !person || !identifiers[field as PersonField]
          || person.objectId.toLowerCase() !== identifiers[field as PersonField]?.toLowerCase())) {
          throw new Error("Directory lookup did not return the requested agent's person identities.");
        }
        setPersisted({ key: evidenceKey, value: response.people });
        setRead({ key: requestKey, evidenceKey, attemptCount });
        if (response.changed) onChanged();
      })
      .catch((failure: unknown) => {
        if (!signal.aborted && ownsRequest(requestKey)) setRead({
          key: requestKey, evidenceKey, attemptCount,
          error: failure instanceof Error ? failure.message : "Agent people could not be resolved.",
        });
      });
  });

  useEffect(() => {
    const controller = new AbortController();
    startLookup(controller.signal);
    return () => controller.abort();
  }, [requestKey, canLookup]);

  const loading = canLookup && (needsLookup || force) && !scoped;
  const needsAttention = Object.values(people).some(person => person.status !== "resolved" || person.expired);
  return {
    people,
    loading,
    error: scoped?.error,
    unavailable: needsAttention && !canLookup
      ? `Directory lookup is unavailable; saved evidence is retained and unverified people are shown by ID. ${directory && canRead
        ? capabilityExplanation(directory, capabilities?.now) : "Directory lookup is not currently available."}` : undefined,
    canRetry: (canRetry || Boolean(scoped?.error) && canLookup) && !loading,
    retry: () => setAttempt({ key: evidenceKey, count: attemptCount + 1 }),
  };
}
