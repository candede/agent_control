import { describe, expect, it, vi } from "vitest";
import { CopilotUsageGraphClient, buildCopilotReportUrl, buildCopilotUsersUrl, buildSubscribedSkusUrl } from "./copilotUsageGraph.js";
import type { FetchLike } from "./graphPackages.js";

const skuId = "639dec6b-bb19-468b-871c-c5c441c4b0cb";
const appsPlanId = "a62f8878-de10-42f3-b68f-6149a25ceb97";
const teamsPlanId = "b95945de-b3bd-46db-8437-f2beb6ea2347";
const chatPlanId = "3f30311c-6b1e-48a4-ab79-725b469da960";
const knownSkus = [
  { skuId, skuPartNumber: "Microsoft_365_Copilot" },
  { skuId: "a809996b-059e-42e2-9866-db24b99a9782", skuPartNumber: "M365_Copilot" },
  { skuId: "ad9c22b3-52d7-4e7e-973c-88121ea96436", skuPartNumber: "Microsoft_365_Copilot_EDU" },
].map(sku => ({ ...sku, appliesTo: "User", servicePlans: [{ servicePlanId: appsPlanId }] }));
const knownSkuIds = knownSkus.map(sku => sku.skuId);

describe("CopilotUsageGraphClient", () => {
  it("uses separate single-SKU predicates with the required advanced-query count", () => {
    const url = new URL(buildCopilotUsersUrl(knownSkuIds));
    expect(url.searchParams.get("$filter")).toBe([
      `assignedLicenses/any(value:value/skuId eq ${skuId})`,
      "assignedLicenses/any(value:value/skuId eq a809996b-059e-42e2-9866-db24b99a9782)",
      "assignedLicenses/any(value:value/skuId eq ad9c22b3-52d7-4e7e-973c-88121ea96436)",
    ].join(" or "));
    expect(url.searchParams.get("$count")).toBe("true");
    expect(url.searchParams.get("$top")).toBe("100");
    expect(url.searchParams.get("$select")?.split(",")).toEqual([
      "id", "userPrincipalName", "displayName", "accountEnabled", "employeeType", "companyName", "department",
      "userType", "assignedLicenses", "assignedPlans",
    ]);
    expect(new URL(buildSubscribedSkusUrl()).searchParams.get("$select")).not.toContain("skuPartNumber");
  });

  it.each([
    { companyName: "  Contoso Health  ", department: "  Clinical Operations  ", expectedCompany: "Contoso Health", expectedDepartment: "Clinical Operations" },
    { companyName: undefined, department: undefined, expectedCompany: null, expectedDepartment: null },
    { companyName: null, department: null, expectedCompany: null, expectedDepartment: null },
    { companyName: "", department: " \t ", expectedCompany: null, expectedDepartment: null },
    { companyName: "C".repeat(256), department: "D".repeat(256), expectedCompany: "C".repeat(256), expectedDepartment: "D".repeat(256) },
  ])("normalizes nullable organization metadata without excluding licensed accounts: %#", async ({ companyName, department, expectedCompany, expectedDepartment }) => {
    const fetcher = vi.fn<FetchLike>(async () => Response.json({
      "@odata.count": 1,
      value: [{
        ...graphUser("11111111-1111-4111-8111-111111111111", "one@example.com", "Active"),
        companyName,
        department,
      }],
    }));
    const users = await new CopilotUsageGraphClient(withCatalog(fetcher)).listCopilotUsers("directory-token");
    expect(users).toHaveLength(1);
    expect(users[0].identity).toMatchObject({ companyName: expectedCompany, department: expectedDepartment });
  });

  it.each(["companyName", "department"] as const)("rejects invalid or oversized %s rather than saving malformed organization metadata", async field => {
    for (const value of [42, {}, ["Operations"], "x".repeat(257)]) {
      const fetcher = vi.fn<FetchLike>(async () => Response.json({
        "@odata.count": 1,
        value: [{
          ...graphUser("11111111-1111-4111-8111-111111111111", "one@example.com", "Active"),
          [field]: value,
        }],
      }));
      await expect(new CopilotUsageGraphClient(withCatalog(fetcher)).listCopilotUsers("directory-token"))
        .rejects.toMatchObject({ code: "provider_schema" });
    }
  });

  it("loads every directory and report page and preserves missing dates as unknown", async () => {
    const userNext = `${buildCopilotUsersUrl(knownSkuIds)}&$skiptoken=user-next`;
    const fetcher = vi.fn<FetchLike>(async input => {
      const url = String(input);
      if (url === buildSubscribedSkusUrl()) return Response.json({ value: knownSkus });
      if (url === buildCopilotUsersUrl(knownSkuIds)) return Response.json({
        value: [graphUser("11111111-1111-4111-8111-111111111111", "one@example.com", "Active")],
        "@odata.count": 2,
        "@odata.nextLink": userNext,
      });
      if (url === userNext) return Response.json({
        value: [
          graphUser("11111111-1111-4111-8111-111111111111", "one@example.com", "Active"),
          {
            ...graphUser("22222222-2222-4222-8222-222222222222", "two@example.com", "Disabled", "a809996b-059e-42e2-9866-db24b99a9782"),
            userType: "Guest",
            accountEnabled: false,
          },
        ],
      });
      if (url === buildCopilotReportUrl()) return new Response(reportCsv([
        reportUser("one@example.com", "2026-09-12"),
        reportUser("two@example.com", ""),
      ]), { headers: { "content-type": "application/octet-stream" } });
      return new Response(null, { status: 404 });
    });
    const client = new CopilotUsageGraphClient(fetcher);

    const [users, report] = await Promise.all([
      client.listCopilotUsers("directory-token"),
      client.listAppActivity("reports-token"),
    ]);

    expect(users).toHaveLength(2);
    expect(users[1].identity.userType).toBe("Guest");
    expect(users[1].identity.accountEnabled).toBe(false);
    expect(users.map(user => user.copilotServiceState)).toEqual(["enabled", "disabled"]);
    expect(users[0]).toMatchObject({
      serviceEvidenceVersion: 1,
      servicePlans: [expect.objectContaining({ state: "enabled", capabilityStatus: "Enabled" })],
    });
    expect(users[0]).not.toHaveProperty("licenses");
    expect(report.users).toHaveLength(2);
    expect(report.users[1].activity.lastActivityDate).toBeNull();
    expect(report.reportRefreshDate).toBe("2026-09-13");
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.find(call => String(call[0]) === buildCopilotUsersUrl(knownSkuIds))?.[1]?.headers)
      .toMatchObject({ Authorization: "Bearer directory-token" });
    for (const url of [buildCopilotUsersUrl(knownSkuIds), userNext]) {
      const call = fetcher.mock.calls.find(call => String(call[0]) === url);
      expect(new Headers(call?.[1]?.headers).get("ConsistencyLevel")).toBe("eventual");
    }
    const reportCall = fetcher.mock.calls.find(call => String(call[0]) === buildCopilotReportUrl());
    expect(new Headers(reportCall?.[1]?.headers).has("ConsistencyLevel")).toBe(false);
    const catalogCall = fetcher.mock.calls.find(call => String(call[0]) === buildSubscribedSkusUrl());
    expect(new Headers(catalogCall?.[1]?.headers).has("ConsistencyLevel")).toBe(false);
    expect(buildCopilotReportUrl()).toContain("period='D30',version='v1'");
    expect(buildCopilotReportUrl()).not.toContain("$format");
  });

  it("rejects an off-host continuation before sending its token", async () => {
    const fetcher = vi.fn(async () => Response.json({
      value: [],
      "@odata.count": 1,
      "@odata.nextLink": "https://attacker.invalid/v1.0/users?$skiptoken=secret",
    }));
    const client = new CopilotUsageGraphClient(withCatalog(fetcher));
    await expect(client.listCopilotUsers("secret-token")).rejects.toMatchObject({ code: "invalid_provider_link" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("reports distinct candidate progress across pages and overlapping SKU batches without inventing a total", async () => {
    const catalog = Array.from({ length: 21 }, (_, index) => ({
      skuId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
      skuPartNumber: `Copilot_bundle_${index}`,
      appliesTo: "User",
      servicePlans: [{ servicePlanId: appsPlanId }],
    }));
    const firstUrl = buildCopilotUsersUrl(catalog.slice(0, 20).map(sku => sku.skuId));
    const lastUrl = buildCopilotUsersUrl([catalog[20].skuId]);
    const nextUrl = `${firstUrl}&$skiptoken=next`;
    const shared = graphUser("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "shared@example.com", "Active", catalog[0].skuId);
    shared.assignedLicenses.push({ skuId: catalog[20].skuId, disabledPlans: [] });
    shared.licenseAssignmentStates.push({ skuId: catalog[20].skuId, state: "Active", error: "None", assignedByGroup: null });
    const fetcher = vi.fn<FetchLike>(async input => {
      const url = String(input);
      if (url === buildSubscribedSkusUrl()) return Response.json({ value: catalog });
      if (url === firstUrl) return Response.json({ value: [shared], "@odata.count": 2, "@odata.nextLink": nextUrl });
      if (url === nextUrl) return Response.json({ value: [
        shared, graphUser("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "first@example.com", "Active", catalog[0].skuId),
      ] });
      if (url === lastUrl) return Response.json({ "@odata.count": 2, value: [
        shared, graphUser("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "last@example.com", "Active", catalog[20].skuId),
      ] });
      throw new Error("Unexpected directory page.");
    });
    const progress = vi.fn(async (_observedCount: number) => undefined);
    expect(await new CopilotUsageGraphClient(fetcher).listCopilotUsers("token", undefined, progress)).toHaveLength(3);
    expect(progress.mock.calls).toEqual([[1], [2], [3]]);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each(["cancellation", "persistence failure"] as const)("waits for page progress and stops before the next page on %s", async failure => {
    const controller = new AbortController();
    const error = new Error(failure);
    const fetcher = vi.fn<FetchLike>(async () => Response.json({
      value: [graphUser("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "one@example.com", "Active")],
      "@odata.count": 2,
      "@odata.nextLink": `${buildCopilotUsersUrl(knownSkuIds)}&$skiptoken=next`,
    }));
    const progress = vi.fn(async (_observedCount: number) => {
      await Promise.resolve();
      if (failure === "cancellation") controller.abort(error);
      else throw error;
    });
    await expect(new CopilotUsageGraphClient(withCatalog(fetcher)).listCopilotUsers("token", controller.signal, progress))
      .rejects.toBe(error);
    expect(progress.mock.calls).toEqual([[1]]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not request the catalog when directory collection is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<FetchLike>();
    await expect(new CopilotUsageGraphClient(fetcher).listCopilotUsers("token", controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([true, false])("reports a measured zero for an empty licensed cohort (no qualifying SKU: %s)", async noSku => {
    const fetcher = vi.fn<FetchLike>(async input => String(input) === buildSubscribedSkusUrl()
      ? Response.json({ value: noSku ? [] : knownSkus })
      : Response.json({ value: [], "@odata.count": 0 }));
    const progress = vi.fn();
    expect(await new CopilotUsageGraphClient(fetcher).listCopilotUsers("token", undefined, progress)).toEqual([]);
    expect(progress.mock.calls).toEqual([[0]]);
  });

  it.each([
    "https://reports.office.com/data/download/synthetic-report?token=synthetic",
    "https://reports.office.com/data/v1.0/download?token=synthetic",
    "https://reportsweu.office.com/data/v1.0/download?token=synthetic%2Bsigned%2Fvalue%3D",
  ])("downloads an allowlisted Microsoft report without forwarding the Graph bearer token: %s", async downloadUrl => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: downloadUrl } }))
      .mockResolvedValueOnce(new Response(reportCsv([reportUser("one@example.com", "2026-09-12")])));
    const report = await new CopilotUsageGraphClient(fetcher).listAppActivity("reports-token");
    expect(report.users).toHaveLength(1);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      redirect: "manual",
      headers: { Authorization: "Bearer reports-token" },
    });
    expect(fetcher.mock.calls[1]?.[0]).toBe(downloadUrl);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ redirect: "manual" });
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).has("authorization")).toBe(false);
    expect(fetcher.mock.calls[1]?.[1]?.signal).toBe(fetcher.mock.calls[0]?.[1]?.signal);
  });

  it.each([
    undefined,
    "not a URL",
    "http://reports.office.com/data/download/report",
    "https://reports.office.com.attacker.invalid/data/download/report",
    "https://attacker.invalid/data/download/report",
    "https://reports.office.com:444/data/download/report",
    "https://user:password@reports.office.com/data/download/report",
    "https://reports.office.com/data/download/report#fragment",
    "https://reports.office.com/unrelated",
    "https://reports.office.com/data/download/",
    "https://reports.office.com/data/download/%2e%2e/unrelated",
    "https://reportsweu.office.com.attacker.invalid/data/v1.0/download?token=synthetic",
    "https://reportsunverified.office.com/data/v1.0/download?token=synthetic",
    "http://reportsweu.office.com/data/v1.0/download?token=synthetic",
    "https://reportsweu.office.com:444/data/v1.0/download?token=synthetic",
    "https://user:password@reportsweu.office.com/data/v1.0/download?token=synthetic",
    "https://reportsweu.office.com/data/v1.0/download?token=synthetic#fragment",
    "https://reportsweu.office.com/unrelated?token=synthetic",
    "https://reportsweu.office.com/data/v1.0/download/extra?token=synthetic",
    "https://reportsweu.office.com/data/v1.0/download",
    "https://reportsweu.office.com/data/v1.0/download?token=",
    "https://reportsweu.office.com/data/v1.0/download?token=one&token=two",
  ])("rejects an invalid report download location: %s", async location => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 302, headers: location === undefined ? {} : { location },
    }));
    await expect(new CopilotUsageGraphClient(fetcher).listAppActivity("reports-token"))
      .rejects.toMatchObject({ code: "invalid_provider_link" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects further redirects and surfaces expired report downloads without leaking their URL", async () => {
    const downloadUrl = "https://reports.office.com/data/download/sensitive-signed-url";
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: downloadUrl } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: downloadUrl } }));
    const client = new CopilotUsageGraphClient(fetcher);
    await expect(client.listAppActivity("reports-token")).rejects.toMatchObject({ code: "invalid_provider_link" });
    expect(fetcher).toHaveBeenCalledTimes(2);

    fetcher.mockReset()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: downloadUrl } }))
      .mockResolvedValueOnce(new Response(`Denied: ${downloadUrl}`, { status: 403 }));
    await expect(client.listAppActivity("reports-token")).rejects.toMatchObject({
      code: "report_download_failed", status: 502,
      message: "Microsoft report download failed; refresh usage to request a new download.",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("preserves cancellation during a redirected report download", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, {
        status: 302, headers: { location: "https://reports.office.com/data/download/report" },
      }))
      .mockImplementationOnce(async (_url, init) => {
        controller.abort();
        init?.signal?.throwIfAborted();
        throw new Error("Download did not honor the cancellation signal.");
      });
    await expect(new CopilotUsageGraphClient(fetcher).listAppActivity("token", controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  it("deduplicates canonical directory object IDs and rejects malformed IDs", async () => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const fetcher = vi.fn(async () => Response.json({ "@odata.count": 1, value: [
      graphUser(id, "one@example.com", "Active"),
      graphUser(id.toUpperCase(), "one@example.com", "Active"),
    ] }));
    await expect(new CopilotUsageGraphClient(withCatalog(fetcher)).listCopilotUsers("token")).resolves.toHaveLength(1);
    fetcher.mockResolvedValue(Response.json({ "@odata.count": 1, value: [graphUser("not-an-object-id", "one@example.com", "Active")] }));
    await expect(new CopilotUsageGraphClient(withCatalog(fetcher)).listCopilotUsers("token")).rejects.toMatchObject({ code: "provider_schema" });
  });

  it("excludes base licenses, free Chat, Studio-only plans and company subscriptions even with Copilot names", async () => {
    const fetcher = vi.fn(async () => Response.json({
      value: [
        { skuId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", skuPartNumber: "Copilot_Studio",
          appliesTo: "User", servicePlans: [{ servicePlanId: "fe6c28b3-d468-44ea-bbd0-a10a5167435c" }] },
        { skuId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", skuPartNumber: "Microsoft_365_E3",
          appliesTo: "User", servicePlans: [] },
        { skuId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", skuPartNumber: "Copilot_Chat",
          appliesTo: "User", servicePlans: [] },
        { ...knownSkus[0], appliesTo: "Company", servicePlans: [{ servicePlanId: appsPlanId }] },
      ],
    }));
    await expect(new CopilotUsageGraphClient(fetcher).listCopilotUsers("token")).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(buildCopilotUsersUrl(knownSkuIds)).not.toMatch(/contains|COPILOT/i);
  });

  it.each([
    ...knownSkus.map(sku => ({ skuId: sku.skuId, skuPartNumber: sku.skuPartNumber })),
    { skuId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", skuPartNumber: "MICROSOFT_365_E7" },
    { skuId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", skuPartNumber: "Future_product" },
    { skuId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", skuPartNumber: undefined },
  ])("detects paid Copilot services without a product-name or SKU allowlist: $skuPartNumber", async sku => {
    const row = graphUser("11111111-1111-4111-8111-111111111111", "one@example.com", "Active", sku.skuId);
    const fetcher = directoryWithCatalog(row, [{
      ...sku, appliesTo: "User", servicePlans: [{ servicePlanId: appsPlanId }],
    }]);
    const users = await new CopilotUsageGraphClient(fetcher).listCopilotUsers("token");
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      serviceEvidenceVersion: 1, copilotServiceState: "enabled",
      servicePlans: [{
        servicePlanId: appsPlanId, service: "M365_COPILOT_APPS",
        displayName: "Microsoft 365 Copilot in Productivity Apps", state: "enabled", capabilityStatus: "Enabled",
      }],
    });
    expect(JSON.stringify(users)).not.toMatch(/skuId|skuPartNumber|licenseAssignmentStates|MICROSOFT_365_E7/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not recognize a familiar Copilot SKU without a paid Copilot service plan", async () => {
    const fetcher = vi.fn<FetchLike>(async () => Response.json({
      value: knownSkus.map(sku => ({ ...sku, servicePlans: [] })),
    }));
    await expect(new CopilotUsageGraphClient(fetcher).listCopilotUsers("token")).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["Enabled", "Warning", "Deleted", "Suspended", "LockedOut", null])(
    "reports Copilot disabled despite an active group-assigned package and capability %s",
    async capabilityStatus => {
      const bundleId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
      const original = graphUser("11111111-1111-4111-8111-111111111111", "one@example.com", "Active", bundleId);
      const row = {
        ...original,
        assignedLicenses: [{ skuId: bundleId, disabledPlans: [appsPlanId.toUpperCase()] }],
        assignedPlans: capabilityStatus ? [{ ...original.assignedPlans[0], capabilityStatus }] : [],
        licenseAssignmentStates: [{
          skuId: bundleId, state: "Active", error: null,
          assignedByGroup: "22222222-2222-4222-8222-222222222222", disabledPlans: [appsPlanId],
        }],
      };
      const fetcher = directoryWithCatalog(row, [{
        skuId: bundleId, skuPartNumber: "MICROSOFT_365_E7", appliesTo: "User",
        servicePlans: [{ servicePlanId: appsPlanId }],
      }]);
      const [user] = await new CopilotUsageGraphClient(fetcher).listCopilotUsers("token");
      expect(user.copilotServiceState).toBe("disabled");
      expect(user.servicePlans[0]).toMatchObject({ state: "disabled", capabilityStatus });
      expect(JSON.stringify(user)).not.toMatch(/MICROSOFT_365_E7|assignmentStates|disabledPlanIds/);
    },
  );

  it.each([
    { capabilityStatus: "Enabled", expected: "enabled" },
    { capabilityStatus: "Warning", expected: "warning" },
    { capabilityStatus: "Deleted", expected: "disabled" },
    { capabilityStatus: "Suspended", expected: "suspended" },
    { capabilityStatus: "LockedOut", expected: "locked_out" },
    { capabilityStatus: null, expected: "unknown" },
  ])("uses the individual Copilot capability $capabilityStatus, not package state", async ({ capabilityStatus, expected }) => {
    const original = graphUser("11111111-1111-4111-8111-111111111111", "one@example.com", "ActiveWithError");
    const row = {
      ...original,
      assignedLicenses: [{ skuId, disabledPlans: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"] }],
      assignedPlans: capabilityStatus ? [{ ...original.assignedPlans[0], capabilityStatus }] : [],
      licenseAssignmentStates: [{ skuId, state: "ActiveWithError", error: "UnrelatedPackageServiceError" }],
    };
    const [user] = await new CopilotUsageGraphClient(directoryWithCatalog(row)).listCopilotUsers("token");
    expect(user.copilotServiceState).toBe(expected);
    expect(user.servicePlans[0]).toMatchObject({ state: expected, capabilityStatus });
  });

  it.each([
    { bundleDisabled: true, standaloneDisabled: false, expected: "enabled" },
    { bundleDisabled: false, standaloneDisabled: true, expected: "enabled" },
    { bundleDisabled: true, standaloneDisabled: true, expected: "disabled" },
  ])("resolves effective Copilot enablement across current assignments: %j", async ({ bundleDisabled, standaloneDisabled, expected }) => {
    const bundleId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const row = {
      ...graphUser("11111111-1111-4111-8111-111111111111", "one@example.com", "Active"),
      assignedLicenses: [
        { skuId: bundleId, disabledPlans: bundleDisabled ? [appsPlanId] : [] },
        { skuId, disabledPlans: standaloneDisabled ? [appsPlanId] : [] },
      ],
      licenseAssignmentStates: [
        { skuId: bundleId, state: "Active", assignedByGroup: "22222222-2222-4222-8222-222222222222" },
        { skuId, state: "Active", assignedByGroup: null },
      ],
    };
    const fetcher = directoryWithCatalog(row, [
      knownSkus[0],
      { skuId: bundleId, appliesTo: "User", servicePlans: [{ servicePlanId: appsPlanId }] },
    ]);
    const [user] = await new CopilotUsageGraphClient(fetcher).listCopilotUsers("token");
    expect(user.copilotServiceState).toBe(expected);
    expect(user.servicePlans).toHaveLength(1);
  });

  it.each([teamsPlanId, chatPlanId])("recognizes the paid Copilot service %s without an Apps plan or E7 product", async servicePlanId => {
    const original = graphUser("11111111-1111-4111-8111-111111111111", "one@example.com", "Active");
    const row = { ...original, assignedPlans: [{ ...original.assignedPlans[0], servicePlanId }] };
    const [user] = await new CopilotUsageGraphClient(directoryWithCatalog(row, [{
      skuId, appliesTo: "User", servicePlans: [{ servicePlanId }],
    }])).listCopilotUsers("token");
    expect(user.copilotServiceState).toBe("enabled");
    expect(user.servicePlans).toEqual([expect.objectContaining({ servicePlanId, state: "enabled" })]);
  });

  it("reports individual Copilot components and partial enablement without promoting a disabled Apps plan", async () => {
    const original = graphUser("11111111-1111-4111-8111-111111111111", "one@example.com", "Active");
    const row = {
      ...original,
      assignedLicenses: [{ skuId, disabledPlans: [appsPlanId] }],
      assignedPlans: [
        { ...original.assignedPlans[0], capabilityStatus: "Deleted" },
        { ...original.assignedPlans[0], servicePlanId: teamsPlanId },
      ],
    };
    const [user] = await new CopilotUsageGraphClient(directoryWithCatalog(row, [{
      skuId, appliesTo: "User", servicePlans: [appsPlanId, teamsPlanId, chatPlanId].map(servicePlanId => ({ servicePlanId })),
    }])).listCopilotUsers("token");
    expect(user.copilotServiceState).toBe("partially_enabled");
    expect(user.servicePlans.map(plan => [plan.servicePlanId, plan.state])).toEqual([
      [appsPlanId, "disabled"], [teamsPlanId, "enabled"], [chatPlanId, "unknown"],
    ]);
  });

  it.each([
    { secondStatus: "Enabled", expected: "enabled", capabilityStatus: "Enabled" },
    { secondStatus: "Warning", expected: "enabled", capabilityStatus: "Enabled" },
    { secondStatus: "Deleted", expected: "unknown", capabilityStatus: null },
  ])("does not guess an active service from conflicting historical capabilities: $secondStatus", async ({ secondStatus, expected, capabilityStatus }) => {
    const original = graphUser("11111111-1111-4111-8111-111111111111", "one@example.com", "Active");
    const row = { ...original, assignedPlans: [
      original.assignedPlans[0], { ...original.assignedPlans[0], capabilityStatus: secondStatus },
    ] };
    const [user] = await new CopilotUsageGraphClient(directoryWithCatalog(row)).listCopilotUsers("token");
    expect(user.copilotServiceState).toBe(expected);
    expect(user.servicePlans).toEqual([expect.objectContaining({ state: expected, capabilityStatus })]);
  });

  it("retains the latest service assignment instant when duplicate observations use different time offsets", async () => {
    const original = graphUser("11111111-1111-4111-8111-111111111111", "one@example.com", "Active");
    const row = { ...original, assignedPlans: [
      { ...original.assignedPlans[0], assignedDateTime: "2026-01-01T00:30:00Z" },
      { ...original.assignedPlans[0], assignedDateTime: "2026-01-01T01:00:00+01:00" },
    ] };
    const [user] = await new CopilotUsageGraphClient(directoryWithCatalog(row)).listCopilotUsers("token");
    expect(user.servicePlans).toEqual([expect.objectContaining({ state: "enabled", assignedDateTime: "2026-01-01T00:30:00Z" })]);
  });

  it("loads all 2,167 assignments when enterprise directory pages exceed the generic 2 MB limit", async () => {
    const bundleId = "15f2e9fc-b782-4f73-bf51-81d8b7fff6f4";
    const catalogNext = "https://graph.microsoft.com/v1.0/subscribedSkus?$skiptoken=next";
    const directoryUrl = buildCopilotUsersUrl([skuId, bundleId]);
    const rows = Array.from({ length: 2_167 }, (_, index) => graphUser(
      `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
      `person${index}@example.com`, index === 10 ? "Disabled" : "Active", index < 10 ? skuId : bundleId,
    ));
    for (const row of rows) {
      row.assignedPlans = Array.from({ length: 300 }, () => ({
        ...row.assignedPlans[0], servicePlanId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", service: "Other enterprise plan",
      })).concat(row.assignedPlans);
    }
    expect(Buffer.byteLength(JSON.stringify({ value: rows.slice(0, 100) }))).toBeGreaterThan(2_000_000);
    expect(Buffer.byteLength(JSON.stringify({ value: rows.slice(0, 100) }))).toBeLessThan(16 * 1024 * 1024);
    rows[10].assignedLicenses[0].disabledPlans = [appsPlanId];
    const fetcher = vi.fn<FetchLike>(async input => {
      const url = String(input);
      if (url === buildSubscribedSkusUrl()) return Response.json({ value: [knownSkus[0]], "@odata.nextLink": catalogNext });
      if (url === catalogNext) return Response.json({ value: [{
        skuId: bundleId, skuPartNumber: "Microsoft_Copilot_for_Sales", appliesTo: "User",
        servicePlans: [{ servicePlanId: appsPlanId.toUpperCase(), provisioningStatus: "Disabled" }],
      }] });
      const target = new URL(url);
      if (target.searchParams.get("$filter") !== new URL(directoryUrl).searchParams.get("$filter")) throw new Error("Unexpected Graph request.");
      const offset = Number(target.searchParams.get("$skiptoken") ?? 0);
      const size = Number(target.searchParams.get("$top"));
      return Response.json({
        value: rows.slice(offset, offset + size),
        ...(offset === 0 ? { "@odata.count": rows.length } : {}),
        ...(offset + size < rows.length ? { "@odata.nextLink": `${directoryUrl}&$skiptoken=${offset + size}` } : {}),
      });
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const users = await new CopilotUsageGraphClient(fetcher).listCopilotUsers("private-token");
      expect(users).toHaveLength(2_167);
      expect(users.every(user => user.servicePlans.some(plan => plan.servicePlanId === appsPlanId))).toBe(true);
      expect(users[10]).toMatchObject({
        copilotServiceState: "disabled",
        servicePlans: [expect.objectContaining({ servicePlanId: appsPlanId, state: "disabled" })],
      });
      expect(JSON.stringify(users)).not.toMatch(/skuId|skuPartNumber|Microsoft_Copilot_for_Sales/);
      expect(fetcher).toHaveBeenCalledTimes(24);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"count":2167'));
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/person0@|private-token|skiptoken/);
    } finally {
      log.mockRestore();
    }
  });

  it.each([3_993, 30_001])("collects all %i product-assignment candidates in bulk, not one request per user", async total => {
    const directoryUrl = buildCopilotUsersUrl([skuId]);
    const progress = vi.fn();
    const fetcher = vi.fn<FetchLike>(async input => {
      const url = String(input);
      if (url === buildSubscribedSkusUrl()) return Response.json({ value: [knownSkus[0]] });
      const target = new URL(url);
      expect(target.pathname).toBe("/v1.0/users");
      expect(target.searchParams.get("$filter")).toBe(`assignedLicenses/any(value:value/skuId eq ${skuId})`);
      const offset = Number(target.searchParams.get("$skiptoken") ?? 0);
      const size = Number(target.searchParams.get("$top"));
      expect(size).toBe(100);
      return Response.json({
        value: Array.from({ length: Math.min(size, total - offset) }, (_, index) => {
          const ordinal = offset + index;
          return graphUser(
            `11111111-1111-4111-8111-${String(ordinal).padStart(12, "0")}`,
            `person${ordinal}@example.com`,
            ordinal === total - 1 ? "Disabled" : "Active",
          );
        }),
        ...(offset === 0 ? { "@odata.count": total } : {}),
        ...(offset + size < total ? { "@odata.nextLink": `${directoryUrl}&$skiptoken=${offset + size}` } : {}),
      });
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const users = await new CopilotUsageGraphClient(fetcher).listCopilotUsers("private-token", undefined, progress);
      expect(users).toHaveLength(total);
      expect(new Set(users.map(user => user.identity.objectId)).size).toBe(total);
      expect(users.at(-1)).toMatchObject({
        identity: { userPrincipalName: `person${total - 1}@example.com` },
        copilotServiceState: "disabled",
      });
      expect(fetcher).toHaveBeenCalledTimes(1 + Math.ceil(total / 100));
      expect(progress).toHaveBeenCalledTimes(Math.ceil(total / 100));
      expect(progress).toHaveBeenLastCalledWith(total);
      for (const [, init] of fetcher.mock.calls.slice(1)) {
        expect(new Headers(init?.headers).get("ConsistencyLevel")).toBe("eventual");
      }
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`"count":${total}`));
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/person0@|private-token|skiptoken/);
    } finally {
      log.mockRestore();
    }
  });

  it("rejects a 3,993-user result if Graph reports 30,000 matching product-assignment candidates", async () => {
    const fetcher = vi.fn(async () => Response.json({
      "@odata.count": 30_000,
      value: Array.from({ length: 3_993 }, (_, index) => graphUser(
        `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`, `person${index}@example.com`, "Active",
      )),
    }));
    await expect(new CopilotUsageGraphClient(withCatalog(fetcher)).listCopilotUsers("token"))
      .rejects.toMatchObject({ code: "provider_count_mismatch" });
  });

  it.each([
    { endpoint: "directory", pageLimit: 1_000 },
    { endpoint: "catalog", pageLimit: 200 },
  ])("retains a bounded $pageLimit-page budget for $endpoint continuations", async ({ endpoint, pageLimit }) => {
    const fetcher = vi.fn<FetchLike>(async input => {
      const next = new URL(String(input));
      next.searchParams.set("$skiptoken", String(Number(next.searchParams.get("$skiptoken") ?? 0) + 1));
      return Response.json({ value: [], "@odata.count": 1, "@odata.nextLink": next.toString() });
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const client = new CopilotUsageGraphClient(endpoint === "directory" ? withCatalog(fetcher) : fetcher);
      await expect(client.listCopilotUsers("token")).rejects.toMatchObject({ code: "provider_result_limit" });
      expect(fetcher).toHaveBeenCalledTimes(pageLimit);
    } finally {
      log.mockRestore();
    }
  });

  it("rejects a cohort beyond the existing 100,000-row limit before reading continuation pages", async () => {
    const fetcher = vi.fn<FetchLike>(async () => Response.json({
      value: [], "@odata.count": 100_001, "@odata.nextLink": `${buildCopilotUsersUrl(knownSkuIds)}&$skiptoken=next`,
    }));
    await expect(new CopilotUsageGraphClient(withCatalog(fetcher)).listCopilotUsers("token"))
      .rejects.toMatchObject({ code: "provider_result_limit" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    { source: "directory", maximumBytes: 16 * 1024 * 1024 },
    { source: "catalog", maximumBytes: 2_000_000 },
  ])("retains the $maximumBytes byte bound for $source with value-free diagnostics", async ({ source, maximumBytes }) => {
    const cancel = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(maximumBytes + 1)); },
      cancel,
    })));
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const client = new CopilotUsageGraphClient(source === "directory" ? withCatalog(fetcher) : fetcher);
      await expect(client.listCopilotUsers("private-token")).rejects.toMatchObject({ code: "provider_response_size_limit" });
      expect(cancel).toHaveBeenCalledOnce();
      expect(fetcher).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledOnce();
      expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
        event: "copilot_license_response_size_limit", source, field: "response_bytes",
        length: maximumBytes + 1, maximumLength: maximumBytes,
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain("private-token");
    } finally {
      log.mockRestore();
    }
  });

  it.each([undefined, -1, 1.5, "2001", null])("rejects a missing or invalid Graph total: %s", async count => {
    const fetcher = vi.fn(async () => Response.json({ value: [], "@odata.count": count }));
    await expect(new CopilotUsageGraphClient(withCatalog(fetcher)).listCopilotUsers("token"))
      .rejects.toMatchObject({ code: "provider_schema" });
  });

  it("does not silently fall back to three SKUs when catalog access fails", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: { code: "Authorization_RequestDenied" } }, { status: 403 }));
    await expect(new CopilotUsageGraphClient(fetcher).listCopilotUsers("token")).rejects.toMatchObject({ status: 403 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    ["catalog", false], ["catalog", true], ["directory", false], ["directory", true],
  ] as const)("rejects a null %s collection as a provider schema error (continuation: %s)", async (source, continuation) => {
    const fetcher = vi.fn<FetchLike>();
    if (continuation) {
      const url = source === "catalog" ? buildSubscribedSkusUrl() : buildCopilotUsersUrl(knownSkuIds);
      fetcher.mockResolvedValueOnce(Response.json({
        value: source === "catalog" ? knownSkus : [],
        "@odata.count": 0,
        "@odata.nextLink": `${url}&$skiptoken=next`,
      }));
    }
    fetcher.mockResolvedValueOnce(Response.json(null));
    const client = new CopilotUsageGraphClient(source === "directory" ? withCatalog(fetcher) : fetcher);
    await expect(client.listCopilotUsers("token")).rejects.toMatchObject({ status: 502, code: "provider_schema" });
    expect(fetcher).toHaveBeenCalledTimes(continuation ? 2 : 1);
  });

  it.each([
    ["no paid plans", { ...knownSkus[0], servicePlans: [] }],
    ["company scope", { ...knownSkus[0], appliesTo: "Company" }],
  ] as const)("rejects conflicting catalog eligibility with %s before querying users", async (_label, excluded) => {
    for (const reverse of [false, true]) {
      for (const paged of [false, true]) {
        const rows = reverse ? [excluded, knownSkus[0]] : [knownSkus[0], excluded];
        const fetcher = vi.fn<FetchLike>();
        if (paged) {
          fetcher.mockResolvedValueOnce(Response.json({
            value: [rows[0]], "@odata.nextLink": `${buildSubscribedSkusUrl()}&$skiptoken=next`,
          }));
          fetcher.mockResolvedValueOnce(Response.json({ value: [rows[1]] }));
        } else {
          fetcher.mockResolvedValueOnce(Response.json({ value: rows }));
        }
        fetcher.mockResolvedValue(Response.json({ value: [], "@odata.count": 0 }));
        await expect(new CopilotUsageGraphClient(fetcher).listCopilotUsers("token"))
          .rejects.toMatchObject({ status: 502, code: "provider_schema" });
        expect(fetcher).toHaveBeenCalledTimes(paged ? 2 : 1);
      }
    }
  });

  it("accepts equivalent catalog duplicates while excluding products without user-scoped paid plans", async () => {
    const excluded = { ...knownSkus[0], skuId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", servicePlans: [] };
    const company = { ...knownSkus[0], skuId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", appliesTo: "Company" };
    const fetcher = vi.fn<FetchLike>()
      .mockResolvedValueOnce(Response.json({
        value: [knownSkus[0], excluded, company], "@odata.nextLink": `${buildSubscribedSkusUrl()}&$skiptoken=next`,
      }))
      .mockResolvedValueOnce(Response.json({
        value: [{ ...knownSkus[0], servicePlans: [...knownSkus[0].servicePlans, ...knownSkus[0].servicePlans] }, excluded, company],
      }))
      .mockResolvedValueOnce(Response.json({ value: [], "@odata.count": 0 }));
    await expect(new CopilotUsageGraphClient(fetcher).listCopilotUsers("token")).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(String(fetcher.mock.calls[2][0])).toBe(buildCopilotUsersUrl([knownSkus[0].skuId]));
  });

  it.each([
    { value: null },
    { value: [{ ...knownSkus[0], servicePlans: null }] },
    { value: [{ ...knownSkus[0], servicePlans: [{ servicePlanId: "invalid" }] }] },
    { value: [{ ...knownSkus[0], skuId: "" }] },
    { value: [{ ...knownSkus[0], appliesTo: null }] },
    { value: [knownSkus[0], { ...knownSkus[0], servicePlans: [{ servicePlanId: teamsPlanId }] }] },
  ])("rejects malformed or conflicting catalog data instead of returning a smaller cohort", async body => {
    const fetcher = vi.fn(async () => Response.json(body));
    await expect(new CopilotUsageGraphClient(fetcher).listCopilotUsers("token")).rejects.toMatchObject({ code: "provider_schema" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects directory users whose historical plans do not establish a current qualifying assignment", async () => {
    const row = graphUser("11111111-1111-4111-8111-111111111111", "one@example.com", "Active");
    row.assignedLicenses = [];
    const fetcher = vi.fn(async () => Response.json({ value: [row], "@odata.count": 1 }));
    await expect(new CopilotUsageGraphClient(withCatalog(fetcher)).listCopilotUsers("token")).rejects.toMatchObject({ code: "provider_schema" });
  });

  it.each([
    "https://attacker.invalid/v1.0/subscribedSkus",
    "https://graph.microsoft.com/v1.0/users",
    buildSubscribedSkusUrl(),
  ])("rejects invalid or repeated catalog continuation: %s", async nextLink => {
    const fetcher = vi.fn(async () => Response.json({ value: knownSkus, "@odata.nextLink": nextLink }));
    await expect(new CopilotUsageGraphClient(fetcher).listCopilotUsers("token"))
      .rejects.toMatchObject({ code: nextLink === buildSubscribedSkusUrl() ? "provider_schema" : "invalid_provider_link" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects a failed later directory page instead of returning the first page", async () => {
    const fetcher = vi.fn<FetchLike>()
      .mockResolvedValueOnce(Response.json({
        value: [graphUser("11111111-1111-4111-8111-111111111111", "one@example.com", "Active")],
        "@odata.count": 2, "@odata.nextLink": "https://graph.microsoft.com/v1.0/users?$skiptoken=next",
      }))
      .mockResolvedValueOnce(Response.json({ error: { code: "ServiceUnavailable" } }, { status: 503 }));
    await expect(new CopilotUsageGraphClient(withCatalog(fetcher)).listCopilotUsers("token")).rejects.toMatchObject({ status: 503 });
  });

  it("bounds dynamic SKU filters and counts a multi-licensed employee only once across batches", async () => {
    const skus = Array.from({ length: 21 }, (_, index) => ({
      skuId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
      skuPartNumber: `Bundle_${index}`, appliesTo: "User", servicePlans: [{ servicePlanId: appsPlanId }],
    }));
    const row = {
      ...graphUser("11111111-1111-4111-8111-111111111111", "one@example.com", "Active"),
      assignedLicenses: skus.map(sku => ({ skuId: sku.skuId, disabledPlans: [] })),
      licenseAssignmentStates: [],
    };
    const fetcher = vi.fn<FetchLike>(async input => {
      if (String(input) === buildSubscribedSkusUrl()) return Response.json({ value: skus });
      return Response.json({ value: [row], "@odata.count": 1 });
    });
    const users = await new CopilotUsageGraphClient(fetcher).listCopilotUsers("token");
    expect(users).toHaveLength(1);
    expect(users[0].servicePlans).toHaveLength(1);
    expect(users[0].copilotServiceState).toBe("enabled");
    expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual([
      buildSubscribedSkusUrl(),
      buildCopilotUsersUrl(skus.slice(0, 20).map(sku => sku.skuId)),
      buildCopilotUsersUrl(skus.slice(20).map(sku => sku.skuId)),
    ]);
    expect(() => buildCopilotUsersUrl([])).toThrow();
    expect(() => buildCopilotUsersUrl(skus.map(sku => sku.skuId))).toThrow();
  });

  describe("exact reported identity verification", () => {
    const objectId = "aaaaaaaa-aaaa-7aaa-1aaa-aaaaaaaaaaaa";
    const otherId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const upn = "reported@example.com";

    it("finishes the catalog and full product roster before verifying only missing report identities", async () => {
      const catalogNext = `${buildSubscribedSkusUrl()}&$skiptoken=catalog`;
      const productUrl = buildCopilotUsersUrl([skuId, otherId]);
      const productNext = `${productUrl}&$skiptoken=products`;
      const candidate = graphUser(objectId, "listed@example.com", "Active");
      const unreported = graphUser(otherId, "unreported@example.com", "Disabled", otherId);
      const reported = { ...graphUser("cccccccc-cccc-4ccc-8ccc-cccccccccccc", upn, "Active"), assignedLicenses: [] };
      const fetcher = vi.fn<FetchLike>(async input => {
        const url = String(input);
        if (url === buildSubscribedSkusUrl()) return Response.json({
          value: [knownSkus[0]], "@odata.nextLink": catalogNext,
        });
        if (url === catalogNext) return Response.json({ value: [{ ...knownSkus[0], skuId: otherId }] });
        if (url === productUrl) return Response.json({
          value: [candidate], "@odata.count": 2, "@odata.nextLink": productNext,
        });
        if (url === productNext) return Response.json({ value: [unreported] });
        expect(new URL(url).searchParams.get("$filter")).toBe(`userPrincipalName eq '${upn}'`);
        return Response.json({ value: [reported], "@odata.count": 1 });
      });
      const progress = vi.fn();
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        const users = await new CopilotUsageGraphClient(fetcher).listCopilotUsers("private-token", undefined, progress, [
          " LISTED@EXAMPLE.COM ", objectId.toUpperCase(), upn, ` ${upn.toUpperCase()} `, "concealed-report-label",
        ]);
        expect(users.map(user => user.identity.objectId)).toEqual([objectId, otherId, reported.id]);
        expect(users.map(user => user.copilotServiceState)).toEqual(["enabled", "disabled", "disabled"]);
        expect(users[2].servicePlans).toEqual([]);
        expect(progress.mock.calls).toEqual([[1], [2], [3]]);
        expect(fetcher.mock.calls.slice(0, 4).map(([url]) => String(url))).toEqual([
          buildSubscribedSkusUrl(), catalogNext, productUrl, productNext,
        ]);
        expect(fetcher).toHaveBeenCalledTimes(5);
        expect(JSON.stringify(log.mock.calls)).not.toMatch(/example\.com|aaaa|bbbb|cccc|private-token|skiptoken|concealed-report-label/);
        expect(log).toHaveBeenLastCalledWith(expect.stringContaining('"count":3'));
      } finally {
        log.mockRestore();
      }
    });

    it.each([
      { label: "zero assignments and observations", assignments: [], observations: [], catalog: knownSkus },
      { label: "only historical paid observations", assignments: [], observations: graphUser(objectId, upn, "Active").assignedPlans, catalog: knownSkus },
      { label: "base or unrecognized plans", assignments: [{ skuId: otherId, disabledPlans: [] }], observations: [], catalog: [
        ...knownSkus, { skuId: otherId, appliesTo: "User", servicePlans: [{ servicePlanId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }] },
      ] },
      { label: "company-scoped paid subscription", assignments: [{ skuId: otherId, disabledPlans: [] }], observations: [], catalog: [
        ...knownSkus, { ...knownSkus[0], skuId: otherId, appliesTo: "Company" },
      ] },
      { label: "no qualifying catalog products", assignments: [{ skuId, disabledPlans: [] }], observations: [], catalog: [
        { ...knownSkus[0], servicePlans: [] },
      ] },
      { label: "empty catalog", assignments: [], observations: [], catalog: [] },
    ])("marks exact verified users disabled with no paid plans: $label", async ({ assignments, observations, catalog }) => {
      const row = { ...graphUser(objectId, upn, "Active"), assignedLicenses: assignments, assignedPlans: observations };
      const fetcher = vi.fn<FetchLike>(async () => Response.json({ value: [row], "@odata.count": 1 }));
      const progress = vi.fn();
      const users = await new CopilotUsageGraphClient(withEmptyDiscovery(fetcher, catalog))
        .listCopilotUsers("token", undefined, progress, [upn]);
      expect(users).toEqual([expect.objectContaining({
        serviceEvidenceVersion: 1, identity: expect.objectContaining({ objectId, userPrincipalName: upn }),
        copilotServiceState: "disabled", servicePlans: [],
      })]);
      expect(progress.mock.calls).toEqual([[0], [1]]);
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it.each([
      { label: "unknown product", catalog: knownSkus, assignedSkuIds: [otherId] },
      { label: "empty catalog", catalog: [], assignedSkuIds: [otherId] },
      { label: "ordinary and unknown products", catalog: [
        ...knownSkus, { ...knownSkus[0], skuId: otherId, servicePlans: [] },
      ], assignedSkuIds: [otherId, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"] },
    ])("does not certify no paid service with an unresolvable current SKU: $label", async ({ catalog, assignedSkuIds }) => {
      const row = {
        ...graphUser(objectId, upn, "Active"),
        assignedLicenses: assignedSkuIds.map(skuId => ({ skuId: skuId.toUpperCase(), disabledPlans: [] })),
      };
      const fetcher = vi.fn<FetchLike>(async () => Response.json({ value: [row], "@odata.count": 1 }));
      const users = await new CopilotUsageGraphClient(withEmptyDiscovery(fetcher, catalog))
        .listCopilotUsers("token", undefined, undefined, [upn]);
      expect(users).toEqual([expect.objectContaining({
        serviceEvidenceVersion: 1, identity: expect.objectContaining({ objectId, userPrincipalName: upn }),
        copilotServiceState: "unknown", servicePlans: [],
      })]);
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it.each([
      { disabled: false, capabilityStatus: "Enabled", expected: "enabled", planState: "enabled" },
      { disabled: false, capabilityStatus: "Warning", expected: "warning", planState: "warning" },
      { disabled: true, capabilityStatus: "Enabled", expected: "unknown", planState: "disabled" },
      { disabled: false, capabilityStatus: "Deleted", expected: "unknown", planState: "disabled" },
      { disabled: false, capabilityStatus: "Suspended", expected: "unknown", planState: "suspended" },
      { disabled: false, capabilityStatus: "LockedOut", expected: "unknown", planState: "locked_out" },
      { disabled: false, capabilityStatus: null, expected: "unknown", planState: "unknown" },
    ])("requires proven active paid evidence alongside an unresolvable current SKU: %j", async ({ disabled, capabilityStatus, expected, planState }) => {
      const original = graphUser(objectId, upn, disabled ? "Disabled" : "Active");
      const row = {
        ...original,
        assignedLicenses: [...original.assignedLicenses, { skuId: otherId, disabledPlans: [] }],
        assignedPlans: capabilityStatus ? [{ ...original.assignedPlans[0], capabilityStatus }] : [],
      };
      for (const targeted of [false, true]) {
        const fetcher = vi.fn<FetchLike>(async () => Response.json({ value: [row], "@odata.count": 1 }));
        const client = new CopilotUsageGraphClient(targeted ? withEmptyDiscovery(fetcher) : withCatalog(fetcher));
        const [user] = await client.listCopilotUsers("token", undefined, undefined, targeted ? [upn] : []);
        expect(user.copilotServiceState).toBe(expected);
        expect(user.servicePlans).toEqual([expect.objectContaining({
          servicePlanId: appsPlanId, state: planState,
        })]);
        expect(fetcher).toHaveBeenCalledOnce();
      }
    });

    it.each([
      { disabled: false, statuses: ["Enabled"], expected: "enabled" },
      { disabled: true, statuses: ["Enabled"], expected: "disabled" },
      { disabled: true, statuses: [], expected: "disabled" },
      { disabled: false, statuses: ["Deleted"], expected: "disabled" },
      { disabled: false, statuses: ["Warning"], expected: "warning" },
      { disabled: false, statuses: ["Suspended"], expected: "suspended" },
      { disabled: false, statuses: ["LockedOut"], expected: "locked_out" },
      { disabled: false, statuses: [], expected: "unknown" },
      { disabled: false, statuses: ["Enabled", "Deleted"], expected: "unknown" },
    ])("derives exact paid service state from current evidence, never roster absence: %j", async ({ disabled, statuses, expected }) => {
      const original = graphUser(objectId, upn, disabled ? "Disabled" : "Active");
      const row = { ...original, assignedPlans: statuses.map(capabilityStatus => ({ ...original.assignedPlans[0], capabilityStatus })) };
      const fetcher = vi.fn<FetchLike>(async () => Response.json({ value: [row], "@odata.count": 1 }));
      const [user] = await new CopilotUsageGraphClient(withEmptyDiscovery(fetcher)).listCopilotUsers("token", undefined, undefined, [upn]);
      expect(user.copilotServiceState).toBe(expected);
      expect(user.servicePlans).toEqual([expect.objectContaining({ servicePlanId: appsPlanId, state: expected })]);
    });

    it("deduplicates normalized UPNs and object IDs across exact batches with distinct progress", async () => {
      const row = graphUser(objectId, upn.toUpperCase(), "Active");
      const fetcher = vi.fn<FetchLike>(async () => Response.json({ value: [row], "@odata.count": 1 }));
      const progress = vi.fn();
      const identities = [upn, ` ${upn.toUpperCase()} `, ...Array.from({ length: 19 }, (_, index) => `missing${index}@example.com`),
        objectId.toUpperCase(), objectId];
      const users = await new CopilotUsageGraphClient(withEmptyDiscovery(fetcher))
        .listCopilotUsers("token", undefined, progress, identities);
      expect(users).toHaveLength(1);
      expect(users[0].identity.objectId).toBe(objectId);
      expect(progress.mock.calls).toEqual([[0], [1], [1]]);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get("$filter")?.split(" or ")).toHaveLength(20);
      expect(new URL(String(fetcher.mock.calls[1][0])).searchParams.get("$filter")).toBe(`id eq '${objectId}'`);
    });

    it("deduplicates UPN and ID aliases within one page without equating identity count to user count", async () => {
      const row = graphUser(objectId, upn, "Active");
      const fetcher = vi.fn<FetchLike>(async () => Response.json({
        value: [row, { ...row, id: objectId.toUpperCase() }], "@odata.count": 1,
      }));
      const users = await new CopilotUsageGraphClient(withEmptyDiscovery(fetcher))
        .listCopilotUsers("token", undefined, undefined, [upn, objectId.toUpperCase()]);
      expect(users).toHaveLength(1);
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it.each(["same page", "separate batches", "product discovery"] as const)("rejects conflicting records from %s", async source => {
      const original = graphUser(objectId, "original@example.com", "Active");
      const changed = { ...original, userPrincipalName: upn, displayName: "Changed" };
      const fetcher = vi.fn<FetchLike>();
      let identities = [objectId];
      let client: CopilotUsageGraphClient;
      if (source === "product discovery") {
        fetcher.mockResolvedValueOnce(Response.json({ value: [original], "@odata.count": 1 }))
          .mockResolvedValueOnce(Response.json({ value: [changed], "@odata.count": 1 }));
        identities = [upn];
        client = new CopilotUsageGraphClient(withCatalog(fetcher));
      } else {
        if (source === "same page") {
          fetcher.mockResolvedValueOnce(Response.json({ value: [original, changed], "@odata.count": 1 }));
        } else {
          fetcher.mockResolvedValueOnce(Response.json({ value: [original], "@odata.count": 1 }))
            .mockResolvedValueOnce(Response.json({ value: [changed], "@odata.count": 1 }));
          identities = [original.userPrincipalName, ...Array.from({ length: 19 }, (_, index) => `missing${index}@example.com`), objectId];
        }
        client = new CopilotUsageGraphClient(withEmptyDiscovery(fetcher));
      }
      await expect(client.listCopilotUsers("token", undefined, undefined, identities))
        .rejects.toMatchObject({ code: "provider_schema", message: "Directory returned conflicting duplicate user records." });
      expect(fetcher).toHaveBeenCalledTimes(source === "same page" ? 1 : 2);
    });

    it("skips concealed or implausible identifiers without fabricating users or making an unfiltered query", async () => {
      const fetcher = vi.fn<FetchLike>();
      const identities = [
        "", "   ", "concealed-identifier", objectId.replaceAll("-", ""), "not-a-uuid", "person", "Person Name",
        "@example.com", "one@@example.com", "one@localhost", "one@-example.com", "one@example..com",
        ".one@example.com", "one.@example.com", "one..two@example.com", "one two@example.com",
        `${"x".repeat(65)}@example.com`, "x".repeat(321), "one@example.com\ninjected",
        "person@example.com' or accountEnabled eq true", "x') or true or ('x@example.com",
      ];
      await expect(new CopilotUsageGraphClient(withEmptyDiscovery(fetcher))
        .listCopilotUsers("token", undefined, undefined, identities)).resolves.toEqual([]);
      expect(fetcher).not.toHaveBeenCalled();
    });

    it("leaves plausible but unresolvable UPNs and UUIDs unresolved instead of inferring non-paid users", async () => {
      const fetcher = vi.fn<FetchLike>(async () => Response.json({ value: [], "@odata.count": 0 }));
      const progress = vi.fn();
      await expect(new CopilotUsageGraphClient(withEmptyDiscovery(fetcher))
        .listCopilotUsers("token", undefined, progress, [upn, objectId])).resolves.toEqual([]);
      expect(progress.mock.calls).toEqual([[0], [0]]);
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it("escapes exact normalized UPN literals and uses the same bounded, authenticated read-only query fields", async () => {
      const fetcher = vi.fn<FetchLike>(async (input, init) => {
        const url = new URL(String(input));
        const product = new URL(buildCopilotUsersUrl([skuId]));
        expect(url.origin + url.pathname).toBe("https://graph.microsoft.com/v1.0/users");
        expect(url.searchParams.get("$filter")).toBe(
          `userPrincipalName eq 'o''brien+tag@example.com' or id eq '${objectId}' or userPrincipalName eq 'x%27%20or%20true@example.com'`,
        );
        for (const field of ["$select", "$count", "$top"]) expect(url.searchParams.get(field)).toBe(product.searchParams.get(field));
        expect(init).toMatchObject({ method: "GET", redirect: "error" });
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private-token");
        expect(new Headers(init?.headers).get("ConsistencyLevel")).toBe("eventual");
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return Response.json({ value: [], "@odata.count": 0 });
      });
      await new CopilotUsageGraphClient(withEmptyDiscovery(fetcher)).listCopilotUsers("private-token", undefined, undefined, [
        " O'Brien+tag@EXAMPLE.COM ", objectId.toUpperCase(), "x%27%20or%20true@example.com",
        "x@example.com' or accountEnabled eq true",
      ]);
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it("bounds encoded exact query URLs as well as batch cardinality without dropping identities", async () => {
      const domain = Array.from({ length: 4 }, () => "d".repeat(60)).join(".");
      const identities = Array.from({ length: 41 }, (_, index) => `${"'".repeat(60)}${index}@${domain}`);
      const filters: string[] = [];
      const fetcher = vi.fn<FetchLike>(async input => {
        const url = String(input);
        expect(url.length).toBeLessThanOrEqual(8_192);
        const filter = new URL(url).searchParams.get("$filter")!;
        expect(filter.split(" or ").length).toBeLessThanOrEqual(20);
        filters.push(...filter.split(" or "));
        return Response.json({ value: [], "@odata.count": 0 });
      });
      await new CopilotUsageGraphClient(withEmptyDiscovery(fetcher)).listCopilotUsers("token", undefined, undefined, identities);
      expect(filters).toEqual(identities.map(identity => `userPrincipalName eq '${identity.replace(/'/g, "''")}'`));
      expect(fetcher.mock.calls.length).toBeGreaterThan(Math.ceil(identities.length / 20));
    });

    it("reads every exact page, validates unique counts and reports cumulative distinct progress", async () => {
      const row = graphUser(objectId, upn, "Active");
      const second = { ...graphUser(otherId, "second@example.com", "Active"), assignedLicenses: [], assignedPlans: [] };
      const fetcher = vi.fn<FetchLike>()
        .mockImplementationOnce(async input => Response.json({
          value: [row], "@odata.count": 2, "@odata.nextLink": `${String(input)}&$skiptoken=next`,
        }))
        .mockResolvedValueOnce(Response.json({ value: [row, second], "@odata.count": 2 }));
      const progress = vi.fn();
      const users = await new CopilotUsageGraphClient(withEmptyDiscovery(fetcher))
        .listCopilotUsers("token", undefined, progress, [upn, otherId]);
      expect(users.map(user => user.copilotServiceState)).toEqual(["enabled", "disabled"]);
      expect(progress.mock.calls).toEqual([[0], [1], [2]]);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it.each([false, true])("rejects returned users not matching either requested UPN or ID (continuation: %s)", async continuation => {
      const fetcher = vi.fn<FetchLike>();
      if (continuation) fetcher.mockImplementationOnce(async input => Response.json({
        value: [], "@odata.count": 1, "@odata.nextLink": `${String(input)}&$skiptoken=next`,
      }));
      fetcher.mockResolvedValueOnce(Response.json({
        value: [graphUser(otherId, "unrequested@example.com", "Active")], "@odata.count": 1,
      }));
      await expect(new CopilotUsageGraphClient(withEmptyDiscovery(fetcher))
        .listCopilotUsers("token", undefined, undefined, [upn, objectId]))
        .rejects.toMatchObject({ code: "provider_schema", message: "Directory returned a user outside the requested exact-identity filter." });
      expect(fetcher).toHaveBeenCalledTimes(continuation ? 2 : 1);
    });

    it.each([
      { id: "not-an-object-id" },
      { assignedLicenses: null },
      { assignedLicenses: [{ skuId, disabledPlans: null }] },
      { assignedPlans: null },
      { assignedPlans: [{ servicePlanId: appsPlanId, service: "M365_COPILOT_APPS", capabilityStatus: "Invalid" }] },
      { companyName: 42 },
    ])("uses the same strict directory parsing for exact records: %#", async fields => {
      const fetcher = vi.fn<FetchLike>(async () => Response.json({
        value: [{ ...graphUser(objectId, upn, "Active"), ...fields }], "@odata.count": 1,
      }));
      await expect(new CopilotUsageGraphClient(withEmptyDiscovery(fetcher))
        .listCopilotUsers("token", undefined, undefined, [upn])).rejects.toMatchObject({ code: "provider_schema" });
    });

    it.each([undefined, null, -1, 1.5, "1"])("rejects missing or invalid exact query counts: %s", async count => {
      const fetcher = vi.fn<FetchLike>(async () => Response.json({ value: [], "@odata.count": count }));
      await expect(new CopilotUsageGraphClient(withEmptyDiscovery(fetcher))
        .listCopilotUsers("token", undefined, undefined, [upn])).rejects.toMatchObject({ code: "provider_schema" });
    });

    it.each([
      { count: 1, values: [] },
      { count: 0, values: [graphUser(objectId, upn, "Active")] },
      { count: 2, values: [graphUser(objectId, upn, "Active"), graphUser(objectId, upn, "Active")] },
      { count: 3, values: [] },
    ])("rejects incomplete, duplicate-only, excessive or impossible exact counts: %#", async ({ count, values }) => {
      const fetcher = vi.fn<FetchLike>(async () => Response.json({ value: values, "@odata.count": count }));
      await expect(new CopilotUsageGraphClient(withEmptyDiscovery(fetcher))
        .listCopilotUsers("token", undefined, undefined, [upn, objectId])).rejects.toMatchObject({ code: "provider_count_mismatch" });
    });

    it.each([0, "1", null, -1])("rejects changing or invalid continuation counts: %s", async count => {
      const fetcher = vi.fn<FetchLike>()
        .mockImplementationOnce(async input => Response.json({
          value: [], "@odata.count": 1, "@odata.nextLink": `${String(input)}&$skiptoken=next`,
        }))
        .mockResolvedValueOnce(Response.json({ value: [graphUser(objectId, upn, "Active")], "@odata.count": count }));
      await expect(new CopilotUsageGraphClient(withEmptyDiscovery(fetcher))
        .listCopilotUsers("token", undefined, undefined, [upn])).rejects.toMatchObject({ code: "provider_schema" });
    });

    it.each([
      { next: "https://attacker.invalid/v1.0/users", code: "invalid_provider_link" },
      { next: `https://graph.microsoft.com/v1.0/users/${objectId}/licenseDetails`, code: "invalid_provider_link" },
      { next: "https://graph.microsoft.com/v1.0/users", code: "provider_schema" },
      { next: "https://graph.microsoft.com/v1.0/users?$filter=accountEnabled%20eq%20true", code: "provider_schema" },
      { next: "repeat", code: "provider_schema" },
      { next: "duplicate-filter", code: "provider_schema" },
    ])("rejects unsafe or repeated exact continuations before sending credentials: $next", async ({ next, code }) => {
      const fetcher = vi.fn<FetchLike>(async input => Response.json({
        value: [], "@odata.count": 1,
        "@odata.nextLink": next === "repeat" ? String(input)
          : next === "duplicate-filter" ? `${String(input)}&$filter=accountEnabled%20eq%20true` : next,
      }));
      await expect(new CopilotUsageGraphClient(withEmptyDiscovery(fetcher))
        .listCopilotUsers("private-token", undefined, undefined, [upn])).rejects.toMatchObject({ code });
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it.each([403, 429, 503])("surfaces exact verification failures instead of returning partial or fabricated users: %i", async status => {
      const fetcher = vi.fn<FetchLike>()
        .mockImplementationOnce(async input => Response.json({
          value: [graphUser(objectId, upn, "Active")], "@odata.count": 2, "@odata.nextLink": `${String(input)}&$skiptoken=next`,
        }))
        .mockResolvedValueOnce(Response.json({ error: { code: "ProviderFailure" } }, { status }));
      await expect(new CopilotUsageGraphClient(withEmptyDiscovery(fetcher))
        .listCopilotUsers("token", undefined, undefined, [upn, otherId])).rejects.toMatchObject({ status });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it.each(["catalog", "discovery", "verification"] as const)("preserves cancellation during %s before starting more requests", async stage => {
      const controller = new AbortController();
      const error = new Error("Cancelled");
      const fetcher = vi.fn<FetchLike>(async (input, init) => {
        const url = new URL(String(input));
        const current = String(input) === buildSubscribedSkusUrl() ? "catalog"
          : url.searchParams.get("$filter")?.startsWith("assignedLicenses/any(") ? "discovery" : "verification";
        if (stage === current) {
          controller.abort(error);
          expect(init?.signal?.aborted).toBe(true);
        }
        return Response.json(current === "catalog" ? { value: knownSkus } : { value: [], "@odata.count": 0 });
      });
      await expect(new CopilotUsageGraphClient(fetcher).listCopilotUsers("token", controller.signal, undefined, [upn])).rejects.toBe(error);
      expect(fetcher).toHaveBeenCalledTimes(stage === "catalog" ? 1 : stage === "discovery" ? 2 : 3);
    });

    it.each(["cancellation", "persistence failure"] as const)("awaits exact page progress and propagates %s before continuing", async failure => {
      const controller = new AbortController();
      const error = new Error(failure);
      const fetcher = vi.fn<FetchLike>(async input => Response.json({
        value: [graphUser(objectId, upn, "Active")], "@odata.count": 2, "@odata.nextLink": `${String(input)}&$skiptoken=next`,
      }));
      const progress = vi.fn(async (count: number) => {
        await Promise.resolve();
        if (count === 0) return;
        if (failure === "cancellation") controller.abort(error);
        else throw error;
      });
      await expect(new CopilotUsageGraphClient(withEmptyDiscovery(fetcher))
        .listCopilotUsers("token", controller.signal, progress, [upn, otherId])).rejects.toBe(error);
      expect(progress.mock.calls).toEqual([[0], [1]]);
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it("bounds report input before provider work and logs only counts", async () => {
      const fetcher = vi.fn<FetchLike>();
      const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        await expect(new CopilotUsageGraphClient(fetcher)
          .listCopilotUsers("private-token", undefined, undefined, Array.from({ length: 100_001 }, () => upn)))
          .rejects.toMatchObject({ code: "provider_result_limit" });
        expect(fetcher).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledOnce();
        expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ count: 100_001, rowLimit: 100_000 });
        expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-token|example\.com/);
      } finally {
        log.mockRestore();
      }
    });

    it("verifies 30,000 reported identities after using the full 1,000-page product discovery budget", async () => {
      const identities = Array.from({ length: 30_000 }, (_, index) => `reported${index}@example.com`);
      const requestedIdentities: string[] = [];
      const productUrl = buildCopilotUsersUrl(knownSkuIds);
      const candidate = graphUser(otherId, "candidate@example.com", "Active");
      const fetcher = vi.fn<FetchLike>(async input => {
        const url = new URL(String(input));
        expect(url.origin + url.pathname).toBe("https://graph.microsoft.com/v1.0/users");
        const filter = url.searchParams.get("$filter")!;
        if (filter.startsWith("assignedLicenses/any(")) {
          const page = Number(url.searchParams.get("$skiptoken") ?? 0);
          return Response.json({
            value: [candidate], "@odata.count": 1,
            ...(page < 999 ? { "@odata.nextLink": `${productUrl}&$skiptoken=${page + 1}` } : {}),
          });
        }
        const predicates = filter.split(" or ");
        expect(predicates).toHaveLength(20);
        const rows = predicates.map(predicate => {
          expect(predicate).toMatch(/^userPrincipalName eq 'reported\d+@example\.com'$/);
          const identity = predicate.slice("userPrincipalName eq '".length, -1);
          requestedIdentities.push(identity);
          const ordinal = identity.slice("reported".length, identity.indexOf("@"));
          return {
            ...graphUser(`11111111-1111-4111-8111-${ordinal.padStart(12, "0")}`, identity, "Active"),
            assignedLicenses: [], assignedPlans: [],
          };
        });
        return Response.json({ value: rows, "@odata.count": rows.length });
      });
      const progress = vi.fn();
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        const users = await new CopilotUsageGraphClient(withCatalog(fetcher))
          .listCopilotUsers("private-token", undefined, progress, identities);
        expect(users).toHaveLength(30_001);
        expect(new Set(users.map(user => user.identity.objectId)).size).toBe(30_001);
        expect(users.slice(1).map(user => user.identity.userPrincipalName)).toEqual(identities);
        expect(users.slice(1).every(user => user.copilotServiceState === "disabled" && user.servicePlans.length === 0)).toBe(true);
        expect(requestedIdentities).toEqual(identities);
        expect(fetcher).toHaveBeenCalledTimes(1_000 + 1_500);
        expect(progress).toHaveBeenCalledTimes(1_000 + 1_500);
        expect(progress).toHaveBeenNthCalledWith(1_000, 1);
        expect(progress).toHaveBeenLastCalledWith(30_001);
        expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({
          event: "copilot_license_inventory", count: 30_001, pages: 2_500, observedCount: 31_000,
        });
        expect(JSON.stringify(log.mock.calls)).not.toMatch(/example\.com|private-token|skiptoken/);
      } finally {
        log.mockRestore();
      }
    });

    it("caps exact verification at 5,000 batch pages plus 1,000 continuation pages independently of discovery", async () => {
      const fetcher = vi.fn<FetchLike>(async input => {
        const next = new URL(String(input));
        next.searchParams.set("$skiptoken", String(Number(next.searchParams.get("$skiptoken") ?? 0) + 1));
        return Response.json({ value: [], "@odata.count": 1, "@odata.nextLink": next.toString() });
      });
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        await expect(new CopilotUsageGraphClient(withEmptyDiscovery(fetcher))
          .listCopilotUsers("token", undefined, undefined, [upn])).rejects.toMatchObject({ code: "provider_result_limit" });
        expect(fetcher).toHaveBeenCalledTimes(6_000);
      } finally {
        log.mockRestore();
      }
    });

    it("shares the 100,000 observed-row limit across discovery and exact verification, including duplicates", async () => {
      const candidate = graphUser(otherId, "candidate@example.com", "Active");
      const reported = graphUser(objectId, upn, "Active");
      const productUrl = buildCopilotUsersUrl(knownSkuIds);
      const fetcher = vi.fn<FetchLike>(async input => {
        const url = new URL(String(input));
        if (!url.searchParams.get("$filter")?.startsWith("assignedLicenses/any(")) {
          return Response.json({ value: [reported, reported], "@odata.count": 1 });
        }
        const page = Number(url.searchParams.get("$skiptoken") ?? 0);
        return Response.json({
          value: Array.from({ length: page === 9 ? 9_999 : 10_000 }, () => candidate),
          "@odata.count": 1,
          ...(page < 9 ? { "@odata.nextLink": `${productUrl}&$skiptoken=${page + 1}` } : {}),
        });
      });
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        await expect(new CopilotUsageGraphClient(withCatalog(fetcher))
          .listCopilotUsers("token", undefined, undefined, [upn])).rejects.toMatchObject({ code: "provider_result_limit" });
        expect(fetcher).toHaveBeenCalledTimes(11);
      } finally {
        log.mockRestore();
      }
    });

    it("retains the exact response byte limit and value-free diagnostics", async () => {
      const maximumBytes = 16 * 1024 * 1024;
      const cancel = vi.fn();
      const fetcher = vi.fn<FetchLike>(async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(maximumBytes + 1)); },
        cancel,
      })));
      const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        await expect(new CopilotUsageGraphClient(withEmptyDiscovery(fetcher))
          .listCopilotUsers("private-token", undefined, undefined, [upn]))
          .rejects.toMatchObject({ code: "provider_response_size_limit" });
        expect(cancel).toHaveBeenCalledOnce();
        expect(fetcher).toHaveBeenCalledOnce();
        expect(log).toHaveBeenCalledOnce();
        expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
          event: "copilot_license_response_size_limit", source: "directory", maximumLength: maximumBytes,
        });
        expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-token|example\.com/);
      } finally {
        log.mockRestore();
      }
    });
  });

  it("rejects non-v1 CSV report schemas instead of guessing columns", async () => {
    const fetcher = vi.fn(async () => new Response("User Principal Name,Last Activity Date\nperson@example.com,2026-09-12"));
    await expect(new CopilotUsageGraphClient(fetcher).listAppActivity("token"))
      .rejects.toMatchObject({ code: "provider_schema" });
  });

  it("reads the v1 fields when Microsoft adds activity and prompt columns to the CSV", async () => {
    const additionalHeaders = [
      "Prompts submitted for All Apps",
      "Prompts submitted for Copilot Chat (work)",
      "Prompts submitted for Copilot Chat (web)",
      "Active Usage Days for All Apps",
      "Edge Last Activity Date",
      "Microsoft 365 App Last Activity Date",
      "Copilot Chat Work Last Activity Date",
      "Copilot Chat Web Last Activity Date",
    ];
    const base = reportCsv([reportUser("one@example.com", "2026-09-12")]);
    const [headers, row] = base.split("\n");
    const extended = [
      [headers, ...additionalHeaders].join(","),
      [row, "20", "10", "10", "3", "2026-09-11", "", "", ""].join(","),
    ].join("\n");
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(base))
      .mockResolvedValueOnce(new Response(extended));
    const client = new CopilotUsageGraphClient(fetcher);
    const expected = await client.listAppActivity("token");
    await expect(client.listAppActivity("token")).resolves.toEqual(expected);
  });

  it("matches required CSV columns by exact header even when reordered", async () => {
    const csv = reportCsv([reportUser("one@example.com", "2026-09-12")])
      .split("\n").map(row => row.split(",").reverse().join(",")).join("\n");
    const fetcher = vi.fn(async () => new Response(csv));
    await expect(new CopilotUsageGraphClient(fetcher).listAppActivity("token")).resolves.toMatchObject({
      reportRefreshDate: "2026-09-13",
      users: [{
        normalizedUserPrincipalName: "one@example.com",
        activity: { lastActivityDate: "2026-09-12", wordCopilotLastActivityDate: null },
      }],
    });
  });

  it.each(["User Principal Name", "", "Last Activity Date"])("rejects ambiguous or empty additive CSV headers: %s", async header => {
    const [headers, row] = reportCsv([reportUser("one@example.com", "2026-09-12")]).split("\n");
    const fetcher = vi.fn(async () => new Response(`${headers},${header}\n${row},unexpected`));
    await expect(new CopilotUsageGraphClient(fetcher).listAppActivity("token"))
      .rejects.toMatchObject({ code: "provider_schema" });
  });

  it.each([
    { reason: "invalid date", date: "2026-02-31", additionalValues: ",value" },
    { reason: "missing column", date: "2026-09-12", additionalValues: "" },
    { reason: "extra column", date: "2026-09-12", additionalValues: ",value,unexpected" },
  ])("rejects $reason when extra CSV columns are present", async ({ date, additionalValues }) => {
    const [headers, row] = reportCsv([reportUser("one@example.com", date)]).split("\n");
    const fetcher = vi.fn(async () => new Response(`${headers},Extra\n${row}${additionalValues}`));
    await expect(new CopilotUsageGraphClient(fetcher).listAppActivity("token"))
      .rejects.toMatchObject({ code: "provider_schema" });
  });

  it("keeps a valid header-only report empty with unknown refresh metadata", async () => {
    const fetcher = vi.fn(async () => new Response(reportCsv([]), { headers: { "content-type": "application/octet-stream" } }));
    await expect(new CopilotUsageGraphClient(fetcher).listAppActivity("token")).resolves.toEqual({
      users: [],
      reportRefreshDate: null,
    });
  });

  it("rejects impossible calendar dates instead of rolling them into another month", async () => {
    const fetcher = vi.fn(async () => new Response(reportCsv([reportUser("one@example.com", "2026-02-31")])));
    await expect(new CopilotUsageGraphClient(fetcher).listAppActivity("token")).rejects.toMatchObject({ code: "provider_schema" });
  });

  it("accepts Graph GUIDs without imposing unrelated UUID version restrictions", async () => {
    const fetcher = vi.fn(async () => Response.json({ "@odata.count": 1, value: [
      graphUser("11111111-1111-7111-1111-111111111111", "one@example.com", "Active"),
    ] }));
    await expect(new CopilotUsageGraphClient(withCatalog(fetcher)).listCopilotUsers("token")).resolves.toHaveLength(1);
  });
});

function withCatalog(fetcher: FetchLike): FetchLike {
  return (input, init) => String(input) === buildSubscribedSkusUrl()
    ? Promise.resolve(Response.json({ value: knownSkus }))
    : fetcher(input, init);
}

function directoryWithCatalog(row: unknown, catalog: unknown[] = knownSkus) {
  return vi.fn<FetchLike>(async input => String(input) === buildSubscribedSkusUrl()
    ? Response.json({ value: catalog })
    : Response.json({ value: [row], "@odata.count": 1 }));
}

function withEmptyDiscovery(fetcher: FetchLike, catalog: unknown[] = knownSkus): FetchLike {
  return (input, init) => {
    if (String(input) === buildSubscribedSkusUrl()) return Promise.resolve(Response.json({ value: catalog }));
    if (new URL(String(input)).searchParams.get("$filter")?.startsWith("assignedLicenses/any(")) {
      return Promise.resolve(Response.json({ value: [], "@odata.count": 0 }));
    }
    return fetcher(input, init);
  };
}

function graphUser(id: string, upn: string, state: string, assignedSkuId = skuId) {
  return {
    id,
    userPrincipalName: upn,
    displayName: upn.split("@")[0],
    accountEnabled: true,
    employeeType: "Employee",
    companyName: "Contoso Health",
    department: "Engineering",
    userType: "Member",
    assignedLicenses: [{ skuId: assignedSkuId, disabledPlans: state === "Disabled" ? [appsPlanId] : [] as string[] }],
    assignedPlans: [{ servicePlanId: appsPlanId, service: "M365_COPILOT_APPS", assignedDateTime: "2026-01-01T00:00:00Z", capabilityStatus: state === "Disabled" ? "Deleted" : "Enabled" }],
    licenseAssignmentStates: [{ skuId: assignedSkuId, state, error: "None", assignedByGroup: null }],
  };
}

function reportUser(userPrincipalName: string, lastActivityDate: string) {
  return ["2026-09-13", userPrincipalName, userPrincipalName, lastActivityDate, "", lastActivityDate, "", "", "", "", "", "", "30"];
}

function reportCsv(rows: string[][]) {
  return [
    "Report Refresh Date,User Principal Name,Display Name,Last Activity Date,Copilot Chat Last Activity Date,Microsoft Teams Copilot Last Activity Date,Word Copilot Last Activity Date,Excel Copilot Last Activity Date,PowerPoint Copilot Last Activity Date,Outlook Copilot Last Activity Date,OneNote Copilot Last Activity Date,Loop Copilot Last Activity Date,Report Period",
    ...rows.map(row => row.join(",")),
  ].join("\n");
}
