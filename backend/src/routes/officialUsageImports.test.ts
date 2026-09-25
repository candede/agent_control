import express from "express";
import session from "express-session";
import type { Server } from "node:http";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { AppError, errorHandler } from "../errors.js";
import { createOfficialUsageRouter } from "./officialUsage.js";

const mocks = vi.hoisted(() => {
  process.env.TENANT_ID = "11111111-1111-1111-1111-111111111111";
  process.env.CLIENT_ID = "22222222-2222-4222-8222-222222222222";
  process.env.SESSION_SECRET = "official-usage-import-route-test-secret";
  return { stage: vi.fn(), acceptBundle: vi.fn(), discardStaging: vi.fn() };
});

vi.mock("../db/officialUsage.js", () => ({
  OfficialUsageRepository: class {
    stage = mocks.stage;
    acceptBundle = mocks.acceptBundle;
    discardStaging = mocks.discardStaging;
  },
}));
vi.mock("../services/telemetry.js", async original => ({
  ...await original<typeof import("../services/telemetry.js")>(),
  operationalLog: vi.fn(),
}));

let server: Server;
let baseUrl: string;
const bundleId = "11111111-1111-4111-8111-111111111111";
const csv = "Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\nagent-1,Agent 1,Your org,1,1,4,2026-07-06";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "official-usage-import-route-test-secret", resave: false, saveUninitialized: false }));
  app.use((request, _response, next) => {
    request.session.accountId = "import-administrator";
    request.session.tenantId = config.tenantId!;
    request.session.csrfToken = "import-csrf";
    request.session.rolesValidatedAt = Date.now();
    request.session.user = {
      tenantId: config.tenantId!, homeAccountId: "import-administrator", username: "admin@example.invalid",
      displayName: "Administrator", roles: ["AgentControl.Admin"],
    };
    next();
  });
  app.use("/api", createOfficialUsageRouter({} as pg.Pool));
  app.use(errorHandler);
  server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/official-usage`;
});

beforeEach(() => {
  mocks.stage.mockReset().mockResolvedValue({ id: bundleId, kind: "agents" });
  mocks.acceptBundle.mockReset();
  mocks.discardStaging.mockReset();
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

function upload(fields: Array<[string, string]> = []) {
  const body = new FormData();
  body.set("bundleId", bundleId);
  for (const [key, value] of fields) body.append(key, value);
  body.set("file", new Blob([csv], { type: "text/csv" }), "agents.csv");
  return fetch(`${baseUrl}/staging`, { method: "POST", headers: { "x-csrf-token": "import-csrf" }, body });
}

describe("official usage import route contracts", () => {
  it.each([
    [undefined, undefined],
    ["true", true],
    ["false", false],
  ])("parses the optional duplicate-kind guard %s without changing legacy defaults", async (value, expected) => {
    const response = await upload(value === undefined ? [] : [["rejectDuplicateKind", value]]);
    expect(response.status).toBe(201);
    expect(mocks.stage).toHaveBeenCalledWith({
      tenantId: config.tenantId, principalId: "import-administrator",
    }, expect.objectContaining({ bundleId, rejectDuplicateKind: expected, report: expect.objectContaining({ kind: "agents" }) }));
  });

  it("accepts the guard alongside every legacy metadata field", async () => {
    const response = await upload([
      ["rejectDuplicateKind", "true"], ["correctionOfSetId", bundleId],
      ["reportingStart", "2026-06-07"], ["reportingEnd", "2026-07-06"], ["periodProvenance", "operator_asserted"],
      ["sourceAsOf", "2026-07-08T12:00:00Z"], ["sourceAsOfProvenance", "operator_asserted"],
      ["downloadedAt", "2026-07-09T12:00:00Z"],
    ]);
    expect(response.status).toBe(201);
    expect(mocks.stage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      rejectDuplicateKind: true, correctionOfSetId: bundleId,
    }));
  });

  it.each(["", "1", "0", "TRUE", "False", " true ", "yes", "null"])("rejects invalid boolean string %j before persistence", async value => {
    const response = await upload([["rejectDuplicateKind", value]]);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_metadata" });
    expect(mocks.stage).not.toHaveBeenCalled();
  });

  it("rejects repeated guard fields instead of silently choosing a value", async () => {
    const response = await upload([["rejectDuplicateKind", "true"], ["rejectDuplicateKind", "false"]]);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_metadata" });
    expect(mocks.stage).not.toHaveBeenCalled();
  });

  it("returns an actionable duplicate-kind conflict without discarding earlier staging", async () => {
    mocks.stage.mockRejectedValueOnce(new AppError(409, "duplicate_report_kind", "Discard the draft before replacing this report."));
    const response = await upload([["rejectDuplicateKind", "true"]]);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "duplicate_report_kind", detail: expect.stringContaining("Discard") });
    expect(mocks.discardStaging).not.toHaveBeenCalled();
  });

  it.each([false, true])("exposes reusedExistingSet=%s from bundle acceptance", async reusedExistingSet => {
    const result = { setId: bundleId, versionId: bundleId, activeRevision: 2, complete: true, reusedExistingSet };
    mocks.acceptBundle.mockResolvedValue(result);
    const response = await fetch(`${baseUrl}/bundles/${bundleId}/accept`, {
      method: "POST", headers: { "x-csrf-token": "import-csrf", "content-type": "application/json" },
      body: JSON.stringify({ bundleHash: "a".repeat(64), expectedActiveRevision: 1 }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
  });
});
