# Phase 11 - Dataverse Conversation Transcript Ingestion

## Mission

Add opt-in, environment-scoped Copilot Studio `conversationtranscripts` ingestion with both delegated and application-user authorization paths, encrypted content, redacted-by-default viewing, audited access, bounded retention, and exact unsupported-state explanations.

## Prerequisites

- Read the roadmap and completion records for Phases 01-10.
- Multi-audience auth, provider/environment configuration, durable jobs/checkpoints/observations, normalized Power Platform identities, capability gates, Key Vault integration, and internal roles must exist.
- Do not deploy in this phase.

## Read first

- Phase 01 persistence/backup/retention code
- Phase 02 Dataverse token/capability code
- Phase 04 environment and Dataverse bot identifiers
- Phase 06 two-step import and Phase 08 collector patterns
- Current Dataverse Web API auth/application-user documentation
- Current Copilot Studio transcript controls and Power Apps transcript documentation
- Current Dataverse `conversationtranscript` entity reference

## Permission contract

- Resource/audience: each configured Dataverse environment organization URL, never a tenant-global Dataverse audience.
- Delegated app permission: that Dataverse environment resource's `user_impersonation` scope. The signed-in user needs the **Bot Transcript Viewer** security role in that environment; Environment Maker does not grant transcript access.
- Application mode: create one Dataverse application user for the app registration or managed identity in each environment. Assign a custom least-privilege security role with organization-level **Read** on `ConversationTranscript`; add Read on `Bot` only if the implementation retrieves bot fields not already present in transcript metadata. Grant no create, write, assign, share, or delete transcript privilege.
- Internal access: configuration and ingestion require `AgentControl.Administrator`; metadata views require an explicitly selected policy; content views/exports require `AgentControl.TranscriptReader` and are always audited.
- Entity set: `conversationtranscripts` under the environment Web API.

## Required implementation

1. Make transcript support default-disabled globally and per environment. Enabling requires a privacy configuration recording purpose, allowed environments, delegated/application mode, collection window, retention, raw-content policy, redaction policy/version, access groups, and acknowledgement of sensitive fields.
	Check in a machine-readable `Agent Control Transcript Reader` Dataverse role specification and operator runbook: organization-level Read on `ConversationTranscript`, optional Read on `Bot` only when selected fields require it, and no Create, Write, Delete, Append, Append To, Assign, or Share. Include an idempotent validation command. Agent Control validates but never assigns or mutates environment roles.
2. Validate environment configuration: HTTPS organization URL, exact allowlisted host, tenant/environment IDs, no userinfo/query/fragment, discovery/probe evidence, and bot mapping. Prevent SSRF, redirects to untrusted hosts, and arbitrary OData paths.
3. Build a typed Dataverse adapter for `conversationtranscripts` with explicit `$select`, bounded `$filter`, server-driven `@odata.nextLink` pagination restricted to the original trusted host, OData error parsing, timeouts, retries, and `Retry-After`.
4. Retrieve only required fields such as `conversationtranscriptid`, `name`, `conversationstarttime`, `createdon`, `modifiedon`, `schematype`, `schemaversion`, `metadata`, `content`, and bot lookup. Do not use `$expand` or extra identity tables unless a documented feature requires them and the role/UI are updated.
5. Implement incremental application-owned ingestion with `(modifiedon, conversationtranscriptid)` checkpoint plus overlap, idempotent row version/content hash, restart recovery, late updates, deletion/retention detection, and per-environment single-writer leases. Delegated mode supports user-triggered bounded import but not unattended scheduling.
6. Parse metadata and content with versioned, size/depth/count-limited JSON schemas. Preserve unknown activity/value types as opaque bounded evidence. Reject/quarantine malformed or oversized content without advancing past unpersisted required data.
7. Reassemble split transcripts by exact `Name` plus `ConversationStartTime`, sorted by `Metadata.BatchId`; retain source row lineage and detect duplicate/missing/conflicting batches. Respect the documented 1 MB per-row content limit and 30-minute inactivity split behavior.
8. Normalize conversation metadata: agent/bot, environment, tenant, conversation, batch, channel, start/end, participants as pseudonymous identifiers, activity counts/types, session outcome, escalation/resolution/abandon, turns, topics, CSAT/PRR, errors, and node traces where present.
9. Encrypt raw `content` and `metadata` at application level with AES-256-GCM envelope encryption and a unique random data-encryption key per stored object. Wrap each data key with a versioned Key Vault key-encryption key; persist algorithm, nonce, tag, wrapped key, and exact key-version URI, never plaintext keys. New writes use the current key version while retained old versions remain decryptable; rotation must not require bulk plaintext exposure. Backups contain ciphertext only. If a key version is unavailable, fail content access closed, retain ciphertext for recovery, mark affected objects `unreadable_key_unavailable`, and alert with counts/key-version reference but no content.
10. Generate a versioned redacted derivative for default viewing and search. Redact user/agent text, variable values, IDs, email/IP/phone patterns, attachment payloads, cards, knowledge snippets, URLs/query values, tool arguments/results, traces, and configured tenant terms. Never index raw content in plaintext.
11. Raw content is hidden by default. A viewer must have `AgentControl.TranscriptReader`, provide a reason, pass a recent-auth/step-up gate where supported, acknowledge sensitivity, and receive a short audited reveal session. Raw export is disabled by default and separately configured.
12. Add transcript browsing by environment, agent, date, channel, outcome, topic, error, and redaction state. Show lineage, batch completeness, retention deadline, source limitations, and whether content is redacted by Microsoft (for example SharePoint-backed answers).
13. Explicitly render unsupported/unavailable conditions: Microsoft 365 Copilot agents, Dataverse for Teams, developer environments, disabled transcript recording/download, absent Dataverse database/table, no Bot Transcript Viewer/custom app role, no application user, stale/deleted environment, no records, and provider retention deletion.
14. Add retention/hold/deletion jobs for raw and redacted data. The default source-side transcript bulk-delete job removes records older than about 30 days and Copilot Studio storage has separate retention; local policy must not claim it changes source retention. Local expiry must securely delete keys/data and leave minimal audit tombstones.
15. Never treat transcript-derived counts as official usage. They are privacy-governed conversation analytics with incomplete platform/environment coverage.

## Focused validation

- Adapter tests for delegated/application paths, trusted environment/next-link hosts, OData pagination/errors, throttling, conditional access, missing roles/table, unsupported environments, and malformed responses.
- Checkpoint tests for overlap, equal timestamps, late updates, restart, duplicates, deletion, partial pages, poison rows, and atomic advancement.
- Parser/reassembly tests for 1 MB splits, BatchId ordering/gaps/conflicts, 30-minute continuation, all documented activity/value types, enhanced node traces, Microsoft redaction, unknown schemas, and hostile JSON depth/count.
- Cryptography tests with known vectors, unique data keys, tamper detection, version-one data after rotation to version two, unavailable/deleted key state and recovery, ciphertext-only backup/restore, purge, and no plaintext in database/log/search index/temp files.
- Authorization tests for environment setup, metadata/content separation, reason/recent-auth gate, reveal timeout, exports, retention/hold, and immutable audit.
- UI/accessibility tests for permission remediation, opt-in setup, redacted default, raw reveal, retention, unsupported/no-data states, long content, mobile layout, and no sensitive screenshots.

## Aggregate validation

Run the global validation baseline. Use synthetic transcripts to exercise the full scheduled and delegated paths, restart, encrypted backup/restore, redaction, reveal audit, and purge. With authorization, perform a read-only live metadata/content probe on an approved test environment without writing content to completion evidence.

## Production continuation

Any uncertainty in role, encryption, redaction, environment trust, or retention keeps transcript content disabled; it does not stop the campaign. Metadata-only diagnostics may remain. Record exact containment and fix-forward evidence, and never lower privacy controls to make a demo pass.

## Scope guard

Do not mutate Dataverse transcript rows, source retention jobs, transcript tenant settings, bots, or environment security roles. Do not support unsupported Microsoft 365 Copilot transcripts. Do not deploy.

## Completion record

Create `plans/admin-poc-production/completions/11-dataverse-transcripts.md` with environment/auth mode, least-privilege role contract, encryption/redaction/retention evidence, unsupported states, live-probe status, and Phase 12 preconditions. Never include transcript content.

## Done conditions

- Delegated and application-user transcript paths are exact, environment-scoped, and capability-gated.
- Collection is idempotent, restart-safe, batch-aware, encrypted, redacted, and retention-controlled.
- Raw viewing/export is least-privileged, reason-gated, short-lived, and audited.
- Unsupported and missing-permission states are precise, and transcript analytics are never official usage.
