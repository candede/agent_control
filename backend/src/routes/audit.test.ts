import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { parseAuditEventsQuery } from "./audit.js";

vi.mock("../db/pool.js", () => ({ pool: {}, secretValue: vi.fn() }));

describe("parseAuditEventsQuery", () => {
  it("parses valid audit event filters", () => {
    expect(
      parseAuditEventsQuery({
        limit: "25",
        offset: "50",
        agentId: "agent-1",
        actorUsername: "admin@example.com",
        scope: "bulk",
        action: "block",
        status: "failed",
        operationIdPrefix: "a5331a93",
        search: "Research Agent",
      }),
    ).toEqual({
      limit: 25,
      offset: 50,
      agentId: "agent-1",
      actorUsername: "admin@example.com",
      scope: "bulk",
      action: "block",
      status: "failed",
      operationIdPrefix: "a5331a93",
      search: "Research Agent",
    });
  });

  it.each([
    "requested", "started", "succeeded", "failed", "skipped", "inconclusive", "cancelled",
  ])("accepts the persisted %s audit status", status => {
    expect(parseAuditEventsQuery({ status })).toMatchObject({ status });
  });

  it("rejects malformed limits", () => {
    expect(() => parseAuditEventsQuery({ limit: "10abc" })).toThrow(AppError);
    expect(() => parseAuditEventsQuery({ limit: "-1" })).toThrow(AppError);
    expect(() => parseAuditEventsQuery({ limit: "0" })).toThrow(AppError);
  });

  it("rejects malformed offsets", () => {
    expect(() => parseAuditEventsQuery({ offset: "10abc" })).toThrow(AppError);
    expect(() => parseAuditEventsQuery({ offset: "-1" })).toThrow(AppError);
    expect(() => parseAuditEventsQuery({ offset: "100001" })).toThrow(AppError);
    expect(parseAuditEventsQuery({ offset: "100000" }).offset).toBe(100000);
  });

  it("rejects unsupported actions, statuses, and scopes", () => {
    expect(() => parseAuditEventsQuery({ action: "delete" })).toThrow(AppError);
    expect(() => parseAuditEventsQuery({ status: "done" })).toThrow(AppError);
    expect(() => parseAuditEventsQuery({ scope: "team" })).toThrow(AppError);
  });

  it("rejects invalid operation id prefixes", () => {
    expect(() =>
      parseAuditEventsQuery({ operationIdPrefix: "a5331a93%" }),
    ).toThrow(AppError);
  });

  it("accepts the same literal operation prefix grammar as inventory reference filters", () => {
    expect(parseAuditEventsQuery({ operationIdPrefix: " REF_CASE-1 " }).operationIdPrefix).toBe("REF_CASE-1");
  });

  it("rejects overlong search values", () => {
    expect(parseAuditEventsQuery({ search: "a".repeat(200) }).search).toHaveLength(200);
    expect(() => parseAuditEventsQuery({ search: "a".repeat(201) })).toThrow(
      AppError,
    );
  });
});
