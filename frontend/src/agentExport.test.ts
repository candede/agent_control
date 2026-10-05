import { describe, expect, it } from "vitest";
import { maximumExplicitAgentReferences, selectedAgentExportReferences } from "./agentExport";

describe("unified agent export references", () => {
  const canonical = "agent:11111111-1111-4111-8111-111111111111";
  const nativeKey = "power_platform:env%2Fa:native%2Fone";
  const record = {
    id: canonical,
    packages: [{ id: "opaque/package%one" }, { id: "opaque:package-two" }],
    powerPlatformResource: { environmentId: "env/a", nativeId: "native/one" },
  };

  it("uses an observed canonical row for selected package/native members without losing off-page references", () => {
    const selected = new Set(["opaque/package%one", "opaque:package-two", "offpage/package"]);
    const native = new Set([nativeKey, "power_platform:other-env:other-native"]);
    expect(selectedAgentExportReferences([record], selected, native)).toEqual([
      canonical, "graph_packages:offpage%2Fpackage", "power_platform:other-env:other-native",
    ]);
    expect([...selected]).toEqual(["opaque/package%one", "opaque:package-two", "offpage/package"]);
    expect([...native]).toEqual([nativeKey, "power_platform:other-env:other-native"]);
  });

  it("does not infer joins from names or arbitrarily choose ambiguous source ownership", () => {
    const other = { ...record, id: "agent:22222222-2222-4222-8222-222222222222", displayName: "Same name" };
    const records = [{ ...record, displayName: "Same name" }, other];
    expect(selectedAgentExportReferences(records, ["opaque/package%one"], [])).toEqual(["graph_packages:opaque%2Fpackage%25one"]);
    const separate = [records[0], { ...other, packages: [{ id: "unrelated-package" }], powerPlatformResource: null }];
    expect(selectedAgentExportReferences(separate, ["opaque/package%one", "unrelated-package"], [])).toEqual([canonical, other.id]);
    expect(selectedAgentExportReferences([{ ...record, id: nativeKey }], record.packages.map(item => item.id), [nativeKey])).toEqual([
      "graph_packages:opaque%2Fpackage%25one", "graph_packages:opaque%3Apackage-two", nativeKey,
    ]);
  });

  it("keeps opaque package IDs source-qualified even when they resemble canonical IDs", () => {
    expect(selectedAgentExportReferences([], [canonical], [canonical])).toEqual([
      `graph_packages:${encodeURIComponent(canonical)}`, canonical,
    ]);
    expect(() => selectedAgentExportReferences([], [""], [])).toThrow();
    expect(() => selectedAgentExportReferences([], [], ["unqualified-native"])).toThrow(/exact canonical or Power Platform reference/);
  });

  it("does not truncate a maximum-size selected package set", () => {
    const ids = Array.from({ length: maximumExplicitAgentReferences }, (_, index) => `package-${index}`);
    const refs = selectedAgentExportReferences([], ids, []);
    expect(refs).toHaveLength(5_000);
    expect(refs.at(-1)).toBe("graph_packages:package-4999");
    expect(() => selectedAgentExportReferences([], [...ids, "over-limit"], [])).toThrow(/at most 5,000/);
  });
});
