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

  it("records failure messages and error codes", () => {
    const auditLog = createAuditLog();

    const started = auditLog.startEvent({
      operationId: "operation-1",
      scope: "single",
      action: "unblock",
      targetBlockedState: false,
      agentId: "agent-1",
      actor: actor("admin@example.com"),
      requestPath: "/api/agents/agent-1/unblock",
    });

    const completed = auditLog.completeEvent(started.id, {
      status: "failed",
      message: "Insufficient privileges to complete the operation.",
      errorCode: "Authorization_RequestDenied",
      metadata: {
        errorDetails: {
          graph: {
            error: {
              code: "Authorization_RequestDenied",
              message: "Insufficient privileges to complete the operation.",
            },
          },
        },
      },
    });

    expect(completed).toMatchObject({
      status: "failed",
      message: "Insufficient privileges to complete the operation.",
      errorCode: "Authorization_RequestDenied",
      metadata: {
        errorDetails: {
          graph: {
            error: {
              code: "Authorization_RequestDenied",
              message: "Insufficient privileges to complete the operation.",
            },
          },
        },
      },
    });
  });

  it("serializes non-JSON metadata without masking audit completion", () => {
    const auditLog = createAuditLog();
    const circularMetadata: Record<string, unknown> = {
      retryAfterMs: 1000n,
      cause: new Error("Graph payload unavailable"),
    };
    circularMetadata.self = circularMetadata;

    const started = auditLog.startEvent({
      operationId: "operation-1",
      scope: "single",
      action: "block",
      targetBlockedState: true,
      agentId: "agent-1",
      actor: actor("admin@example.com"),
      requestPath: "/api/agents/agent-1/block",
    });

    const completed = auditLog.completeEvent(started.id, {
      status: "failed",
      metadata: circularMetadata,
    });

    expect(completed.metadata).toMatchObject({
      retryAfterMs: "1000",
      cause: {
        name: "Error",
        message: "Graph payload unavailable",
      },
      self: "[Circular]",
    });
  });

  it("records a serialization error when metadata cannot be stringified", () => {
    const auditLog = createAuditLog();
    const started = auditLog.startEvent({
      operationId: "operation-1",
      scope: "single",
      action: "block",
      targetBlockedState: true,
      agentId: "agent-1",
      actor: actor("admin@example.com"),
      requestPath: "/api/agents/agent-1/block",
    });

    const completed = auditLog.completeEvent(started.id, {
      status: "failed",
      metadata: {
        payload: {
          toJSON() {
            throw new Error("broken serializer");
          },
        },
      },
    });

    expect(completed.metadata).toEqual({
      serializationError: "broken serializer",
    });
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

  it("paginates audit events and counts the filtered result", () => {
    const auditLog = createAuditLog();

    for (let index = 0; index < 5; index += 1) {
      auditLog.startEvent({
        operationId: `operation-${index}`,
        scope: "single",
        action: index % 2 === 0 ? "block" : "unblock",
        targetBlockedState: index % 2 === 0,
        agentId: `agent-${index}`,
        actor: actor("admin@example.com"),
        startedAt: `2026-07-03T10:0${index}:00.000Z`,
        requestPath: `/api/agents/agent-${index}/block`,
      });
    }

    const query = { action: "block" as const, limit: 2, offset: 1 };
    const events = auditLog.listEvents(query);

    expect(auditLog.countEvents(query)).toBe(3);
    expect(events.map((event) => event.agentId)).toEqual([
      "agent-2",
      "agent-0",
    ]);
  });

  it("searches audit events before paginating", () => {
    const auditLog = createAuditLog();

    auditLog.startEvent({
      operationId: "operation-1",
      scope: "single",
      action: "block",
      targetBlockedState: true,
      agentId: "agent-1",
      agentDisplayName: "Research Agent",
      actor: actor("admin@example.com"),
      startedAt: "2026-07-03T10:00:00.000Z",
      requestPath: "/api/agents/agent-1/block",
    });
    auditLog.startEvent({
      operationId: "operation-2",
      scope: "single",
      action: "block",
      targetBlockedState: true,
      agentId: "agent-2",
      agentDisplayName: "Sales Agent",
      actor: actor("owner@example.com"),
      startedAt: "2026-07-03T10:01:00.000Z",
      requestPath: "/api/agents/agent-2/block",
    });

    const query = { search: "research", limit: 1, offset: 0 };
    const events = auditLog.listEvents(query);

    expect(auditLog.countEvents(query)).toBe(1);
    expect(events[0]).toMatchObject({ agentId: "agent-1" });
  });

  it("filters bulk audit events by operation id prefix", () => {
    const auditLog = createAuditLog();

    auditLog.startEvent({
      operationId: "a5331a93-1111-4222-8333-111111111111",
      scope: "bulk",
      action: "block",
      targetBlockedState: true,
      agentId: "agent-1",
      actor: actor("admin@example.com"),
      startedAt: "2026-07-03T10:00:00.000Z",
      requestPath: "/api/agents/block",
    });
    auditLog.startEvent({
      operationId: "a5331a93-1111-4222-8333-111111111111",
      scope: "bulk",
      action: "block",
      targetBlockedState: true,
      agentId: "agent-2",
      actor: actor("admin@example.com"),
      startedAt: "2026-07-03T10:01:00.000Z",
      requestPath: "/api/agents/block",
    });
    auditLog.startEvent({
      operationId: "b6442b04-1111-4222-8333-111111111111",
      scope: "bulk",
      action: "block",
      targetBlockedState: true,
      agentId: "agent-3",
      actor: actor("admin@example.com"),
      startedAt: "2026-07-03T10:02:00.000Z",
      requestPath: "/api/agents/block",
    });
    auditLog.startEvent({
      operationId: "a5331a93-1111-4222-8333-111111111111",
      scope: "single",
      action: "block",
      targetBlockedState: true,
      agentId: "agent-4",
      actor: actor("admin@example.com"),
      startedAt: "2026-07-03T10:03:00.000Z",
      requestPath: "/api/agents/agent-4/block",
    });

    const events = auditLog.listEvents({
      scope: "bulk",
      operationIdPrefix: "a5331a93",
    });

    expect(events.map((event) => event.agentId)).toEqual([
      "agent-2",
      "agent-1",
    ]);
  });

  it("treats operation id prefix wildcards as literal characters", () => {
    const auditLog = createAuditLog();

    auditLog.startEvent({
      operationId: "batch_100",
      scope: "bulk",
      action: "block",
      targetBlockedState: true,
      agentId: "agent-1",
      actor: actor("admin@example.com"),
      startedAt: "2026-07-03T10:00:00.000Z",
      requestPath: "/api/agents/block",
    });
    auditLog.startEvent({
      operationId: "batchA100",
      scope: "bulk",
      action: "block",
      targetBlockedState: true,
      agentId: "agent-2",
      actor: actor("admin@example.com"),
      startedAt: "2026-07-03T10:01:00.000Z",
      requestPath: "/api/agents/block",
    });

    const events = auditLog.listEvents({ operationIdPrefix: "batch_" });

    expect(events.map((event) => event.agentId)).toEqual(["agent-1"]);
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
