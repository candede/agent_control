import type { CopilotPackage, PackageAccessUpdate } from "./api/client";

export function projectVerifiedAccessScope(
  agent: CopilotPackage,
  update: PackageAccessUpdate,
): CopilotPackage {
  const scope = update.scope === "none" ? "none" : "some";
  return update.target === "availability"
    ? { ...agent, availableTo: scope }
    : { ...agent, deployedTo: scope };
}