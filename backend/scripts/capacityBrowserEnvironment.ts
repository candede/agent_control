export const capacityBrowserOrigin = "http://test-db:8081";

export function capacityBrowserLaunchOptions(environment = process.env) {
  if (environment.AGENT_CONTROL_ISOLATED_TESTS!=="1") throw new Error("capacity_browser_requires_isolated_fixture");
  return { headless: true,args: ["--disable-dev-shm-usage",
    `--unsafely-treat-insecure-origin-as-secure=${capacityBrowserOrigin}`] };
}
