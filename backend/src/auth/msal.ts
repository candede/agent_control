import {
  ConfidentialClientApplication,
  type AccountInfo,
  type AuthenticationResult,
} from "@azure/msal-node";
import { randomBytes } from "node:crypto";
import { authConfigured, config, graphScopes, loginScopes } from "../config.js";
import { AppError } from "../errors.js";
import type { AuthenticatedUser } from "../types/session.js";

let client: ConfidentialClientApplication | undefined;

export function requireAuthConfigured() {
  if (
    !authConfigured ||
    !config.tenantId ||
    !config.clientId ||
    !config.clientSecret
  ) {
    throw AppError.serviceUnavailable(
      "Set TENANT_ID, CLIENT_ID, and CLIENT_SECRET before signing in.",
    );
  }
}

export function getMsalClient() {
  requireAuthConfigured();

  client ??= new ConfidentialClientApplication({
    auth: {
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
      clientId: config.clientId!,
      clientSecret: config.clientSecret!,
    },
  });

  return client;
}

export function createState() {
  return randomBytes(24).toString("hex");
}

export async function createLoginUrl(state: string) {
  return getMsalClient().getAuthCodeUrl({
    scopes: loginScopes,
    redirectUri: config.redirectUri,
    state,
    prompt: "select_account",
  });
}

export async function redeemAuthorizationCode(code: string) {
  const result = await getMsalClient().acquireTokenByCode({
    code,
    scopes: loginScopes,
    redirectUri: config.redirectUri,
  });

  if (!result?.account) {
    throw AppError.unauthorized(
      "Microsoft Entra ID did not return an account.",
    );
  }

  return result;
}

export async function acquireGraphToken(homeAccountId: string) {
  const msalClient = getMsalClient();
  const account = await getAccount(homeAccountId);

  if (!account) {
    throw AppError.unauthorized(
      "Your sign-in session expired. Please sign in again.",
    );
  }

  const result = await msalClient.acquireTokenSilent({
    account,
    scopes: graphScopes,
  });

  if (!result?.accessToken) {
    throw AppError.unauthorized(
      "Unable to acquire a Microsoft Graph access token.",
    );
  }

  return result.accessToken;
}

export function toAuthenticatedUser(
  result: AuthenticationResult,
): AuthenticatedUser {
  const account = result.account;

  if (!account) {
    throw AppError.unauthorized(
      "Microsoft Entra ID did not return an account.",
    );
  }

  const claims = result.idTokenClaims as
    | { name?: string; preferred_username?: string; tid?: string }
    | undefined;

  return {
    displayName: account.name ?? claims?.name ?? account.username,
    username: account.username ?? claims?.preferred_username ?? "",
    homeAccountId: account.homeAccountId,
    tenantId: account.tenantId ?? claims?.tid,
  };
}

async function getAccount(homeAccountId: string): Promise<AccountInfo | null> {
  const cache = getMsalClient().getTokenCache();
  const account = await cache.getAccountByHomeId(homeAccountId);
  return account ?? null;
}
