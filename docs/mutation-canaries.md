# Optional mutation canaries

For administrators and operators who choose to test one provider change and its
exact restoration on a dedicated nonproduction target. These APIs perform real
writes; they are not read-only permission checks.

**Canaries are optional diagnostics, not application authorization.** Normal
deployment, sign-in, automatic read-only synchronization and supported package
or quarantine controls require no canary, release qualification or extra approval
process. For ordinary changes, use **Agents > Manage** and review the exact
target, preview and confirmation. Current app roles, delegated provider
permissions, licensing, prestate and readback checks still apply.

## Requirements

- Choose a dedicated test package or Studio agent whose interruption will not
  affect business operations. Arrange a restoration owner and monitoring window.
- Use `AgentControl.Admin` accounts. Each cycle needs two unused approval
  **records**, one per direction. The same Admin may create both; the executing
  Admin principal must differ from every approving principal.
- Provider reads and writes need current delegated authority: package changes use
  `CopilotPackages.ReadWrite.All` with tenant admin consent and a Microsoft
  Agent 365 license; quarantine uses `CopilotStudio.AdminActions.Invoke` and the
  required provider administrator role, including for direct status reads.
  See [permissions and provider roles](user-roles-and-permissions.md#app-registration-permissions).
- Record the tenant, exact target, original state, inverse transition, actors,
  approval IDs, returned revisions/expiry, job IDs and final observed state.
  Create approvals shortly before execution: unused approvals expire after
  30 minutes. Never record provider tokens.

Canary approval/execution requires browser sessions, not MCP or bearer tokens.
Use an authenticated same-origin session. Read `csrfToken` from `GET /api/me`;
every POST below requires `Content-Type: application/json` and
`X-CSRF-Token: <current session csrfToken>`. Each actor uses their own session.
Provider tokens are acquired by the application, never supplied in request bodies.

## Package canary

1. Read the dedicated package's current details from Graph and capture its
   explicit `isBlocked` value. Package IDs are opaque: preserve case and whitespace.
2. As the approving Admin, create the original approval. This example starts
   with an unblocked package:

   ```http
   POST /api/agents/mutation-canaries

   {
     "action": "block",
     "targetId": "<exact test package ID>",
     "prestate": { "kind": "block", "isBlocked": false },
     "poststate": { "kind": "block", "isBlocked": true }
   }
   ```

3. Save the returned `id`. Create the inverse through the same endpoint with
   `"action": "unblock"`, the same exact `targetId`, and exchanged
   `prestate` / `poststate`; save its `id` too.
   Both creation requests return HTTP 201. Only `action`, `targetId`, `prestate`
   and `poststate` are accepted; the server supplies revisions and restoration
   criteria. If initially blocked, reverse the actions and boolean states.

4. As a different Admin principal, execute the pair **once**:

   ```http
   POST /api/agents/mutation-canaries/<original-approval-id>/execute

   {
     "confirmed": true,
     "restorationApprovalId": "<inverse-approval-id>"
   }
   ```

The application runs a separate durable job for each direction. It checks current
authority and prestate, records dispatch, writes once and verifies provider
readback. Restoration is submitted only after the original direction succeeds.
HTTP acceptance alone is not success. A fully verified response has
`status: "qualified"` and `jobs.originalId` / `jobs.restorationId`; this records
diagnostic evidence only, not permission for later changes.

### Access changes

Use the same approval and execution endpoints with `update-availability` or
`update-installation`. Both directions use the **same action** with exchanged
prestate/poststate. Each state contains exactly:

```json
{
  "kind": "access",
  "availableTo": "none",
  "deployedTo": "none",
  "allowedUsersAndGroups": [],
  "acquireUsersAndGroups": []
}
```

Replace those values with the exact observed and intended states. Change only
availability (`availableTo` / `allowedUsersAndGroups`) or installation
(`deployedTo` / `acquireUsersAndGroups`), never both or neither.

- In both directions, the selected setting must be `none` with an empty
  collection, or `some` with 1–500 typed native directory IDs:
  `{ "resourceType": "user" | "group", "resourceId": "<directory GUID>" }`.
- The untouched setting must also be writable: `none` with no principals or
  `some` with principals. Preserve its exact opaque provider IDs; do not convert
  them to caller-entered directory assignments. An untouched `all` setting,
  inactive entries under `none`, or an empty `some` collection cannot be preserved
  by the collection-only PATCH and are rejected.
- Both collections are sent and verified. There is no provider conditional-write
  protection here: an external change after the final pre-read can be overwritten.
  Keep other administrators from changing the test target during the cycle.
- Reassignment is not supported by this canary workflow.

## Copilot Studio quarantine canary

Quarantine and package blocking are different effects. Do not use package
blocking as quarantine restoration.

1. Select the exact native Studio resource from current tenant inventory. Record
   its `snapshotId`, native resource ID, environment and bot IDs. Each actor must
   resolve the same exact target from current inventory; snapshot UUIDs may be
   shared, but actor-bound selections and provider authorization may not.
2. Read current provider status, URL-encoding the query values:

   ```http
   GET /api/quarantine/status?snapshotId=<snapshot-uuid>&nativeId=<encoded-native-id>&force=true
   ```

   Capture `direct.isBotQuarantined` and the exact `direct.providerUpdatedAt`
   string, not inventory state or a reformatted timestamp. The client uses
   `api-version=1` without fallback. If Microsoft rejects the target, role,
   consent or API availability, resolve that specific provider limitation;
   local fixtures or package canary evidence do not establish quarantine access.

3. As the approving Admin, create the original approval. For an initially
   non-quarantined bot:

   ```http
   POST /api/quarantine/canary-approvals

   {
     "action": "quarantine",
     "snapshotId": "<current inventory snapshot UUID>",
     "nativeId": "<exact native resource ID>",
     "prestate": false,
     "prestateProviderUpdatedAt": "<exact direct.providerUpdatedAt>",
     "poststate": true
   }
   ```

4. Save the returned `id`. Create the inverse through the same endpoint with
   `"action": "unquarantine"`, `"prestate": true`, `"poststate": false` and
   `"prestateProviderUpdatedAt": null`, keeping the exact target. These six
   fields are the only accepted fields; creation returns HTTP 201.
   If initially quarantined, reverse the actions and booleans. Always leave the
   inverse timestamp `null`: the application binds it to the original direction's
   verified provider readback.
5. As the distinct executing Admin, execute **once**, within the approval window:

   ```http
   POST /api/quarantine/canary-approvals/<original-approval-id>/execute

   {
     "confirmed": true,
     "restorationApprovalId": "<inverse-approval-id>"
   }
   ```

Each direction requires exact state/timestamp prechecks and verified readback
with a changed provider timestamp. These checks cannot prevent an external race
after the final pre-read; coordinate with other administrators. The timestamp is
provider-owned evidence, not a field to restore or caller-predict. Restoration
runs only after the original direction is verified. Full success returns
`qualification.qualified` as `true` and full job objects at
`jobs.original` / `jobs.restoration`.

## Failure handling

- Stop on changed prestate/timestamp, lost authority, expired approval, timeout,
  process interruption or unverified readback. A sent but unverified write is
  inconclusive, not proof that nothing changed. Missing or unfinished job results
  also do not prove that no write occurred.
- **Never rerun a claimed canary `/execute` after an uncertain response.** Logout
  or a replacement sign-in cannot resume its old cycle. Canary jobs do not
  support ordinary resume; cancel abandoned unsent work and inspect sent outcomes.
- Recover job IDs and inspect results using the executing account:

  | Purpose | Package | Studio quarantine |
  | --- | --- | --- |
  | List jobs | `GET /api/agents/bulk-jobs` | `GET /api/quarantine/jobs` |
  | Read job | `GET /api/agents/bulk-jobs/{id}` | `GET /api/quarantine/jobs/{id}` |
  | Read item evidence | `GET /api/agents/bulk-jobs/{id}/items` | Job response `results` |
  | Cancel unfinished work | `POST /api/agents/bulk-jobs/{id}/cancel` | `POST /api/quarantine/jobs/{id}/cancel` |
  | Reconcile sent work | `POST /api/agents/bulk-jobs/{id}/reconcile` | `POST /api/quarantine/jobs/{id}/reconcile` |

  Use `{}` for cancellation/reconciliation bodies. Reconciliation requires
  current Admin/delegated authority and performs provider reads only; it neither
  replays the write nor dispatches restoration. Studio approval/job associations
  are also available from `GET /api/quarantine/canary-approvals`.
- Do not overwrite an external change or create another operation while sent
  work remains unresolved. Escalate to the restoration owner, establish the exact
  provider state and plan a fresh, explicitly confirmed recovery if needed.
  Do not assume restoration occurred because the request ended or a job was
  cancelled. Keep the test target out of business use until its final state is known.

Source contracts: [package routes](../backend/src/routes/agents.ts),
[package state validation](../backend/src/db/packageMutationQualifications.ts),
[Studio routes](../backend/src/routes/copilotStudioQuarantine.ts) and
[Studio cycle execution](../backend/src/services/copilotStudioQuarantineCanaries.ts).
