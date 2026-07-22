import { useEffect, useState } from "react";
import { Search, X } from "lucide-react";
import {
  searchDirectoryPrincipals,
  type DirectoryPrincipal,
} from "../api/client";

type PrincipalFilter = "all" | "users" | "security" | "microsoft365";

type PrincipalPickerProps = {
  selected: DirectoryPrincipal[];
  onChange: (selected: DirectoryPrincipal[]) => void;
};

export function PrincipalPicker({ selected, onChange }: PrincipalPickerProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PrincipalFilter>("all");
  const [results, setResults] = useState<DirectoryPrincipal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const normalized = query.trim();

    if (normalized.length < 2) {
      return;
    }

    let cancelled = false;
    const timerId = window.setTimeout(async () => {
      setLoading(true);
      setError(undefined);

      try {
        const response = await searchDirectoryPrincipals(normalized, 40);
        if (!cancelled) {
          setResults(response.value);
        }
      } catch (requestError) {
        if (!cancelled) {
          setResults([]);
          setError(errorMessage(requestError));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
    };
  }, [query]);

  const selectedKeys = new Set(selected.map(principalKey));
  const visibleResults = results.filter(
    (principal) =>
      !selectedKeys.has(principalKey(principal)) &&
      matchesFilter(principal, filter),
  );

  return (
    <div className="principal-picker">
      <div className="principal-search-row">
        <label className="principal-search">
          <span>Add a user or group</span>
          <span className="input-with-icon">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              value={query}
              placeholder="Name or email"
              onChange={(event) => {
                const nextQuery = event.target.value;
                const canSearch = nextQuery.trim().length >= 2;
                setQuery(nextQuery);
                setResults([]);
                setError(undefined);
                setLoading(canSearch);
              }}
            />
          </span>
        </label>
        <label>
          <span>Type</span>
          <select
            value={filter}
            onChange={(event) =>
              setFilter(event.target.value as PrincipalFilter)
            }
          >
            <option value="all">All</option>
            <option value="users">Users</option>
            <option value="security">Security groups</option>
            <option value="microsoft365">Microsoft 365 groups</option>
          </select>
        </label>
      </div>

      <div
        className="principal-results"
        role="group"
        aria-label="Directory results"
      >
        {loading ? <p role="status">Searching directory...</p> : null}
        {error ? <p className="inline-error">{error}</p> : null}
        {!loading && !error && query.trim().length < 2 ? (
          <p>Enter at least two characters.</p>
        ) : null}
        {!loading &&
        !error &&
        query.trim().length >= 2 &&
        visibleResults.length === 0 ? (
          <p>No matching unselected principals.</p>
        ) : null}
        {visibleResults.map((principal) => (
          <button
            type="button"
            className="principal-result"
            key={principalKey(principal)}
            onClick={() => onChange([...selected, principal])}
          >
            <span>
              <strong>{principal.displayName}</strong>
              <small>{principal.secondaryText ?? principal.resourceId}</small>
            </span>
            <small>{principalKindLabel(principal)}</small>
          </button>
        ))}
      </div>

      <div className="selected-principals" aria-label="Selected principals">
        <div className="selected-principals-header" aria-hidden="true">
          <span>User or group</span>
          <span>Identity</span>
          <span>Type</span>
          <span>Action</span>
        </div>
        {selected.length === 0 ? (
          <p className="selected-principals-empty">
            No users or groups selected yet.
          </p>
        ) : (
          selected.map((principal) => (
            <div className="principal-row" key={principalKey(principal)}>
              <span className="principal-avatar" aria-hidden="true">
                {principalInitials(principal.displayName)}
              </span>
              <strong>{principal.displayName}</strong>
              <small>{principal.secondaryText ?? principal.resourceId}</small>
              <span className="principal-type">
                {principalKindLabel(principal)}
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove ${principal.displayName}`}
                title={`Remove ${principal.displayName}`}
                onClick={() =>
                  onChange(
                    selected.filter(
                      (item) => principalKey(item) !== principalKey(principal),
                    ),
                  )
                }
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function matchesFilter(principal: DirectoryPrincipal, filter: PrincipalFilter) {
  return (
    filter === "all" ||
    (filter === "users" && principal.principalKind === "user") ||
    (filter === "security" && principal.principalKind === "securityGroup") ||
    (filter === "microsoft365" &&
      principal.principalKind === "microsoft365Group")
  );
}

function principalKey(principal: DirectoryPrincipal) {
  return `${principal.resourceType.trim().toLowerCase()}:${principal.resourceId
    .trim()
    .toLowerCase()}`;
}

function principalKindLabel(principal: DirectoryPrincipal) {
  switch (principal.principalKind) {
    case "user":
      return "User";
    case "securityGroup":
      return "Security group";
    case "microsoft365Group":
      return "Microsoft 365 group";
    default:
      return principal.resourceType === "user" ? "User ID" : "Group ID";
  }
}

function principalInitials(displayName: string) {
  return (
    displayName
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?"
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Directory search failed.";
}
