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
    ["everyone", "all", "All users"],
    ["availableToAll", "all", "All users"],
    ["installedForSome", "specific", "Specific users or groups"],
    ["deployedToNoOne", "none", "No users"],
    ["deployedToNone", "none", "No users"],
    [" DEPLOYED_TO-NO_ONE ", "none", "No users"],
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

  it.each(["unknownFutureValue", "futureStatus"])("keeps an empty unrecognized response %s unknown", status => {
    expect(getInitialAccessScope(status, [])).toBeUndefined();
    expect(formatAccessScope(status, [])).toBe("Unknown");
  });

  it.each(["all", "none"] as const)("keeps explicit %s scope authoritative over principal entries", status => {
    const principals = [{ resourceType: "group", resourceId: "group-1" }];
    expect(getInitialAccessScope(status, principals)).toBe(status);
    expect(formatAccessScope(status, principals)).toBe(status === "all" ? "All users" : "No users");
  });

  it.each(["unknownFutureValue", "futureStatus"])("preserves principal-based fallback for unknown status %s", status => {
    expect(getInitialAccessScope(status, [{ resourceType: "user", resourceId: "user-1" }])).toBe("specific");
  });
});
