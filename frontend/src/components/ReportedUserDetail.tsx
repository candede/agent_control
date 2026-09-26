import type { RefObject } from "react";
import type { CopilotUsageSourceSummary, CopilotUsageUser, OfficialUsageUserSummary } from "../api/client";
import type { UserRelationshipFilters } from "./ReportedUserAgents";
import { UserDetailModal } from "./UserDetailModal";

export function ReportedUserDetail({ user, directoryUser, filters, returnFocusTo, onClose, onFocusAgent, onOpenAgent, dataRevision, agentInventoryRevision, reportPeriod, appActivityState }: {
  user: OfficialUsageUserSummary;
  directoryUser?: CopilotUsageUser | null;
  hasRelationships: boolean;
  filters: UserRelationshipFilters;
  returnFocusTo: RefObject<HTMLInputElement | null>;
  onClose: () => void;
  onFocusAgent: (agentId: string, reportSetId: string) => void;
  onOpenAgent?: (id: string) => void;
  dataRevision?: number;
  agentInventoryRevision?: number;
  reportPeriod?: { startDate: string | null; endDate: string | null };
  appActivityState?: CopilotUsageSourceSummary["state"];
}) {
  return <UserDetailModal identity={JSON.stringify([user.username, user.datasetScope])} displayName={user.displayName || user.username}
    username={user.username} directoryUser={directoryUser} directoryCurrent={Boolean(directoryUser)} reportUser={user}
    reportPeriod={reportPeriod} appActivityState={appActivityState} filters={filters} returnFocusTo={returnFocusTo}
    closeLabel="Close reported user details" onClose={onClose} onFocusAgent={onFocusAgent} onOpenAgent={onOpenAgent}
    dataRevision={dataRevision} agentInventoryRevision={agentInventoryRevision} />;
}
