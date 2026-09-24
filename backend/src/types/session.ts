import type { AppRole } from "./capability.js";

export type AuthenticatedUser = {
  displayName: string;
  username: string;
  homeAccountId: string;
  tenantId?: string;
  roles: AppRole[];
  providerRoleIds?: string[];
};

export type AuthFlow = {
  kind: "login";
  state: string;
  nonce: string;
  codeVerifier: string;
  scopes: string[];
  createdAt: number;
  returnTo: string;
};

declare module "express-session" {
  interface SessionData {
    tenantId?: string;
    authFlowHandle?: string;
    accountId?: string;
    user?: AuthenticatedUser;
    csrfToken?: string;
    rolesValidatedAt?: number;
    signedInAt?: number;
  }
}
