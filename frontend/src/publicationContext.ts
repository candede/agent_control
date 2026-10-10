import { createContext, useContext } from "react";
import type { PublicationRevisions } from "../../backend/src/types/dataSelection";
import type { DataSyncSourceState } from "../../backend/src/types/dataSync";
import type { UserSourceMetadata } from "../../backend/src/types/userSources";

export const PublicationContext = createContext<{
  admit: (revisions: PublicationRevisions) => void;
  revisions?: PublicationRevisions;
  usersRefresh?: { checking: boolean; status?: DataSyncSourceState };
} | undefined>(undefined);

export function useUserSourceProgress(source: UserSourceMetadata | undefined) {
  const refresh = useContext(PublicationContext)?.usersRefresh;
  if (!source || source.state === "available") return undefined;
  if (refresh?.status && !["queued", "running"].includes(refresh.status)) return undefined;
  if (["failed", "cancelled", "waiting_authorization", "permission_required"].includes(source.attemptStatus ?? "")) return undefined;
  if (source.attemptStatus === "running" || refresh?.status === "queued" || refresh?.status === "running") {
    return "Users sync is in progress. Please wait a moment; this page will update automatically.";
  }
  if (refresh?.checking && refresh.status === undefined) {
    return "Checking user data and automatic sync status. Please wait a moment.";
  }
  return undefined;
}

export function useUserSourceFailure(source: UserSourceMetadata | undefined) {
  const refresh = useContext(PublicationContext)?.usersRefresh;
  if (!source || source.state === "available" || !["partial", "failed"].includes(refresh?.status ?? "")) return undefined;
  return "The latest Users sync did not complete. Saved data remains available; automatic refresh will retry when eligible. Review Sync for details.";
}
