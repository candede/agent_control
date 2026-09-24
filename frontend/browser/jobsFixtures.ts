import type { Page } from "@playwright/test";
import { isAutomaticRefreshRequest } from "./automaticRefreshFixtures";
import type { WorkbenchJobsResponse } from "../src/api/client";
import { mockLayoutApi } from "./layoutFixtures";

export async function mockJobs(page: Page, getState: () => WorkbenchJobsResponse) {
  const unexpected = await mockLayoutApi(page);
  const commands: string[] = [];
  const automaticChecks: string[] = [];
  page.on("request", request => {
    if (isAutomaticRefreshRequest(request)) {
      automaticChecks.push(request.url());
      return;
    }
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) {
      const url = new URL(request.url());
      commands.push(`${request.method()} ${url.pathname}${url.search}`);
    }
  });
  await page.route(url => url.pathname === "/api/workbench/jobs", route =>
    route.request().method() === "GET" ? route.fulfill({ json: getState() }) : route.fallback());
  return { unexpected, commands, automaticChecks };
}
