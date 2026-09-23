import type pg from "pg";
import { DataSyncRepository, type DataSyncScope, type SavedCopilotUsageSource } from "../db/dataSync.js";
import { AppError } from "../errors.js";
import type { SavedAgentPerson, UnifiedAgentRecord } from "../types/unifiedAgents.js";
import { AgentPeopleRepository } from "../db/agentPeople.js";
import { isDirectoryObjectId } from "../types/copilotPackage.js";
import { isCopilotServiceSummaryState } from "../types/copilotUsage.js";

export class SavedAgentPeopleService {
  constructor(
    private readonly repository: Pick<DataSyncRepository, "getDirectorySource"> = new DataSyncRepository(),
    private readonly cache: Pick<AgentPeopleRepository, "read"> = new AgentPeopleRepository(),
  ) {}

  async project(scope: DataSyncScope, records: readonly UnifiedAgentRecord[], database?: pg.PoolClient): Promise<UnifiedAgentRecord[]> {
    const ids = [...new Set(records.flatMap(record => [
      record.powerPlatformResource?.createdBy, record.powerPlatformResource?.details.ownerId,
      record.powerPlatformResource?.details.lastModifiedBy,
    ]).filter((id): id is string => typeof id === "string" && isDirectoryObjectId(id)).map(id => id.toLowerCase()))];
    const people = await this.read(scope, ids, database);
    return records.map(record => {
      const resource = record.powerPlatformResource;
      if (resource && resource.tenantId !== scope.tenantId) {
        throw new AppError(403, "scope_mismatch", "Saved agent people require inventory from the same tenant.");
      }
      const { people: _previousPeople, ...inventory } = record;
      const lookup = (id: string | null | undefined) => {
        const key = objectId(id);
        return key ? people.get(key) : undefined;
      };
      const owner = lookup(resource?.details.ownerId);
      const createdBy = lookup(resource?.createdBy);
      const lastModifiedBy = lookup(resource?.details.lastModifiedBy);
      return {
        ...inventory,
        ...(owner || createdBy || lastModifiedBy ? { people: {
          ...(owner ? { owner } : {}),
          ...(createdBy ? { createdBy } : {}),
          ...(lastModifiedBy ? { lastModifiedBy } : {}),
        } } : {}),
      };
    });
  }

  async read(scope: DataSyncScope, ids: readonly string[], database?: pg.PoolClient): Promise<Map<string, SavedAgentPerson>> {
    const source = await this.repository.getDirectorySource(scope, database);
    const people = directoryPeople(source);
    for (const { lastConclusiveAt, ...cached } of await this.cache.read(scope, ids, database)) {
      const saved = people.get(cached.objectId);
      if (saved && Date.parse(saved.observedAt) > Date.parse(cached.checkedAt ?? cached.observedAt)) continue;
      const identity = cached.status === "lookup_failed" && saved
        && (lastConclusiveAt === null || Date.parse(saved.observedAt) > Date.parse(lastConclusiveAt)) ? saved : cached;
      people.set(cached.objectId, { ...identity, status: cached.status, checkedAt: cached.checkedAt,
        expiresAt: cached.expiresAt, ...(cached.errorCode ? { errorCode: cached.errorCode } : {}) });
    }
    return new Map(ids.flatMap(id => {
      const person = people.get(id.toLowerCase());
      return person ? [[id.toLowerCase(), person]] : [];
    }));
  }
}

export const savedAgentPeople = new SavedAgentPeopleService();

export function directoryPeople(source: SavedCopilotUsageSource<unknown>): Map<string, SavedAgentPerson> {
  if (source.source !== "directory") throw invalidDirectory();
  if (source.value === null && source.observedAt === null) return new Map();
  if (!source.observedAt || !Number.isFinite(Date.parse(source.observedAt)) || !Array.isArray(source.value)) throw invalidDirectory();
  if (source.value.length > 100_000 || Buffer.byteLength(JSON.stringify(source.value), "utf8") > 32 * 1024 * 1024) {
    throw new AppError(413, "copilot_usage_snapshot_limit", "Saved directory data exceeded the bounded snapshot limit.");
  }
  if (source.rowCount !== source.value.length) throw invalidDirectory();
  const people = new Map<string, SavedAgentPerson>();
  for (const row of source.value) {
    if (!isObject(row) || !isObject(row.identity) || !Array.isArray(row.servicePlans)
      || row.serviceEvidenceVersion !== 1 || !isCopilotServiceSummaryState(row.copilotServiceState)) throw invalidDirectory();
    const identity = row.identity;
    const { displayName, userPrincipalName } = identity;
    const id = objectId(identity.objectId);
    if (!id || people.has(id) || !text(userPrincipalName, 320)
      || (displayName !== null && !text(displayName, 512))) throw invalidDirectory();
    people.set(id, {
      objectId: id,
      displayName,
      userPrincipalName,
      observedAt: source.observedAt,
    });
  }
  return people;
}

function objectId(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : null;
}

function text(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= maximumLength && !/[\r\n\0]/.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidDirectory() {
  return new AppError(409, "copilot_usage_snapshot_invalid", "Saved directory data is invalid or ambiguous. Refresh Users before retrying agent inventory.");
}
