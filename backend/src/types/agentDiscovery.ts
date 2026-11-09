export const discoveryOperations = ["profile", "search", "detail", "workplace"] as const;
export type DiscoveryPrivacy = { hide_employee_details: boolean; hide_champion_employee: boolean };
export type DiscoveryText = { state: "available" | "absent" | "privacy_withheld" | "unsafe_withheld" | "limit_withheld"; text: string | null };
export type DiscoveryContact = { name: string | null; contact: string | null; company: string | null; department: string | null };
type DiscoverySource = {
  source: "graph_packages" | "power_platform"; generationId: string; sourceIdentity: string; revision: string;
};
type DiscoveryOrigin = {
  kind: "organization_created" | "microsoft";
  evidence: (DiscoverySource & { field: "type" | "publisher" | "resourceType" | "creatorType";
    setId: string | null; versionId: string | null })[];
};
export type DiscoveryCard = {
  id: string;
  origin: DiscoveryOrigin;
  title: DiscoveryText;
  description: DiscoveryText & { clipped: boolean };
  lifecycle: "draft" | "published" | "unknown";
  people: { state: "available" | "absent" | "privacy_withheld" | "unavailable"; value: DiscoveryContact[] };
  affiliations: { company: string | null; department: string | null }[];
  useLink: DiscoveryText;
  evidence: (DiscoverySource & { field: "description" | "title"; excerpt: string })[];
  sources: (DiscoverySource & { observedAt: string; descriptionField: "longDescription" | "shortDescription" | "details.description";
    descriptionState: DiscoveryText["state"] })[];
};
export type DiscoveryContext = {
  mode: "self" | "preview";
  subject: "current_account" | "selected_member";
  company: string | null;
  department: string | null;
  profileState: "available" | "unavailable";
};
type DiscoveryPeriod = { startDate: string | null; endDate: string | null } | null;
type DiscoveryReportState = "available" | "stale" | "unavailable";
export type DiscoverySelection = { id: string; revision: string; expiresAt: string };
export type DiscoveryPage = {
  context: DiscoveryContext; selection: DiscoverySelection; privacy: DiscoveryPrivacy;
  state: "candidate" | "no_matching_saved_evidence" | "coverage_incomplete";
  value: DiscoveryCard[]; nextCursor: string | null;
};
export type DiscoveryWorkplace = {
  context: DiscoveryContext; selection: DiscoverySelection; privacy: DiscoveryPrivacy;
  period: DiscoveryPeriod; reportState: DiscoveryReportState;
  champions: { state: "available" | "privacy_withheld" | "unavailable"; value: DiscoveryContact[] };
  ownChampion: { state: "suggested" | "not_suggested" | "unavailable"; reason: string | null };
  department: { state: "available" | "unavailable"; value: DiscoveryCard[] };
  company: { state: "available" | "unavailable"; value: DiscoveryCard[] };
  useCases: { state: "available" | "unavailable"; value: { agent: DiscoveryCard; relationships: ("created_here" | "used_here")[] }[] };
};
export type DiscoveryProfile = {
  context: DiscoveryContext; selection: DiscoverySelection; privacy: DiscoveryPrivacy; period: DiscoveryPeriod; reportState: DiscoveryReportState;
  ownChampion: DiscoveryWorkplace["ownChampion"];
};
export type DiscoveryDetail = {
  context: DiscoveryContext; selection: DiscoverySelection; privacy: DiscoveryPrivacy;
  agent: DiscoveryCard; description: DiscoveryText & { clipped: boolean }; nextCursor: string | null;
};
export type DiscoveryResult = DiscoveryPage | DiscoveryWorkplace | DiscoveryProfile | DiscoveryDetail;
type DiscoveryRead =
  | { operation: "profile" }
  | { operation: "search"; goal?: string; terms?: string[]; limit?: number; cursor?: string }
  | { operation: "detail"; agentId: string; cursor?: string }
  | { operation: "workplace"; scope?: "department" | "company" | "both"; limit?: number };
export type DiscoveryRequest = DiscoveryRead & { selectionId?: string };
