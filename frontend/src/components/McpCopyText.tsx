import { useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

export function McpCopyText({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"copied" | "failed">();
  const copyAttempt = useRef(0);
  async function copy() {
    const attempt = ++copyAttempt.current;
    setState(undefined);
    try {
      await navigator.clipboard.writeText(value);
      if (attempt === copyAttempt.current) setState("copied");
    } catch {
      if (attempt === copyAttempt.current) setState("failed");
    }
  }
  return <span className="mcp-copy">
    <button type="button" className="secondary" aria-label={`Copy ${label}`} onClick={() => void copy()}>
      {state === "copied" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      {state === "copied" ? "Copied" : "Copy"}</button>
    {state === "copied" ? <span className="sr-only" role="status">{label} copied.</span> : null}
    {state === "failed" ? <span className="mcp-copy-error" role="alert">Copy unavailable. Select and copy the text.</span> : null}
  </span>;
}
