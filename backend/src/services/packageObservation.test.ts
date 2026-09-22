import { describe, expect, it, vi } from "vitest";
import { GraphPackagesClient, verifyPackageMutationConverged } from "./graphPackages.js";
import { allowlistedPackage } from "./packageObservation.js";
import { capturePackageMutationState } from "./packageMutationState.js";
import { normalizePackageStatus } from "../types/copilotPackage.js";

const base = { id: "package", displayName: "Package", isBlocked: false };
const access = { ...base, availableTo: "none", deployedTo: "none", allowedUsersAndGroups: [], acquireUsersAndGroups: [] };

describe("complete package observations", () => {
  it.each(["availableTo", "deployedTo"] as const)("does not truncate %s into a recognized access scope", async field => {
    const status = "all".padEnd(4096, "-") + "future";
    expect(normalizePackageStatus(status)).toBeUndefined();
    const fetcher = vi.fn(async () => Response.json({ ...access, [field]: status }));
    const client = new GraphPackagesClient(fetcher);
    const action = field === "availableTo" ? "update-availability" : "update-installation";
    const expected = capturePackageMutationState(allowlistedPackage({ ...access, [field]: "all" }), action);

    await expect(verifyPackageMutationConverged(client, "fixture-token", base.id, action, expected, { maxAttempts: 1 }))
      .rejects.toMatchObject({ status: 502, code: "provider_schema" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["type", "publisher", "availableTo", "deployedTo", "platform", "version", "manifestVersion", "sensitivity"] as const)(
    "preserves complete bounded %s values and rejects oversized ones",
    field => {
      const value = "x".repeat(4096);
      expect(allowlistedPackage({ ...base, [field]: value })[field]).toBe(value);
      expect(() => allowlistedPackage({ ...base, [field]: value + "different-suffix" }))
        .toThrow(expect.objectContaining({ code: "provider_schema" }));
      for (const malformed of [false, 123, {}, []]) {
        expect(() => allowlistedPackage({ ...base, [field]: malformed }))
          .toThrow(expect.objectContaining({ code: "provider_schema" }));
      }
    },
  );

  it("retains raw future scopes and complete version markers without normalization", () => {
    const value = allowlistedPackage({
      ...base, availableTo: "FutureStatus", deployedTo: " DEPLOYED_TO-NO_ONE ",
      platform: "Copilot Studio", version: "2.0.0-preview.1", manifestVersion: "1.17",
    });
    expect(value).toMatchObject({
      availableTo: "FutureStatus", deployedTo: " DEPLOYED_TO-NO_ONE ",
      platform: "Copilot Studio", authoringTool: "Copilot Studio",
      version: "2.0.0-preview.1", manifestVersion: "1.17",
      provenance: { authoringTool: { sourceSystem: "graph_packages", path: "platform", maturity: "ga" } },
    });
  });

  it.each(["supportedHosts", "elementTypes", "categories"] as const)(
    "retains the complete bounded %s collection instead of dropping or shortening entries",
    field => {
      const values = [...Array<string>(99).fill("x".repeat(256)), "FutureFacet"];
      expect(allowlistedPackage({ ...base, [field]: values })[field]).toEqual(values);
      for (const invalid of [[...values, "DeclarativeCopilots"], ["x".repeat(257)], ["Copilot", 42], "Copilot"]) {
        expect(() => allowlistedPackage({ ...base, [field]: invalid }))
          .toThrow(expect.objectContaining({ code: "provider_schema" }));
      }
      expect(allowlistedPackage({ ...base, [field]: [] })[field]).toEqual([]);
      expect(allowlistedPackage({ ...base, [field]: null })[field]).toBeUndefined();
    },
  );

  it.each(["catalog", "inventory", "detail"])("rejects lossy package observations at the Graph %s boundary", async operation => {
    const invalid = { ...base, elementTypes: [...Array<string>(100).fill("Bots"), "DeclarativeCopilots"] };
    const fetcher = vi.fn(async () => Response.json(operation === "detail" ? invalid : { value: [invalid] }));
    const client = new GraphPackagesClient(fetcher);
    const observation = operation === "catalog" ? client.checkCatalogAccess("fixture-token")
      : operation === "inventory" ? client.listCopilotAgents("fixture-token")
        : client.getPackageDetails("fixture-token", base.id);
    await expect(observation).rejects.toMatchObject({ status: 502, code: "provider_schema" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("persistable package text", () => {
  it.each([
    { field: "displayName", limit: 256 },
    { field: "shortDescription", limit: 4096 },
    { field: "longDescription", limit: 32768 },
  ] as const)("bounds $field without splitting Unicode characters", ({ field, limit }) => {
    const prefix = "x".repeat(limit - 1);
    expect(allowlistedPackage({ ...base, [field]: prefix + "😀tail" })[field]).toBe(prefix);
    const complete = "x".repeat(limit - 2) + "😀";
    expect(allowlistedPackage({ ...base, [field]: complete + "tail" })[field]).toBe(complete);
    expect(allowlistedPackage({ ...base, [field]: "x".repeat(limit + 1) })[field]).toBe("x".repeat(limit));
  });

  it.each([
    { label: "NUL", text: "a\0b" },
    { label: "lone high surrogate", text: "a\uD83Db" },
    { label: "lone low surrogate", text: "a\uDE00b" },
  ])("rejects $label before text or JSONB publication", ({ text }) => {
    const fields: Record<string, unknown>[] = [
      ...["id", "displayName", "shortDescription", "longDescription", "platform", "publisher", "manifestId", "appId", "assetId"]
        .map(field => ({ [field]: text })),
      { supportedHosts: [text] },
      { allowedUsersAndGroups: [{ resourceId: text, resourceType: "user" }] },
      { acquireUsersAndGroups: [{ resourceId: "user-id", resourceType: text }] },
      { elementDetails: [{ elementType: text, elements: [] }] },
      { elementDetails: [{ elementType: "Bots", elements: [{ id: text, definition: "{}" }] }] },
      { elementDetails: [{ elementType: "Bots", elements: [{ id: "", definition: text }] }] },
    ];
    for (const field of fields) {
      expect(() => allowlistedPackage({ ...base, ...field })).toThrow(expect.objectContaining({ code: "provider_schema" }));
    }
  });

  it("preserves valid Unicode and escaped definition content", () => {
    const text = "Package 😀";
    const definition = JSON.stringify({ description: "escaped\0text\uD83D" });
    expect(allowlistedPackage({
      ...base, id: text, displayName: text, manifestId: text, supportedHosts: [text],
      elementDetails: [{ elementType: "Bots", elements: [{ id: "", definition }] }],
    })).toMatchObject({
      id: text, displayName: text, manifestId: text, supportedHosts: [text],
      elementDetails: [{ elementType: "Bots", elements: [{ id: "", definition }] }],
    });
  });
});

describe("package observation timestamps", () => {
  it.each(["createdDateTime", "lastModifiedDateTime"] as const)("validates %s without losing precision or offset", field => {
    for (const value of [
      "2026-09-22T12:30:45Z", "2024-02-29T12:30:45.1234567Z", "2026-09-22T12:30:45.123456789+05:30",
      "2026-09-22T12:30:45-14:00", "0001-01-01T00:00:00Z",
    ]) {
      expect(allowlistedPackage({ ...base, [field]: value })[field]).toBe(value);
    }
    for (const value of [undefined, null, ""]) {
      expect(allowlistedPackage({ ...base, [field]: value })[field]).toBeUndefined();
    }
  });

  it.each(["createdDateTime", "lastModifiedDateTime"] as const)("rejects malformed %s before persistence or sorting", field => {
    for (const value of [
      "not-a-date", "2026-09-22", "2026-09-22T12:30:45", "2026-02-29T12:30:45Z", "2026-04-31T12:30:45Z",
      "2026-13-01T12:30:45Z", "2026-09-22T24:00:00Z", "2026-09-22T12:60:45Z", "2026-09-22T12:30:60Z",
      "2026-09-22T12:30:45+14:01", "0000-01-01T00:00:00Z", 123, {}, [],
    ]) {
      expect(() => allowlistedPackage({ ...base, [field]: value })).toThrow(expect.objectContaining({ code: "provider_schema" }));
    }
  });
});
