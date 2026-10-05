import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { directoryRecord, generationInput, selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import { UserSourceProvider } from "../services/userSourceProvider.js";
import { reportHeaders } from "../services/userSourceGraphFields.js";
import { DataGenerations } from "./dataGenerations.js";
import { verifySchema } from "./schema.js";
import { UserSourcesRepository } from "./userSources.js";
import { UserSourceStages } from "./userSourceStages.js";

const userId = "00000000-0000-4000-8000-000000000001";
const date = new Date().toISOString().slice(0, 10);
const daysAgo = (days: number) => new Date(Date.parse(date) - days * 86400000).toISOString().slice(0, 10);
const csvRow = (lastActivity = daysAgo(28)) => [date, `${userId}@example.invalid`, "Person", lastActivity,
  "", "", "", "", "", "", "", "", "28"];

describe("Copilot report v2 schema", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => {
    fixture = await testDatabase();
    const generations = new DataGenerations(fixture.runtime);
    const input = generationInput({ scope: { ...generationInput().scope, source: "directory" } });
    const lease = await generations.begin(input);
    await fixture.runtime.query(`INSERT INTO user_source_attempts(generation_id,scope_id,tenant_id,source) VALUES($1,$2,$3,'directory')`,
      [lease.id, lease.scopeId, lease.tenantId]);
    await generations.append(lease, "directory", 0, [directoryRecord(userId)]);
    await generations.validate(lease, { rows: 1, children: 0, batches: 1, pages: 0, wireRows: 0 });
    await generations.publish(lease, { completeJob: async client => {
      await client.query("UPDATE user_source_attempts SET status='available' WHERE generation_id=$1", [lease.id]);
    } });
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });

  it("publishes the exact inclusive D28 boundary and pins each selected report without changing its period", async () => {
    await verifySchema(fixture.runtime);
    const repository = new UserSourcesRepository(fixture.runtime, "synthetic-report-schema-cursor-secret");

    const stages = new UserSourceStages(fixture.runtime);
    const input = generationInput({ scope: { ...generationInput().scope, source: "app_activity" } });
    let firstSelectionId: string | undefined;
    for (const [days, expected] of [[28, "inactive"], [27, "active"]] as const) {
      const csv = `${reportHeaders.join(",")},Prompts submitted for all apps\n${csvRow(daysAgo(days)).join(",")},10\n`;
      await new UserSourceProvider(async () => new Response(csv)).refresh(stages, input, { authorize: async () => "synthetic-token" });
      const current = await repository.capture(selectionIdentity, "delegated");
      const page = await repository.page(current.id, selectionIdentity);
      expect(page.sources.app_activity).toMatchObject({ period: "D28", reportVersion: "v2", rowCount: 1 });
      expect(page.value[0].activityState).toBe(expected);
      firstSelectionId ??= current.id;
      expect((await repository.page(firstSelectionId, selectionIdentity)).value[0].activityState).toBe("inactive");
    }
    await stages.execute(input, async lease => {
      await expect(fixture.runtime.query("UPDATE user_source_attempts SET observed_count=0,report_period='D30' WHERE generation_id=$1", [lease.id]))
        .rejects.toThrow("user_source_report_period_immutable");
      const key = await stages.query(lease, "activity", "empty-v2");
      await stages.finishQuery(lease, key);
    }, { beforePublish: async () => {} });
    expect((await repository.refreshStatus(selectionIdentity, "delegated")).sources.app_activity)
      .toMatchObject({ period: "D28", reportVersion: "v2", rowCount: 0 });
  });
});
