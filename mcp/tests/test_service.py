import asyncio
import json
from contextlib import asynccontextmanager

import httpx2
import pytest
from starlette.responses import JSONResponse

from agent_control_mcp.service import ProtocolBoundary, build_service


@pytest.mark.parametrize(
    ("upload_seconds", "application_seconds", "status"),
    [(31, 0, 408), (0, 31, 504), (20, 20, 504), (20, 5, 200)],
)
async def test_oauth_upload_and_application_share_one_deadline(
    settings, monkeypatch, upload_seconds, application_seconds, status
):
    anchor = asyncio.get_running_loop().time()
    elapsed = 0
    active_deadline = None

    @asynccontextmanager
    async def budget(deadline):
        nonlocal active_deadline
        previous = active_deadline
        active_deadline = deadline
        try:
            yield
        finally:
            active_deadline = previous

    def advance(seconds):
        nonlocal elapsed
        elapsed += seconds
        if active_deadline is not None and elapsed >= active_deadline:
            raise TimeoutError

    monkeypatch.setattr(asyncio, "timeout", lambda seconds: budget(elapsed + seconds))
    monkeypatch.setattr(asyncio, "timeout_at", lambda deadline: budget(deadline - anchor))

    async def application(scope, receive, send):
        advance(application_seconds)
        await JSONResponse({"status": "ok"})(scope, receive, send)

    async def receive():
        advance(upload_seconds)
        return {"type": "http.request", "body": b"{}", "more_body": False}

    messages = []

    async def send(message):
        messages.append(message)

    await ProtocolBoundary(application, settings)(
        {
            "type": "http",
            "method": "POST",
            "path": "/register",
            "headers": [],
            "query_string": b"",
        },
        receive,
        send,
    )
    assert messages[0]["status"] == status
    body = json.loads(messages[1]["body"])
    assert body == (
        {"status": "ok"}
        if status == 200
        else {"error": "request_deadline" if status == 408 else "temporarily_unavailable"}
    )
    if status == 504:
        assert (b"cache-control", b"no-store") in messages[0]["headers"]


@pytest.mark.parametrize("failed_resource", ["recorder", "store"])
@pytest.mark.parametrize("error_type", [OSError, asyncio.CancelledError])
async def test_lifespan_closes_remaining_resources_after_cleanup_failure(
    settings, entra, monkeypatch, failed_resource, error_type
):
    runtime = build_service(settings, transport=httpx2.MockTransport(entra.route))
    closed = []
    close_http = runtime.http.aclose

    async def close_recorder():
        closed.append("recorder")
        if failed_resource == "recorder":
            raise error_type("Synthetic cleanup failure.")

    async def close_store():
        closed.append("store")
        if failed_resource == "store":
            raise error_type("Synthetic cleanup failure.")

    async def close_client():
        closed.append("http")
        await close_http()

    monkeypatch.setattr(runtime.recorder, "close", close_recorder)
    monkeypatch.setattr(runtime.store, "aclose", close_store)
    monkeypatch.setattr(runtime.http, "aclose", close_client)
    try:
        with pytest.raises(error_type, match="Synthetic cleanup failure"):
            async with runtime.mcp._lifespan(runtime.mcp) as state:
                assert state == {"api": runtime.api}
        assert closed == ["recorder", "store", "http"]
        assert runtime.http.is_closed
    finally:
        await close_http()


@pytest.mark.parametrize("failed_resource", ["store", "recorder"])
async def test_lifespan_cleans_up_partial_startup(settings, entra, monkeypatch, failed_resource):
    runtime = build_service(settings, transport=httpx2.MockTransport(entra.route))
    closed = []
    close_http = runtime.http.aclose

    async def fail_start():
        raise OSError("Synthetic startup failure.")

    async def close_recorder():
        closed.append("recorder")

    async def close_store():
        closed.append("store")

    async def close_client():
        closed.append("http")
        await close_http()

    monkeypatch.setattr(getattr(runtime, failed_resource), "start", fail_start)
    monkeypatch.setattr(runtime.recorder, "close", close_recorder)
    monkeypatch.setattr(runtime.store, "aclose", close_store)
    monkeypatch.setattr(runtime.http, "aclose", close_client)
    try:
        with pytest.raises(OSError, match="Synthetic startup failure"):
            async with runtime.mcp._lifespan(runtime.mcp):
                pytest.fail("A failed startup cannot yield a ready service.")
        assert closed == ["recorder", "store", "http"]
        assert runtime.http.is_closed
    finally:
        await close_http()
