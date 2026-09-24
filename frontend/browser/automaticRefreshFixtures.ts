import type { Page, Request } from "@playwright/test";
import type { AutomaticRefreshResult } from "../src/api/client";

export function isAutomaticRefreshRequest(request: Pick<Request, "method" | "url" | "postData">) {
  const url = new URL(request.url());
  return request.method() === "POST" && url.pathname === "/api/data-sync/auto-refresh"
    && !url.search && request.postData() === "{}";
}

export function automaticRefreshFixture(revisions: AutomaticRefreshResult["revisions"] = {
  users: "fixture-users", graph_packages: "fixture-packages", power_platform: "fixture-platform",
}): AutomaticRefreshResult {
  return { run: null, detailJob: null, revisions, nextCheckAt: new Date(Date.now() + 60_000).toISOString() };
}

export async function mockAutomaticRefresh(page: Page) {
  await page.route(url => url.pathname === "/api/data-sync/auto-refresh", route =>
    isAutomaticRefreshRequest(route.request())
      ? route.fulfill({ json: automaticRefreshFixture() })
      : route.fallback());
}
