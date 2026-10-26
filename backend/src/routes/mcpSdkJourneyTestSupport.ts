import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { apiToken, account, jwk } from "../auth/authFoundationTestSupport.js";
import type { setupAuditOriginHttp } from "./auditOriginHttpTestSupport.js";

export type SdkCall = { name: string; request: Record<string, unknown>; expected?: unknown };

export async function sdkJourney(fixture: Awaited<ReturnType<typeof setupAuditOriginHttp>>, calls: SdkCall[]) {
  const python = process.env.AGENT_CONTROL_MCP_SQL_JOURNEY;
  if (python !== "/opt/mcp/.venv/bin/python" || process.env.AGENT_CONTROL_ISOLATED_TESTS !== "1"
    || process.env.PGHOST !== "127.0.0.1" || process.env.PGDATABASE !== "agentcontrol_test_control") throw new Error("Exact isolated SDK/SQL fixture required.");
  const payload = { url: fixture.base, client: fixture.integrationClientId, oid: account().localAccountId, jwk: { ...jwk, kid: "sdk-api-fixture" },
    token: apiToken({ roles: ["AgentControl.Viewer", "AgentControl.Admin"], azp: fixture.integrationClientId }, "sdk-api-fixture"),
    state: `/evidence/mcp-sql-${randomUUID()}`, calls };
  const child = spawn(python, ["/opt/mcp/tests/sql_journey.py"], {
    env: { PATH: process.env.PATH, HOME: "/evidence", TMPDIR: "/evidence", PYTHONDONTWRITEBYTECODE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let bytes = 0;
  const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) child.kill("SIGTERM");
    else stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => { if (stderr.reduce((sum, item) => sum + item.length, 0) < 16384) stderr.push(chunk); });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(
        `SDK SQL journey failed: exit=${code},signal=${signal}; ${Buffer.concat(stderr).toString("utf8")}`)));
      child.stdin.end(JSON.stringify(payload));
    });
    const result: { results: unknown[]; trace: Array<{ tool: string; status: number; bytes: number; seconds: number }> } =
      JSON.parse(Buffer.concat(stdout).toString("utf8"));
    if (result.results.length !== calls.length) throw new Error("Incomplete SDK SQL journey.");
    console.info("mcp_sql_sdk_journey", JSON.stringify({ calls: result.trace, count: calls.length }));
    return result.results;
  } finally { clearTimeout(timer); }
}
