import { describe, expect, it } from "vitest";
import { parseBulkRefSearch } from "./bulkRefSearch";

describe("parseBulkRefSearch", () => {
  it.each([
    ["a5331a93", "a5331a93"],
    ["A5331A93", "a5331a93"],
    [" ref a5331a93 ", "a5331a93"],
  ])("parses %s as a bulk ref", (query, expected) => {
    expect(parseBulkRefSearch(query)).toBe(expected);
  });

  it.each(["", "ref", "agent-1", "a5331a9", "a5331a930", "a5331a9z"])(
    "ignores %s as a bulk ref",
    (query) => {
      expect(parseBulkRefSearch(query)).toBeUndefined();
    },
  );
});
