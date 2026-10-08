# Optional mutation canaries

Agent Control package and quarantine changes do not require a canary. An
authorized Admin can perform a supported change after reviewing the exact target
and confirmation.

Canaries are optional production validation exercises for organizations that
require separate approval and verified restoration.

## Requirements

- A dedicated, approved test target
- Two Admin approvals for exact opposite states
- A third Admin account to execute the cycle
- Current provider permissions and licensing
- A maintenance window and restoration owner
- Monitoring until both the change and restoration are verified

Do not use production user targets or an agent whose interruption would affect
business operations.

## Package canary

For a block/unblock cycle:

1. Record and verify the package's current state.
2. Create an approval for the intended change.
3. Create a separate approval for the exact inverse change.
4. Use a different Admin account to execute the pair.
5. Verify provider readback after the first change.
6. Restore the original state and verify provider readback again.
7. Record the job IDs, actors, timestamps, target, and final state.

Access-assignment canaries follow the same process and must preserve the complete
reviewed assignment state.

## Copilot Studio quarantine canary

Use a dedicated Copilot Studio agent in an approved environment.

1. Verify that the agent is not quarantined.
2. Approve quarantine and restore as separate exact actions.
3. Execute quarantine with the approved Admin account.
4. Verify the provider reports the quarantined state.
5. Restore the agent.
6. Verify the provider reports the original state.

## Failure handling

- Stop if the current state differs from the approved prestate.
- Do not send the inverse action until the first action has verified readback.
- Treat an accepted write without verified readback as inconclusive.
- Do not automatically repeat an inconclusive write.
- Escalate to the restoration owner and inspect provider state directly.
- Keep the target unavailable until its final state is known.

Canary evidence does not grant permissions or make future provider operations
safe. Every operation still performs current authorization and target checks.
