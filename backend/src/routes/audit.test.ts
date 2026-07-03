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
        action: "block",
        status: "failed",
      }),
    ).toEqual({
      limit: 25,
      agentId: "agent-1",
      actorUsername: "admin@example.com",
      action: "block",
      status: "failed",
    });
  });

  it("rejects malformed limits", () => {
    expect(() => parseAuditEventsQuery({ limit: "10abc" })).toThrow(AppError);
    expect(() => parseAuditEventsQuery({ limit: "-1" })).toThrow(AppError);
    expect(() => parseAuditEventsQuery({ limit: "0" })).toThrow(AppError);
  });

  it("rejects unsupported actions and statuses", () => {
    expect(() => parseAuditEventsQuery({ action: "delete" })).toThrow(AppError);
    expect(() => parseAuditEventsQuery({ status: "done" })).toThrow(AppError);
  });
});
