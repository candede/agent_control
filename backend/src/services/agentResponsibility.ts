import { AppError } from "../errors.js";
import { isDirectoryObjectId } from "../types/copilotPackage.js";
import { responsibilityRoles, type AgentResponsibilityPage, type AgentResponsibilityQuery,
  type ResponsibilityAgent, type ResponsibilityPerson } from "../types/agentResponsibility.js";
import type { SavedAgentPerson, UnifiedAgentInventoryPage } from "../types/unifiedAgents.js";

export function projectAgentResponsibility(inventory: UnifiedAgentInventoryPage, query: AgentResponsibilityQuery,
  selectedEvidence?: SavedAgentPerson): AgentResponsibilityPage {
  if (inventory.value.length !== inventory.count || !inventory.revision) {
    throw new AppError(409, "responsibility_inventory_incomplete", "Responsibility requires the complete authorized saved agent inventory.");
  }
  const people = new Map<string, ResponsibilityPerson>();
  const relationships = new Map<string, ResponsibilityAgent[]>();
  let unknownAgentCount = 0;
  let invalidReferenceCount = 0;
  for (const record of inventory.value) {
    const resource = record.powerPlatformResource;
    const ids = { owner: resource?.details.ownerId, createdBy: resource?.createdBy, lastModifiedBy: resource?.details.lastModifiedBy };
    if (responsibilityRoles.some(role => !ids[role] || !isDirectoryObjectId(ids[role]!))) unknownAgentCount++;
    const rolesByPerson = new Map<string, ResponsibilityAgent["roles"]>();
    for (const role of responsibilityRoles) {
      const id = ids[role];
      if (!id) continue;
      if (!isDirectoryObjectId(id)) { invalidReferenceCount++; continue; }
      const objectId = id.toLowerCase();
      const roles = rolesByPerson.get(objectId) ?? [];
      roles.push(role);
      rolesByPerson.set(objectId, roles);
      const evidence = record.people?.[role];
      if (!people.has(objectId)) people.set(objectId, {
        objectId, evidence: evidence?.objectId.toLowerCase() === objectId ? evidence : null, agentCount: 0, roles: [],
      });
    }
    for (const [objectId, roles] of rolesByPerson) {
      const person = people.get(objectId)!;
      person.agentCount++;
      person.roles = responsibilityRoles.filter(role => person.roles.includes(role) || roles.includes(role));
      const agents = relationships.get(objectId) ?? [];
      agents.push({ id: record.id, displayName: record.displayName, presence: record.presence,
        environmentId: record.environmentId, roles, observedAt: record.observations.powerPlatform!.observedAt });
      relationships.set(objectId, agents);
    }
  }
  const source = inventory.sources.powerPlatform;
  const coverage = source.state === "unavailable" ? "unavailable"
    : source.state === "partial" || unknownAgentCount > 0 ? "partial" : "available";
  const offset = Math.max(0, query.offset ?? 0);
  const limit = Math.min(100, Math.max(1, query.limit ?? 50));
  const search = query.search?.trim().toLocaleLowerCase("en-US") ?? "";
  const sorted = [...people.values()].filter(person => !search || [
    person.objectId, person.evidence?.displayName, person.evidence?.userPrincipalName,
  ].some(value => value?.toLocaleLowerCase("en-US").includes(search))).sort((a, b) =>
    (a.evidence?.displayName ?? a.objectId).localeCompare(b.evidence?.displayName ?? b.objectId) || a.objectId.localeCompare(b.objectId));
  const objectId = query.objectId?.toLowerCase();
  let selected: AgentResponsibilityPage["selected"] = null;
  if (objectId) {
    const person = people.get(objectId) ?? (selectedEvidence?.objectId.toLowerCase() === objectId
      ? { objectId, evidence: selectedEvidence, agentCount: 0, roles: [] } : undefined);
    if (!person) throw new AppError(404, "responsibility_person_unavailable", "No authorized saved responsibility or directory evidence exists for this exact user. Reload Users or Sync.");
    const agents = (relationships.get(objectId) ?? []).sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id));
    selected = { person, state: coverage === "unavailable" ? "unavailable" : agents.length ? "reported" : "no_reported_relationships",
      agents: agents.slice(offset, offset + limit), count: agents.length };
  }
  return { revision: inventory.revision, sources: inventory.sources, coverage, unknownAgentCount, invalidReferenceCount,
    people: objectId ? [] : sorted.slice(offset, offset + limit), count: sorted.length, offset, limit, selected };
}
