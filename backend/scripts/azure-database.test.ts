import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { schemaFingerprint } from "../src/db/schema.js";
import { initializeSchema, bootstrap, grantRuntime } from "./database.js";
import { testDatabase, fixturePassword } from "./testDatabase.js";
import {
  enterAzureMaintenance,
  preflightAzureDatabase,
  reopenAzureDatabase,
  verifyAzureRuntimePrivileges,
  rotateAzureRuntimeCredential,
  verifyAzureDrain,
} from "./azure-database.js";

let initialized: Awaited<ReturnType<typeof testDatabase>>;
let empty: Awaited<ReturnType<typeof testDatabase>>;

beforeAll(async () => {
  initialized = await testDatabase();
  empty = await testDatabase(false);
});
afterAll(async () => {
  await initialized.close();
  await empty.close();
});

describe("Azure database identity and sequencing guards", () => {
  it("rejects unsupported operator actions without emitting a success result", async () => {
    await expect(promisify(execFile)(process.execPath,
      ["--import", "tsx", fileURLToPath(new URL("./azure-database.ts", import.meta.url)), "unsupported"],
      { env: { ...process.env, PGDATABASE: initialized.name }, timeout: 15_000 },
    )).rejects.toMatchObject({
      code: 1, stdout: "", stderr: expect.stringContaining('"outcome":"failed"'),
    });
  });

  it("separates explicitly empty first install from an existing current schema", async () => {
    await expect(preflightAzureDatabase(empty.operator, "fresh", empty.name)).resolves.toMatchObject({
      mode: "fresh",
      database: empty.name,
      currentFingerprint: null,
      targetFingerprint: schemaFingerprint,
      tableCount: 0,
    });
    await bootstrap(empty.operator, fixturePassword);
    await initializeSchema(empty.operator);
    await grantRuntime(empty.operator);
    await expect(preflightAzureDatabase(empty.operator, "fresh", empty.name)).rejects.toThrow("never replaced");
    await expect(preflightAzureDatabase(empty.operator, "existing", empty.name)).resolves.toMatchObject({
      currentFingerprint: schemaFingerprint,
    });
  });

  it("rejects missing, stale and modified expected schemas instead of initializing", async () => {
    const blank = await testDatabase(false);
    try {
      await expect(preflightAzureDatabase(blank.operator, "existing", blank.name)).rejects.toThrow("initialization fallback");
    } finally {
      await blank.close();
    }
    await initialized.operator.query("UPDATE app_schema SET fingerprint=repeat('0',64)");
    try {
      await expect(preflightAzureDatabase(initialized.operator, "existing", initialized.name))
        .rejects.toMatchObject({ code: "database_schema_reset_required" });
    } finally { await initialized.operator.query("UPDATE app_schema SET fingerprint=$1", [schemaFingerprint]); }
  });

  it("accepts repeated initialization and deployment of the exact current schema", async () => {
    await initializeSchema(initialized.operator);
    await expect(preflightAzureDatabase(initialized.operator, "existing", initialized.name))
      .resolves.toMatchObject({ currentFingerprint: schemaFingerprint, targetFingerprint: schemaFingerprint });
  });

  it("keeps maintenance closed through drain and reopens with provider work disabled", async () => {
    expect(await enterAzureMaintenance(initialized.operator, initialized.name)).toMatchObject({ mode: "maintenance" });
    await initialized.operator.query(
      `INSERT INTO jobs(id,tenant_id,principal_id,token_mode,capability,action,request_hash,idempotency_key,
        actor_name,actor_username,request_path,scope,status,lease_owner,lease_until)
        VALUES (gen_random_uuid(),'fixture','fixture','delegated','graph.package.block.manage','block',$1,'fixture-azure-drain',
        'Fixture','fixture@example.invalid','/fixture','single','running',gen_random_uuid(),clock_timestamp()+interval '1 minute')`,
      ["a".repeat(64)],
    );
    await expect(verifyAzureDrain(initialized.operator, initialized.name)).rejects.toThrow("Execution owners remain");
    await initialized.operator.query(
      "UPDATE jobs SET lease_owner=NULL,lease_until=NULL,status='waiting_authorization' WHERE idempotency_key='fixture-azure-drain'",
    );
    await expect(verifyAzureDrain(initialized.operator, initialized.name)).resolves.toMatchObject({ execution_owners: 0 });
    await expect(reopenAzureDatabase(initialized.operator, initialized.name)).resolves.toMatchObject({
      mode: "normal",
      providerWorkEnabled: false,
    });
    expect((await initialized.operator.query("SELECT mode,provider_work_enabled FROM operational_state")).rows[0])
      .toEqual({ mode: "normal", provider_work_enabled: false });
    await expect(reopenAzureDatabase(initialized.operator, initialized.name)).rejects.toThrow("requires the exact database");
  });

  it("requires the fixed administrator and exact database identity", async () => {
    await expect(preflightAzureDatabase(initialized.runtime, "existing", initialized.name)).rejects.toThrow("requires agentcontrol_admin");
    await expect(verifyAzureRuntimePrivileges(initialized.runtime, initialized.name)).resolves.toMatchObject({
      user: "agentcontrol_app",
      ddlDenied: true,
      auditMutationDenied: true,
    });
    await expect(verifyAzureRuntimePrivileges(initialized.operator, initialized.name)).rejects.toThrow("privilege separation");
  });

  it("rotates the runtime login only through the explicit bounded operator action", async () => {
    const password = "synthetic-fixture-approved-rotated-password-0001";
    await expect(rotateAzureRuntimeCredential(initialized.operator, password, initialized.name)).resolves.toEqual({
      runtimeCredentialRotated: true,
      valueRedacted: true,
    });
    const rotatedRuntime = new (await import("pg")).default.Pool({
      ...initialized.operator.options,
      user: "agentcontrol_app",
      password,
      max: 1,
    });
    try {
      await expect(verifyAzureRuntimePrivileges(rotatedRuntime, initialized.name)).resolves.toMatchObject({ ddlDenied: true });
    } finally {
      await rotatedRuntime.end();
      await rotateAzureRuntimeCredential(initialized.operator, fixturePassword, initialized.name);
    }
    await expect(rotateAzureRuntimeCredential(initialized.operator, "short", initialized.name)).rejects.toThrow("invalid");
  });
});
