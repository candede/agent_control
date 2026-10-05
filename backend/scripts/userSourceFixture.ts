import type pg from "pg";
import { encodeBatch } from "../src/db/dataBounds.js";
import { UserSourceStages } from "../src/db/userSourceStages.js";
import type { SelectionIdentity } from "../src/services/dataSelections.js";
import type { CopilotDirectoryUser } from "../src/types/copilotUsage.js";
import { generationInput } from "./largeTenantFixtures.js";

export function fixtureDirectoryUser(objectId: string, displayName: string | null = "Saved person", upn = "person@example.invalid"): CopilotDirectoryUser {
  return {
    identity: { objectId, displayName, userPrincipalName: upn, companyName: null, department: null,
      employeeType: null, accountEnabled: true, userType: "Member" },
    serviceEvidenceVersion: 1, copilotServiceState: "unknown", servicePlans: [],
  };
}

export async function publishFixtureDirectory(database: pg.Pool, identity: SelectionIdentity, users: readonly CopilotDirectoryUser[],
  options: { observedAt?: Date; expiresAt?: Date; tokenMode?: "delegated" | "application" } = {}) {
  encodeBatch(users);
  const stages = new UserSourceStages(database);
  return stages.execute(generationInput({
    scope: { kind: "principal", tenantId: identity.tenantId, principalId: identity.principalId,
      source: "directory", selector: "complete", tokenMode: options.tokenMode ?? "delegated" },
    sessionEpoch: identity.sessionEpoch, observedAt: options.observedAt ?? new Date(),
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
  }), async lease => {
    const key = await stages.query(lease, "discovery", "synthetic:exact-people");
    await stages.page(lease, key, "synthetic:exact-people", users.length, users.length);
    if (users.length) await stages.directory(lease, key, users);
    await stages.finishQuery(lease, key);
  }, { beforePublish: async () => {} });
}

export async function publishFixtureEmptyActivity(database: pg.Pool, identity: SelectionIdentity,
  options: { observedAt?: Date; expiresAt?: Date } = {}) {
  const stages = new UserSourceStages(database);
  return stages.execute(generationInput({
    scope: { kind: "principal", tenantId: identity.tenantId, principalId: identity.principalId,
      source: "app_activity", selector: "complete", tokenMode: "delegated" },
    sessionEpoch: identity.sessionEpoch,
    ...(options.observedAt ? { observedAt: options.observedAt } : {}),
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
  }), async lease => {
    const key = await stages.query(lease, "activity", "synthetic:empty-activity");
    await stages.page(lease, key, "synthetic:empty-activity", 0, 0);
    await stages.finishQuery(lease, key);
  }, { beforePublish: async () => {} });
}
