import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import {
  officialUsageHistoryWarning,
  validateOfficialUsageHistoryOptions,
} from "./officialUsageHistory.js";

describe("official usage history contract", () => {
  it("states that rolling snapshots and activity ranges are not additive coverage", () => {
    expect(officialUsageHistoryWarning).toEqual({
      code: "rolling_snapshots_not_additive",
      message: expect.stringMatching(/not summed or subtracted.*do not prove reporting coverage/i),
    });
  });

  it("applies bounded paging defaults and rejects unbounded archive reads", () => {
    expect(validateOfficialUsageHistoryOptions({})).toEqual({ limit: 25, offset: 0 });
    expect(validateOfficialUsageHistoryOptions({ limit: 100, offset: 100_000 }))
      .toEqual({ limit: 100, offset: 100_000 });
    for (const options of [
      { limit: 0 },
      { limit: 101 },
      { offset: -1 },
      { offset: 100_001 },
      { limit: Number.NaN },
    ]) {
      expect(() => validateOfficialUsageHistoryOptions(options)).toThrowError(
        expect.objectContaining<Partial<AppError>>({ code: "invalid_usage_query", status: 400 }),
      );
    }
  });
});
