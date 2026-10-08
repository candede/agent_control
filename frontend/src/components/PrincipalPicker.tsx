import { useEffect, useState } from "react";
import { Search, X } from "lucide-react";
import {
  searchDirectoryPrincipals,
  type DirectoryPrincipal,
} from "../api/client";

type PrincipalFilter = "all" | "users" | "security" | "microsoft365";

const searchLimit = 40;
const maxSearchQueryLength = 120;

type PrincipalPickerProps = {
  selected: DirectoryPrincipal[];
  onChange: (selected: DirectoryPrincipal[]) => void;
  disabled?: boolean;
};

export function PrincipalPicker({ selected, onChange, disabled = false }: PrincipalPickerProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PrincipalFilter>("all");
  const [results, setResults] = useState<DirectoryPrincipal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [settledQuery, setSettledQuery] = useState<string>();
  const normalizedQuery = query.trim();
  const queryTooLong = normalizedQuery.length > maxSearchQueryLength;
  const displayedError = queryTooLong
    ? `Directory searches cannot exceed ${maxSearchQueryLength} characters.`
    : error;

  useEffect(() => {
    if (disabled || normalizedQuery.length < 2 || queryTooLong || settledQuery === normalizedQuery) {
      return;
    }

    const controller = new AbortController();
    const timerId = window.setTimeout(async () => {
      setLoading(true);
      setError(undefined);

      try {
        const response = await searchDirectoryPrincipals(normalizedQuery, searchLimit, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setResults(response.value);
        }
      } catch (requestError) {
        if (!controller.signal.aborted) {
          setResults([]);
          setError(errorMessage(requestError));
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setSettledQuery(normalizedQuery);
        }
      }
    }, 300);

    return () => {
      controller.abort();
      window.clearTimeout(timerId);
    };
  }, [disabled, normalizedQuery, queryTooLong, settledQuery]);

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
              disabled={disabled}
              aria-invalid={queryTooLong || undefined}
              placeholder="Name or email"
              onChange={(event) => {
                const nextQuery = event.target.value;
                const nextNormalizedQuery = nextQuery.trim();
                const canSearch = nextNormalizedQuery.length >= 2 && nextNormalizedQuery.length <= maxSearchQueryLength;
                setQuery(nextQuery);
                if (nextNormalizedQuery === normalizedQuery) return;
                setSettledQuery(undefined);
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
            disabled={disabled}
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
        aria-busy={loading && !disabled}
      >
        {loading ? <p role="status">{disabled
          ? "Directory search is paused until editing resumes."
          : "Searching directory..."}</p> : null}
        {displayedError ? <p className="inline-error" role="alert">{displayedError}</p> : null}
        {error ? <p>Change the search, or clear and re-enter it to try again.</p> : null}
        {!loading && !displayedError && normalizedQuery.length < 2 ? (
          <p>Enter at least two characters.</p>
        ) : null}
        {!loading && !displayedError && settledQuery === normalizedQuery ? (
          <p>Search returns up to {searchLimit} users and groups. Type filters apply only to these results; refine your search if a principal is missing.</p>
        ) : null}
        {!loading &&
        !displayedError &&
        settledQuery === normalizedQuery &&
        visibleResults.length === 0 ? (
          <p>No matching unselected principals in these results.</p>
        ) : null}
        {visibleResults.map((principal) => (
          <button
            type="button"
            className="principal-result"
            disabled={disabled}
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
                disabled={disabled}
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
