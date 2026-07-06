import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { parseAuditEventsQuery } from "./audit.js";

describe("parseAuditEventsQuery", () => {
  it("parses valid audit event filters", () => {
    expect(
      parseAuditEventsQuery({
        limit: "25",
        agentId: "agent-1",
        actorUsername: "admin@example.com",
        scope: "bulk",
        action: "block",
        status: "failed",
        operationIdPrefix: "a5331a93",
      }),
    ).toEqual({
      limit: 25,
      agentId: "agent-1",
      actorUsername: "admin@example.com",
      scope: "bulk",
      action: "block",
      status: "failed",
      operationIdPrefix: "a5331a93",
    });
  });

  it("rejects malformed limits", () => {
    expect(() => parseAuditEventsQuery({ limit: "10abc" })).toThrow(AppError);
    expect(() => parseAuditEventsQuery({ limit: "-1" })).toThrow(AppError);
    expect(() => parseAuditEventsQuery({ limit: "0" })).toThrow(AppError);
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
});
