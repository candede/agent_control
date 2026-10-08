import "./workspaceSkeleton.css";

const titles = { agents: "Agents", users: "Users & adoption", audit: "Local control audit" };

export function WorkspaceSkeleton({ view, contentOnly = false, showSummary = true }: {
  view: keyof typeof titles;
  contentOnly?: boolean;
  showSummary?: boolean;
}) {
  // A busy ancestor can defer the live announcement until the skeleton is removed.
  return <>
    <p className="sr-only" role="status">Loading {view === "audit" ? "audit events" : view}...</p>
    <section className={`workspace-skeleton workspace-skeleton-${view}`} aria-label={`Loading ${view}`} aria-busy="true">
      {!contentOnly ? <header className="workspace-skeleton-heading" aria-hidden="true">
        <h2>{titles[view]}</h2>
        <div className="workspace-skeleton-heading-actions"><span className="skeleton-block skeleton-control" /><span className="skeleton-block skeleton-control" /></div>
        {view === "audit" ? <span className="skeleton-block skeleton-description" /> : null}
      </header> : null}
      {showSummary ? <div className="workspace-skeleton-summary" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => <div className="workspace-skeleton-metric" key={index}>
          <span className="skeleton-block skeleton-label" />
          <span className="skeleton-block skeleton-value" />
          <span className="skeleton-block skeleton-label" />
        </div>)}
        {view !== "audit" ? <div className="workspace-skeleton-context"><span className="skeleton-block skeleton-label" /><span className="skeleton-block skeleton-control" /></div> : null}
      </div> : view === "users" && !contentOnly ? <div className="workspace-skeleton-context" aria-hidden="true">
        <span className="skeleton-block skeleton-label" /><span className="skeleton-block skeleton-control" />
      </div> : null}
      <div className="workspace-skeleton-table" aria-hidden="true">
        <div className="workspace-skeleton-toolbar">
          <span className="skeleton-block skeleton-search" />
          <span className="skeleton-block skeleton-control" /><span className="skeleton-block skeleton-control" />
        </div>
        <div className="workspace-skeleton-row workspace-skeleton-columns">
          {Array.from({ length: 6 }, (_, index) => <span className="skeleton-block skeleton-label" key={index} />)}
        </div>
        {Array.from({ length: 8 }, (_, index) => <div className="workspace-skeleton-row" key={index}>
          <div className="workspace-skeleton-name">
            {view === "agents" ? <span className="skeleton-block skeleton-avatar" /> : null}
            <div><span className="skeleton-block skeleton-label" /><span className="skeleton-block skeleton-label" /></div>
          </div>
          {Array.from({ length: 5 }, (_, column) => <span className="skeleton-block skeleton-label" key={column} />)}
        </div>)}
        <div className="workspace-skeleton-pagination">
          <span className="skeleton-block skeleton-label" /><span className="skeleton-block skeleton-control" />
        </div>
      </div>
    </section>
  </>;
}
