import type { ContentDraft } from "../types/adoptionContent.js";

export const manualDraft = (kind: ContentDraft["kind"] = "brief"): ContentDraft => ({
  kind, title: "Department activation", scope: { company: null, department: null },
  narrative: { task: "Review a workflow", inputs: "Approved material", prompt: "Draft inert text", expectedOutput: "Reviewed draft",
    reviewSteps: "Check sources", limitations: "No measured ROI", example: "", opportunity: "", exercises: "",
    successMeasure: "Review the next group snapshot", unknowns: "Usage is not expertise" },
  learning: kind === "card" ? { task: "draft", inputs: "synthetic_example", output: "draft_document",
    prompt: "draft_for_review", reviews: ["human_review"], failures: ["incorrect_facts"] } : null,
  evidenceKind: "contributor_provided", visibility: "staff_only", assigneeId: null, dueDate: null,
  status: "open", progress: "", agentIds: [], linkedIds: [],
});
