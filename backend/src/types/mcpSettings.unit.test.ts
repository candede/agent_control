import { describe, expect, it } from "vitest";
import { parseBoundedMcpJson, parseMcpSettingsJson } from "./mcpSettings.js";

describe("bounded MCP JSON tokenization", () => {
  it.each([
    ["metadata", parseBoundedMcpJson],
    ["settings", parseMcpSettingsJson],
  ] as const)("rejects unterminated escape-heavy %s without rescanning the string", (_label, parse) => {
    for (const suffix of ["", "\\"]) {
      const raw = '"' + '\\"'.repeat(65_536) + suffix;
      const started = performance.now();
      expect(() => parse(raw)).toThrow(SyntaxError);
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });

  it("ignores escaped quotes and structural characters inside strings", () => {
    const value = { '"[]{}\\': ['"[]{}\\', { value: "\\" }], value: "after" };
    expect(parseBoundedMcpJson(JSON.stringify(value))).toEqual(value);
  });

  it("rejects duplicate decoded keys while allowing the same key in separate objects", () => {
    expect(() => parseBoundedMcpJson('{"value":0,"val\\u0075e":1}')).toThrow(SyntaxError);
    expect(() => parseBoundedMcpJson('{"nested":{"value":0,"val\\u0075e":1}}')).toThrow(SyntaxError);
    expect(parseBoundedMcpJson('[{"value":0},{"value":1}]')).toEqual([{ value: 0 }, { value: 1 }]);
  });
});
