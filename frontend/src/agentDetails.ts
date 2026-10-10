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

export function getAdoptionDescriptionPreview(description: string | null) {
  if (!description) return "";
  const fragment = DOMPurify.sanitize(description, { USE_PROFILES: { html: true }, RETURN_DOM_FRAGMENT: true });
  for (const element of fragment.querySelectorAll("p, div, br, li, ul, ol, h1, h2, h3, h4, h5, h6, tr, td, th, blockquote, pre, hr")) {
    element.before(document.createTextNode(" "));
    element.after(document.createTextNode(" "));
  }
  const text = (fragment.textContent ?? "").replace(/\s+/g, " ").trim();
  const characters = Array.from(text);
  if (characters.length <= 300) return text;
  const prefix = characters.slice(0, 299).join("");
  const boundary = /\s/.test(characters[299]) ? prefix.length : prefix.lastIndexOf(" ");
  return `${(boundary > 0 ? prefix.slice(0, boundary) : prefix).trimEnd()}…`;
}
