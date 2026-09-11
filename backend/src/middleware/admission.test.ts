import { afterEach, describe, expect, it } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { apiAdmission, clearAdmissionForTest } from "./admission.js";

afterEach(() => clearAdmissionForTest());

describe("API admission", () => {
  it("keeps liveness outside request budgets", () => {
    for (let index = 0; index < 300; index += 1) expect(invoke("/health", "GET").error).toBeUndefined();
  });

  it("bounds writes independently by trusted Express IP", () => {
    for (let index = 0; index < 300; index += 1) expect(invoke("/jobs", "POST").error).toBeUndefined();
    const rejected = invoke("/jobs", "POST");
    expect((rejected.error as { code: string }).code).toBe("request_admission_limit");
    expect(rejected.headers["Retry-After"]).toBeDefined();
  });
});

function invoke(path: string, method: string) {
  let error: unknown;
  const headers: Record<string, string> = {};
  const request = { path, method, ip: "127.0.0.1", session: {} } as Request;
  const response = { setHeader: (name: string, value: string) => { headers[name] = value; } } as unknown as Response;
  apiAdmission(request, response, ((value?: unknown) => { error = value; }) as NextFunction);
  return { error, headers };
}
