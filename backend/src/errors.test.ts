import { afterEach, describe, expect, it } from "vitest";
import { config } from "./config.js";
import { AppError, normalizeError } from "./errors.js";

const originalNodeEnv = config.nodeEnv;

afterEach(() => {
  config.nodeEnv = originalNodeEnv;
});

describe("normalizeError", () => {
  it("preserves intentional application errors", () => {
    const error = new AppError(400, "invalid_request", "Invalid request");

    expect(normalizeError(error)).toBe(error);
  });

  it("hides unexpected error details in production", () => {
    config.nodeEnv = "production";

    expect(
      normalizeError(new Error("database path /private/data")),
    ).toMatchObject({
      status: 500,
      code: "internal_error",
      message: "An unexpected error occurred",
    });
  });

  it("keeps unexpected error details available during development", () => {
    config.nodeEnv = "development";

    expect(normalizeError(new Error("development details"))).toMatchObject({
      status: 500,
      code: "internal_error",
      message: "development details",
    });
  });
});
