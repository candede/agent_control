import type { AppRole, CapabilityId } from "./capability.js";

export type AuthenticatedUser = {
  displayName: string;
  username: string;
  homeAccountId: string;
  tenantId?: string;
  roles: AppRole[];
  providerRoleIds?: string[];
};

export type AuthFlow = {
  kind: "login" | "consent";
  state: string;
  nonce: string;
  codeVerifier: string;
  scopes: string[];
  extraScopesToConsent?: string[];
  createdAt: number;
  returnTo: string;
  capabilityId?: CapabilityId;
  accountId?: string;
};

declare module "express-session" {
  interface SessionData {
    tenantId?: string;
    authFlowHandle?: string;
    accountId?: string;
    user?: AuthenticatedUser;
    csrfToken?: string;
    rolesValidatedAt?: number;
  }
}
