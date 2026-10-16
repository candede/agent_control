import type { AppRole, CapabilityId } from "./capability.js";

export type RequestPrincipal = Readonly<{
  tenantId: string; principalId: string; apiClientId: string;
  localAccountId: string; username: string; displayName: string;
  roles: readonly AppRole[]; providerRoleIds: readonly string[];
  transport: "browser" | "bearer"; integrationClientId: string;
  rolesValidatedAt: number; authenticatedAt: number; expiresAt: number;
  sessionEpoch: string; authorizationHash: string;
}>;

export type CredentialReference = Readonly<{
  id: string; tenantId: string; principalId: string; apiClientId: string;
  transport: RequestPrincipal["transport"]; integrationClientId: string;
  sessionEpoch: string; authorizationHash: string; expiresAt: number;
}>;

export type DelegatedCredentialSource = {
  readonly principal: RequestPrincipal;
  readonly reference: CredentialReference;
  readonly expiresAt: number;
  assertCurrent(): void;
  revalidate(signal?: AbortSignal): Promise<RequestPrincipal>;
  acquire(capabilityId: CapabilityId, signal?: AbortSignal): Promise<string>;
  revoke(): void;
};
