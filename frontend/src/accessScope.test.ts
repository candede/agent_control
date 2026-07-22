import { describe, expect, it } from "vitest";
import { formatAccessScope, getInitialAccessScope } from "./accessScope";

describe("access scope", () => {
  it.each([
    ["all", "all", "All users"],
    ["allowedForAll", "all", "All users"],
    ["some", "specific", "Specific users or groups"],
    ["allowedForSome", "specific", "Specific users or groups"],
    ["none", "none", "No users"],
    ["allowedForNoOne", "none", "No users"],
  ] as const)("maps %s to %s", (status, scope, label) => {
    expect(getInitialAccessScope(status, [])).toBe(scope);
    expect(formatAccessScope(status, [])).toBe(label);
  });

  it("uses explicit principals when the status is missing", () => {
    const principals = [{ resourceType: "group", resourceId: "group-1" }];

    expect(getInitialAccessScope(undefined, principals)).toBe("specific");
    expect(formatAccessScope(undefined, principals)).toBe(
      "Specific users or groups",
    );
  });

  it("keeps an empty unrecognized response unknown", () => {
    expect(getInitialAccessScope("unknownFutureValue", [])).toBeUndefined();
    expect(formatAccessScope("unknownFutureValue", [])).toBe("Unknown");
  });
});
