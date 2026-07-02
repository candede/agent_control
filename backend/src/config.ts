import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const configDirectory = dirname(fileURLToPath(import.meta.url));
loadEnv({
  path: resolve(configDirectory, "../../.env"),
  override: true,
  quiet: true,
});
loadEnv({
  path: resolve(configDirectory, "../.env"),
  override: true,
  quiet: true,
});

const port = Number.parseInt(process.env.PORT ?? "3001", 10);

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number.isNaN(port) ? 3001 : port,
  tenantId: process.env.TENANT_ID,
  clientId: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
  redirectUri:
    process.env.REDIRECT_URI ?? "http://localhost:3001/auth/callback",
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? "http://localhost:5173",
  sessionSecret:
    process.env.SESSION_SECRET ??
    "dev-only-change-me-agent-control-session-secret",
};

export const authConfigured = Boolean(
  config.tenantId && config.clientId && config.clientSecret,
);

export const graphScopes = [
  "https://graph.microsoft.com/User.Read",
  "https://graph.microsoft.com/CopilotPackages.ReadWrite.All",
];

export const loginScopes = [
  "openid",
  "profile",
  "offline_access",
  ...graphScopes,
];
