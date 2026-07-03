import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog } from "./auditLog.js";

const tempDirs: string[] = [];
const auditLogs: AuditLog[] = [];

afterEach(() => {
  for (const auditLog of auditLogs.splice(0)) {
    auditLog.close();
  }

  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

describe("AuditLog", () => {
  it("records and completes an audit event", () => {
    const auditLog = createAuditLog();

    const started = auditLog.startEvent({
      operationId: "operation-1",
      scope: "single",
      action: "block",
      targetBlockedState: true,
      agentId: "agent-1",
      agentDisplayName: "Research Agent",
      actor: {
        username: "admin@example.com",
        displayName: "Admin User",
        homeAccountId: "account-1",
        tenantId: "tenant-1",
      },
      requestPath: "/api/agents/agent-1/block",
      metadata: { source: "test" },
    });

    const completed = auditLog.completeEvent(started.id, {
      status: "succeeded",
    });

    expect(completed).toMatchObject({
      id: started.id,
      operationId: "operation-1",
      action: "block",
      targetBlockedState: true,
      agentId: "agent-1",
      agentDisplayName: "Research Agent",
      status: "succeeded",
      actor: {
        username: "admin@example.com",
        displayName: "Admin User",
        homeAccountId: "account-1",
        tenantId: "tenant-1",
      },
      metadata: { source: "test" },
    });
    expect(completed.completedAt).toBeDefined();
  });

  it("filters newest audit events", () => {
    const auditLog = createAuditLog();

    auditLog.startEvent({
      operationId: "operation-1",
      scope: "single",
      action: "block",
      targetBlockedState: true,
      agentId: "agent-1",
      actor: actor("admin@example.com"),
      startedAt: "2026-07-03T10:00:00.000Z",
      requestPath: "/api/agents/agent-1/block",
    });
    auditLog.startEvent({
      operationId: "operation-2",
      scope: "single",
      action: "unblock",
      targetBlockedState: false,
      agentId: "agent-2",
      actor: actor("owner@example.com"),
      startedAt: "2026-07-03T11:00:00.000Z",
      requestPath: "/api/agents/agent-2/unblock",
    });

    const events = auditLog.listEvents({ action: "unblock" });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      operationId: "operation-2",
      action: "unblock",
      agentId: "agent-2",
    });
  });

  it("rejects completion for an unknown audit event", () => {
    const auditLog = createAuditLog();

    expect(() =>
      auditLog.completeEvent("missing-event", { status: "failed" }),
    ).toThrow("Audit event missing-event was not found.");
  });
});

function createAuditLog() {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-control-audit-"));
  tempDirs.push(tempDir);
  const auditLog = new AuditLog(join(tempDir, "audit.sqlite"));
  auditLogs.push(auditLog);
  return auditLog;
}

function actor(username: string) {
  return {
    username,
    displayName: username,
    homeAccountId: `${username}-account`,
  };
}
