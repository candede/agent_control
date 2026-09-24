import { describe, expect, it } from "vitest";
import { automaticRefreshFixture, isAutomaticRefreshRequest } from "../../browser/automaticRefreshFixtures";

describe("automatic refresh browser fixture boundary", () => {
  it("recognizes only the empty-body automatic due check", () => {
    expect(isAutomaticRefreshRequest({
      method: () => "POST", url: () => "http://localhost/api/data-sync/auto-refresh", postData: () => "{}",
    })).toBe(true);
  });

  it.each([
    ["GET", "/api/data-sync/auto-refresh", "{}"],
    ["DELETE", "/api/data-sync/auto-refresh", "{}"],
    ["POST", "/api/data-sync/runs", "{}"],
    ["POST", "/api/data-sync/auto-refresh?force=true", "{}"],
    ["POST", "/api/data-sync/auto-refresh", '{"clearSavedData":true}'],
    ["POST", "/api/data-sync/auto-refresh", null],
  ])("does not conceal unexpected %s %s with body %s", (method, path, body) => {
    expect(isAutomaticRefreshRequest({
      method: () => method!, url: () => `http://localhost${path}`, postData: () => body,
    })).toBe(false);
  });

  it("supplies stable saved revisions without starting a provider workload", () => {
    const first = automaticRefreshFixture();
    expect(first.run).toBeNull();
    expect(first.detailJob).toBeNull();
    expect(automaticRefreshFixture().revisions).toEqual(first.revisions);
    expect(Date.parse(first.nextCheckAt)).toBeGreaterThan(Date.now());
  });
});
