import { describe, expect, it } from "vitest";
import {
  parseBulkActionIds,
  parseDirectorySearchLimit,
  parseActionGroupId,
  parsePackageAccessUpdate,
} from "./agents.js";

describe("parsePackageAccessUpdate", () => {
  it("parses and deduplicates a specific principal update", () => {
    expect(
      parsePackageAccessUpdate({
        target: "availability",
        mode: "add",
        scope: "specific",
        principals: [
          { resourceType: "group", resourceId: "group-1" },
          { resourceType: "group", resourceId: "GROUP-1" },
          { resourceType: "user", resourceId: "user-1" },
        ],
      }),
    ).toEqual({
      target: "availability",
      mode: "add",
      scope: "specific",
      principals: [
        { resourceType: "group", resourceId: "GROUP-1" },
        { resourceType: "user", resourceId: "user-1" },
      ],
    });
  });

  it("accepts replacing a target with no users", () => {
    expect(
      parsePackageAccessUpdate({
        target: "installation",
        mode: "replace",
        scope: "none",
        principals: [],
      }),
    ).toMatchObject({
      target: "installation",
      mode: "replace",
      scope: "none",
      principals: [],
    });
  });

  it("rejects all users until the tenant payload is verified", () => {
    expect(() =>
      parsePackageAccessUpdate({
        target: "availability",
        mode: "replace",
        scope: "all",
        principals: [],
      }),
    ).toThrow("All users has not been verified");
  });

  it("rejects add mode with no users", () => {
    expect(() =>
      parsePackageAccessUpdate({
        target: "availability",
        mode: "add",
        scope: "none",
        principals: [],
      }),
    ).toThrow("No users requires replace mode");
  });
});

describe("parseBulkActionIds", () => {
  it("trims and deduplicates string IDs", () => {
    expect(parseBulkActionIds({ ids: [" P_1 ", "P_1", "P_2"] })).toEqual([
      "P_1",
      "P_2",
    ]);
  });

  it("rejects non-string IDs", () => {
    expect(() => parseBulkActionIds({ ids: ["P_1", { id: "P_2" }] })).toThrow(
      "Each id must be a non-empty string",
    );
  });
});

describe("parseDirectorySearchLimit", () => {
  it("accepts positive integer limits", () => {
    expect(parseDirectorySearchLimit("40")).toBe(40);
    expect(parseDirectorySearchLimit(undefined)).toBeUndefined();
  });

  it("rejects partial, zero, and unsafe limits", () => {
    expect(() => parseDirectorySearchLimit("10abc")).toThrow(
      "positive integer",
    );
    expect(() => parseDirectorySearchLimit("0")).toThrow("positive integer");
    expect(() => parseDirectorySearchLimit("999999999999999999999")).toThrow(
      "positive integer",
    );
  });
});

describe("parseActionGroupId", () => {
  it("accepts a trimmed alphanumeric identifier", () => {
    expect(parseActionGroupId(" a5331a93-1111 ")).toBe("a5331a93-1111");
    expect(parseActionGroupId(undefined)).toBeUndefined();
  });

  it("rejects unqueryable or oversized identifiers", () => {
    expect(() => parseActionGroupId("{a5331a93}")).toThrow(
      "Action group ID is invalid",
    );
    expect(() => parseActionGroupId("a".repeat(65))).toThrow(
      "Action group ID is invalid",
    );
  });
});
