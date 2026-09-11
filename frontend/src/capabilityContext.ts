import { createContext, useContext } from "react";
import type { useCapabilities } from "./useCapabilities";

export const CapabilityContext = createContext<(ReturnType<typeof useCapabilities> & { openPermissions: () => void }) | undefined>(undefined);

export function useCapabilityContext() {
  const context = useContext(CapabilityContext);
  if (!context) throw new Error("Capability context is required.");
  return context;
}