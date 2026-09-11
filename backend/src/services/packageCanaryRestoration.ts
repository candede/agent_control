import { randomUUID } from "node:crypto";
import { assessCanaryRestoration } from "../db/packageMutationQualifications.js";
import { AppError } from "../errors.js";
import { verifyPackageMutationConverged, type GraphPackagesClient, type PackageMutationOptions, type PackageReadOptions, type PackageReadbackOptions } from "./graphPackages.js";
import { capturePackageMutationState } from "./packageMutationState.js";
import type { PackageMutationState } from "./packageMutationState.js";
import type { AuditAction } from "../types/audit.js";

type RestorationProvider = Pick<GraphPackagesClient, "getPackageDetails" | "blockPackage" | "unblockPackage" | "patchPackageAccess">;

export type PackageCanaryRestorationInput = {
  targetId: string;
  action: AuditAction;
  prestate: PackageMutationState;
  poststate: PackageMutationState;
  accessToken: string;
  correlationId?: string;
  signal?: AbortSignal;
  readback?: Pick<PackageReadbackOptions, "maxAttempts" | "delayMs" | "delay">;
};

export async function restorePackageMutationCanary(provider: RestorationProvider, input: PackageCanaryRestorationInput) {
  if (input.action === "reassign") {
    throw new AppError(409, "canary_restoration_unsupported", "Reassignment cannot be restored because Microsoft Graph does not expose a verifiable owner state.");
  }

  const correlationId = input.correlationId ?? randomUUID();
  const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(30_000)]);
  const readOptions: PackageReadOptions = { correlationId, signal };
  const mutationOptions: PackageMutationOptions = { correlationId, signal };
  const details = await provider.getPackageDetails(input.accessToken, input.targetId, readOptions);
  if (details.id !== input.targetId) throw new AppError(502, "target_mismatch", "Provider returned a different package identity.");
  signal.throwIfAborted();
  const current = capturePackageMutationState(details, input.action);
  const assessment = assessCanaryRestoration(input.prestate, input.poststate, current);

  if (assessment.status === "already_restored") return { status: "already_restored" as const, correlationId, readbackCount: 1 };
  if (assessment.status === "conflict") {
    throw new AppError(409, "canary_restoration_conflict", assessment.message);
  }

  if (input.prestate.kind === "block") {
    if (input.prestate.isBlocked) await provider.blockPackage(input.accessToken, input.targetId, mutationOptions);
    else await provider.unblockPackage(input.accessToken, input.targetId, mutationOptions);
  } else {
    if (current.kind !== "access") throw new AppError(409, "canary_restoration_conflict", "The current package state does not match the qualified canary type.");
    await provider.patchPackageAccess(input.accessToken, input.targetId, restoredAccessPayload(input.prestate, current, input.action), mutationOptions);
  }

  try {
    const readback = await verifyPackageMutationConverged(provider, input.accessToken, input.targetId, input.action, input.prestate, { ...input.readback, ...readOptions });
    signal.throwIfAborted();
    return { status: "restored" as const, correlationId, readbackCount: readback.readbackCount };
  } catch (error) {
    throw new AppError(409, "canary_restoration_inconclusive", "The restoration write was accepted but provider read-back did not converge to the qualified prestate. Do not retry automatically.", error instanceof AppError ? error.details : undefined);
  }
}

function restoredAccessPayload(
  prestate: Extract<PackageMutationState, { kind: "access" }>,
  current: Extract<ReturnType<typeof capturePackageMutationState>, { kind: "access" }>,
  action: AuditAction,
) {
  if (action !== "update-availability" && action !== "update-installation") {
    throw new AppError(409, "canary_restoration_conflict", "The qualified canary action does not match package access state.");
  }
  return {
    allowedUsersAndGroups: action === "update-availability" ? prestate.allowedUsersAndGroups : current.allowedUsersAndGroups,
    acquireUsersAndGroups: action === "update-installation" ? prestate.acquireUsersAndGroups : current.acquireUsersAndGroups,
  };
}