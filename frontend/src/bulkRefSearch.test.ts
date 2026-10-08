import { describe, expect, it } from "vitest";
import { parseBulkRefSearch } from "./bulkRefSearch";

describe("parseBulkRefSearch", () => {
  it.each([
    ["a5331a93", "a5331a93"],
    ["A5331A93", "a5331a93"],
    [" ref a5331a93 ", "a5331a93"],
    [" REF A5331A93 ", "a5331a93"],
    ["Ref\t00000000", "00000000"],
    ["\nref  FFFFFFFF\r\n", "ffffffff"],
    ["12345678", "12345678"],
  ])("parses %s as a bulk ref", (query, expected) => {
    expect(parseBulkRefSearch(query)).toBe(expected);
  });

  it.each([
    "", " ", "ref", "agent-1", "a5331a9", "a5331a930", "a5331a9z",
    "refa5331a93", "ref: a5331a93", "ref ref a5331a93", "a5331a93 extra",
    "prefix a5331a93", "a5331a93%", "a5331a93\0", "ａ５３３１ａ９３",
    "a5331a93-1234-4123-8123-123456789abc",
  ])(
    "ignores %s as a bulk ref",
    (query) => {
      expect(parseBulkRefSearch(query)).toBeUndefined();
    },
  );
});
