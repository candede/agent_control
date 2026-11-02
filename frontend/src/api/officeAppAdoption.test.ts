// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { request } from "./client";
import { officeAdoption, officeQueryString } from "./officeAppAdoption";

vi.mock("./client", () => ({ request: vi.fn() }));
afterEach(() => vi.mocked(request).mockReset());

it("encodes nullable and literal group filters with separate Office snapshots", () => {
  const query = { company: null, department: "~null", officeSnapshot: "11111111-1111-4111-8111-111111111111", app: "teams" as const };
  const encoded = new URLSearchParams(officeQueryString(query));
  expect(Object.fromEntries(encoded)).toEqual({ ...query,company:"~null",department:"~string:~null" });
  expect(encoded.has("snapshot")).toBe(false);
});

it("preserves supported literal facets and opaque people cursors in every paged API", async () => {
  const query = { company: "Example\tCompany", department: "Research\u0001Development",
    selectionId: "11111111-1111-4111-8111-111111111111", cursor: "opaque.signed", limit: 50 };
  const encoded = new URLSearchParams(officeQueryString(query));
  expect(encoded.get("company")).toBe("~string:Example\tCompany");
  expect(encoded.get("department")).toBe("~string:Research\u0001Development");
  expect(encoded.get("cursor")).toBe(query.cursor);
  await officeAdoption.history(query);
  await officeAdoption.departments(query);
  await officeAdoption.facets("company", query);
  await officeAdoption.people("exact-group", query);
  expect(vi.mocked(request).mock.calls.map(([path]) => path)).toEqual([
    `/api/office-app-adoption/history${officeQueryString(query)}`,
    `/api/office-app-adoption/departments${officeQueryString(query)}`,
    `/api/office-app-adoption/facets${officeQueryString({ ...query, kind: "company" })}`,
    `/api/office-app-adoption/groups/exact-group/people${officeQueryString(query)}`,
  ]);
});

it("sends the same selected query to every panel without overwriting validation inputs", async () => {
  const query = { selectionId: "11111111-1111-4111-8111-111111111111", company: "A / B", app: "word" as const };
  const signal = new AbortController().signal;
  await officeAdoption.context(query,signal);
  await officeAdoption.summary(query,signal);
  await officeAdoption.comparison(query,signal);
  await officeAdoption.groups({ ...query,limit:100 },signal);
  await officeAdoption.people("exact/group",query,signal);
  expect(vi.mocked(request).mock.calls.map(([path]) => path)).toEqual([
    `/api/office-app-adoption/context${officeQueryString(query)}`,
    `/api/office-app-adoption/summary${officeQueryString(query)}`,
    `/api/office-app-adoption/comparison${officeQueryString(query)}`,
    `/api/office-app-adoption/groups${officeQueryString({ ...query,limit:100 })}`,
    `/api/office-app-adoption/groups/exact%2Fgroup/people${officeQueryString(query)}`,
  ]);
  expect(vi.mocked(request).mock.calls.every(([,options]) => options?.signal===signal)).toBe(true);
});
