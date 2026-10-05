import { createHash } from "node:crypto";
import pg from "pg";
import { schemaFingerprint, verifySchema } from "../src/db/schema.js";
import { bootstrap, grantRuntime, initializeSchema } from "./database.js";
import { closeFixtureResources } from "./fixtureSupport.js";

export function testSchemaTemplateIdentity(database: string) {
  if (!/^agentcontrol_test_[a-z0-9_]+$/.test(database)) throw new Error("test_schema_template_scope");
  const checksum = createHash("sha256").update(JSON.stringify({
    database, schemaFingerprint,
  })).digest("hex");
  return { name: `agentcontrol_test_schema_${checksum.slice(0, 32)}`, marker: `agentcontrol-test-schema:${database}:${checksum}` };
}

export async function prepareTestSchemaTemplate(admin: pg.Pool, settings: pg.PoolConfig, password: string) {
  if (process.env.AGENT_CONTROL_ISOLATED_TESTS !== "1") return undefined;
  const { name, marker } = testSchemaTemplateIdentity(String(settings.database));
  const started = performance.now();
  const client = await admin.connect();
  let locked = false, created = false, template: pg.Pool | undefined;
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [marker]);
    locked = true;
    const existing = (await client.query(`SELECT datallowconn,pg_get_userbyid(datdba) AS owner,
      shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1`, [name])).rows[0];
    if (existing) {
      if (existing.owner !== "agentcontrol_admin" || existing.datallowconn !== false || existing.marker !== marker) {
        throw new Error("test_schema_template_identity");
      }
      return name;
    }
    await client.query(`CREATE DATABASE "${name}"`);
    created = true;
    template = new pg.Pool({ ...settings, database: name, max: 1 });
    await bootstrap(template, password);
    await initializeSchema(template);
    await grantRuntime(template);
    await verifySchema(template);
    await template.end();
    template = undefined;
    await client.query(`ALTER DATABASE "${name}" ALLOW_CONNECTIONS false`);
    const quoted = (await client.query<{ value: string }>("SELECT quote_literal($1) AS value", [marker])).rows[0].value;
    await client.query(`COMMENT ON DATABASE "${name}" IS ${quoted}`);
    process.stdout.write(JSON.stringify({ event: "test_schema_template_initialized", database: name,
      schemaFingerprint, marker, elapsedMs: performance.now() - started }) + "\n");
    return name;
  } catch (error) {
    try {
      await closeFixtureResources(
        () => template?.end(),
        async () => { if (created) await client.query(`DROP DATABASE "${name}"`); },
      );
    } catch (cleanup) { throw new AggregateError([error, cleanup], "Owned schema template initialization and cleanup failed."); }
    throw error;
  } finally {
    try { if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [marker]); }
    finally { client.release(true); }
  }
}
