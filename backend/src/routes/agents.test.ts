import { describe, expect, it } from "vitest";
import {
  parseBulkActionIds,
  parseDirectorySearchLimit,
  parseActionGroupId,
  parsePackageAccessUpdate,
  parseMutationScope,
  inventoryPackageDetail,
} from "./agents.js";

const groupId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";

describe("parsePackageAccessUpdate", () => {
  it("parses a specific principal update", () => {
    expect(
      parsePackageAccessUpdate({
        target: "availability",
        mode: "add",
        scope: "specific",
        principals: [
          { resourceType: "group", resourceId: groupId },
          { resourceType: "user", resourceId: userId },
        ],
      }),
    ).toEqual({
      target: "availability",
      mode: "add",
      scope: "specific",
      principals: [
        { resourceType: "group", resourceId: groupId },
        { resourceType: "user", resourceId: userId },
      ],
    });
  });

  it("rejects duplicate principals instead of silently deduplicating", () => {
    expect(() => parsePackageAccessUpdate({
      target: "availability", mode: "replace", scope: "specific",
      principals: [
        { resourceType: "group", resourceId: groupId },
        { resourceType: "group", resourceId: groupId.toUpperCase() },
      ],
    })).toThrow("Duplicate package access principals");
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

  it("rejects all users while Graph has no documented write payload", () => {
    expect(() =>
      parsePackageAccessUpdate({
        target: "availability",
        mode: "replace",
        scope: "all",
        principals: [],
      }),
    ).toThrow("does not document a supported write payload");
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
  it("trims unique string IDs", () => {
    expect(parseBulkActionIds({ ids: [" P_1 ", "P_2"] })).toEqual(["P_1", "P_2"]);
  });

  it("rejects duplicate IDs after normalization", () => {
    expect(() => parseBulkActionIds({ ids: [" P_1 ", "P_1"] })).toThrow(
      "Duplicate package IDs",
    );
  });

  it("rejects non-string IDs", () => {
    expect(() => parseBulkActionIds({ ids: ["P_1", { id: "P_2" }] })).toThrow(
      "Each id must be a non-empty string",
    );
  });
});

describe("parseMutationScope", () => {
  it("keeps mutation cardinality separate from package access scope", () => {
    expect(parseMutationScope("single")).toBe("single");
    expect(parseMutationScope("bulk")).toBe("bulk");
    expect(() => parseMutationScope("specific")).toThrowError(
      expect.objectContaining({ code: "invalid_mutation_scope" }),
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

describe("inventoryPackageDetail", () => {
  it("removes exact assignment principals from Reader inventory", () => {
    expect(inventoryPackageDetail({
      id: "package-1", displayName: "Fixture", isBlocked: false,
      allowedUsersAndGroups: [{ resourceType: "user", resourceId: "sensitive-user" }],
      acquireUsersAndGroups: [{ resourceType: "group", resourceId: "sensitive-group" }],
    })).toEqual({ id: "package-1", displayName: "Fixture", isBlocked: false });
  });
});
