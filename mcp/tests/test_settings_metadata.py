import asyncio
import json
from pathlib import Path

import httpx2 as httpx
import pytest
from conftest import tokens
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.types import PaginatedRequestParams
from starlette.types import Receive, Scope, Send

from agent_control_mcp.config import ConfigurationError, Settings, checked_url
from agent_control_mcp.service import build_service

HEADER = "X-Agent-Control-Mcp-Metadata-Token"


async def test_same_instance_complete_wire_metadata(browser, service, entra, record_property):
    _, issued = await tokens(browser)
    browser.headers["Authorization"] = "Bearer " + issued["access_token"]
    async with streamable_http_client("https://mcp.example.test/mcp", http_client=browser) as (
        read,
        write,
    ):
        async with ClientSession(read, write) as session:
            initialized = await session.initialize()
            tools = []
            cursor = None
            while True:
                page = await session.list_tools(params=PaginatedRequestParams(cursor=cursor))
                tools.extend(page.tools)
                cursor = page.next_cursor
                if cursor is None:
                    break
    response = await browser.get(
        "/internal/mcp-metadata", headers={HEADER: service.api.settings.metadata_key.decode()}
    )
    assert response.status_code == 200
    metadata = response.json()
    assert metadata["serverInfo"] == initialized.server_info.model_dump(
        mode="json", by_alias=True, exclude_none=True
    )
    assert metadata["instructions"] == initialized.instructions
    assert metadata["tools"] == [
        tool.model_dump(mode="json", by_alias=True, exclude_none=True) for tool in tools
    ]
    discovery = {"initialize": initialized.model_dump(
        mode="json", by_alias=True, exclude_none=True
    ), "tools": metadata["tools"]}
    record_property("metadata_utf8_bytes", len(response.content))
    record_property("discovery_utf8_bytes", len(json.dumps(
        discovery, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")))
    record_property("public_tools", len(tools))
    record_property("instructions_words", len(metadata["instructions"].split()))
    assert len(metadata["tools"]) == 50
    assert len(response.content) < 4 * 1024 * 1024
    assert metadata["storageReady"] is True
    assert response.headers["cache-control"] == "no-store"
    assert not entra.api_calls


async def test_metadata_authority_is_independent(browser, service, entra):
    key = service.api.settings.metadata_key.decode()
    for headers in (
        {}, {HEADER: "wrong"}, {HEADER: entra.token()}, {"Authorization": f"Bearer {key}"}
    ):
        response = await browser.get("/internal/mcp-metadata", headers=headers)
        assert response.status_code == 401
        assert key not in response.text
    response = await browser.post("/mcp", headers={"Authorization": f"Bearer {key}"}, json={})
    assert response.status_code == 401
    assert not entra.api_calls


@pytest.mark.parametrize("path", ["/internal/mcp-metadata", "/mcp"])
async def test_private_transport_preserves_public_host_and_origin_protection(
    service, entra, path
):
    async def bound_server(scope: Scope, receive: Receive, send: Send) -> None:
        # ASGITransport otherwise infers the server bind address from the request Host.
        scope["server"] = ("0.0.0.0", 8000)
        await service.app(scope, receive, send)

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=bound_server)) as client:
        headers = {HEADER: service.api.settings.metadata_key.decode()}
        method = "GET" if path == "/internal/mcp-metadata" else "POST"
        url = f"http://mcp:8000{path}"
        assert (await client.request(method, url, headers=headers)).status_code == 421
        headers["Host"] = "mcp.example.test"
        response = await client.request(method, url, headers=headers)
        assert response.status_code == (200 if method == "GET" else 401)
        if method == "GET":
            assert len(response.json()["tools"]) == 50
        headers["Origin"] = "https://untrusted.example.invalid"
        assert (await client.request(method, url, headers=headers)).status_code == 403
    assert not entra.api_calls


async def test_metadata_observes_readiness_without_oauth_record_reads_or_writes(
    browser, service, monkeypatch
):
    async def forbidden(*args, **kwargs):
        raise AssertionError("Metadata must not read or write OAuth records.")

    for name in ("get", "put", "delete", "check"):
        monkeypatch.setattr(service.store, name, forbidden)
    headers = {HEADER: service.api.settings.metadata_key.decode()}
    response = await browser.get("/internal/mcp-metadata", headers=headers)
    assert response.status_code == 200 and response.json()["storageReady"] is True
    service.store._ready = False
    response = await browser.get("/internal/mcp-metadata", headers=headers)
    assert response.status_code == 200 and response.json()["storageReady"] is False


@pytest.mark.parametrize("fails", [False, True])
async def test_pending_probe_preserves_last_completed_readiness(
    browser, service, monkeypatch, fails
):
    entered, release = asyncio.Event(), asyncio.Event()
    cull = service.store.files.cull

    async def held_probe():
        entered.set()
        await release.wait()
        if fails:
            raise OSError("Synthetic readiness probe failure.")
        await cull()

    monkeypatch.setattr(service.store.files, "cull", held_probe)
    probe = asyncio.create_task(service.store.check())
    headers = {HEADER: service.api.settings.metadata_key.decode()}
    try:
        await asyncio.wait_for(entered.wait(), timeout=1)
        response = await browser.get("/internal/mcp-metadata", headers=headers)
        assert response.status_code == 200 and response.json()["storageReady"] is True
    finally:
        release.set()
        if fails:
            with pytest.raises(OSError, match="Synthetic readiness probe failure"):
                await probe
        else:
            await probe
    response = await browser.get("/internal/mcp-metadata", headers=headers)
    assert response.status_code == 200
    assert response.json()["storageReady"] is not fails


@pytest.mark.parametrize("missing_file", [False, True])
async def test_metadata_configuration_failure_is_scoped(settings_env, tmp_path, missing_file):
    if missing_file:
        settings_env["MCP_METADATA_TOKEN_FILE"] = str(tmp_path / "metadata-absent")
    else:
        settings_env.pop("MCP_METADATA_TOKEN_FILE")
    service = build_service(Settings.from_env(settings_env))
    async with service.http, service.app.app.router.lifespan_context(service.app.app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=service.app), base_url="https://mcp.example.test"
        ) as client:
            response = await client.get("/internal/mcp-metadata", headers={HEADER: "unusable"})
            assert response.status_code == 503
            assert response.json() == {"error": "metadata_configuration_unavailable"}
            assert (await client.get("/ready")).status_code == 200
            assert (await client.post("/mcp", json={})).status_code == 401


@pytest.mark.parametrize(
    "kind", ["missing", "missing-file", "invalid", "link", "oauth", "azure", "unreadable"]
)
def test_optional_metadata_failure_never_vetoes_oauth(settings_env, tmp_path, kind):
    if kind == "missing":
        settings_env.pop("MCP_METADATA_TOKEN_FILE")
    elif kind == "missing-file":
        settings_env["MCP_METADATA_TOKEN_FILE"] = str(tmp_path / "metadata-absent")
    elif kind == "azure":
        settings_env["MCP_AZURE_METADATA_TOKEN"] = "@Microsoft.KeyVault(unresolved)"
    else:
        path = tmp_path / "metadata-bad"
        if kind == "link":
            path.symlink_to(settings_env["MCP_METADATA_TOKEN_FILE"])
        elif kind == "oauth":
            path.write_text(
                json.loads(Path(settings_env["MCP_OAUTH_ENCRYPTION_KEY_FILE"]).read_text())[0]
            )
            path.chmod(0o600)
        elif kind == "unreadable":
            path.write_text(Path(settings_env["MCP_METADATA_TOKEN_FILE"]).read_text())
            path.chmod(0o000)
        else:
            path.write_text("invalid")
            path.chmod(0o600)
        settings_env["MCP_METADATA_TOKEN_FILE"] = str(path)
    settings = Settings.from_env(settings_env)
    assert settings.client_secret
    assert settings.metadata_key is None


def test_reserved_metadata_path():
    with pytest.raises(ConfigurationError):
        checked_url("https://mcp.example.test/internal/mcp-metadata", resource=True)
