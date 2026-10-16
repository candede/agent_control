import { useEffect, useEffectEvent, useState } from "react";
import { ApiError, getAgentAbout } from "../api/client";
import { getSanitizedDescriptionHtml } from "../agentDetails";
import type { AgentAboutPage } from "../../../backend/src/types/savedReadContracts";

function lacksText(about: { page: AgentAboutPage; text: string }) {
  return about.page.state === "missing" || !about.text.trim();
}

export function SavedAgentAbout({ selectionId, recordId, source, native = false, nativeSource, onInvalidated }: {
  selectionId: string; recordId: string; source: { scopeId: string; identity: string }; native?: boolean;
  nativeSource?: { scopeId: string; identity: string }; onInvalidated?: () => void;
}) {
  const nativeScopeId = nativeSource?.scopeId, nativeIdentity = nativeSource?.identity;
  const owner = JSON.stringify([selectionId, recordId, source.scopeId, source.identity, native, nativeScopeId, nativeIdentity]);
  const [state, setState] = useState<{ owner: string; page?: AgentAboutPage; text: string; error?: string; loading: boolean }>({ owner, text: "", loading: true });
  if (state.owner !== owner) setState({ owner, text: "", loading: true });
  const invalidated = useEffectEvent(() => onInvalidated?.());
  useEffect(() => {
    const controller = new AbortController();
    const boundSource = { scopeId: source.scopeId, identity: source.identity };
    const loadText = async (selectedSource: typeof source, field: AgentAboutPage["field"]) => {
      let page = await getAgentAbout(selectionId, recordId, selectedSource, field, { signal: controller.signal });
      let text = page.text ?? "";
      while (page.nextCursor && !controller.signal.aborted) {
        page = await getAgentAbout(selectionId, recordId, { scopeId: page.sourceScopeId, identity: page.sourceIdentity },
          page.field, { cursor: page.nextCursor, signal: controller.signal });
        text += page.text ?? "";
      }
      controller.signal.throwIfAborted();
      return { page, text };
    };
    void (async () => {
      let about = await loadText(boundSource, native ? "native" : "long");
      if (!native && lacksText(about) && nativeScopeId && nativeIdentity) {
        about = await loadText({ scopeId: nativeScopeId, identity: nativeIdentity }, "native");
      }
      if (!native && lacksText(about)) about = await loadText(boundSource, "short");
      if (!controller.signal.aborted) setState({ owner, ...about, loading: false });
    })().catch(error => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.code === "selection_invalidated") invalidated();
      setState({ owner, text: "", loading: false, error: error instanceof Error ? error.message : "Saved About text is unavailable." });
    });
    return () => controller.abort();
  }, [selectionId, recordId, source.scopeId, source.identity, native, nativeScopeId, nativeIdentity, owner]);
  const html = getSanitizedDescriptionHtml(state.text);
  return <div>
    {state.loading ? <p role="status">Loading saved About text…</p> : null}
    {state.error ? <p role="alert">{state.error}</p> : null}
    {html ? <div className="agent-overview-description rich-description" aria-label="Agent description"
      dangerouslySetInnerHTML={{ __html: html }} /> : state.text ? <p aria-label="Agent description">{state.text}</p> : null}
    {state.page?.state === "missing" ? <p>About text was not supplied by this saved source.</p> : null}
  </div>;
}
