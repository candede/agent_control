import { describe, expect, it, vi } from "vitest";
import { tinyGraphCatalog } from "./inventoryProviderTestSupport.js";
import { GraphPackagesClient, verifyPackageMutationConverged } from "./graphPackages.js";
import { allowlistedPackage } from "./packageObservation.js";
import { capturePackageMutationState } from "./packageMutationState.js";
import { normalizePackageStatus } from "../types/copilotPackage.js";
import { dataLimits } from "../db/dataBounds.js";

const base = { id: "package", displayName: "Package", isBlocked: false };
const access = { ...base, availableTo: "none", deployedTo: "none", allowedUsersAndGroups: [], acquireUsersAndGroups: [] };

describe("complete package observations", () => {
  it("retains non-enumerable own evidence without turning a supplied unknown scope into inferred access", () => {
    const observation = { ...access, allowedUsersAndGroups: [{ resourceId: "Opaque_User", resourceType: "USER" }] };
    Object.defineProperty(observation, "availableTo", { value: "FutureScope", enumerable: false });
    expect(allowlistedPackage(observation).availableTo).toBe("FutureScope");
    const timestamp = "2026-10-01T12:00:00.123456789+05:30";
    Object.defineProperties(observation, {
      id: { value: " Exact_Package ", enumerable: false },
      lastModifiedDateTime: { value: timestamp },
      elementDetails: { value: [Object.defineProperties({}, {
        elementType: { value: "Bots" },
        elements: { value: [Object.defineProperties({}, {
          id: { value: " Exact_Element " }, definition: { value: "{}" },
        })] },
      })] },
    });
    const saved = allowlistedPackage(observation);
    expect(saved).toMatchObject({
      id: " Exact_Package ", availableTo: "FutureScope", lastModifiedDateTime: timestamp,
      allowedUsersAndGroups: observation.allowedUsersAndGroups,
      elementDetails: [{ elementType: "Bots", elements: [{ id: " Exact_Element ", definition: "{}" }] }],
    });
    expect(() => capturePackageMutationState(saved, "update-availability"))
      .toThrow(expect.objectContaining({ code: "ambiguous_access_scope" }));
  });

  it("rejects non-enumerable accessors instead of silently omitting supplied evidence", () => {
    const getter = vi.fn(() => "FutureScope");
    const observation = { ...access };
    Object.defineProperty(observation, "availableTo", { get: getter, enumerable: false });
    expect(() => allowlistedPackage(observation)).toThrow(expect.objectContaining({ code: "provider_schema" }));
    expect(getter).not.toHaveBeenCalled();
  });

  it("requires own observation identity and child fields instead of inheriting provider evidence", () => {
    expect(() => allowlistedPackage(Object.create(base))).toThrow(expect.objectContaining({ code: "provider_schema" }));
    for (const elementDetails of [
      [Object.create({ elementType: "Bots", elements: [] })],
      [{ elementType: "Bots", elements: [Object.create({ id: "bot", definition: "{}" })] }],
      Array(1),
      [{ elementType: "Bots", elements: Array(1) }],
    ]) {
      expect(() => allowlistedPackage({ ...base, elementDetails })).toThrow(expect.objectContaining({ code: "provider_schema" }));
    }
    const inherited = Object.assign(Object.create({ manifestId: "inherited-manifest", elementTypes: ["DeclarativeCopilots"] }), base);
    const observed = allowlistedPackage(inherited);
    expect(observed).not.toHaveProperty("manifestId");
    expect(observed).not.toHaveProperty("elementTypes");
    expect(() => allowlistedPackage({ ...access, allowedUsersAndGroups: [Object.create({ resourceId: "inherited-user", resourceType: "user" })] }))
      .toThrow(expect.objectContaining({ code: "provider_schema" }));
    const getter = vi.fn(() => "inherited-manifest");
    const accessor = { ...base };
    Object.defineProperty(accessor, "manifestId", { get: getter, enumerable: true });
    expect(() => allowlistedPackage(accessor)).toThrow(expect.objectContaining({ code: "provider_schema" }));
    expect(getter).not.toHaveBeenCalled();
    const entryGetter = vi.fn(() => ({ elementType: "Bots", elements: [] }));
    const elementDetails = Array(1);
    Object.defineProperty(elementDetails, 0, { get: entryGetter });
    expect(() => allowlistedPackage({ ...base, elementDetails })).toThrow(expect.objectContaining({ code: "provider_schema" }));
    expect(entryGetter).not.toHaveBeenCalled();
  });

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
      : operation === "inventory" ? tinyGraphCatalog(client, "fixture-token")
        : client.getPackageDetails("fixture-token", base.id);
    await expect(observation).rejects.toMatchObject({ status: 502, code: "provider_schema" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("unambiguous package response JSON", () => {
  const jsonMembers = `"id":"package","displayName":"Package","isBlocked":false`;
  const duplicates = [
    `"id":"other",${jsonMembers}`,
    `${jsonMembers},"isBlocked":true`,
    `${jsonMembers},"manifestId":"other","manifest\\u0049d":"manifest"`,
    `${jsonMembers},"availableTo":"none","availableTo":"all"`,
    `${jsonMembers},"lastModifiedDateTime":"invalid","lastModifiedDateTime":"2026-10-01T12:00:00.123456789+05:30"`,
    `${jsonMembers},"supportedHosts":["Copilot"],"supportedHosts":[]`,
    `${jsonMembers},"@odata.type":"#unsupported","@odata.type":"#microsoft.graph.copilotPackage"`,
    `${jsonMembers},"allowedUsersAndGroups":[],"allowedUsersAndGroups":[{"resourceId":"user","resourceType":"user"}]`,
    `${jsonMembers},"allowedUsersAndGroups":[{"resourceId":"other","resourceId":"user","resourceType":"user"}]`,
    `${jsonMembers},"acquireUsersAndGroups":[{"resourceId":"user","resourceType":"group","resourceType":"user"}]`,
    `${jsonMembers},"elementDetails":[{"elementType":"Bots","elementType":"AgentMetadatas","elements":[]}]`,
    `${jsonMembers},"elementDetails":[{"elementType":"Bots","elements":[],"elements":[{"id":"bot","definition":"{}"}]}]`,
    `${jsonMembers},"elementDetails":[{"elementType":"Bots","elements":[{"id":"other","id":"bot","definition":"{}"}]}]`,
    `${jsonMembers},"elementDetails":[{"elementType":"Bots","elements":[{"id":"bot","definition":"{}","definition":"{\\"botId\\":\\"other\\"}"}]}]`,
    `"ignored":${"[".repeat(32)}0${"]".repeat(32)},${jsonMembers},"id":"package"`,
  ];

  it.each(["catalog", "inventory", "detail"])("rejects repeated contract members at the Graph %s boundary", async operation => {
    for (const members of duplicates) {
      const packageJson = `{${members}}`;
      const body = operation === "detail" ? packageJson : `{"value":[${packageJson}]}`;
      const fetcher = vi.fn(async () => new Response(body));
      const client = new GraphPackagesClient(fetcher);
      const observation = operation === "catalog" ? client.checkCatalogAccess("fixture-token")
        : operation === "inventory" ? tinyGraphCatalog(client, "fixture-token")
          : client.getPackageDetails("fixture-token", base.id);
      await expect(observation).rejects.toMatchObject({ status: 502, code: "provider_schema" });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it.each([
    `{"value":[{${jsonMembers}}],"value":[]}`,
    `{"value":[{${jsonMembers}}],"@odata.count":2,"@odata.count":1}`,
    `{"value":[{${jsonMembers}}],"@odata.nextLink":"https://invalid.example/other","@odata.nextLink":"https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages?$filter=supportedHosts%2Fany(h%3Ah%20eq%20'Copilot')&$skiptoken=next"}`,
  ])("rejects overwritten catalog completion evidence", async body => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(body)).mockResolvedValue(Response.json({ value: [] }));
    const client = new GraphPackagesClient(fetcher);
    await expect(tinyGraphCatalog(client, "fixture-token")).rejects.toMatchObject({ status: 502, code: "provider_schema" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["block", "update-availability"] as const)("does not qualify %s convergence using overwritten control evidence", async action => {
    const expected = capturePackageMutationState(allowlistedPackage({
      ...access, isBlocked: true, availableTo: "some",
      allowedUsersAndGroups: [{ resourceId: "user", resourceType: "user" }],
    }), action);
    const body = action === "block" ? `{${jsonMembers},"isBlocked":true}`
      : `{${jsonMembers},"availableTo":"none","availableTo":"some","deployedTo":"none",
        "allowedUsersAndGroups":[{"resourceId":"user","resourceType":"user"}],"acquireUsersAndGroups":[]}`;
    const fetcher = vi.fn(async () => new Response(body));
    const client = new GraphPackagesClient(fetcher);
    await expect(verifyPackageMutationConverged(client, "fixture-token", base.id, action, expected, { maxAttempts: 1 }))
      .rejects.toMatchObject({ status: 502, code: "provider_schema" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not treat unrelated fields, repeated authoring members, or escaped text as package evidence", async () => {
    const definition = '{"description":"first","description":"last","nested":{"id":"first","id":"last"}}';
    const body = `{${jsonMembers},"ignored":{"id":"first","id":"last"},"ignored":null,
      "longDescription":"quoted \\"id\\": { braces [ and escaped \\\\ text",
      "elementDetails":[{"elementType":"DeclarativeCopilots","elements":[{"id":"","definition":${JSON.stringify(definition)}}]}]}`;
    const client = new GraphPackagesClient(async () => new Response(body));
    await expect(client.getPackageDetails("fixture-token", base.id)).resolves.toMatchObject({
      ...base, elementDetails: [{ elementType: "DeclarativeCopilots", elements: [{ id: "", definition }] }],
    });
  });
});

describe("persistable package text", () => {
  it.each(["allowedUsersAndGroups", "acquireUsersAndGroups"] as const)(
    "rejects controls and unsupported principal types in %s before observation or mutation hashing", field => {
      for (const control of ["\0", "\t", "\n", "\u001b", "\u001f", "\u007f", "\u0085", "\u009f"]) {
        for (const principal of [
          { resourceId: `Opaque${control}Id`, resourceType: "user" },
          { resourceId: "OpaqueId", resourceType: `gr${control}oup` },
        ]) {
          expect(() => allowlistedPackage({ ...access, [field]: [principal] }))
            .toThrow(expect.objectContaining({ code: "provider_schema" }));
        }
      }
      for (const resourceType of ["servicePrincipal", "device", "futureType", "user:group", " ", " user "]) {
        expect(() => allowlistedPackage({ ...access, [field]: [{ resourceId: "OpaqueId", resourceType }] }))
          .toThrow(expect.objectContaining({ code: "provider_schema" }));
      }
      expect(() => allowlistedPackage({ ...access, [field]: [{ resourceId: "   ", resourceType: "user" }] }))
        .toThrow(expect.objectContaining({ code: "provider_schema" }));
    },
  );

  it("preserves opaque, case-exact user/group principal observations", () => {
    const principals = [
      { resourceId: "Opaque_ABC:/?😀", resourceType: "USER" },
      { resourceId: "Opaque_abc:/?😀", resourceType: "group" },
      { resourceId: " Opaque_Case ", resourceType: "Group" },
      { resourceId: "x".repeat(512), resourceType: "user" },
    ];
    expect(allowlistedPackage({
      ...access, allowedUsersAndGroups: principals, acquireUsersAndGroups: principals,
    })).toMatchObject({ allowedUsersAndGroups: principals, acquireUsersAndGroups: principals });
    expect(() => allowlistedPackage({
      ...access, allowedUsersAndGroups: [{ resourceId: "x".repeat(513), resourceType: "user" }],
    })).toThrow(expect.objectContaining({ code: "provider_schema" }));
  });

  it.each(["catalog", "inventory", "detail"])("rejects malformed UTF-8 identity bytes at the Graph %s boundary", async operation => {
    const invalid = Buffer.concat([
      Buffer.from(operation === "detail" ? '{"id":"package","manifestId":"manifest-' : '{"id":"package-'),
      Buffer.from([0xff]),
      Buffer.from('","displayName":"Package","isBlocked":false}'),
    ]);
    const body = operation === "detail" ? invalid : Buffer.concat([Buffer.from('{"value":['), invalid, Buffer.from("]}")]);
    const fetcher = vi.fn(async () => new Response(body));
    const client = new GraphPackagesClient(fetcher);
    const observation = operation === "catalog" ? client.checkCatalogAccess("fixture-token")
      : operation === "inventory" ? tinyGraphCatalog(client, "fixture-token")
        : client.getPackageDetails("fixture-token", base.id);
    await expect(observation).rejects.toMatchObject({ status: 502, code: "provider_schema" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

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
