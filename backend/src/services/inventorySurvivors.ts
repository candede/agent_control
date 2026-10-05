import { powerPlatformAgentKey } from "./inventoryIdentity.js";

type Source = { source: "graph_packages" | "power_platform"; normalized_environment_id: string; normalized_native_id: string };

export function sourceKey(value: Source) {
  return value.source === "power_platform"
    ? JSON.stringify([value.source, powerPlatformAgentKey(value.normalized_environment_id, value.normalized_native_id)])
    : JSON.stringify([value.source, value.normalized_environment_id, value.normalized_native_id]);
}

export function assignSurvivors(groups: readonly { index: number; sources: readonly Source[] }[],
  existing: readonly (Source & { agent_id: string })[], previous: ReadonlyMap<string, string>) {
  const candidates = new Map<string, number[]>();
  for (const group of groups) {
    for (const agentId of new Set(group.sources.flatMap(source => {
      const id = previous.get(sourceKey(source));
      return id ? [id] : [];
    }))) {
      const choices = candidates.get(agentId) ?? [];
      choices.push(group.index);
      candidates.set(agentId, choices);
    }
  }
  const groupOwners = new Map<number, string>();
  const agentGroups = new Map<string, number>();
  // Oldest-first augmenting paths preserve the most UUIDs through simultaneous merges and splits.
  for (const agentId of new Set(existing.map(source => source.agent_id))) {
    const queue = [agentId], visited = new Set<string>(queue), paths = new Map<number, string>();
    let freeGroup: number | undefined;
    for (let offset = 0; offset < queue.length && freeGroup === undefined; offset++) {
      const candidate = queue[offset];
      for (const group of candidates.get(candidate) ?? []) {
        if (paths.has(group)) continue;
        paths.set(group, candidate);
        const owner = groupOwners.get(group);
        if (!owner) { freeGroup = group; break; }
        if (!visited.has(owner)) { visited.add(owner); queue.push(owner); }
      }
    }
    while (freeGroup !== undefined) {
      const owner = paths.get(freeGroup);
      if (!owner) throw new Error("Canonical survivor assignment lost its membership path.");
      const previousGroup = agentGroups.get(owner);
      groupOwners.set(freeGroup, owner);
      agentGroups.set(owner, freeGroup);
      freeGroup = previousGroup;
    }
  }
  return groupOwners;
}
