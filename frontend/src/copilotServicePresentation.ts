import type { CopilotServiceSummaryState } from "./api/client";

const serviceStates = {
  enabled: { label: "Active", tone: "", needsAttention: false },
  warning: { label: "Active (grace period)", tone: "attention", needsAttention: true },
  disabled: { label: "Not enabled", tone: "attention", needsAttention: true },
  suspended: { label: "Suspended", tone: "attention", needsAttention: true },
  locked_out: { label: "Locked out", tone: "attention", needsAttention: true },
  unknown: { label: "Unverified", tone: "unknown", needsAttention: true },
  partially_enabled: { label: "Partially active", tone: "attention", needsAttention: true },
} satisfies Record<CopilotServiceSummaryState, {
  label: string;
  tone: "" | "attention" | "unknown";
  needsAttention: boolean;
}>;

export function copilotServicePresentation(state: CopilotServiceSummaryState | null | undefined) {
  return serviceStates[state ?? "unknown"];
}
