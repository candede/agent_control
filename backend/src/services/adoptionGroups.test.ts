import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { generationInput, selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { UserSourceStages } from "../db/userSourceStages.js";
import { saveUsageInventory } from "../db/agentUsageTestSupport.js";
import { OfficialReportImports } from "../db/officialReportImports.js";
import { schemaRegistry } from "./officialReportFields.js";
import { LargeTenantUsersReports, reportQuery } from "./largeTenantUsersReports.js";
import { readAdoptionGroups } from "./adoptionGroups.js";
import type { CopilotDirectoryUser } from "../types/copilotUsage.js";
import type { ReportQuery } from "../types/officialReportData.js";

describe("read-only adoption groups", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => { fixture = await testDatabase(); }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  const secret = "synthetic-adoption-test-secret-not-production";
  function user(n: number, company: string | null = "Contoso", department: string | null = "HR"): CopilotDirectoryUser {
    return { serviceEvidenceVersion: 1, identity: {
      objectId: `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      userPrincipalName: `user${n}@example.invalid`, displayName: `User ${n}`,
      companyName: company, department, accountEnabled: true, employeeType: null, userType: "Member",
    }, copilotServiceState: "disabled", servicePlans: [] };
  }
  async function setup(users: CopilotDirectoryUser[]) {
    const identity = { ...selectionIdentity, tenantId: randomUUID(), principalId: randomUUID() };
    const stages = new UserSourceStages(fixture.runtime);
    const saveUsers = (users: CopilotDirectoryUser[]) => stages.execute(generationInput({ scope: { ...generationInput().scope, ...identity } }), async lease => {
      const key = await stages.query(lease, "discovery", "synthetic:adoption");
      await stages.page(lease, key, "synthetic:adoption", users.length, users.length);
      for (let offset = 0; offset < users.length; offset += 250) await stages.directory(lease, key, users.slice(offset, offset + 250));
      await stages.finishQuery(lease, key);
    }, { beforePublish: async () => {} });
    await saveUsers(users);
    const reader = new LargeTenantUsersReports(fixture.runtime, secret, 7);
    const read = async (query: ReportQuery = {}, limit = 5) => {
      const selection = await reader.capture(identity, "delegated", "adoption", query);
      return reader.read(selection.id, identity, (client, context) => readAdoptionGroups(client, reader, context, { limit }));
    };
    return { identity, reader, read, saveUsers };
  }
  async function publish(identity: typeof selectionIdentity, data: { users: string[]; agents: string[]; userAgents: string[] }) {
    const imports = new OfficialReportImports(fixture.runtime), bundleId = randomUUID();
    for (const kind of ["users", "agents", "userAgents"] as const) {
      await imports.stage(identity, { bundleId }, (async function* () {
        yield Buffer.from(`${schemaRegistry[kind].headers.join(",")}\n${data[kind].join("\n")}\n`);
      })());
    }
    return imports.acceptBundle(identity, bundleId, await imports.bundle(identity, bundleId));
  }
  it("rejects the bounded group-row sentinel instead of extracting an unbounded cohort or returning a partial success", async () => {
    const { read } = await setup(Array.from({ length: 16_385 }, (_, index) => user(index + 1)));
    await expect(read()).rejects.toMatchObject({ status: 413, code: "adoption_page_too_large" });
  }, 60000);
  it("normalizes organization fields, keeps missing departments, and includes users without paid Copilot", async () => {
    const { read } = await setup([user(1), user(2, " contoso ", " hr "), user(3, "Contoso", null)]);
    const page = await read();
    expect(page.counts).toEqual({ total: 2, filtered: 2 });
    expect(page.value.find(group => group.department === "HR")?.people).toHaveLength(2);
    expect(page.value.find(group => group.department === "Department not provided")?.people).toHaveLength(1);
    expect(page.value.flatMap(group => group.people).every(person => !person.champion && person.responses === null)).toBe(true);
    expect(page.inventoryAvailable).toBe(false);
    expect((await read({ search: "CONTOSO hr" })).value).toHaveLength(1);
    expect((await read({ search: "no-match" })).counts).toEqual({ total: 2, filtered: 0 });
  });
  it("unions creations and usage, deduplicates agents, excludes first/third party, and marks up to three champs", async () => {
    const { identity, read } = await setup(Array.from({ length: 5 }, (_, i) => user(i + 1)));
    await saveUsageInventory(fixture.runtime, identity, [
      { packages: ["HR-A", "HR-B"], native: { nativeId: randomUUID(), environmentId: randomUUID(), createdBy: user(5).identity.objectId },
        packageFields: { type: "custom", platform: "CopilotStudio", shortDescription: "Built using Microsoft 365 Copilot Agent Builder",
          longDescription: "Helps HR colleagues find policies and onboarding guidance." } },
      { packages: ["Unused"], native: { nativeId: randomUUID(), environmentId: randomUUID(), createdBy: user(5).identity.objectId },
        packageFields: { type: "custom", platform: "CopilotStudio", longDescription: "   ", shortDescription: "Helps with HR requests." } },
      { packages: ["First"], packageFields: { type: "firstParty" } },
      { packages: ["Third"], packageFields: { type: "thirdParty" } },
    ]);
    const today = new Date().toISOString().slice(0, 10);
    await publish(identity, {
      users: Array.from({ length: 5 }, (_, i) => `user${i + 1}@example.invalid,User ${i + 1},2,${(i + 1) * 10},${today}`),
      agents: ["HR-A", "HR-B", "First", "Third"].map(id => `${id},${id},Your org,5,0,100,${today}`),
      userAgents: [
        `HR-A,HR-A,Your org,user1@example.invalid,10,${today}`,
        `HR-B,HR-B,Your org,user1@example.invalid,20,${today}`,
        `HR-A,HR-A,Your org,user2@example.invalid,20,${today}`,
        `First,First,Microsoft,user3@example.invalid,30,${today}`,
        `Third,Third,External,user4@example.invalid,40,${today}`,
      ],
    });
    const page = await read(), group = page.value[0];
    expect(page.inventoryAvailable).toBe(true);
    expect(group.agents).toHaveLength(2);
    expect(new Set(group.agents.map(agent => agent.id)).size).toBe(2);
    expect(group.agents.every(agent => agent.type === "Copilot Studio")).toBe(true);
    expect(group.agents.map(agent => agent.description)).toEqual(expect.arrayContaining([
      "Helps HR colleagues find policies and onboarding guidance.", "Helps with HR requests.",
    ]));
    expect(group.people[0]).toMatchObject({ id: user(5).identity.objectId, agents: 2, champion: true, responses: 50 });
    expect(group.people.find(person => person.id === user(1).identity.objectId)?.agents).toBe(1);
    expect(group.people.filter(person => person.champion)).toHaveLength(3);
  });
  it("keeps departments separate across companies and pages forward/backward in both sort directions", async () => {
    const { identity, reader } = await setup([user(1, "A"), user(2, "B"), user(3, "C"), user(4, "D")]);
    for (const order of ["asc", "desc"] as const) {
      const selected = await reader.capture(identity, "delegated", "adoption", { order });
      const page = (cursor?: string) => reader.read(selected.id, identity,
        (client, context) => readAdoptionGroups(client, reader, context, { limit: 2, cursor }));
      const first = await page(), second = await page(first.page.nextCursor!);
      expect(first.value.map(group => group.company)).toEqual(order === "asc" ? ["A", "B"] : ["D", "C"]);
      expect(second.value.map(group => group.company)).toEqual(order === "asc" ? ["C", "D"] : ["B", "A"]);
      expect(second.page.nextCursor).toBeNull();
      expect((await page(second.page.previousCursor!)).value).toEqual(first.value);
      await expect(page(`${first.page.nextCursor}tampered`)).rejects.toThrow("invalid_cursor");
      await expect(reader.read(selected.id, { ...identity, principalId: "another-user" },
        (client, context) => readAdoptionGroups(client, reader, context, { limit: 2 }))).rejects.toThrow();
    }
  });
  it.each(["asc", "desc"] as const)("resumes a fresh %s selection at the visible group after directory changes", async order => {
    const users = [user(1, "B"), user(2, "C"), user(3, "D"), user(4, "E"), user(5, "F"), user(6, "G")];
    const { identity, reader, saveUsers } = await setup(users);
    const read = (id: string, options: { cursor?: string; anchor?: string } = {}) => reader.read(id, identity,
      (client, context) => readAdoptionGroups(client, reader, context, { limit: 2, ...options }));
    const initial = await reader.capture(identity, "delegated", "adoption", { order });
    const first = await read(initial.id), second = await read(initial.id, { cursor: first.page.nextCursor! });
    expect(second.page.anchor).toBe(second.value[0].id);
    await saveUsers([...users, user(7, order === "asc" ? "A" : "Z")]);
    const fresh = await reader.capture(identity, "delegated", "adoption", { order });
    await expect(read(fresh.id, { cursor: first.page.nextCursor! })).rejects.toThrow("invalid_cursor");
    const resumed = await read(fresh.id, { anchor: second.page.anchor });
    expect(resumed.value.map(group => group.company)).toEqual(order === "asc" ? ["C", "D"] : ["F", "E"]);
    expect(resumed.value.some(group => group.id === second.page.anchor)).toBe(true);
    expect(resumed.page).toMatchObject({ number: 2, offset: 2 });
    expect(resumed.counts).toEqual({ total: 7, filtered: 7 });
    expect(resumed.selection.id).toBe(fresh.id);
    expect(resumed.page.previousCursor).not.toBeNull();
    expect(resumed.page.nextCursor).not.toBeNull();
    const previous = await read(fresh.id, { cursor: resumed.page.previousCursor! });
    expect(previous.value.at(-1)?.company).toBe(order === "asc" ? "B" : "G");
    const next = await read(fresh.id, { cursor: resumed.page.nextCursor! });
    expect(next.value[0].company).toBe(order === "asc" ? "E" : "D");
  });
  it("resolves anchors only inside matching groups and handles missing groups without inventing rows", async () => {
    const { identity, reader, read } = await setup([user(1, "A"), user(2, "B"), user(3, "C")]);
    const all = await read();
    const selected = await reader.capture(identity, "delegated", "adoption", { company: "B" });
    const anchored = (anchor: string) => reader.read(selected.id, identity,
      (client, context) => readAdoptionGroups(client, reader, context, { limit: 2, anchor }));
    for (const anchor of [all.value[0].id, "f".repeat(64)]) {
      const result = await anchored(anchor);
      expect(result.value.map(group => group.company)).toEqual(["B"]);
      expect(result.page.previousCursor).toBeNull();
      expect(result.page.nextCursor).toBeNull();
    }
    for (const anchor of ["invalid", "", "A".repeat(64)]) await expect(anchored(anchor)).rejects.toThrow("invalid_cursor");
    await expect(reader.read(selected.id, identity, (client, context) =>
      readAdoptionGroups(client, reader, context, { limit: 2, anchor: all.value[0].id, cursor: "cursor" }))).rejects.toThrow("invalid_cursor");
  });
  it.each(["asc", "desc"] as const)("jumps directly to numbered %s pages within one filtered selection", async order => {
    const { identity, reader } = await setup(Array.from({ length: 12 }, (_, index) => user(index + 1, "Contoso", `Department ${String(index + 1).padStart(2, "0")}`)));
    const selected = await reader.capture(identity, "delegated", "adoption", { order, search: "contoso" });
    const read = (pageNumber: number) => reader.read(selected.id, identity,
      (client, context) => readAdoptionGroups(client, reader, context, { limit: 5, pageNumber }));
    const last = await read(3);
    expect(last.selection.id).toBe(selected.id);
    expect(last.page).toMatchObject({ number: 3, offset: 10, limit: 5, nextCursor: null });
    expect(last.value.map(group => group.department)).toEqual(order === "asc" ? ["Department 11", "Department 12"] : ["Department 02", "Department 01"]);
    expect(last.counts).toEqual({ total: 12, filtered: 12 });
    expect((await read(Number.MAX_SAFE_INTEGER)).value).toEqual(last.value);
    expect((await read(1)).page).toMatchObject({ number: 1, offset: 0, previousCursor: null });
    const filtered = await reader.capture(identity, "delegated", "adoption", { department: "Department 05" });
    const only = await reader.read(filtered.id, identity, (client, context) =>
      readAdoptionGroups(client, reader, context, { limit: 5, pageNumber: 3 }));
    expect(only.value.map(group => group.department)).toEqual(["Department 05"]);
    expect(only.page).toMatchObject({ number: 1, offset: 0 });
  });
  it("rejects invalid and ambiguous numbered page requests", async () => {
    const { identity, reader } = await setup([user(1)]);
    const selected = await reader.capture(identity, "delegated", "adoption", {});
    for (const pageNumber of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(reader.read(selected.id, identity, (client, context) =>
        readAdoptionGroups(client, reader, context, { limit: 5, pageNumber }))).rejects.toThrow("invalid_cursor");
    }
    for (const position of [{ cursor: "cursor" }, { anchor: "a".repeat(64) }]) {
      await expect(reader.read(selected.id, identity, (client, context) =>
        readAdoptionGroups(client, reader, context, { limit: 5, pageNumber: 1, ...position }))).rejects.toThrow("invalid_cursor");
    }
  });
  it("lists shared agents in each matching group, but never assigns ambiguous user identities", async () => {
    const duplicated = user(3);
    duplicated.identity.userPrincipalName = user(2).identity.userPrincipalName;
    const { identity, read } = await setup([user(1, "Contoso"), user(2, "Fabrikam"), duplicated, user(4, "Fabrikam")]);
    await saveUsageInventory(fixture.runtime, identity, [
      { packages: ["Shared"], packageFields: { type: "shared" } },
      { packages: ["Ambiguous"], packageFields: { type: "custom" } },
    ]);
    const today = new Date().toISOString().slice(0, 10);
    await publish(identity, {
      users: [`user1@example.invalid,User 1,1,10,${today}`, `user2@example.invalid,User 2,1,20,${today}`, `user4@example.invalid,User 4,1,30,${today}`],
      agents: [`Shared,Shared,Your org,2,0,40,${today}`, `Ambiguous,Ambiguous,Your org,1,0,20,${today}`],
      userAgents: [`Shared,Shared,Your org,user1@example.invalid,10,${today}`,
        `Shared,Shared,Your org,user4@example.invalid,30,${today}`,
        `Ambiguous,Ambiguous,Your org,user2@example.invalid,20,${today}`],
    });
    const page = await read();
    expect(page.value).toHaveLength(2);
    expect(page.summary).toEqual({ people: 4, champs: 2, agents: 1 });
    expect(page.value.every(group => group.agents.length === 1)).toBe(true);
    expect(page.value[0].agents[0].id).toBe(page.value[1].agents[0].id);
    expect(page.value[0].agents[0].description).toBeNull();
    expect(page.value.flatMap(group => group.people).filter(person =>
      [user(2).identity.objectId, user(3).identity.objectId].includes(person.id))
      .every(person => person.responses === null && person.agents === 0 && !person.champion)).toBe(true);
  });
  it("distinguishes a collected empty inventory from unavailable inventory", async () => {
    const { identity, read } = await setup([user(1)]);
    await saveUsageInventory(fixture.runtime, identity, []);
    const page = await read();
    expect(page.inventoryAvailable).toBe(true);
    expect(page.value[0].agents).toEqual([]);
    expect(page.value[0].people[0].champion).toBe(false);
  });
  it("filters all groups before paging and exposes selected company and department facets", async () => {
    const { identity, reader, read } = await setup([
      user(1, "A", "HR"), user(2, "B", "IT"), user(3, " a ", "Finance"), user(4, "C", "HR"), user(5, null, null),
    ]);
    await saveUsageInventory(fixture.runtime, identity, [
      { packages: ["Created"], native: { nativeId: randomUUID(), environmentId: randomUUID(), createdBy: user(4).identity.objectId },
        packageFields: { type: "custom", platform: "CopilotStudio" } },
    ]);
    const today = new Date().toISOString().slice(0, 10);
    await publish(identity, { users: [`user2@example.invalid,User 2,1,10,${today}`],
      agents: [`Created,Created,Your org,0,0,0,${today}`], userAgents: [] });
    expect((await read()).summary).toEqual({ people: 5, champs: 2, agents: 1 });
    const champs = await read({ adoptionChamps: "with" }, 1);
    expect(champs.counts).toEqual({ total: 5, filtered: 2 });
    expect(champs.value[0].company).toBe("B");
    expect(champs.page.nextCursor).not.toBeNull();
    expect(champs.summary).toEqual({ people: 2, champs: 2, agents: 1 });
    expect((await read({ adoptionChamps: "with", adoptionAgents: "with" })).value.map(group => group.company)).toEqual(["C"]);
    expect((await read({ adoptionChamps: "with", adoptionAgents: "without" })).value.map(group => group.company)).toEqual(["B"]);
    expect((await read({ adoptionChamps: "without" })).counts.filtered).toBe(3);
    expect((await read({ company: " a ", department: "hr" })).value.map(group => group.company)).toEqual(["A"]);
    expect((await read({ company: null, department: null })).value[0].company).toBe("Company not provided");
    expect((await read({ adoptionAgents: "with", search: "hr" })).counts.filtered).toBe(1);
    expect((await read({ adoptionAgents: "without", search: "hr" })).counts.filtered).toBe(1);
    const selected = await reader.capture(identity, "delegated", "adoption", { company: "A", department: "HR" });
    const departments = await reader.facets(selected.id, identity, { field: "department", limit: 1 });
    expect(departments.counts).toEqual({ total: 2, filtered: 2 });
    expect(departments.value).toEqual([{ value: "Finance", count: 1 }]);
    const next = await reader.facets(selected.id, identity, { field: "department", limit: 1, cursor: departments.page.nextCursor! });
    expect(next.value).toEqual([{ value: "HR", count: 1 }]);
    expect((await reader.facets(selected.id, identity, { field: "department", limit: 1, cursor: next.page.previousCursor! })).value).toEqual(departments.value);
    expect((await reader.facets(selected.id, identity, { field: "company" })).value.map(option => option.value)).toEqual(["A", "C"]);
    await expect(reader.facets(selected.id, identity, { field: "creatorType" })).rejects.toThrow("invalid_cursor");
    const unfiltered = await reader.capture(identity, "delegated", "adoption", {});
    const companies = await reader.facets(unfiltered.id, identity, { field: "company" });
    expect(companies.value).toEqual([{ value: "A", count: 2 }, { value: "B", count: 1 }, { value: "C", count: 1 }, { value: null, count: 1 }]);
  });
  it("rejects unrelated filters rather than ignoring them", () => {
    expect(() => reportQuery("adoption", { cohort: "licensed" })).toThrow("invalid_cursor");
    expect(() => reportQuery("adoption", { sort: "responses" })).toThrow("invalid_cursor");
    expect(() => reportQuery("copilot_users", { adoptionChamps: "with" })).toThrow("invalid_cursor");
    expect(() => reportQuery("official_users", { adoptionAgents: "with" })).toThrow("invalid_cursor");
  });
});
