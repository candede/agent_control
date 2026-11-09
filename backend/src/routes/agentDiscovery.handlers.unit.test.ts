import type { Request, RequestHandler, Response } from "express";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { AgentDiscovery } from "../services/agentDiscovery.js";
import { AdoptionContent } from "../services/adoptionContent.js";
import type { DiscoveryProfile } from "../types/agentDiscovery.js";
import type { SharedLearningPage } from "../types/adoptionContent.js";
import { createAgentDiscoveryRouter } from "./agentDiscovery.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, RequestHandler>(),
  user: { tenantId: "tenant", homeAccountId: "employee", localAccountId: "member",
    username: "member@example.invalid", displayName: "Member", roles: [] },
}));
vi.mock("./policy.js", () => ({
  policyRoute: (_router: unknown, method: string, path: string, _policy: unknown, handler: RequestHandler) =>
    mocks.handlers.set(`${method} ${path}`, handler),
}));
vi.mock("../middleware/requestAuthentication.js", () => ({
  requestUser: () => mocks.user,
}));

const discovery: DiscoveryProfile = {
  context: { mode: "self", subject: "current_account", company: null, department: null, profileState: "unavailable" },
  selection: { id: "11111111-1111-4111-8111-111111111111", revision: "1", expiresAt: "2026-11-09T00:10:00Z" },
  privacy: { hide_employee_details: false, hide_champion_employee: false },
  reportState: "unavailable", period: null,
  ownChampion: { state: "unavailable", reason: "saved_subject_report_link_unavailable" },
};
const learning: SharedLearningPage = { value: [], nextCursor: null };
const routes = ["/discovery/read", "/discovery/preview", "/discovery/learning", "/discovery/learning/preview"] as const;
const database = {
  options: { max: 4 },
  query: vi.fn(() => { throw new Error("Unexpected database query."); }),
  connect: vi.fn(() => { throw new Error("Unexpected database acquisition."); }),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  vi.spyOn(AgentDiscovery.prototype, "execute").mockResolvedValue(discovery);
  vi.spyOn(AdoptionContent.prototype, "shared").mockResolvedValue(learning);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected provider request."); }));
  createAgentDiscoveryRouter(database as unknown as pg.Pool);
});
afterEach(() => {
  try {
    expect(database.query).not.toHaveBeenCalled();
    expect(database.connect).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

function transport(path: typeof routes[number], body: unknown, query: Request["query"] = {}) {
  const request = { body, query };
  const response = { setHeader: vi.fn(), json: vi.fn() };
  const handler = mocks.handlers.get(`post ${path}`);
  if (!handler) throw new Error(`Missing discovery handler: ${path}`);
  return {
    response,
    run: () => handler(request as Request, response as unknown as Response, vi.fn()),
  };
}

describe("discovery handlers without a server", () => {
  it.each(routes)("forwards the exact self/preview contract and prevents storage for %s", async path => {
    const isLearning = path.includes("/learning");
    const isPreview = path.endsWith("/preview");
    const read = isLearning ? { company: "Saved company", limit: 3 } : { operation: "profile" };
    const body = isPreview ? { ...read, subject: "  member@example.invalid  " } : read;
    const { response, run } = transport(path, body);
    await run();
    const service = isLearning ? AdoptionContent.prototype.shared : AgentDiscovery.prototype.execute;
    const other = isLearning ? AgentDiscovery.prototype.execute : AdoptionContent.prototype.shared;
    expect(service).toHaveBeenCalledTimes(1);
    expect(service).toHaveBeenCalledWith(mocks.user, read, ...(isPreview ? ["member@example.invalid"] : []));
    expect(other).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledExactlyOnceWith(isLearning ? learning : discovery);
    expect(response.setHeader).toHaveBeenCalledExactlyOnceWith("Cache-Control", "no-store");
    expect(response.setHeader.mock.invocationCallOrder[0]).toBeLessThan(response.json.mock.invocationCallOrder[0]);
    expect(body).toEqual(isPreview ? { ...read, subject: "  member@example.invalid  " } : read);
  });

  it.each(routes)("rejects query options before reading or publishing data for %s", async path => {
    const { response, run } = transport(path, { operation: "profile", subject: "member@example.invalid" },
      { company: "Another company" });
    await expect(run()).rejects.toMatchObject({ status: 400 });
    expect(AgentDiscovery.prototype.execute).not.toHaveBeenCalled();
    expect(AdoptionContent.prototype.shared).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
  });

  it.each(["/discovery/preview", "/discovery/learning/preview"] as const)(
    "rejects malformed or absent preview subjects without invoking services for %s", async path => {
      for (const body of [undefined, null, [], "not-an-object", {}, { subject: null }, { subject: "" },
        { subject: " " }, { subject: "x".repeat(513) }, { subject: "member\n@example.invalid" }]) {
        const { response, run } = transport(path, body);
        await expect(run()).rejects.toMatchObject({ status: 400 });
        expect(response.json).not.toHaveBeenCalled();
      }
      expect(AgentDiscovery.prototype.execute).not.toHaveBeenCalled();
      expect(AdoptionContent.prototype.shared).not.toHaveBeenCalled();
    },
  );

  it.each(routes)("propagates read failures without publishing success for %s", async path => {
    const failure = new AppError(409, "selection_invalidated", "The saved evidence changed.");
    vi.mocked(AgentDiscovery.prototype.execute).mockRejectedValue(failure);
    vi.mocked(AdoptionContent.prototype.shared).mockRejectedValue(failure);
    const body = path.includes("/learning") ? {} : { operation: "profile" };
    const { response, run } = transport(path, { ...body, subject: "member@example.invalid" });
    await expect(run()).rejects.toBe(failure);
    expect(response.json).not.toHaveBeenCalled();
  });
});
