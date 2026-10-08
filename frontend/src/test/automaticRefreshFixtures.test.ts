import { afterEach, describe, expect, it, vi } from "vitest";
import { automaticRefreshFixture, isAutomaticRefreshRequest } from "../../browser/automaticRefreshFixtures";
import { checkAutomaticRefresh } from "../api/client";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("automatic refresh browser fixture boundary", () => {
  it("recognizes only the empty-body automatic due check", () => {
    expect(isAutomaticRefreshRequest({
      method: () => "POST", url: () => "http://localhost/api/data-sync/auto-refresh", postData: () => "{}",
    })).toBe(true);
  });

  it("matches the real cancellable client request without admitting a separate provider command", async () => {
    const fixture = automaticRefreshFixture();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(fixture));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    await expect(checkAutomaticRefresh({ signal: controller.signal })).resolves.toEqual(fixture);
    expect(fetch).toHaveBeenCalledOnce();
    const [path, init] = fetch.mock.calls[0];
    expect(init).toMatchObject({ credentials: "include", signal: controller.signal });
    const request = new Request(new URL(String(path), window.location.href), init);
    const body = await request.text();
    expect(isAutomaticRefreshRequest({
      method: () => request.method, url: () => request.url, postData: () => body,
    })).toBe(true);
    expect(request.headers.get("Content-Type")).toBe("application/json");
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T10:00:00Z"));
    const first = automaticRefreshFixture();
    expect(first.run).toBeNull();
    expect(first.detailJob).toBeNull();
    expect(automaticRefreshFixture().revisions).toEqual(first.revisions);
    expect(Date.parse(first.nextCheckAt)).toBe(Date.now() + 60_000);
  });
});
