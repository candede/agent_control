import type { DiscoveryCard } from "./agentDiscovery.js";
import type { OpportunityPage, OpportunityQuery } from "./departmentOpportunity.js";
import type { OfficeObservation } from "./officeAppAdoption.js";
import type { ReportMetadata } from "./officialReportData.js";

export const learningTasks = ["summarize", "draft", "compare", "plan"] as const;
export const learningInputs = ["public_information", "approved_business_material", "synthetic_example"] as const;
export const learningOutputs = ["summary", "draft_document", "comparison", "checklist"] as const;
export const learningReviews = ["verify_sources", "check_accuracy", "remove_sensitive_data", "human_review"] as const;
export const learningFailures = ["missing_context", "incorrect_facts", "unsupported_access", "incomplete_output"] as const;
export const learningPrompts = ["summarize_with_sources", "draft_for_review", "compare_with_caveats", "plan_with_checks"] as const;
export type LearningSlots = {
  task: typeof learningTasks[number]; inputs: typeof learningInputs[number]; output: typeof learningOutputs[number];
  prompt: typeof learningPrompts[number]; reviews: Array<typeof learningReviews[number]>;
  failures: Array<typeof learningFailures[number]>;
};
export type ContentKind = "brief" | "card" | "action";
type ContentStatus = "open" | "in_progress" | "completed" | "cancelled";
type ContentVisibility = "staff_only" | "employees";
type ContentEvidenceKind = "generated_draft" | "description_suggestion" | "contributor_provided" | "contributor_confirmed";
type ContentScope = { company: string | null; department: string | null };
export type ContentNarrative = {
  task: string; inputs: string; prompt: string; expectedOutput: string; reviewSteps: string;
  limitations: string; example: string; opportunity: string; exercises: string; successMeasure: string; unknowns: string;
};
export type ContentDraft = {
  kind: ContentKind; title: string; scope: ContentScope; narrative: ContentNarrative;
  learning: LearningSlots | null; evidenceKind: ContentEvidenceKind; visibility: ContentVisibility;
  assigneeId: string | null; dueDate: string | null; status: ContentStatus; progress: string;
  agentIds: string[]; linkedIds: string[];
  baseline?: { groupId: string; query: OpportunityQuery };
};
export type ContentReference = { id: string; state: "available" | "removed" };
export type ContentAgentReference = {
  id: string; sources: DiscoveryCard["sources"]; state: "available" | "unavailable"; agent: DiscoveryCard | null;
};
export type ContentBaseline = {
  group: Omit<OpportunityPage["value"][number], "drilldowns">;
  definitions: OpportunityPage["definitions"]; office: OfficeObservation;
  report: ReportMetadata; capturedAt: string;
};
export type ContentRecord = Omit<ContentDraft, "baseline" | "agentIds" | "linkedIds"> & {
  id: string; creatorId: string; revision: number; createdAt: string; updatedAt: string;
  agents: ContentAgentReference[]; links: ContentReference[];
  baseline: ContentBaseline | null;
  evidence: { state: "unmeasured" | "available" | "superseded" | "unavailable"; reason: string | null;
    freshQuery: { officeSnapshot: string; company: string | null; department: string | null; setId?: string } | null };
  permissions: { core: boolean; progress: boolean };
};
export type ContentPage = { value: ContentRecord[]; nextCursor: string | null };
export type ContentSave = { record: ContentRecord | null; id: string; replayed: boolean; state: "saved" | "deleted" };
export type ContentFollowUp = {
  baseline: ContentBaseline; current: ContentBaseline;
  caveats: string[]; sameOriginalPeople: false;
};
export type SharedLearningCard = {
  id: string; revision: number; learning: LearningSlots; evidenceKind: ContentEvidenceKind;
  title: string; scope: { company: string | null; department: string | null; state: "available" | "privacy_withheld" };
  agents: Array<Pick<ContentAgentReference, "id" | "state" | "agent">>;
  narrative: { state: "privacy_withheld"; reason: "arbitrary_prose_identity_evidence_unavailable" };
  attribution: { state: "privacy_withheld" }; visibility: "employees";
};
export type SharedLearningPage = { value: SharedLearningCard[]; nextCursor: string | null };
