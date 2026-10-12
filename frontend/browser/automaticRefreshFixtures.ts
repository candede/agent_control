import { createHash } from "node:crypto";
import type { Page, Request } from "@playwright/test";
import type { AutomaticRefreshResult } from "../src/api/client";

export function isAutomaticRefreshRequest(request: Pick<Request, "method" | "url" | "postData">) {
  const url = new URL(request.url());
  return request.method() === "POST" && url.pathname === "/api/data-sync/auto-refresh"
    && !url.search && request.postData() === "{}";
}

export function automaticRefreshFixture(revisions: AutomaticRefreshResult["revisions"] = {
  users: "3".repeat(64), graph_packages: "1".repeat(64), power_platform: "2".repeat(64),
}): AutomaticRefreshResult {
  const revision = (value: string) => /^[a-f0-9]{64}$/.test(value)
    ? value : createHash("sha256").update(value).digest("hex");
  return { run: null, detailJob: null,
    revisions: { users: revision(revisions.users), graph_packages: revision(revisions.graph_packages), power_platform: revision(revisions.power_platform) },
    nextCheckAt: new Date(Date.now() + 60_000).toISOString() };
}

export async function mockAutomaticRefresh(page: Page) {
  await page.route(url => url.pathname === "/api/data-sync/auto-refresh", route =>
    isAutomaticRefreshRequest(route.request())
      ? route.fulfill({ json: automaticRefreshFixture() })
      : route.fallback());
}
