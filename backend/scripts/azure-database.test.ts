import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrations } from "../src/db/schema.js";
import { migrate, bootstrap, grantRuntime } from "./database.js";
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
let previousRelease: Awaited<ReturnType<typeof testDatabase>>;

beforeAll(async () => {
  initialized = await testDatabase();
  empty = await testDatabase(false);
  previousRelease = await testDatabase(false);
  await bootstrap(previousRelease.operator, fixturePassword);
  await migrate(previousRelease.operator, migrations.slice(0, -1));
  await grantRuntime(previousRelease.operator);
});
afterAll(async () => {
  await initialized.close();
  await empty.close();
  await previousRelease.close();
});

describe("Azure database identity and sequencing guards", () => {
  it("separates explicitly empty first install from an exact known upgrade", async () => {
    await expect(preflightAzureDatabase(empty.operator, "fresh", 0, empty.name)).resolves.toMatchObject({
      mode: "fresh",
      database: empty.name,
      currentVersion: 0,
      tableCount: 0,
    });
    await bootstrap(empty.operator, fixturePassword);
    await migrate(empty.operator);
    await grantRuntime(empty.operator);
    await expect(preflightAzureDatabase(empty.operator, "fresh", 0, empty.name)).rejects.toThrow("never replaced");
    await expect(preflightAzureDatabase(empty.operator, "upgrade", migrations.length, empty.name)).resolves.toMatchObject({
      currentVersion: migrations.length,
    });
  });

  it("rejects missing, stale and modified expected schemas instead of initializing", async () => {
    const blank = await testDatabase(false);
    try {
      await expect(preflightAzureDatabase(blank.operator, "upgrade", migrations.length, blank.name)).rejects.toThrow("initialization fallback");
    } finally {
      await blank.close();
    }
    await expect(preflightAzureDatabase(initialized.operator, "upgrade", migrations.length - 1, initialized.name)).rejects.toThrow("exact approved");
    await initialized.operator.query("UPDATE schema_migrations SET checksum='changed' WHERE version=$1", [migrations.length]);
    await expect(preflightAzureDatabase(initialized.operator, "upgrade", migrations.length, initialized.name)).rejects.toThrow("modified migration");
    await initialized.operator.query("UPDATE schema_migrations SET checksum=$1 WHERE version=$2", [
      (await empty.operator.query("SELECT checksum FROM schema_migrations WHERE version=$1", [migrations.length])).rows[0].checksum,
      migrations.length,
    ]);
  });

  it("accepts the approved previous-release baseline and the current schema on repeat deployment", async () => {
    await expect(preflightAzureDatabase(previousRelease.operator, "upgrade", migrations.length - 1, previousRelease.name))
      .resolves.toMatchObject({ currentVersion: migrations.length - 1 });
    await migrate(previousRelease.operator);
    await expect(preflightAzureDatabase(previousRelease.operator, "upgrade", migrations.length, previousRelease.name))
      .resolves.toMatchObject({ currentVersion: migrations.length });
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
    await expect(preflightAzureDatabase(initialized.runtime, "upgrade", migrations.length, initialized.name)).rejects.toThrow("requires agentcontrol_admin");
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
