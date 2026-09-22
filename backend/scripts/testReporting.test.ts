import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));

function childEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { CI: "1", NO_COLOR: "1" };
  for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "COMSPEC", "LANG"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

it.each(["backend", "frontend"])("%s keeps passing logs quiet without hiding failed tests or unhandled errors", workspace => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "agentcontrol-test-reporting-")));
  const workspacePath = join(root, workspace);
  try {
    const require = createRequire(join(workspacePath, "package.json"));
    const vitest = dirname(require.resolve("vitest/package.json"));
    writeFileSync(join(directory, "vitest.config.mjs"), `
import base from ${JSON.stringify(join(workspacePath, "vitest.config.ts"))};
import { resolve } from "node:path";
export default {
  ...base,
  root: ${JSON.stringify(directory)},
  test: {
    ...base.test,
    include: ["reporting.test.ts"],
    setupFiles: base.test.setupFiles?.map(file => resolve(${JSON.stringify(workspacePath)}, file)),
    maxWorkers: 1,
    fileParallelism: false
  }
};
`);
    writeFileSync(join(directory, "reporting.test.ts"), `
import { it, expect } from ${JSON.stringify(pathToFileURL(join(vitest, "dist/index.js")).href)};
it("passing HTTP error contract", () => {
  console.log(process.env.REPORTING_PASS_OUT);
  console.warn(process.env.REPORTING_PASS_WARNING);
  console.error(process.env.REPORTING_PASS_ERROR);
  expect(404).toBe(404);
});
it("failure diagnostic contract", async () => {
  if (process.env.REPORTING_CASE === "failure") {
    console.log(process.env.REPORTING_FAIL_OUT);
    console.warn(process.env.REPORTING_FAIL_WARNING);
    console.error(process.env.REPORTING_FAIL_ERROR);
    expect("actual-fixture-value").toBe("expected-fixture-value");
  }
  if (process.env.REPORTING_CASE === "unhandled") {
    setTimeout(() => { throw new Error(process.env.REPORTING_UNHANDLED); }, 0);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
});
`);
    for (const mode of ["passing", "failure", "unhandled"]) {
      const result = spawnSync(process.execPath, [join(vitest, "vitest.mjs"), "run", "--config", join(directory, "vitest.config.mjs")], {
        cwd: workspacePath,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...childEnvironment(),
          REPORTING_CASE: mode,
          REPORTING_PASS_OUT: "EXPECTED_PASS_STDOUT_MARKER",
          REPORTING_PASS_WARNING: "EXPECTED_PASS_WARNING_MARKER",
          REPORTING_PASS_ERROR: "EXPECTED_PASS_STDERR_MARKER",
          REPORTING_FAIL_OUT: "FAILED_STDOUT_MARKER",
          REPORTING_FAIL_WARNING: "FAILED_WARNING_MARKER",
          REPORTING_FAIL_ERROR: "FAILED_STDERR_MARKER",
          REPORTING_UNHANDLED: "UNEXPECTED_UNHANDLED_ERROR_MARKER",
        },
      });
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.error, output).toBeUndefined();
      expect(result.signal, output).toBeNull();
      expect(result.status, output).toBe(mode === "passing" ? 0 : 1);
      for (const marker of ["EXPECTED_PASS_STDOUT_MARKER", "EXPECTED_PASS_WARNING_MARKER", "EXPECTED_PASS_STDERR_MARKER"]) {
        expect(output).not.toContain(marker);
      }
      if (mode === "passing") {
        expect(output).toMatch(/2 passed/);
        expect(output).toContain("reporting.test.ts");
      } else if (mode === "failure") {
        for (const marker of ["FAILED_STDOUT_MARKER", "FAILED_WARNING_MARKER", "FAILED_STDERR_MARKER", "failure diagnostic contract", "AssertionError", "actual-fixture-value", "expected-fixture-value"]) {
          expect(output).toContain(marker);
        }
        expect(output).toMatch(/1 failed/);
      } else {
        expect(output).toContain("UNEXPECTED_UNHANDLED_ERROR_MARKER");
        expect(output).toContain("Unhandled");
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 100_000);

it("the aggregate CLI rejects an application database and exits nonzero with the actual cause", () => {
  const require = createRequire(join(root, "backend/package.json"));
  const tsx = join(dirname(require.resolve("tsx/package.json")), "dist/cli.mjs");
  const result = spawnSync(process.execPath, [tsx, join(root, "backend/scripts/test-all.ts")], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
    env: { ...childEnvironment(), PGDATABASE: "agentcontrol" },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Software checks require the isolated test-db/test-postgres environment");
  expect(result.stderr).toContain("AGENT_CONTROL_ISOLATED_TESTS differs");
  expect(result.stdout).toContain("[AUTOMATED CHECKS] FAILED: 0/5");
  expect(result.stdout).not.toMatch(/LOCAL READINESS|MICROSOFT|Permissions/);
});
