import asyncio
import io
import json
import os
import stat
import subprocess
import sys
import tarfile
import time
from pathlib import Path

import pytest
from conftest import protocol_client, tokens
from mcp.server.auth.middleware.bearer_auth import AuthenticatedUser
from mcp.server.auth.provider import AccessToken

from agent_control_mcp import recording
from agent_control_mcp.config import ConfigurationError, Settings
from agent_control_mcp.recording import MIB, RecordingError, RecordingStore


@pytest.fixture(autouse=True)
def recording_store(settings_env, tmp_path):
    root = tmp_path / "recordings"
    root.mkdir(mode=0o700)
    settings_env["MCP_RECORDING_STORAGE_PATH"] = str(root)
    return RecordingStore(root)


async def active(service):
    async with asyncio.timeout(5):
        while not service.recorder.window or not service.recorder.window.accepting:
            if service.recorder.failure:
                pytest.fail(service.recorder.failure)
            await asyncio.sleep(0.02)


async def stopped(store):
    async with asyncio.timeout(5):
        while True:
            status = await asyncio.to_thread(store.status)
            if status["status"] in {"stopped", "incomplete"}:
                return status
            await asyncio.sleep(0.02)


def events(store, identifier):
    directory = store.directory(identifier)
    return {
        path.stem: [json.loads(line) for line in path.read_text().splitlines()]
        for path in directory.glob("*.jsonl")
    }


def command(store, *args):
    return subprocess.run(
        [sys.executable, "-m", "agent_control_mcp.recording", *args],
        env={
            **os.environ,
            "MCP_RECORDING_STORAGE_PATH": str(store.root),
            "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src"),
        },
        capture_output=True,
        check=False,
    )


def test_cli_defaults_stop_and_private_export(recording_store):
    store = recording_store
    assert json.loads(command(store, "status").stdout) == {"status": "off"}
    started = command(store, "start")
    assert started.returncode == 0, started.stderr
    manifest = json.loads(started.stdout)
    assert manifest["sessionLimit"] == 100 * MIB
    assert manifest["totalLimit"] == 500 * MIB
    assert 1790 < manifest["deadline"] - time.time() <= 1800
    assert manifest["expiresAt"] - manifest["deadline"] == 86400
    assert command(store, "start").returncode == 2
    assert command(store, "export").returncode == 2
    assert command(store, "stop").returncode == 0
    exported = command(store, "export")
    assert exported.returncode == 0, exported.stderr
    with tarfile.open(fileobj=io.BytesIO(exported.stdout)) as archive:
        assert archive.getnames() == [manifest["id"] + "/manifest.json"]
        assert archive.getmembers()[0].mode == 0o600
    for path in [store.root, *store.root.iterdir(), *store.directory(manifest["id"]).iterdir()]:
        assert stat.S_IMODE(path.stat().st_mode) == (0o700 if path.is_dir() else 0o600)


async def test_real_authenticated_sessions_full_payload_and_protocol_errors(
    recording_store, browser, service, settings
):
    store = recording_store
    manifest = store.start(1800, 86400, 100 * MIB, 500 * MIB)
    await active(service)
    # OAuth happens inside the window but must not appear in session recordings.
    _, issued = await tokens(browser)
    first = await protocol_client(browser, issued["access_token"], client_name="First")
    second = await protocol_client(browser, issued["access_token"], client_name="Second")
    large = "business-data-" * 8000
    await asyncio.gather(
        first(
            "list_capabilities",
            meta={
                "com.agentcontrol/recording": {"conversationId": "external-transcript-123"},
                "business": large,
                "password": "never-retain-this-password",
                "echo": issued["access_token"],
            },
        ),
        second("list_capabilities"),
    )
    listed = await browser.post(
        "/mcp",
        headers=first.headers,
        json={
            "jsonrpc": "2.0",
            "id": 101,
            "method": "tools/list",
        },
    )
    for identifier, params in [
        (102, {"name": "not_a_real_tool", "arguments": {}}),
        (103, {"name": "capabilities", "arguments": {"request": {"action": "invalid-action"}}}),
    ]:
        response = await browser.post(
            "/mcp",
            headers=first.headers,
            json={
                "jsonrpc": "2.0",
                "id": identifier,
                "method": "tools/call",
                "params": params,
            },
        )
        assert response.status_code == 200
        assert response.json()["result"]["isError"]
    assert (
        await browser.post("/mcp", json={"jsonrpc": "2.0", "id": 99, "method": "tools/list"})
    ).status_code == 401
    store.stop()
    final = await stopped(store)
    assert final["complete"] is True
    streams = events(store, manifest["id"])
    assert len(streams) == 2
    assert final["capturedBytes"] == sum(
        path.stat().st_size for path in store.directory(manifest["id"]).glob("*.jsonl")
    )
    assert 86390 < final["expiresAt"] - time.time() <= 86400
    all_events = [event for stream in streams.values() for event in stream]
    assert len({event["sequence"] for event in all_events}) == len(all_events)
    for stream in streams.values():
        assert [event["sequence"] for event in stream] == sorted(
            event["sequence"] for event in stream
        )
        for request in [event for event in stream if event["event"] == "request"]:
            assert any(
                event["exchangeId"] == request["exchangeId"] and event["event"] == "response"
                for event in stream
            )
    serialized = json.dumps(all_events)
    assert issued["access_token"] not in serialized
    assert settings.client_secret not in serialized
    assert "never-retain-this-password" not in serialized
    assert first.headers["mcp-session-id"] not in serialized
    assert second.headers["mcp-session-id"] not in serialized
    assert "/authorize" not in serialized and "csrf_token" not in serialized
    captured = next(event for event in all_events if event.get("reportedConversationId"))
    assert captured["reportedConversationId"] == "external-transcript-123"
    assert captured["payload"]["params"]["_meta"]["business"] == large
    assert any(event.get("payload") == listed.json() for event in all_events)
    assert (
        len(
            [
                event
                for event in all_events
                if isinstance(event.get("payload"), dict) and event["payload"].get("id") == 102
            ]
        )
        == 2
    )
    catalog = store.read(store.directory(manifest["id"]) / "catalog.json")
    assert catalog["instructions"]
    assert catalog["serverInfo"]["version"] == "0.1.0"
    # Recorder's restricted operator snapshot is deliberately unprojected.
    # Actual per-caller wire discovery remains captured verbatim in events above.
    assert {tool["name"] for tool in catalog["tools"]} == {
        tool["name"] for tool in listed.json()["result"]["tools"]
    }
    before = final["events"]
    assert not (await first("list_capabilities")).get("isError")
    assert store.status()["events"] == before
    with tarfile.open(fileobj=io.BytesIO(command(store, "export").stdout)) as archive:
        assert len(archive.getmembers()) == 4


async def test_start_mid_session_and_automatic_deadline(recording_store, browser, service):
    _, issued = await tokens(browser)
    caller = await protocol_client(browser, issued["access_token"])
    manifest = recording_store.start(1, 86400, 100 * MIB, 500 * MIB)
    await active(service)
    assert not (await caller("list_capabilities")).get("isError")
    final = await stopped(recording_store)
    assert final["complete"] is True
    streams = events(recording_store, manifest["id"])
    assert len(streams) == 1
    requests = [event for event in next(iter(streams.values())) if event["event"] == "request"]
    assert len(requests) == 1 and requests[0]["payload"]["method"] == "tools/call"
    assert not (await caller("list_capabilities")).get("isError")


async def test_stop_during_snapshot_does_not_resurrect_the_old_window(
    recording_store, service, monkeypatch
):
    entered, released = asyncio.Event(), asyncio.Event()
    original = service.recorder.snapshot

    async def delayed():
        entered.set()
        await released.wait()
        return await original()

    monkeypatch.setattr(service.recorder, "snapshot", delayed)
    old = recording_store.start(1800, 86400, 100 * MIB, 500 * MIB)
    await asyncio.wait_for(entered.wait(), 5)
    recording_store.stop()
    new = recording_store.start(1800, 86400, 100 * MIB, 500 * MIB)
    released.set()
    await active(service)
    assert service.recorder.window.manifest["id"] == new["id"]
    previous = recording_store.read(recording_store.directory(old["id"]) / "manifest.json")
    assert previous["status"] == "stopped" and previous["events"] == 0
    assert not (recording_store.directory(old["id"]) / "catalog.json").exists()
    recording_store.stop()
    assert (await stopped(recording_store))["complete"]


async def test_stop_drains_inflight_without_blocking_tools(
    recording_store, browser, service, entra
):
    recording_store.start(1800, 86400, 100 * MIB, 500 * MIB)
    await active(service)
    _, issued = await tokens(browser)
    caller = await protocol_client(browser, issued["access_token"])
    entra.block_api = asyncio.Event()
    call = asyncio.create_task(caller("list_capabilities"))
    await asyncio.wait_for(entra.api_started.wait(), 5)
    recording_store.stop()
    await asyncio.sleep(0.4)
    assert recording_store.status()["status"] == "stopping"
    assert not call.done()
    entra.block_api.set()
    assert not (await call).get("isError")
    assert (await stopped(recording_store))["complete"] is True


async def test_session_limit_is_honest_and_does_not_break_execution(
    recording_store, browser, service
):
    recording_store.start(1800, 86400, 1500, 10 * MIB)
    await active(service)
    _, issued = await tokens(browser)
    caller = await protocol_client(browser, issued["access_token"])
    assert not (await caller("list_capabilities", meta={"data": "x" * 5000})).get("isError")
    final = await stopped(recording_store)
    assert final["status"] == "incomplete" and final["reason"] == "storage_limit"
    for path in recording_store.directory(final["id"]).glob("*.jsonl"):
        assert path.stat().st_size <= 1500
    assert not (await caller("list_capabilities")).get("isError")


async def test_storage_failure_is_not_a_tool_failure(
    recording_store, browser, service, monkeypatch
):
    recording_store.start(1800, 86400, 100 * MIB, 500 * MIB)
    await active(service)
    _, issued = await tokens(browser)
    caller = await protocol_client(browser, issued["access_token"])

    def failed(*args):
        raise OSError("synthetic disk full")

    monkeypatch.setattr(service.recorder, "persist_event", failed)
    assert not (await caller("list_capabilities")).get("isError")
    final = await stopped(recording_store)
    assert final["complete"] is False
    assert final["reason"] == "recording_storage_unavailable"
    assert not (await caller("list_capabilities")).get("isError")


async def test_total_size_budget_is_enforced(recording_store, browser, service):
    recording_store.start(1800, 86400, 2 * MIB, 2 * MIB)
    await active(service)
    _, issued = await tokens(browser)
    caller = await protocol_client(browser, issued["access_token"])
    for _ in range(12):
        assert not (await caller("list_capabilities", meta={"data": "x" * 200000})).get("isError")
        if recording_store.status()["status"] == "incomplete":
            break
    final = await stopped(recording_store)
    assert not final["complete"] and final["reason"] == "storage_limit"
    assert (
        sum(path.stat().st_size for path in recording_store.root.rglob("*") if path.is_file())
        <= 2 * MIB
    )


def test_corrupt_control_is_explicit(recording_store):
    recording_store.write(recording_store.root / "control.json", {"enabled": True})
    with pytest.raises(RecordingError, match="control fields"):
        recording_store.status()
    assert command(recording_store, "status").returncode == 2


async def test_queue_overflow_does_not_affect_tools(recording_store, browser, service, monkeypatch):
    recording_store.start(1800, 86400, 100 * MIB, 500 * MIB)
    await active(service)
    _, issued = await tokens(browser)
    caller = await protocol_client(browser, issued["access_token"])
    monkeypatch.setattr(recording, "MAX_QUEUED", 1)
    assert not (await caller("list_capabilities")).get("isError")
    final = await stopped(recording_store)
    assert final["complete"] is False and final["reason"] == "event_or_queue_limit"
    assert not (await caller("list_capabilities")).get("isError")


def test_retention_removes_only_valid_expired_recordings(recording_store):
    store = recording_store
    manifest = store.start(1, 1, MIB, 10 * MIB)
    store.stop()
    directory = store.directory(manifest["id"])
    manifest = store.read(directory / "manifest.json")
    manifest["expiresAt"] = time.time() - 1
    store.write(directory / "manifest.json", manifest)
    assert store.cleanup() == 0
    assert not directory.exists()
    assert store.status() == {"status": "off"}


def test_private_storage_and_export_reject_links(recording_store, tmp_path):
    store = recording_store
    store.start(1800, 86400, MIB, 10 * MIB)
    store.stop()
    outside = tmp_path / "outside"
    outside.write_text("not a recording")
    outside.chmod(0o600)
    (store.directory(store.control()["id"]) / ("a" * 64 + ".jsonl")).symlink_to(outside)
    with pytest.raises(OSError):
        store.export(None, io.BytesIO())
    with pytest.raises(RecordingError):
        store.directory("../../outside")
    store.root.chmod(0o755)
    with pytest.raises(RecordingError):
        store.status()
    assert outside.read_text() == "not a recording"


def test_storage_cannot_overlap_oauth(settings_env):
    settings_env["MCP_RECORDING_STORAGE_PATH"] = (
        settings_env["MCP_OAUTH_STORAGE_PATH"] + "/recordings"
    )
    with pytest.raises(ConfigurationError, match="separate"):
        Settings.from_env(settings_env)


def test_redaction_preserves_full_nonsecret_data():
    raw = {
        "business": "x" * 20000,
        "access_token": "opaque",
        "nested": {"password": "private"},
        "text": '{"access_token":"opaque","business":"kept"}',
        "note": "password=secret; Bearer opaque-value",
    }
    cleaned = recording.sanitize(raw, ("opaque-value",))
    assert cleaned["business"] == raw["business"]
    assert cleaned["access_token"] == "[redacted]"
    assert cleaned["nested"]["password"] == "[redacted]"
    assert "opaque" not in cleaned["text"] and "kept" in cleaned["text"]
    assert "secret" not in cleaned["note"] and "opaque-value" not in cleaned["note"]


async def test_sse_frames_and_drain_timeout_are_explicit(recording_store, monkeypatch):
    async def snapshot():
        return {"serverInfo": {}, "tools": [], "instructions": "synthetic"}

    recorder = recording.Recorder(recording_store.root, (), snapshot)
    recording_store.start(1800, 86400, MIB, 10 * MIB)
    await recorder.start()
    async with asyncio.timeout(3):
        while recorder.window is None:  # noqa: ASYNC110 - observing the cross-process control contract
            await asyncio.sleep(0.02)
    scope = {
        "type": "http",
        "path": "/mcp",
        "method": "GET",
        "headers": [],
        "user": AuthenticatedUser(
            AccessToken(token="synthetic", client_id="client", scopes=[], claims={"oid": "user"})
        ),
    }
    capture = recorder.begin(scope, "session", b"", time.monotonic())
    buffer = bytearray(
        b'event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/test"}\r\n\r\n'
    )
    recording.RecordingMiddleware(None, recorder, "/mcp").sse_events(capture, buffer, final=True)
    assert not buffer
    monkeypatch.setattr(recording, "DRAIN_SECONDS", 0.1)
    recording_store.stop()
    final = await stopped(recording_store)
    assert final["complete"] is False and final["reason"] == "inflight_at_drain_timeout"
    assert any(
        event["event"] == "server_message"
        for stream in events(recording_store, final["id"]).values()
        for event in stream
    )
    recorder.finish(capture, 200, b"", False)
    await recorder.close()


@pytest.mark.parametrize("first_separator", [b"\n", b"\r\n", b"\r"])
@pytest.mark.parametrize("second_separator", [b"\n", b"\r\n", b"\r"])
@pytest.mark.parametrize("fragmented", [False, True])
async def test_sse_middleware_preserves_frames_across_line_endings(
    recording_store, first_separator, second_separator, fragmented
):
    async def snapshot():
        return {}

    recorder = recording.Recorder(None, (), snapshot)
    recorder.window = recording.Window(recording_store.start(1800, 86400, MIB, 10 * MIB))
    documents = [
        {"jsonrpc": "2.0", "method": "notifications/first"},
        {"jsonrpc": "2.0", "method": "notifications/second"},
    ]
    body = b"".join(
        b": keepalive"
        + separator * 2
        + b"event: message"
        + separator
        + b"data: "
        + json.dumps(document).encode()
        + separator * 2
        for document, separator in zip(documents, [first_separator, second_separator], strict=True)
    )
    chunks = [body[index : index + 1] for index in range(len(body))] if fragmented else [body]
    sent = []
    scope = {
        "type": "http",
        "path": "/mcp",
        "method": "GET",
        "headers": [(b"mcp-session-id", b"session")],
        "user": AuthenticatedUser(
            AccessToken(token="synthetic", client_id="client", scopes=[], claims={"oid": "user"})
        ),
    }

    async def app(scope, receive, send):
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"content-type", b"text/event-stream")],
            }
        )
        for index, chunk in enumerate(chunks):
            await send(
                {
                    "type": "http.response.body",
                    "body": chunk,
                    "more_body": index < len(chunks) - 1,
                }
            )

    async def receive():
        return {"type": "http.request", "body": b""}

    async def send(message):
        sent.append(message)

    await recording.RecordingMiddleware(app, recorder, "/mcp")(scope, receive, send)
    captured = [json.loads(recorder.queue.get_nowait()[2]) for _ in range(recorder.queue.qsize())]
    assert [event["payload"] for event in captured if event["event"] == "server_message"] == (
        documents
    )
    assert captured[-1]["event"] == "response" and captured[-1]["payload"] is None
    assert not captured[-1]["interrupted"]
    assert recorder.window.manifest["complete"]
    assert b"".join(message["body"] for message in sent[1:]) == body
