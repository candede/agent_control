import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { databaseSettings } from "./pool.js";

afterEach(() => vi.unstubAllEnvs());

describe("PostgreSQL calendar dates", () => {
  it.each(["UTC", "Asia/Dubai", "America/Los_Angeles", "Pacific/Apia"])(
    "decodes dates at UTC midnight independently of the host time zone %s", timezone => {
      vi.stubEnv("TZ", timezone);
      const parse = databaseSettings().types!.getTypeParser(pg.types.builtins.DATE, "text");
      for (const date of ["2026-07-06", "2024-02-29", "2026-03-08", "2011-12-30", "0099-01-01"]) {
        expect(parse(date).toISOString()).toBe(`${date}T00:00:00.000Z`);
      }
      expect(parse("0002-01-01 BC").toISOString()).toBe("-000001-01-01T00:00:00.000Z");
    },
  );

  it("preserves infinite dates and the standard parsers for other types", () => {
    const original = pg.types.getTypeParser(pg.types.builtins.DATE, "text");
    const types = databaseSettings().types!;
    expect(types.getTypeParser(pg.types.builtins.DATE, "text")("infinity")).toBe(Infinity);
    expect(types.getTypeParser(pg.types.builtins.DATE, "text")("-infinity")).toBe(-Infinity);
    expect(types.getTypeParser(pg.types.builtins.TIMESTAMPTZ, "text"))
      .toBe(pg.types.getTypeParser(pg.types.builtins.TIMESTAMPTZ, "text"));
    expect(types.getTypeParser(pg.types.builtins.DATE, "binary"))
      .toBe(pg.types.getTypeParser(pg.types.builtins.DATE, "binary"));
    expect(pg.types.getTypeParser(pg.types.builtins.DATE, "text")).toBe(original);
  });
});
