import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { generationInput } from "../../scripts/largeTenantFixtures.js";
import { UserSourceStages } from "../db/userSourceStages.js";
import { UserSourceProvider } from "./userSourceProvider.js";
import type { FetchLike } from "./graphPackages.js";

const skuId = "639dec6b-bb19-468b-871c-c5c441c4b0cb";
const otherSku = "15f2e9fc-b782-4f73-bf51-81d8b7fff6f4";
const planId = "a62f8878-de10-42f3-b68f-6149a25ceb97";
const objectId = "aaaaaaaa-aaaa-7aaa-1aaa-aaaaaaaaaaaa";
const upn = "reported@example.invalid";
const catalog = [{ skuId, appliesTo: "User", servicePlans: [{ servicePlanId: planId }] }];
type Options = Parameters<UserSourceProvider["refresh"]>[2];

function user(id = objectId, username = upn) {
  return { id, userPrincipalName: username, displayName: "Employee", accountEnabled: true,
    companyName: "Company", department: "Department", employeeType: "Employee", userType: "Member",
    assignedLicenses: [{ skuId, disabledPlans: [] as string[] }],
    assignedPlans: [{ servicePlanId: planId, service: "M365_COPILOT_APPS",
      assignedDateTime: "2026-01-01T00:00:00Z", capabilityStatus: "Enabled" }] };
}
function kind(url: URL) {
  return url.pathname.endsWith("subscribedSkus") ? "catalog"
    : url.searchParams.get("$filter")!.includes("assignedLicenses") ? "discovery" : "identity";
}

describe("record-backed Graph provider protocol", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => { fixture = await testDatabase(); }, 30_000);
  afterAll(async () => { await fixture?.close(); });

  function setup(fetcher: FetchLike) {
    const stages = new UserSourceStages(fixture.runtime);
    const input = generationInput({ scope: { ...generationInput().scope, principalId: randomUUID() } });
    const wait = vi.fn(async () => undefined);
    return { stages, input, wait, collect: (options: Partial<Options> = {}) =>
      new UserSourceProvider(fetcher, wait).refresh(stages, input, { authorize: async () => "synthetic-token", ...options }) };
  }
  async function noHead(principal: string) {
    expect((await fixture.runtime.query(`SELECT h.generation_id FROM data_generation_heads h
      JOIN data_scope_epochs s ON s.id=h.scope_id WHERE s.principal_id=$1 ORDER BY h.scope_id LIMIT 2`, [principal])).rows)
      .toEqual([{ generation_id: null }]);
  }
  function requested(source: "discovery" | "identity", response: (url: URL) => Response | Promise<Response>): FetchLike {
    return async (target, options) => {
      const url = new URL(String(target)), current = kind(url);
      expect(options).toMatchObject({ method: "GET", redirect: "error", signal: expect.any(AbortSignal) });
      expect(new Headers(options?.headers).has("Authorization")).toBe(true);
      if (current === "catalog") return Response.json({ value: catalog });
      expect(new Headers(options?.headers).get("ConsistencyLevel")).toBe("eventual");
      return current === source ? response(url) : Response.json({ value: [], "@odata.count": 0 });
    };
  }

  it.each(["discovery", "identity"] as const)("rejects missing, invalid and excessive %s counts without publication", async source => {
    for (const count of [undefined, null, -1, 1.5, "1", 100001]) {
      const fetcher = vi.fn(requested(source, () => Response.json({ value: [], "@odata.count": count })));
      const run = setup(fetcher);
      await expect(run.collect({ identities: lease => run.stages.identities(lease, [upn]) }))
        .rejects.toMatchObject({ code: "provider_count_mismatch" });
      await noHead(run.input.scope.principalId);
      expect(fetcher).toHaveBeenCalledTimes(source === "discovery" ? 2 : 3);
    }
  });

  it.each(["discovery", "identity"] as const)("reconciles unique %s members rather than raw duplicates or reported identities", async source => {
    for (const example of [
      { count: 1, values: [] }, { count: 0, values: [user()] },
      { count: 2, values: [user(), user()] }, { count: 3, values: [] },
    ]) {
      const run = setup(requested(source, () => Response.json({ value: example.values, "@odata.count": example.count })));
      await expect(run.collect({ identities: lease => run.stages.identities(lease, [upn, objectId]) }))
        .rejects.toMatchObject({ code: "provider_count_mismatch" });
      await noHead(run.input.scope.principalId);
    }
    const run = setup(requested(source, () => Response.json({
      value: [user(), { ...user(), id: objectId.toUpperCase() }], "@odata.count": 1,
    })));
    const result = await run.collect({ identities: lease => run.stages.identities(lease, [upn, objectId.toUpperCase()]) });
    expect(result.rows).toBe(1);
    expect((await fixture.runtime.query("SELECT count(*)::int AS n FROM directory_user_rows WHERE generation_id=$1", [result.generationId])).rows[0].n).toBe(1);
  });

  it.each(["discovery", "identity"] as const)("rejects a contradictory %s continuation count", async source => {
    for (const count of [0, 2, "1", null, -1, 1.5]) {
      let page = 0;
      const run = setup(requested(source, url => {
        const next = new URL(url); next.searchParams.set("$skiptoken", "next");
        return Response.json(page++ === 0 ? { value: [user()], "@odata.count": 1, "@odata.nextLink": next.toString() }
          : { value: [user()], "@odata.count": count });
      }));
      await expect(run.collect({ identities: lease => run.stages.identities(lease, [upn, objectId]) }))
        .rejects.toMatchObject({ code: "provider_count_mismatch" });
      expect(page).toBe(2);
      await noHead(run.input.scope.principalId);
    }
  });

  it.each(["catalog", "discovery", "identity"] as const)("rejects null %s collections on initial and continuation pages", async source => {
    for (const continuation of [false, true]) {
      let requests = 0;
      const fetcher = vi.fn<FetchLike>(async target => {
        const url = new URL(String(target)), current = kind(url);
        if (current !== source) return Response.json(current === "catalog" ? { value: catalog } : { value: [], "@odata.count": 0 });
        requests++;
        if (continuation && requests === 1) {
          url.searchParams.set("$skiptoken", "next");
          return Response.json({ value: [], "@odata.count": 0, "@odata.nextLink": url.toString() });
        }
        return Response.json(null);
      });
      const run = setup(fetcher);
      await expect(run.collect({ identities: lease => run.stages.identities(lease, [upn]) }))
        .rejects.toMatchObject({ code: "provider_schema" });
      expect(requests).toBe(continuation ? 2 : 1);
      await noHead(run.input.scope.principalId);
    }
  });

  it.each(["no_paid_plans", "company_scope", "different_paid_plans"] as const)("rejects conflicting catalog eligibility: %s", async conflict => {
    const changed = { ...catalog[0], ...(conflict === "company_scope" ? { appliesTo: "Company" }
      : { servicePlans: conflict === "no_paid_plans" ? [] : [{ servicePlanId: "b95945de-b3bd-46db-8437-f2beb6ea2347" }] }) };
    for (const paged of [false, true]) for (const reverse of [false, true]) {
      let calls = 0;
      const records = reverse ? [changed, catalog[0]] : [catalog[0], changed];
      const run = setup(async target => {
        const url = new URL(String(target));
        expect(kind(url)).toBe("catalog");
        calls++;
        if (!paged) return Response.json({ value: records });
        url.searchParams.set("$skiptoken", "next");
        return Response.json({ value: [records[calls - 1]], ...(calls === 1 ? { "@odata.nextLink": url.toString() } : {}) });
      });
      await expect(run.collect()).rejects.toMatchObject({ code: "provider_schema" });
      expect(calls).toBe(paged ? 2 : 1);
      await noHead(run.input.scope.principalId);
    }
  });

  it("accepts equivalent catalog duplicates without querying excluded products", async () => {
    let catalogPages = 0, directoryPages = 0;
    const run = setup(async target => {
      const url = new URL(String(target));
      if (kind(url) === "catalog") {
        catalogPages++;
        url.searchParams.set("$skiptoken", "next");
        return Response.json({ value: [
          { ...catalog[0], servicePlans: catalogPages === 1 ? catalog[0].servicePlans : [...catalog[0].servicePlans, ...catalog[0].servicePlans] },
          { ...catalog[0], skuId: otherSku, appliesTo: "Company" },
        ], ...(catalogPages === 1 ? { "@odata.nextLink": url.toString() } : {}) });
      }
      directoryPages++;
      expect(url.searchParams.get("$filter")).toBe(`assignedLicenses/any(value:value/skuId eq ${skuId})`);
      return Response.json({ value: [], "@odata.count": 0 });
    });
    expect((await run.collect()).rows).toBe(0);
    expect([catalogPages, directoryPages]).toEqual([2, 1]);
  });

  it.each(["discovery", "identity"] as const)("rejects records outside the requested %s filter", async source => {
    for (const continuation of [false, true]) {
      let page = 0;
      const run = setup(requested(source, url => {
        page++;
        if (continuation && page === 1) {
          url.searchParams.set("$skiptoken", "next");
          return Response.json({ value: [], "@odata.count": 1, "@odata.nextLink": url.toString() });
        }
        const row = source === "discovery" ? { ...user(), assignedLicenses: [] }
          : user("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "unrequested@example.invalid");
        return Response.json({ value: [row], "@odata.count": 1 });
      }));
      await expect(run.collect({ identities: lease => run.stages.identities(lease, [upn, objectId]) }))
        .rejects.toMatchObject({ code: "provider_schema" });
      expect(page).toBe(continuation ? 2 : 1);
      await noHead(run.input.scope.principalId);
    }
  });

  it.each(["off_host", "wrong_path", "missing_filter", "changed_filter", "duplicate_filter", "repeated"] as const)(
    "rejects unsafe exact continuation %s before forwarding credentials", async failure => {
      let calls = 0;
      const run = setup(requested("identity", initial => {
        calls++;
        const next = new URL(initial);
        if (failure === "off_host") next.hostname = "attacker.invalid";
        else if (failure === "wrong_path") next.pathname += "/private/licenseDetails";
        else if (failure === "missing_filter") next.search = "";
        else if (failure === "changed_filter") next.searchParams.set("$filter", "accountEnabled eq true");
        else if (failure === "duplicate_filter") next.searchParams.append("$filter", "accountEnabled eq true");
        return Response.json({ value: [], "@odata.count": 1, "@odata.nextLink": next.toString() });
      }));
      await expect(run.collect({ identities: lease => run.stages.identities(lease, [upn]) })).rejects.toMatchObject({ status: 502 });
      expect(calls).toBe(1);
      await noHead(run.input.scope.principalId);
    });

  it.each(["same_page", "separate_queries", "product_discovery"] as const)("rejects conflicting exact evidence across %s", async variation => {
    let exact = 0;
    const run = setup(async target => {
      const url = new URL(String(target));
      if (kind(url) === "catalog") return Response.json({ value: catalog });
      if (kind(url) === "discovery") return Response.json({ value: variation === "product_discovery" ? [user()] : [], "@odata.count": variation === "product_discovery" ? 1 : 0 });
      exact++;
      const first = user(), changed = { ...user(), displayName: "Changed", userPrincipalName: "z@example.invalid" };
      return Response.json({ value: variation === "same_page" ? [first, changed] : [variation === "product_discovery" || exact > 1 ? changed : first], "@odata.count": 1 });
    });
    await expect(run.collect({ identities: lease => run.stages.identities(lease, [
      objectId, upn, ...Array.from({ length: 19 }, (_, n) => `missing${n}@example.invalid`), "z@example.invalid",
    ]) })).rejects.toMatchObject({ code: "provider_schema" });
    await noHead(run.input.scope.principalId);
  });

  it("bounds encoded exact URLs without dropping long escaped identities", async () => {
    const domain = Array.from({ length: 4 }, () => "d".repeat(60)).join(".");
    const identities = Array.from({ length: 41 }, (_, n) => `${"'".repeat(60)}${n}@${domain}`);
    const observed: string[] = [];
    let exactPages = 0;
    const run = setup(requested("identity", url => {
      expect(url.toString().length).toBeLessThanOrEqual(8192);
      const predicates = url.searchParams.get("$filter")!.split(" or ");
      expect(predicates.length).toBeLessThanOrEqual(20);
      observed.push(...predicates); exactPages++;
      return Response.json({ value: [], "@odata.count": 0 });
    }));
    expect((await run.collect({ identities: lease => run.stages.identities(lease, identities) })).rows).toBe(0);
    expect(exactPages).toBeGreaterThan(Math.ceil(identities.length / 20));
    expect(observed).toEqual([...identities].sort().map(identity => `userPrincipalName eq '${identity.replace(/'/g, "''")}'`));
  });

  it.each(["catalog", "discovery", "identity"] as const)("preserves cancellation during %s before any later request", async source => {
    const controller = new AbortController(), failure = new Error("Synthetic cancellation");
    const fetcher = vi.fn<FetchLike>(async (target, options) => {
      const current = kind(new URL(String(target)));
      if (current === source) { controller.abort(failure); expect(options?.signal?.aborted).toBe(true); }
      return Response.json(current === "catalog" ? { value: catalog } : { value: [], "@odata.count": 0 });
    });
    const run = setup(fetcher);
    await expect(run.collect({ signal: controller.signal, identities: lease => run.stages.identities(lease, [upn]) })).rejects.toBe(failure);
    expect(fetcher).toHaveBeenCalledTimes(source === "catalog" ? 1 : source === "discovery" ? 2 : 3);
    await noHead(run.input.scope.principalId);
  });

  it.each(["discovery", "identity"] as const)("awaits %s progress persistence and cancellation before continuation", async source => {
    for (const cancel of [false, true]) {
      const controller = new AbortController(), failure = new Error("Synthetic progress failure");
      let calls = 0;
      const run = setup(requested(source, url => {
        calls++; url.searchParams.set("$skiptoken", "next");
        return Response.json({ value: [user()], "@odata.count": 2, "@odata.nextLink": url.toString() });
      }));
      const progress = vi.fn(async (count: number) => {
        await Promise.resolve();
        if (!count) return;
        if (cancel) controller.abort(failure); else throw failure;
      });
      await expect(run.collect({ signal: controller.signal, progress,
        identities: lease => run.stages.identities(lease, [upn, objectId]) })).rejects.toBe(failure);
      expect(calls).toBe(1);
      expect(progress).toHaveBeenLastCalledWith(1);
      await noHead(run.input.scope.principalId);
    }
  });

  it("does not acquire or call the provider when already cancelled", async () => {
    const controller = new AbortController(); controller.abort();
    const fetcher = vi.fn<FetchLike>(), authorize = vi.fn(async () => "synthetic-token"), run = setup(fetcher);
    await expect(run.collect({ signal: controller.signal, authorize })).rejects.toMatchObject({ name: "AbortError" });
    expect(authorize).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([403, 429, 503])("never publishes partial source evidence after a later %i response", async status => {
    let requests = 0;
    const run = setup(requested("identity", url => {
      requests++;
      if (requests > 1) return Response.json({ error: { code: "SyntheticFailure" } }, { status });
      url.searchParams.set("$skiptoken", "next");
      return Response.json({ value: [user()], "@odata.count": 2, "@odata.nextLink": url.toString() });
    }));
    await expect(run.collect({ identities: lease => run.stages.identities(lease, [upn, objectId]) })).rejects.toMatchObject({ status });
    expect(requests).toBe(status === 403 ? 2 : 4);
    expect(run.wait).toHaveBeenCalledTimes(status === 403 ? 0 : 2);
    await noHead(run.input.scope.principalId);
  });

  it("does not replace catalog permission failure with a SKU allowlist", async () => {
    const fetcher = vi.fn<FetchLike>(async () => Response.json({ error: { code: "Authorization_RequestDenied" } }, { status: 403 }));
    const run = setup(fetcher);
    await expect(run.collect()).rejects.toMatchObject({ status: 403 });
    expect(fetcher).toHaveBeenCalledOnce(); await noHead(run.input.scope.principalId);
  });

  it.each(["catalog", "discovery", "identity"] as const)("cancels oversized %s responses at their existing byte ceiling", async source => {
    const bytes = source === "catalog" ? 2_000_000 : 16 * 1024 * 1024, cancel = vi.fn();
    const run = setup(async target => {
      const current = kind(new URL(String(target)));
      if (current !== source) return Response.json(current === "catalog" ? { value: catalog } : { value: [], "@odata.count": 0 });
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(bytes + 1)); }, cancel }));
    });
    await expect(run.collect({ identities: lease => run.stages.identities(lease, [upn]) }))
      .rejects.toMatchObject({ code: "provider_response_size_limit", message: "Graph page exceeds its byte limit." });
    expect(cancel).toHaveBeenCalledOnce(); await noHead(run.input.scope.principalId);
  });

  it("collects every 2167-user enterprise page above 2 MB without retaining a tenant array", async () => {
    const total = 2167, id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
    let catalogPages = 0, directoryPages = 0;
    const run = setup(async target => {
      const url = new URL(String(target));
      if (kind(url) === "catalog") {
        catalogPages++;
        url.searchParams.set("$skiptoken", "catalog");
        return Response.json({ value: [{ ...catalog[0], skuId: catalogPages === 1 ? skuId : otherSku }],
          ...(catalogPages === 1 ? { "@odata.nextLink": url.toString() } : {}) });
      }
      directoryPages++;
      const offset = Number(url.searchParams.get("$skiptoken") ?? 0);
      expect(url.searchParams.get("$top")).toBe("100");
      const rows = Array.from({ length: Math.min(100, total - offset) }, (_, index) => {
        const ordinal = offset + index, row = user(id(ordinal), `person${ordinal}@example.invalid`);
        row.assignedLicenses = [{ skuId: ordinal < 10 ? skuId : otherSku, disabledPlans: ordinal === 10 ? [planId] : [] }];
        row.assignedPlans = Array.from({ length: 300 }, () => ({ ...row.assignedPlans[0],
          servicePlanId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", service: "Other enterprise plan" })).concat(row.assignedPlans);
        return row;
      });
      const body = { value: rows, ...(offset === 0 ? { "@odata.count": total } : {}),
        ...(offset + rows.length < total ? { "@odata.nextLink": (() => { const next = new URL(url); next.searchParams.set("$skiptoken", String(offset + rows.length)); return next.toString(); })() } : {}) };
      if (rows.length === 100) expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(2_000_000);
      expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(16 * 1024 * 1024);
      return Response.json(body);
    });
    const progress = vi.fn(async (_count: number) => undefined), result = await run.collect({ progress });
    expect(result.rows).toBe(total);
    expect([catalogPages, directoryPages]).toEqual([2, 22]);
    expect(progress).toHaveBeenLastCalledWith(total);
    expect((await fixture.runtime.query(`SELECT count(*)::int AS n,count(*) FILTER(WHERE service_state='enabled')::int AS enabled,
      count(*) FILTER(WHERE plan_count=1)::int AS plans FROM directory_user_rows WHERE generation_id=$1`, [result.generationId])).rows)
      .toEqual([{ n: total, enabled: total - 1, plans: total }]);
    const exact = (await fixture.runtime.query("SELECT service_state,residual FROM directory_user_rows WHERE generation_id=$1 AND identity=$2",
      [result.generationId, id(10)])).rows;
    expect(exact).toEqual([{ service_state: "disabled", residual: expect.any(Object) }]);
    expect(JSON.stringify(exact)).not.toMatch(/skuId|skuPartNumber|licenseAssignmentStates/);
  }, 30_000);
});
