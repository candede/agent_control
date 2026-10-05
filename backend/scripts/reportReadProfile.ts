import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { testDatabase } from "./testDatabase.js";
import { seedDisjointReportUnion, seedReportSet, seedUserFact } from "./officialReportFixtures.js";
import { selectionIdentity } from "./largeTenantFixtures.js";
import { LargeTenantUsersReports } from "../src/services/largeTenantUsersReports.js";
import { digest } from "../src/db/dataBounds.js";

const fixture = await testDatabase();
const identity = { ...selectionIdentity, tenantId: `native-union-${randomUUID()}` };
const reports = new LargeTenantUsersReports(fixture.runtime, "synthetic-report-read-profile-secret", 35);
const slow = new Map<string, { sql: string; values: unknown[]; milliseconds: number }>();
const wrapped = new WeakSet<pg.PoolClient>();
try {
  const set = await seedDisjointReportUnion(fixture.operator, identity.tenantId, 50000);
  await reports.history.ensure(identity.tenantId);
  await reports.history.connections.run(client => reports.history.accepted(client, identity.tenantId, set.id));
  fixture.runtime.on("acquire", client => {
    if (wrapped.has(client)) return;
    wrapped.add(client);
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    client.query = ((...args: unknown[]) => {
      const start = performance.now(), result = query(...args);
      if (!(result instanceof Promise)) return result;
      return result.finally(() => {
        const sql = args[0], milliseconds = performance.now() - start;
        if (typeof sql !== "string" || !/^(WITH|SELECT)/.test(sql) || milliseconds < 30) return;
        const hash = digest(sql);
        if (milliseconds > (slow.get(hash)?.milliseconds ?? 0)) slow.set(hash, {
          sql, values: Array.isArray(args[1]) ? args[1] : [], milliseconds,
        });
        if (slow.size > 20) slow.delete([...slow].sort((a, b) => a[1].milliseconds - b[1].milliseconds)[0][0]);
        console.log("QUERY_MS", milliseconds.toFixed(2), hash.slice(0, 12), sql.slice(0, 70).replaceAll("\n", " "));
      });
    }) as typeof client.query;
  });
  for (const endpoint of ["official_users", "official_agents"] as const) {
    let start = performance.now();
    const selection = await reports.capture(identity, "delegated", endpoint, { setId: set.id });
    console.log("CAPTURE_MS", endpoint, performance.now() - start);
    start = performance.now();
    console.log("COUNTS", endpoint, (await reports.page(selection.id, identity)).counts);
    console.log("PAGE_MS", endpoint, performance.now() - start);
    start = performance.now();
    await reports.exact(selection.id, identity, endpoint === "official_users" ? "bridge-49999" : "agent-49999");
    console.log("EXACT_MS", endpoint, performance.now() - start);
  }
  await fixture.operator.query("ANALYZE official_usage_row_facts; ANALYZE official_usage_version_rows; ANALYZE official_usage_versions; ANALYZE official_usage_set_versions");
  const smallIdentity = { ...selectionIdentity, tenantId: `native-small-${randomUUID()}` };
  const small = await seedReportSet(fixture.operator, smallIdentity.tenantId, 1, "importing-admin", { users: 3 });
  for (let n = 0; n < 3; n++) await seedUserFact(fixture.operator, smallIdentity.tenantId, small.versions.users, n, `small-${n}`, n * 5);
  await reports.history.ensure(smallIdentity.tenantId);
  await reports.history.connections.run(client => reports.history.accepted(client, smallIdentity.tenantId, small.id));
  slow.clear();
  for (const cohort of ["all", "zero", "low", "review"] as const) {
    const start = performance.now();
    const selection = await reports.capture(smallIdentity, "delegated", "official_users", { setId: small.id, cohort });
    console.log("SMALL_CAPTURE_MS", cohort, performance.now() - start);
    console.log("SMALL_COUNTS", cohort, (await reports.page(selection.id, smallIdentity)).counts);
    console.log("SMALL_PAGE_MS", cohort, performance.now() - start);
  }
  for (const [hash, query] of [...slow].sort((a, b) => b[1].milliseconds - a[1].milliseconds).slice(0, 4)) {
    const plan = await reports.selections.connections.selectedRead(async client => {
      await reports.history.prepareRead(client, smallIdentity.tenantId);
      return (await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query.sql}`, query.values)).rows[0]["QUERY PLAN"][0];
    });
    if (Buffer.byteLength(JSON.stringify(plan)) > 1048576) throw new Error("profile_result_bytes");
    console.log("EXPLAIN", hash, JSON.stringify(plan));
  }
} finally { await fixture.close(); }
