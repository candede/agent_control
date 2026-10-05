import type pg from "pg";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { dataConnections } from "../db/dataConnections.js";
import { UserSourcesRepository, userSourceObjectIds, userSourcePeopleInRead } from "../db/userSources.js";
import type { DataSyncScope } from "../db/dataSync.js";
import type { SavedAgentPerson, UnifiedAgentRecord } from "../types/unifiedAgents.js";
import { isDirectoryObjectId } from "../types/copilotPackage.js";
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
    if (!ids.length) return new Map<string, SavedAgentPerson>();
    const read = async (client: pg.PoolClient) => {
      const boundary = (await client.query("SELECT current_setting('transaction_isolation') AS isolation,clock_timestamp() AS now")).rows[0];
      if (boundary.isolation !== "repeatable read") throw new Error("people_selected_snapshot_required");
      const selectedScope = { ...scope, tokenMode: "delegated" as const };
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
    if (records.length > 100) throw new AppError(400, "data_page_limit", "Project at most 100 caller records.");
    const ids = new Set<string>();
    for (const record of records) {
      const resource = record.powerPlatformResource;
      if (resource && resource.tenantId !== scope.tenantId) throw new AppError(403, "scope_mismatch", "Inventory belongs to another tenant.");
      for (const id of [resource?.createdBy, resource?.details.ownerId, resource?.details.lastModifiedBy]) {
        if (typeof id === "string" && isDirectoryObjectId(id)) ids.add(id.toLowerCase());
      }
    }
    const people = await this.readIds(scope, [...ids], database);
    return projectSavedAgentPeople(records, people);
  }
}
function projectSavedAgentPeople(records: readonly UnifiedAgentRecord[], people: ReadonlyMap<string, SavedAgentPerson>): UnifiedAgentRecord[] {
  if (records.length > 100) throw new AppError(400, "data_page_limit", "Project at most 100 caller records.");
  return records.map(record => {
    const { people: _previous, ...inventory } = record, resource = record.powerPlatformResource;
    const owner = people.get(resource?.details.ownerId?.toLowerCase() ?? "");
    const createdBy = people.get(resource?.createdBy?.toLowerCase() ?? "");
    const lastModifiedBy = people.get(resource?.details.lastModifiedBy?.toLowerCase() ?? "");
    return { ...inventory, ...(owner || createdBy || lastModifiedBy ? { people: {
      ...(owner ? { owner } : {}), ...(createdBy ? { createdBy } : {}), ...(lastModifiedBy ? { lastModifiedBy } : {}),
    } } : {}) };
  });
}
