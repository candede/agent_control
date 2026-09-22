import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { closeFixtureResources } from "./fixtureSupport.js";

const steps = [
  { name: "Backend tests", args: ["run", "test", "--workspace", "backend"] },
  { name: "Frontend tests", args: ["run", "test", "--workspace", "frontend"] },
  { name: "Backend typecheck", args: ["run", "typecheck", "--workspace", "backend"] },
  { name: "Frontend lint", args: ["run", "lint", "--workspace", "frontend"] },
  { name: "Production build", args: ["run", "build"] },
];
const timeout = 180_000;
const fixtureEnvironment = {
  AGENT_CONTROL_ISOLATED_TESTS: "1",
  PGHOST: "127.0.0.1",
  PGPORT: "5432",
  PGDATABASE: "agentcontrol_test_control",
  PGUSER: "agentcontrol_admin",
  PGPASSWORD: "isolated-fixture-admin-password-never-production-01",
  APP_PGPASSWORD: "isolated-fixture-password-never-production-01",
  PGSSLMODE: "disable",
};

function isolatedEnvironment(): NodeJS.ProcessEnv {
  for (const [key, value] of Object.entries(fixtureEnvironment)) {
    if (process.env[key] !== value) {
      throw new Error(`Software checks require the isolated test-db/test-postgres environment (${key} differs). Run the local Test helper; do not supply application database credentials.`);
    }
  }
  for (const key of ["PGPASSWORD_FILE", "APP_PGPASSWORD_FILE", "PGDATABASE_FILE", "PGPASSFILE", "PGSERVICE", "PGSERVICEFILE"]) {
    if (process.env[key]) throw new Error(`Software checks reject ${key}; use only the isolated fixture environment.`);
  }
  const environment: NodeJS.ProcessEnv = { ...fixtureEnvironment };
  for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "COMSPEC", "LANG", "LC_ALL", "TERM", "CI", "NO_COLOR", "FORCE_COLOR"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

export async function runSoftwareChecks() {
  const name = `agentcontrol_test_${randomUUID().replaceAll("-", "")}`;
  const failures: unknown[] = [];
  let operator: pg.Pool | undefined;
  let created = false;
  let passed = 0;
  let current = "Isolated PostgreSQL setup";
  console.log("[AUTOMATED CHECKS] Software qualification with isolated fixtures.");
  try {
    const environment = isolatedEnvironment();
    operator = new pg.Pool({
      host: environment.PGHOST,
      port: 5432,
      database: environment.PGDATABASE,
      user: environment.PGUSER,
      password: environment.PGPASSWORD,
      ssl: false,
      max: 1,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
    });
    await operator.query(`CREATE DATABASE "${name}"`);
    created = true;
    for (const [index, step] of steps.entries()) {
      const command = `npm ${step.args.join(" ")}`;
      current = `${step.name}: ${command}`;
      console.log(`[AUTOMATED CHECKS ${index + 1}/${steps.length}] RUN ${step.name}\nCommand: ${command}`);
      const result = spawnSync("npm", step.args, {
        stdio: "inherit",
        env: { ...environment, PGDATABASE: name },
        timeout,
      });
      if (result.error) {
        throw new Error(`${command} could not complete (timeout limit ${timeout / 1_000}s): ${result.error.message}`, { cause: result.error });
      }
      if (result.signal) throw new Error(`${command} was terminated by ${result.signal}.`);
      if (result.status !== 0) {
        throw new Error(`${command} exited with ${result.status ?? "no exit status"}. See the test/compiler diagnostics above.`);
      }
      passed += 1;
      console.log(`[AUTOMATED CHECKS ${index + 1}/${steps.length}] PASS ${step.name}`);
    }
  } catch (error) {
    failures.push(error);
    console.error(`[AUTOMATED CHECKS] FAIL ${current}`, error);
  } finally {
    try {
      await closeFixtureResources(
        async () => {
          if (operator && created) await operator.query(`DROP DATABASE "${name}" WITH (FORCE)`);
        },
        () => operator?.end(),
      );
    } catch (error) {
      failures.push(error);
      console.error(`[AUTOMATED CHECKS] FAIL cleanup of owned fixture database ${name}`, error);
    }
  }
  console.log(`[AUTOMATED CHECKS] ${failures.length ? "FAILED" : "PASSED"}: ${passed}/${steps.length} steps passed${failures.length ? "; software is not qualified" : "; isolated database cleanup completed"}.`);
  if (failures.length) throw new AggregateError(failures, "Software qualification failed; fix the reported command or fixture cleanup before deployment.");
}
