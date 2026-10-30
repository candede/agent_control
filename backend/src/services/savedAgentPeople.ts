import type pg from "pg";
import { isProxy } from "node:util/types";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { dataConnections, isSelectedRead } from "../db/dataConnections.js";
import { UserSourcesRepository, agentPeopleRecordIds, projectAgentPeopleRecords, snapshotAgentPeopleRecords,
  userSourceObjectIds, userSourcePeopleInRead } from "../db/userSources.js";
import type { DataSyncScope } from "../db/dataSync.js";
import type { SavedAgentPerson, UnifiedAgentRecord } from "../types/unifiedAgents.js";
import { AppError } from "../errors.js";

export class SavedAgentPeopleService {
  private readonly sources: UserSourcesRepository;
  constructor(private readonly database: pg.Pool = pool) {
    this.sources = new UserSourcesRepository(database, config.sessionSecret);
  }
  async read(scope: DataSyncScope, ids: readonly string[], database?: pg.PoolClient): Promise<Map<string, SavedAgentPerson>> {
    return this.readIds(scope, userSourceObjectIds(ids), database);
  }
  private async readIds(scope: DataSyncScope, ids: readonly string[], database?: pg.PoolClient): Promise<Map<string, SavedAgentPerson>> {
    const selectedScope = peopleScope(scope);
    if (!ids.length) return new Map<string, SavedAgentPerson>();
    const read = async (client: pg.PoolClient) => {
      if (!isSelectedRead(client)) throw new Error("people_selected_snapshot_required");
      const boundary = (await client.query("SELECT current_setting('transaction_isolation') AS isolation,clock_timestamp() AS now")).rows[0];
      if (boundary.isolation !== "repeatable read") throw new Error("people_selected_snapshot_required");
      const source = (await this.sources.metadataInRead(client, selectedScope, boundary.now)).directory;
      const directory = source.generationId ? { generationId: source.generationId, observedAt: new Date(source.observedAt!) } : null;
      const people = new Map<string, SavedAgentPerson>();
      for (let offset = 0; offset < ids.length; offset += 100) {
        for (const person of await userSourcePeopleInRead(client, selectedScope, directory, ids.slice(offset, offset + 100), boundary.now)) {
          people.set(person.objectId, person);
        }
      }
      return people;
    };
    return database ? read(database) : dataConnections(this.database).selectedRead(read);
  }
  async project(scope: DataSyncScope, records: readonly UnifiedAgentRecord[], database?: pg.PoolClient): Promise<UnifiedAgentRecord[]> {
    const selectedScope = peopleScope(scope);
    const snapshot = snapshotAgentPeopleRecords(records, selectedScope.tenantId);
    const people = await this.readIds(selectedScope, agentPeopleRecordIds(snapshot), database);
    return projectAgentPeopleRecords(snapshot, people);
  }
}
function peopleScope(scope: DataSyncScope) {
  const invalid = () => new AppError(403, "scope_mismatch", "Saved people require an authenticated tenant and principal.");
  if (isProxy(scope) || !scope || typeof scope !== "object"
    || Object.getPrototypeOf(scope) !== Object.prototype && Object.getPrototypeOf(scope) !== null) throw invalid();
  const field = (key: "tenantId" | "principalId", maximum: number) => {
    const property = Object.getOwnPropertyDescriptor(scope, key), value: unknown = property?.value;
    if (!property || !Object.hasOwn(property, "value") || typeof value !== "string" || !value.trim()
      || value.length > maximum || /[\p{Cc}\p{Cs}]/u.test(value)) throw invalid();
    return value;
  };
  return { tenantId: field("tenantId", 512), principalId: field("principalId", 1024) };
}
