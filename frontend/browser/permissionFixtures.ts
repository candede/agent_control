export function fixtureLoginUrl(scenario: string) {
  if (process.env.AGENT_CONTROL_FIXTURE_MODE !== "browser") {
    throw new Error("Real HTTP browser checks require the isolated synthetic-auth fixture.");
  }
  const origin = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3001");
  if (origin.protocol !== "http:" || isExternalFixtureRequest(origin)
    || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("The browser fixture requires a plain HTTP loopback origin.");
  }
  const login = new URL("/api/auth/login", origin);
  login.searchParams.set("returnTo", `/permissions?${new URLSearchParams({ fixture: scenario })}`);
  return login.href;
}

export function isExternalFixtureRequest(url: URL) {
  return !["localhost", "127.0.0.1"].includes(url.hostname);
}

export type PermissionLayoutRequestKind = "catalog" | "automatic-check" | "retry-failed";

export function permissionLayoutRequestKind(method: string, url: URL): PermissionLayoutRequestKind | undefined {
  if (method === "GET" && url.pathname === "/api/capabilities") return "catalog";
  if (method !== "POST" || url.pathname !== "/api/capabilities/check") return undefined;
  const options = [...url.searchParams];
  if (!options.length) return "automatic-check";
  if (options.length === 1 && options[0][0] === "retry" && options[0][1] === "failed") return "retry-failed";
  return undefined;
}

export function isUnexpectedPermissionCommand(method: string, pathname: string) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method) || !/^\/api\//i.test(pathname)) return false;
  return method !== "POST" || ![
    "/api/capabilities/check",
    "/api/data-sync/auto-refresh",
    "/api/auth/consent",
    "/api/auth/logout",
  ].includes(pathname);
}

export function isPackageMutationRequest(method: string, pathname: string) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return false;
  return /^\/api\/agents\/(?:[^/]+\/)?(?:access|block|unblock|block-all|unblock-all)\/?$/i.test(pathname)
    || /^\/api\/agents\/bulk-jobs\/[^/]+\/resume\/?$/i.test(pathname)
    || /^\/api\/agents\/mutation-canaries\/[^/]+\/execute\/?$/i.test(pathname);
}
