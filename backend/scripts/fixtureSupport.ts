import type { Server } from "node:http";

export function configureBrowserFixtureEnvironment(env: NodeJS.ProcessEnv = process.env) {
  if (env.AGENT_CONTROL_FIXTURE_MODE !== "browser" || env.NODE_ENV !== "test") {
    throw new Error("This fixture requires its isolated browser test entry point.");
  }
  const origin = new URL(env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3001");
  if (origin.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(origin.hostname)
    || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
    || origin.port === "0") {
    throw new Error("The browser fixture requires a plain HTTP loopback origin with a fixed port.");
  }
  // File-backed settings take precedence over inline values in runtime configuration.
  for (const name of ["TENANT_ID", "CLIENT_ID", "CLIENT_SECRET", "SESSION_SECRET"]) delete env[`${name}_FILE`];
  env.TENANT_ID = "11111111-1111-1111-1111-111111111111";
  env.CLIENT_ID = "22222222-2222-2222-2222-222222222222";
  env.CLIENT_SECRET = "synthetic-browser-client-secret";
  env.SESSION_SECRET = "synthetic-browser-session-secret-0001";
  env.FRONTEND_ORIGIN = origin.origin;
  env.REDIRECT_URI = `${origin.origin}/api/auth/callback`;
}

export async function closeFixtureServer(server?: Pick<Server, "listening" | "close">) {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

export async function closeFixtureResources(...steps: Array<() => void | Promise<void>>) {
  const errors: unknown[] = [];
  for (const close of steps) {
    try { await close(); }
    catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Fixture cleanup failed.");
}
