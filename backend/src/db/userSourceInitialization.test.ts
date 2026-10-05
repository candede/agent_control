import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeSchema } from "../../scripts/database.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import { publishFixtureDirectory, publishFixtureEmptyActivity } from "../../scripts/userSourceFixture.js";
import { selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import type { CopilotDirectoryUser } from "../types/copilotUsage.js";
import { DataSyncRepository, type DataSyncScope } from "./dataSync.js";
import { verifySchema } from "./schema.js";
import { UserSourcesRepository } from "./userSources.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => { fixture = await testDatabase(); });
afterAll(async () => { await fixture?.close(); });

describe("current user-source initialization", () => {
  it("starts empty and preserves published native records and success markers on repeated initialization", async () => {
    const scopes = [
      { tenantId: randomUUID(), principalId: randomUUID() },
      { tenantId: randomUUID(), principalId: randomUUID() },
    ];
    const repository = new DataSyncRepository(fixture.runtime);
    await verifySchema(fixture.runtime);
    for (const scope of scopes) {
      const page = await sourcePage(scope);
      expect(page.sources.directory).toMatchObject({ generationId: null, rowCount: null, observedAt: null });
      expect(page.sources.app_activity).toMatchObject({ generationId: null, rowCount: null, observedAt: null });
      expect(page.value).toEqual([]);
      expect(page.summary.licensedUsers).toBeNull();
    }
    const observedAt = new Date().toISOString();
    const user: CopilotDirectoryUser = {
      serviceEvidenceVersion: 1,
      identity: {
        objectId: randomUUID(), userPrincipalName: "fresh@example.invalid", displayName: "Fresh user",
        accountEnabled: true, userType: "Member", employeeType: null, companyName: null, department: null,
      },
      copilotServiceState: "enabled",
      servicePlans: [{
        servicePlanId: "a62f8878-de10-42f3-b68f-6149a25ceb97", service: "M365_COPILOT_APPS",
        displayName: "Microsoft 365 Copilot in Productivity Apps", state: "enabled",
        capabilityStatus: "Enabled", assignedDateTime: observedAt,
      }],
    };
    const identity = { ...selectionIdentity, ...scopes[0] };
    await publishFixtureDirectory(fixture.runtime, identity, [user]);
    await publishFixtureEmptyActivity(fixture.runtime, identity);
    await repository.recordSuccessMarker(scopes[0], "users", 1, observedAt);
    await initializeSchema(fixture.operator);
    await verifySchema(fixture.runtime);
    const page = await sourcePage(scopes[0]);
    expect(page.value).toHaveLength(1);
    expect(page.value[0]).toMatchObject({ directory: user.identity, entitlement: "paid_active" });
    expect(page.summary.licensedUsers).toBe(1);
    expect(page.sources.directory.state).toBe("available");
    expect((await repository.listMarkers(scopes[0])).find(source => source.source === "users"))
      .toMatchObject({ status: "succeeded", count: 1, lastSuccessAt: observedAt });
    expect((await sourcePage(scopes[1])).value).toEqual([]);
    await expect(fixture.runtime.query("DELETE FROM data_sync_success_markers"))
      .rejects.toMatchObject({ code: "42501" });
  });
});

async function sourcePage(scope: DataSyncScope) {
  const identity = { ...selectionIdentity, ...scope };
  const reader = new UserSourcesRepository(fixture.runtime, "synthetic-initialization-read-secret");
  const selected = await reader.capture(identity, "delegated");
  return reader.page(selected.id, identity);
}
