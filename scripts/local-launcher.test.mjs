import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = join(repository, "artifacts", "test-scratch", `sh-${randomUUID().slice(0, 8)}`);
const root = join(scratch, "checkout");
const bin = join(scratch, "bin");
const log = join(scratch, "calls");
mkdirSync(bin, { recursive: true, mode: 0o700 });
mkdirSync(join(root, "scripts"), { recursive: true, mode: 0o700 });
for (const path of ["deploy-local.sh", "scripts/local-launcher.Dockerfile"]) {
  copyFileSync(join(repository, path), join(root, path));
}
for (const name of ["bash", "dirname", "cat", "printenv"]) {
  const command = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
  symlinkSync(command, join(bin, name));
}
function executable(name, source) {
  writeFileSync(join(bin, name), `#!/bin/bash\nset -eu\n${source}\n`, { mode: 0o700 });
}
executable("uname", 'if [[ "$1" == -s ]]; then printf "Linux\\n"; else printf "%s\\n" "${TEST_ARCH:-x86_64}"; fi');
executable("git", "exit 0");
executable("stat", `if [[ "$1" == -L ]]; then printf '%s\\n' "\${TEST_SOCKET_GID:-${process.getgid()}}"; else printf '%s\\n' "\${TEST_LINK_GID:-${process.getgid()}}"; fi`);
executable("mkdir", "exit 0");
executable("id", `case "$1" in -u) printf '${process.getuid()}\\n';; -g) printf '${process.getgid()}\\n';; esac`);
executable("docker", `
printf '%s\\0' "$@" >> "$TEST_LOG"; printf '\\n' >> "$TEST_LOG"
case "$1" in
  context) printf '%s\\n' "$TEST_ENDPOINT";;
  info) if [[ "$*" == *SecurityOptions* ]]; then printf '%s\\n' "\${TEST_SECURITY:-[]}"; else printf 'linux\\n'; fi;;
  build) printf 'sha256:${"a".repeat(64)}\\n';;
  run)
    if [[ "$*" == *local-launcher-inputs.ps1* ]]; then
      printf '%s\\n' "$TEST_SECRET_INPUT"
    else
      exit "\${TEST_DEPLOY_EXIT:-0}"
    fi;;
  *) exit 99;;
esac`);
const socket = join(scratch, "d.sock");
const server = createServer();
await new Promise((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(socket, resolveListen);
});
const environment = {
  ...process.env, PATH: bin, TEST_LOG: log, TEST_ENDPOINT: `unix://${socket}`,
  DOCKER_HOST: "", DOCKER_CONTEXT: "", DOCKER_CONFIG: join(scratch, "docker-config"),
};
mkdirSync(environment.DOCKER_CONFIG, { mode: 0o700 });
function run(args, extra = {}) {
  rmSync(log, { force: true });
  return spawnSync("/bin/bash", [join(root, "deploy-local.sh"), ...args], {
    cwd: root, env: { ...environment, ...extra }, encoding: "utf8",
  });
}
function calls() {
  return existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n").map(line => line.split("\0").filter(Boolean)) : [];
}
after(async () => {
  await new Promise(resolveClose => server.close(resolveClose));
  rmSync(scratch, { recursive: true, force: true });
});

test("help and invalid options do not invoke a runtime or Docker", () => {
  assert.equal(run(["--help"]).status, 0);
  assert.deepEqual(calls(), []);
  for (const args of [["--unknown"], ["--proxy-network"], ["start", "--public-url", "--db-reset"], ["destroy"]]) {
    assert.equal(run(args).status, 2);
    assert.deepEqual(calls(), []);
  }
});

test("installed PowerShell receives the complete canonical parameter contract unchanged", () => {
  executable("pwsh", `printf '%s\\0' "$@" >> "$TEST_LOG"; printf '\\n' >> "$TEST_LOG"; exit 17`);
  try {
    const result = run(["start", "--project", "seha", "--proxy-network", "agent-control-local-ingress",
      "--public-url", "https://control.example.invalid", "--mcp-config", "private config.json", "--configure-mcp",
      "--db-reset", "--force-checks", "--agent-sharing-diagnostics", "--candidate", "candidate.json",
      "--candidate-sha256", "abc", "--expected-preflight", "def", "--read-only"]);
    assert.equal(result.status, 17);
    assert.deepEqual(calls(), [["-NoLogo", "-NoProfile", "-File", join(root, "deploy-local.ps1"),
      "start", "-Project", "seha", "-ProxyNetwork", "agent-control-local-ingress",
      "-PublicUrl", "https://control.example.invalid", "-McpConfig", "private config.json", "-ConfigureMcp",
      "-DbReset", "-ForceChecks", "-AgentSharingDiagnostics", "-Candidate", "candidate.json",
      "-CandidateSha256", "abc", "-ExpectedPreflight", "def", "-ReadOnly"]]);
  } finally { rmSync(join(bin, "pwsh")); }
});

test("incomplete pinned-release metadata fails before Docker access", () => {
  for (const args of [
    ["--read-only"], ["--candidate-sha256", "abc"], ["--expected-preflight", "def"],
    ["--candidate", " \t ", "--read-only"],
  ]) {
    const result = run(args);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.match(result.stderr, /nonempty.*candidate/i);
    assert.deepEqual(calls(), []);
  }
});

test("native Linux bootstraps the same core without host PowerShell and preserves failure status", () => {
  const result = run(["start", "--project", "seha", "--proxy-network", "agent-control-local-ingress"], { TEST_DEPLOY_EXIT: "37" });
  assert.equal(result.status, 37, result.stderr);
  const invocations = calls();
  assert.equal(invocations.filter(args => args[0] === "build").length, 1);
  const container = invocations.find(args => args[0] === "run");
  assert.ok(container);
  assert.equal(container[container.indexOf("--network") + 1], "host");
  assert.equal(container[container.indexOf("--user") + 1], `${process.getuid()}:${process.getgid()}`);
  assert.ok(container.includes(`type=bind,source=${root},target=${root}`));
  assert.ok(container.includes(`type=bind,source=${socket},target=${socket}`));
  assert.ok(container.includes("--read-only") && container.includes("--rm"));
  const coreArguments = ["-File", join(root, "deploy-local.ps1"), "start", "-Project", "seha",
    "-ProxyNetwork", "agent-control-local-ingress"];
  assert.deepEqual(container.slice(-coreArguments.length), coreArguments);
  assert.ok(!container.includes("-DbReset") && !container.includes("-PublicUrl"));
  assert.ok(!container.includes("--privileged") && !container.includes("--detach"));
});

test("a symbolic Docker socket uses the target socket group", () => {
  const link = join(scratch, "socket-link");
  symlinkSync(socket, link);
  const result = run(["check"], {
    DOCKER_HOST: `unix://${link}`, TEST_SOCKET_GID: "9123", TEST_LINK_GID: "9124",
  });
  assert.equal(result.status, 0, result.stderr);
  const container = calls().find(args => args[0] === "run");
  assert.equal(container[container.indexOf("--group-add") + 1], "9123");
});

test("remote engines are refused before helper build or any deployment", () => {
  const result = run(["start"], { DOCKER_HOST: "ssh://foreign-engine" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /local Unix Docker socket/);
  assert.deepEqual(calls(), []);
});

test("ARM64 selects native PowerShell and rootless engines fail before a build", () => {
  const native = run(["check"], { TEST_ARCH: "aarch64" });
  assert.equal(native.status, 0, native.stderr);
  assert.ok(calls().find(args => args[0] === "build").includes("POWERSHELL_BASE=mcr.microsoft.com/powershell:7.5-azurelinux-3.0-arm64"));
  const rootless = run(["start"], { TEST_SECURITY: '["name=rootless"]' });
  assert.equal(rootless.status, 1);
  assert.match(rootless.stderr, /rootless engines are not supported/);
  assert.ok(!calls().some(args => args[0] === "build" || args[0] === "run"));
});

test("external MCP config and its explicit secret inputs are mounted read-only", () => {
  const config = join(scratch, "mcp-config.json");
  const secret = join(scratch, "mcp-client");
  writeFileSync(config, "{}", { mode: 0o600 });
  writeFileSync(secret, "synthetic-credential", { mode: 0o600 });
  chmodSync(config, 0o600);
  const result = run(["start", "--mcp-config", config], { TEST_SECRET_INPUT: secret });
  assert.equal(result.status, 0, result.stderr);
  const containers = calls().filter(args => args[0] === "run");
  assert.equal(containers.length, 2);
  const deployment = containers[1];
  assert.ok(deployment.includes(`type=bind,source=${config},target=${config},readonly`));
  assert.ok(deployment.includes(`type=bind,source=${secret},target=${secret},readonly`));
  assert.ok(!deployment.includes("synthetic-credential"));
});

test("MCP inputs already in the checkout do not overlay writable saved state", () => {
  const directory = join(root, ".local", "agent-control", "secrets");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const config = join(root, "mcp-config.json");
  const secret = join(directory, "mcp-client");
  writeFileSync(config, "{}", { mode: 0o600 });
  writeFileSync(secret, "synthetic-credential", { mode: 0o600 });
  const result = run(["start", "--mcp-config", config], { TEST_SECRET_INPUT: secret });
  assert.equal(result.status, 0, result.stderr);
  const containers = calls().filter(args => args[0] === "run");
  assert.equal(containers.length, 2);
  for (const container of containers) {
    assert.ok(container.includes(`type=bind,source=${root},target=${root}`));
    assert.ok(!container.includes(`type=bind,source=${config},target=${config},readonly`));
    assert.ok(!container.includes(`type=bind,source=${secret},target=${secret},readonly`));
  }
});
