import DOMPurify from "dompurify";
import type { CopilotPackageDetail } from "./api/client";

export function getAgentDescription(
  agent: Pick<CopilotPackageDetail, "longDescription" | "shortDescription">,
  additionalDescription?: string,
) {
  return agent.longDescription?.trim() || additionalDescription?.trim() || agent.shortDescription?.trim() || "No description provided.";
}

export function getSanitizedDescriptionHtml(description: string) {
  if (!/<\/?[a-z][\s\S]*>/i.test(description)) return undefined;
  return DOMPurify.sanitize(description, { USE_PROFILES: { html: true } }).trim() || undefined;
}
