# MCP session flight recorder

The optional flight recorder captures authenticated MCP protocol traffic for
diagnosing tool selection, repeated calls, errors, latency and response handling.
Recording is **off by default**. Starting or stopping it does not restart MCP,
change permissions, or enable/disable application features.

## Capture boundary

- One append-only JSONL file per authenticated MCP session and client/user owner.
  Filenames are opaque fingerprints, not usable session handles.
- Full JSON-RPC business requests and responses, including tool definitions,
  arguments, structured/text results and protocol/tool errors.
- Server-sent MCP messages are separate `server_message` events. SSE keepalive
  comments are not business protocol events. CRLF, LF and CR frame boundaries
  are preserved in wire order, including when boundaries span response chunks.
- UTC timestamps, an ordered recording-wide sequence, an exchange ID matching
  request/response events, HTTP status and elapsed milliseconds.
- Each recording has a manifest plus a snapshot of the server version,
  instructions and tool catalog.
- OAuth routes, authentication headers, cookies and raw MCP session handles are
  excluded. Known runtime secrets, token-like strings and credential-named
  fields are redacted, including credential fields in JSON text results.

This is **not an agent conversation transcript**. MCP cannot observe user
messages that never reach the server, internal agent reasoning, or final answers.
A client can reuse one MCP session for several conversations or create several
sessions for one conversation. Invalid requests without an assigned or supplied
MCP session ID cannot be grouped and are not recorded.

Full business payloads can contain personal and confidential organizational
data. Redaction is not a general-purpose data-loss-prevention system: an
unlabelled secret embedded in arbitrary business text cannot reliably be
identified. Do not send secrets as tool arguments. Restrict recording access and
handle exports as sensitive diagnostic data.

## Docker deployment

The local/VPS Compose MCP profile mounts the separate `mcp-recordings` volume at
`/var/lib/agent-control-mcp/recordings`, configured by
`MCP_RECORDING_STORAGE_PATH`. It is not OAuth storage, database storage,
administrative audit, or ordinary Docker logs.
Local recording and OAuth directories must be disjoint after resolving symbolic
links, including links in parent directories; neither can contain the other.

The normal local deployment scripts initialize its ownership automatically.
For a manually managed Compose installation, initialize the new volume before
recreating MCP. Substitute the actual project, immutable MCP image and existing
non-root MCP UID/GID:

```bash
docker volume create \
  --label com.docker.compose.project=seha \
  --label com.docker.compose.volume=mcp-recordings \
  --label io.agent-control.purpose=mcp-session-recordings \
  seha_mcp-recordings

docker run --rm --network none --user 0:0 --read-only \
  --cap-drop ALL --cap-add CHOWN --cap-add FOWNER \
  --security-opt no-new-privileges \
  --mount type=volume,source=seha_mcp-recordings,target=/var/lib/agent-control-mcp/recordings,volume-nocopy \
  --env MCP_RECORDING_STORAGE_PATH=/var/lib/agent-control-mcp/recordings \
  --entrypoint python YOUR_MCP_IMAGE \
  -m agent_control_mcp.recording initialize YOUR_MCP_UID YOUR_MCP_GID
```

Initialization changes only an empty root-owned directory. It rejects foreign
or incorrectly protected existing data instead of silently repairing ownership.
Runtime directories are `0700`; files are `0600`. The regular MCP container
remains non-root with a read-only root filesystem.

The Azure Blob OAuth profile does not automatically provide recording storage
or Docker-exec access. This feature is verified for local/VPS Docker. Do not put
recordings in the OAuth Blob or claim Azure diagnostic persistence without
separately provisioning protected storage and an operator command channel.
Azure OAuth uses Blob storage and has no local OAuth directory to overlap.
Without `MCP_RECORDING_STORAGE_PATH`, recording is unavailable and normal MCP
operation is unchanged.

## Operator commands

Run commands on the Docker host. Replace the container name if necessary:

```bash
MCP_CONTAINER=seha-agent-control-mcp-1

docker exec "$MCP_CONTAINER" python -m agent_control_mcp.recording start
docker exec "$MCP_CONTAINER" python -m agent_control_mcp.recording status

# Reproduce the agent issue, keeping the agent-side transcript.

docker exec "$MCP_CONTAINER" python -m agent_control_mcp.recording stop
docker exec "$MCP_CONTAINER" python -m agent_control_mcp.recording status
```

`start` reports `armed`; the running server normally reports `active` within a
second after capturing its catalog. Start reproducing after status is `active`.
This is diagnostic readiness, not application authorization. Existing
authenticated sessions are included from their next request; initialization
that happened before recording is not reconstructed.

`stop` requests a cutoff, normally observed within a second. After the server
reports `stopping` or a finalized status it no longer admits new exchanges.
Admitted responses can finish for up to
65 seconds. Wait for `stopped` or `incomplete` before exporting. An indefinitely
open SSE connection can cause `inflight_at_drain_timeout`; it is not terminated
by the recorder.

Defaults:

| Setting | Default |
| --- | --- |
| Capture window | 1,800 seconds / 30 minutes |
| Retention after finalization | 86,400 seconds / 24 hours |
| Per-session JSONL cap | 100 MiB |
| Retained recording storage cap | 500 MiB |

Example override:

```bash
docker exec "$MCP_CONTAINER" python -m agent_control_mcp.recording start \
  --duration 600 --retention 86400 --session-mib 100 --total-mib 500
```

There is one recording window per server storage directory. Another `start`
while armed/active is rejected. Expired finalized recordings are removed
automatically while the server runs, checked approximately once per minute,
and before starting a new recording. Unexpired recordings are not deleted to
make room. The total budget reserves space for catalog/manifest bookkeeping;
recording can stop before reaching the literal cap.

Additional bounds: 8 MiB per encoded event/response buffer, 16 MiB queued
event data, 128 queued events, and 256 session streams per window. Exceeding a
bound stops capture and marks it incomplete; it does not truncate a result and
claim a complete capture, nor fail the underlying tool.

## Export

Export writes a gzip-compressed tar archive to stdout; it creates no export
copy inside the container. Do not allocate a TTY or redirect stderr into it.

```bash
umask 077
docker exec "$MCP_CONTAINER" python -m agent_control_mcp.recording export \
  > mcp-recording.tar.gz

# Optional: export an earlier, retained recording using its exact manifest ID.
docker exec "$MCP_CONTAINER" python -m agent_control_mcp.recording export \
  --id RECORDING_ID > earlier-mcp-recording.tar.gz

tar -tzf mcp-recording.tar.gz
```

Check the exit status before using an archive. Active/armed recordings cannot
be exported; missing/expired IDs and invalid storage produce explicit failures.
The archive contains `RECORDING_ID/manifest.json`, `catalog.json` and session
JSONL files. An armed recording stopped before activation has only a manifest.
Host exports are **not** covered by server retention; protect and delete them
according to your organization's diagnostic-data policy.

`complete: true` means admitted exchanges were captured without a known gap,
not that the complete AI conversation was recorded. Check `status`, `reason`,
`pendingRequests`, `lastUpdatedAt` and the capture times. Storage/encoding/queue
errors or interrupted exchanges produce `complete: false` and safe error logs.
Abrupt process termination can leave the last persisted status active; the next
server start marks that unfinished window incomplete rather than resuming it.
If storage is no longer writable, even the status update can fail: Docker logs
explicitly report this. Repair storage before recording again and restart MCP
if its recorder worker has reported itself unavailable.

## Optional external-conversation correlation

A client that knows its chat ID can send the following MCP tool-call metadata;
it is never a required tool argument:

```json
{
  "_meta": {
    "com.agentcontrol/recording": {
      "conversationId": "client-provided-chat-id"
    }
  }
}
```

The recorder copies a printable ID of 1-256 characters into
`reportedConversationId`. It is client-reported, not authenticated conversation
ownership. No ID is invented when absent. Keep the ID non-secret and use it
with UTC timestamps and the agent-side transcript to correlate sessions.
Recording metadata does not modify the separate `com.agentcontrol/origin`
administrative-audit contract.
