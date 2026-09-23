# 03 - User-to-agent responsibility relationships

Reasoning posture: extra-high. Read roadmap and phases 01-02 completion records.

## Outcome

Users is a second meaningful entry point: the application distinguishes agents a person owns/created/last modified from agents that official reports show they used, and opens the correct agent context.

## Implementation

1. Trace current Users directory identity, report-user identity and detail/navigation surfaces. Use exact validated tenant-scoped Entra object IDs from saved directory/agent ownership fields for responsibility. Do not join on names, guessed emails, report GUID fragments or usage.
2. Add a bounded authorized saved-data projection of related canonical agents with separately labelled owner, creator and last-modifier relationships. Prefer existing unified source/revision/scope helpers over duplicated identity resolution. Preserve source-only agents.
3. Surface responsibility-related agents alongside, not merged into, report-observed usage. Report-only or unresolved users receive an explicit unavailable state instead of guessed responsibility.
4. Make agent responsible-person navigation lead to the corresponding Users context when an exact directory identity exists. Where it does not, retain the readable identity and explain why navigation is unavailable. Do not invent owner reassignment or maintainer controls.
5. User-to-agent actions must open the current canonical agent and appropriate tab; stale/missing identities fail explicitly. Clear selection/request state on principal or selected-user changes; preserve abort/error/retry patterns.
6. Keep licensing, reported activity, source filters, export semantics, and access-role behavior unchanged except where directly implicated. Ensure ownership does not grant controls or create usage counts.
7. Update current docs and tests for the complete navigation/projection contracts.

## Verification and handoff

Test tenant/principal isolation, exact-ID matching, same-name/different-ID negatives, role distinction, shared responsibility, report-only users, PP-only agents, pagination, stale selection, source unavailable and permission failures. Run focused backend/frontend tests plus build/typecheck/lint. Add browser coverage for both navigation directions and separation of responsibility from usage.

Create `completions/03-user-agent-responsibility.md` with source/route/type contracts and tested behaviors. No placeholder tab or deferred actionable implementation is acceptable.
