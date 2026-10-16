import type { AuditOriginV1 } from "./actionOrigin.js";
import type { QuarantineJobStatus } from "./copilotStudioQuarantine.js";

export type AgentControlAction = "block" | "unblock";
type AgentControlEffect =
  | { provider: "graph_packages"; action: AgentControlAction; id: string; displayName: string; alreadyInState: boolean }
  | { provider: "power_platform"; action: "quarantine" | "unquarantine"; id: string; displayName: string;
      environmentId: string; botId: string; alreadyInState: boolean };
export type AgentControlEligibility = {
  recordId: string; displayName: string | null; eligible: boolean; reason: string | null; effects: AgentControlEffect[];
};
export type AgentControlPreview = {
  receiptId: string; confirmationHash: string; selectionId: string; action: AgentControlAction; expiresAt: string;
  targetCount: number; eligibleCount: number; ineligibleCount: number; alreadyInStateCount: number;
  targets: AgentControlEligibility[]; providerAtomicity: false;
};
export type AgentControlChild = {
  provider: "graph_packages" | "power_platform"; recordIds: string[];
  accepted: boolean; jobId: string | null; status: QuarantineJobStatus | null; final: boolean; verified: boolean;
  verification: "pending" | "verified" | "unverified" | "readback_unknown";
  errorCode: string | null; statusUrl: string | null; itemsUrl: string | null;
  cancelUrl: string | null; resumeUrl: string | null; reconcileUrl: string | null;
};
export type AgentControlExecution = {
  receiptId: string; confirmationHash: string; accepted: true; acceptedAt: string; origin: AuditOriginV1;
  outcome: "accepted" | "partial" | "ineligible" | "failed";
  final: boolean; verified: boolean; providerAtomicity: false; ineligibleCount: number; children: AgentControlChild[];
};
