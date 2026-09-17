import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import type { InventorySnapshot, UnifiedAgentInventoryPage, UnifiedAgentPowerPlatformObservation } from "../api/client";
import { inventoryCoverageLabel, inventoryRequestScope, inventoryRoleHint, powerPlatformInventoryCaveat, savedInventoryTime } from "../inventoryVerification";
import "./savedInventoryVerification.css";

type ReadState = { loading?: boolean; error?: string };

export function SavedAgentInventoryVerification({
  inventory, loading = false, error, onVerify,
}: ReadState & { inventory?: UnifiedAgentInventoryPage; onVerify?: () => void }) {
  const receipt = inventory?.verification;
  const observation = inventory?.sources.powerPlatform.observation;
  const powerPlatform = observation && "roleScope" in observation ? observation : undefined;
  const noSources = inventory && Object.values(inventory.sources).every(source => source.state === "unavailable");
  return <section className="saved-inventory-verification" aria-label="Saved agent inventory verification" aria-busy={loading}>
    <div className="verification-heading">
      <h3>Saved inventory verification</h3>
      <button type="button" className="secondary" disabled={loading || !onVerify} onClick={onVerify}
        title="Recheck existing saved source counts and identity accounting. No provider sync or clearing.">
        <RefreshCw size={15} aria-hidden="true" />{loading ? "Verifying saved inventory..." : "Verify saved inventory"}
      </button>
    </div>
    <p>Saved inventory is checked automatically. No manual verification or administrator approval is required after sync.</p>
    {loading ? <p role="status">Checking saved inventory. Any previous receipt is not the result of this check.</p>
      : error ? <p className="verification-attention" role="alert">Saved inventory verification failed. The previous receipt has not been reverified. {error}</p>
        : !receipt || !inventory ? <p role="status">Saved inventory verification is not available. Read the saved inventory to obtain a receipt.</p>
          : <>
            <p className={receipt.status === "verified" ? "verification-success" : "verification-attention"} role="status">
              <strong>{receipt.status === "verified" ? "Saved inventory verified" : "Saved inventory needs attention"}</strong>
              {" "}- authorized saved-source collection, accounting and identity consistency.
            </p>
            <dl className="verification-counts" aria-label="Full saved agent accounting">
              <Fact label="Graph package targets">{inventory.sources.graphPackages.state === "unavailable" ? "Not available" : receipt.graphPackageCount.toLocaleString()}</Fact>
              <Fact label="Power Platform agent targets">{inventory.sources.powerPlatform.state === "unavailable" ? "Not available" : receipt.powerPlatformAgentCount.toLocaleString()}</Fact>
              <Fact label="Targets represented / unique source targets">{noSources ? "Not established" : `${receipt.representedSourceCount.toLocaleString()} / ${receipt.uniqueSourceCount.toLocaleString()}`}</Fact>
              <Fact label="Logical agents">{noSources ? "Not established" : receipt.logicalAgentCount.toLocaleString()}</Fact>
            </dl>
            <ul className="verification-checks">
              <li>{receipt.checks.sourceScopes ? "Saved source query scopes verified." : "A saved source is missing or its collection scope is limited."}</li>
              <li>{inventory.sources.graphPackages.state === "unavailable"
                ? "Package identity metadata is not established: the saved Graph source is unavailable."
                : receipt.checks.packageMetadata ? "Package identity metadata checked and valid." : "Package identity metadata still needs collection or repair."}</li>
              <li>{noSources
                ? "Identity-link consistency is not established: no saved agent source is available."
                : receipt.checks.identityLinks ? "No ambiguous or conflicting identity links." : "Ambiguous or conflicting identity links require review."}</li>
              <li>{noSources
                ? "Source membership accounting is not established: no saved agent source is available."
                : receipt.checks.sourceMemberships ? "Each available source target is represented exactly once." : "Source membership accounting is not verified."}</li>
            </ul>
            {inventory.partial || inventory.errors.length > 0 ? <p className="verification-attention">
              <strong>Saved source limitations.</strong> {inventory.errors.map(item => item.message).join(" ")}
            </p> : null}
            <p>These counts cover all unfiltered saved records, not the current page or display filters. Logical grouping follows exact source evidence; this does not prove every source-only row is a different physical agent.</p>
            <dl className="verification-dates">
              <Fact label={receipt.status === "verified" ? "Saved data verified at" : "Saved data checked at"}><time dateTime={receipt.checkedAt}>{savedInventoryTime(receipt.checkedAt)}</time></Fact>
              <Fact label="Graph source collected at">{inventory.sources.graphPackages.observation
                ? <time dateTime={inventory.sources.graphPackages.observation.observedAt}>{savedInventoryTime(inventory.sources.graphPackages.observation.observedAt)}</time>
                : "Not available"}</Fact>
            </dl>
            <SavedPowerPlatformVerification snapshot={powerPlatform} />
          </>}
    <p className="verification-caveat">Verification reads saved data, not live Microsoft data. It does not grant permissions or attest universal tenant visibility.</p>
  </section>;
}

export function SavedPowerPlatformVerification({
  snapshot, loading = false, error,
}: ReadState & { snapshot?: InventorySnapshot | UnifiedAgentPowerPlatformObservation | null }) {
  const verification = snapshot?.verification;
  const agentCoverage = snapshot && ("coveredCount" in snapshot
    ? { count: snapshot.coveredCount, status: snapshot.coverage }
    : snapshot.coverage.find(item => item.type === "microsoft.copilotstudio/agents"));
  return <section className="saved-power-platform-verification" aria-label="Saved Power Platform query verification" aria-busy={loading}>
    <h4>Power Platform saved request</h4>
    {loading ? <p role="status">Verifying the saved Power Platform request. Previous verification is not current for this read.</p>
      : error ? <p className="verification-attention" role="alert">Power Platform saved verification failed. The previous receipt has not been reverified. {error}</p>
        : !snapshot || !verification ? <p role="status">No verified Power Platform snapshot is available. Collection counts and request coverage are not established.</p>
          : <>
            <p className="verification-success"><strong>Authorized Power Platform query verified</strong> - provider total agrees with stored, unique resource identities.</p>
            <dl className="verification-counts" aria-label="Verified Power Platform request counts">
              <Fact label="Resources stored / provider total">{verification.storedCount.toLocaleString()} / {snapshot.totalRecords.toLocaleString()}</Fact>
              <Fact label="Unique resource identities">{verification.uniqueIdentityCount.toLocaleString()}</Fact>
              <Fact label="Provider pages collected">{snapshot.pageCount.toLocaleString()}</Fact>
              {"requestedTypes" in snapshot ? <Fact label="Resource types requested">{snapshot.requestedTypes.length.toLocaleString()}</Fact> : null}
              <Fact label="Actual resource types queried">{verification.queriedTypes.length.toLocaleString()}</Fact>
              <Fact label="Power Platform agents observed">{agentCoverage?.count?.toLocaleString() ?? "Not established"}</Fact>
              <Fact label="Environment request scope">{inventoryRequestScope(snapshot.environmentScope)}</Fact>
              <Fact label="Optional directory-role hint">{inventoryRoleHint(snapshot.roleScope)}</Fact>
              <Fact label="Agent type query">{agentCoverage ? inventoryCoverageLabel(agentCoverage.status) : "Not established"}</Fact>
            </dl>
            <details>
              <summary>Actual queried resource types</summary>
              <ul>{verification.queriedTypes.map(type => <li key={type}><code>{type}</code></li>)}</ul>
            </details>
            {"requestedTypes" in snapshot && snapshot.requestedTypes.some(type => !verification.queriedTypes.includes(type)) ? <p>
              Not every requested type was executed. Verification covers the persisted executed types, not the full request or a later role policy.
            </p> : null}
            <dl className="verification-dates">
              <Fact label="Power Platform collected at"><time dateTime={snapshot.observedAt}>{savedInventoryTime(snapshot.observedAt)}</time></Fact>
              <Fact label="Saved request verified at"><time dateTime={verification.checkedAt}>{savedInventoryTime(verification.checkedAt)}</time></Fact>
            </dl>
            <p>Counts describe the original authorized request, not display filters or paging. This is a saved-data check, not a fresh Microsoft read or proof of universal tenant visibility. Directory-role hints are optional diagnostics, not permission attestations.</p>
          </>}
    <p className="verification-caveat">{powerPlatformInventoryCaveat}</p>
  </section>;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}
