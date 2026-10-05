import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { testDatabase } from "./testDatabase.js";
import { fixtureEnvironment } from "./largeTenantFixture.js";
import { generationInput, selectionIdentity } from "./largeTenantFixtures.js";
import { DataGenerations } from "../src/db/dataGenerations.js";
import { DataSelections, canonicalQuery } from "../src/services/dataSelections.js";
import { DataExports } from "../src/services/dataExports.js";

fixtureEnvironment();
try {
  await writeFile("foundation-readonly-probe", "must not be writable");
  throw new Error("Application filesystem was writable; readonly proof failed.");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EROFS") throw error;
}
const fixture = await testDatabase();
try {
  const generations = new DataGenerations(fixture.runtime);
  const lease = await generations.begin(generationInput());
  await generations.validate(lease, { rows: 0, children: 0, batches: 0, pages: 0, wireRows: 0 });
  await generations.publish(lease);
  const selections = new DataSelections(fixture.runtime);
  const selection = await selections.capture(selectionIdentity, "/fixture/export", { values: {}, allowed: [] }, [{
    kind: "generation", scopeId: lease.scopeId, generationId: lease.id, revision: "1", expiresAt: new Date(Date.now() + 600_000),
  }]);
  const exports = new DataExports(fixture.runtime, selections, async (client, event) => {
    await client.query(`INSERT INTO audit_events(id,event_id,operation_id,tenant_id,principal_id,actor_username,actor_name,
      scope,action,target_blocked_state,agent_id,started_at,completed_at,status,request_path,metadata)
      VALUES($1,$2,$3,$4,$5,'fixture@example.invalid','Fixture','bulk','export-official-usage-users',NULL,
        'official-usage',clock_timestamp(),CASE WHEN $6='started' THEN NULL ELSE clock_timestamp() END,$6,'/fixture/export',$7::jsonb)`,
    [randomUUID(), event.id, event.exportId, selectionIdentity.tenantId, selectionIdentity.principalId, event.status,
      JSON.stringify({ phase: event.phase, resultingCount: event.rows, resultingBytes: event.bytes })]);
  });
  const id = await exports.create(selectionIdentity, {
    selectionId: selection.id, queryHash: canonicalQuery({}, []), kind: "official_users", filename: "fixture.csv",
  });
  await exports.build(id, selectionIdentity, ["Name"], async function* () {
    for (let batch = 0; batch < 5; batch++) yield Array.from({ length: 250 }, (_, row) => ({ Name: `${batch}-${row}` }));
  });
  let bytes = 0;
  for await (const chunk of exports.download(id, selectionIdentity, new AbortController().signal)) bytes += chunk.length;
  const status = await exports.status(id, selectionIdentity);
  if (status.rows !== 1250 || status.bytes !== bytes) throw new Error("Readonly artifact count mismatch.");
  const audit = (await fixture.runtime.query("SELECT count(*)::int AS n FROM audit_events WHERE operation_id=$1 AND status='succeeded'", [id])).rows[0];
  if (audit.n !== 2) throw new Error("Durable build/download audit missing.");
  console.log(JSON.stringify({ readonlyApplicationFilesystem: true, rows: status.rows, bytes, durableSuccessfulAudits: audit.n }));
} finally { await fixture.close(); }
