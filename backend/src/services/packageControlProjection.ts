import { AppError } from "../errors.js";
import type { CopilotPackageDetail, PackageControlObservation } from "../types/copilotPackage.js";
import { isPackageElementType, normalizedGuid, packageCustomEngineBotIdentityChanged, readPackageAgentMetadata } from "./packageAgentMetadata.js";
import { capturePackageMutationState, packageMutationStatesEqual, type PackageMutationState } from "./packageMutationState.js";

export type SavedPackageControl = {
  detail: CopilotPackageDetail;
  state: PackageMutationState;
  observation: PackageControlObservation;
  identityRevalidationRequired?: boolean;
};

export function projectPackageControl(current: CopilotPackageDetail, control: SavedPackageControl): CopilotPackageDetail {
  const action = control.state.kind === "block" ? "block" : "update-availability";
  if (current.id !== control.detail.id
    || !packageMutationStatesEqual(capturePackageMutationState(control.detail, action), control.state)) {
    throw new AppError(409, "mutation_readback_mismatch", "Saved package control evidence does not match its target or verified state.");
  }
  const result: CopilotPackageDetail = {
    ...current,
    ...(control.state.kind === "block"
      ? { isBlocked: control.state.isBlocked }
      : {
        availableTo: control.detail.availableTo ?? control.state.availableTo,
        deployedTo: control.detail.deployedTo ?? control.state.deployedTo,
        allowedUsersAndGroups: control.state.allowedUsersAndGroups,
        acquireUsersAndGroups: control.state.acquireUsersAndGroups,
      }),
    controlObservations: { ...current.controlObservations, [control.state.kind]: control.observation },
  };
  if (control.identityRevalidationRequired || packageControlIdentityChanged(current, control.detail)) {
    result.identityRevalidationRequired = true;
    delete result.identityDetailsCollected;
  }
  return result;
}

export function packageControlIdentityChanged(current: CopilotPackageDetail, incoming: CopilotPackageDetail) {
  // A block changes lastModifiedDateTime too; it is not, by itself, evidence of a new agent identity.
  for (const key of ["manifestId", "appId", "assetId", "version", "manifestVersion"] as const) {
    const before = current[key];
    const after = incoming[key];
    if (after && (key === "manifestId"
      ? (normalizedGuid(before) ?? before) !== (normalizedGuid(after) ?? after) : before !== after)) return true;
  }
  const types = (values: string[]) => JSON.stringify([...new Set(values.map(value => value.toLowerCase()))].sort());
  if (incoming.elementTypes?.length && types(incoming.elementTypes) !== types(current.elementTypes ?? [])) return true;
  if (incoming.elementDetails === undefined) return false;
  const incomingDetails = incoming.elementDetails.filter(group => group.elements.length);
  const declarativeCount = (value: CopilotPackageDetail) => value.elementDetails?.reduce((count, group) =>
    count + (isPackageElementType(group.elementType, "DeclarativeCopilots") ? group.elements.length : 0), 0) ?? 0;
  const nextDeclarativeCount = declarativeCount(incoming);
  if (nextDeclarativeCount) {
    const previousDeclarativeCount = declarativeCount(current);
    const previouslyDeclarative = previousDeclarativeCount > 0
      || current.elementTypes?.some(type => isPackageElementType(type, "DeclarativeCopilots"));
    if (!previouslyDeclarative || nextDeclarativeCount > 1 && nextDeclarativeCount !== previousDeclarativeCount) return true;
  }
  const previous = readPackageAgentMetadata(current);
  const next = readPackageAgentMetadata({ ...incoming, elementDetails: incomingDetails });
  if (next.status === "conflicting" || next.status === "unmatched" && next.invalidMetadata) return true;
  if (next.identity) {
    for (const key of ["environmentId", "cdsBotId", "schemaName", "manifestId", "entraApplicationId"] as const) {
      if (next.identity[key] !== undefined && previous.identity?.[key] !== next.identity[key]) return true;
    }
    if (next.identity.graphAgentIds.some(id => !previous.identity?.graphAgentIds.includes(id))) return true;
  }
  return packageCustomEngineBotIdentityChanged(current, { ...incoming, elementDetails: incomingDetails });
}
