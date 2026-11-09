import { useEffect, useState } from "react";
import { readSharedLearning, type SharedLearningPage } from "../api/adoptionContent";

export function SharedLearningCards({ principalKey }: { principalKey: string }) {
  const [page, setPage] = useState<SharedLearningPage>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState<string>();
  const [pageSize, setPageSize] = useState(10);
  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) { setLoading(true); setError(undefined); setPage(undefined); } });
    readSharedLearning({ limit: pageSize, ...(cursor ? { cursor } : {}) }, controller.signal).then(value => {
      if (!controller.signal.aborted) setPage(value);
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Shared learning could not be read."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [principalKey, cursor, pageSize]);
  return <section className="shared-learning" aria-label="Employee-shared learning">
    <h2>Employee-shared learning</h2>
    <p>Explicit tenant-wide sharing. Department labels describe relevance, not access. Contributor assertions are not certification.</p>
    <label>Shared learning page size<select value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setCursor(undefined); }}>
      {[1, 5, 10, 20].map(value => <option key={value}>{value}</option>)}</select></label>
    {loading ? <p role="status">Loading shared learning...</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {!loading && !error && page?.value.length === 0 ? <p>No employee-shared learning cards yet. Agent discovery remains available.</p> : null}
    {page?.value.map(card => <article key={card.id}>
      <h3>{card.title}</h3><p>Card {card.id} · revision {card.revision} · {card.evidenceKind.replaceAll("_", " ")}</p>
      <dl><dt>Inputs</dt><dd>{card.learning.inputs.replaceAll("_", " ")}</dd>
        <dt>Prompt pattern</dt><dd>{card.learning.prompt.replaceAll("_", " ")}</dd>
        <dt>Expected output</dt><dd>{card.learning.output.replaceAll("_", " ")}</dd>
        <dt>Review steps</dt><dd>{card.learning.reviews.map(value => value.replaceAll("_", " ")).join(", ")}</dd>
        <dt>Known failures</dt><dd>{card.learning.failures.map(value => value.replaceAll("_", " ")).join(", ") || "Not supplied"}</dd></dl>
      <p>Staff narrative, examples and contributor identities are withheld: complete identity evidence for arbitrary prose is unavailable.</p>
      {card.agents.map(reference => <p key={reference.id}>Agent {reference.id}: {reference.state}
        {reference.agent?.title.text ? ` — ${reference.agent.title.text}` : ""}. Discovery does not grant provider access.</p>)}
    </article>)}
    {page?.nextCursor ? <button type="button" disabled={loading} onClick={() => setCursor(page.nextCursor!)}>Next shared cards</button> : null}
    {cursor ? <button type="button" onClick={() => setCursor(undefined)}>First shared cards</button> : null}
  </section>;
}
