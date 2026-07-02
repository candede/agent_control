export type AuthenticatedUser = {
  displayName: string;
  username: string;
  homeAccountId: string;
  tenantId?: string;
};

declare module "express-session" {
  interface SessionData {
    authState?: string;
    accountId?: string;
    user?: AuthenticatedUser;
  }
}
