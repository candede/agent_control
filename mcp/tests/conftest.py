import asyncio
import base64
import hashlib
import json
import os
import re
import subprocess
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx2
import pytest
from cryptography.fernet import Fernet
from joserfc import jwt
from joserfc.jwk import RSAKey

from agent_control_mcp.config import Settings
from agent_control_mcp.service import build_service

TENANT = "11111111-1111-1111-1111-111111111111"
CLIENT = "33333333-3333-3333-3333-333333333333"
API = "22222222-2222-2222-2222-222222222222"
USER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
OTHER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"


def pytest_addoption(parser):
    parser.addoption("--azure-oauth-endpoint", default=None)


@pytest.fixture
def settings_env(tmp_path):
    values = {
        "MCP_TENANT_ID": TENANT,
        "MCP_CLIENT_ID": CLIENT,
        "MCP_API_CLIENT_ID": API,
        "MCP_API_ORIGIN": "https://api.example.test",
        "MCP_PUBLIC_URL": "https://mcp.example.test/mcp",
        "MCP_ALLOWED_CLIENT_REDIRECT_URIS": '["https://client.example.test/callback"]',
        "MCP_OAUTH_STORAGE_PATH": str(tmp_path / "oauth"),
    }
    for name, content in (
        ("CLIENT_SECRET", "synthetic-confidential-client-secret"),
        ("JWT_SIGNING_KEY", Fernet.generate_key().decode()),
        ("OAUTH_ENCRYPTION_KEY", json.dumps([Fernet.generate_key().decode()])),
    ):
        path = tmp_path / name
        path.write_text(content)
        path.chmod(0o600)
        values[f"MCP_{name}_FILE"] = str(path)
    return values


@pytest.fixture
def settings(settings_env):
    return Settings.from_env(settings_env)


class Entra:
    def __init__(self, settings):
        self.settings = settings
        self.key = RSAKey.generate_key(parameters={"kid": "fixture-key"})
        self.oid = USER
        self.calls = []
        self.api_calls = []
        self.api_responses = []
        self.exchange_error = None
        self.refresh_error = False
        self.refresh_unavailable = False
        self.upstream_lifetime = 3600
        self.response_claims = {}
        self.upstream_claims = {}
        self.block_api = None
        self.api_started = asyncio.Event()
        self.api_cancelled = asyncio.Event()
        self.block_refresh = None
        self.refresh_started = asyncio.Event()
        self.authorization_error = False

    def claims(self, *, api=False, oid=None, **extra):
        now = int(time.time())
        return {
            "iss": self.settings.issuer,
            "tid": TENANT,
            "aud": API if api else CLIENT,
            "azp": CLIENT,
            "ver": "2.0",
            "oid": oid or self.oid,
            "sub": "synthetic-sub-" + (oid or self.oid),
            "iat": now - 1,
            "nbf": now - 1,
            "exp": now + 3600,
            "scp": "AgentControl.Access" if api else "Mcp.Access",
            **({"roles": ["AgentControl.Viewer"]} if api else {}),
            **extra,
        }

    def token(self, *, api=False, oid=None, **extra):
        return jwt.encode(
            {"alg": "RS256", "kid": "fixture-key"},
            self.claims(api=api, oid=oid, **extra),
            self.key,
        )

    async def route(self, request):
        self.calls.append(request)
        if request.url.host == "login.microsoftonline.com":
            assert request.url.path.startswith("/" + TENANT + "/")
            if request.url.path.endswith("/keys"):
                return httpx2.Response(200, json={"keys": [self.key.as_dict(private=False)]})
            assert request.url.path.endswith("/token")
            data = parse_qs(request.content.decode())
            if self.authorization_error and data["grant_type"] == ["authorization_code"]:
                return httpx2.Response(
                    400,
                    json={
                        "error": "invalid_grant",
                        "error_description": "synthetic sensitive provider diagnostic",
                    },
                )
            if data["grant_type"] == ["urn:ietf:params:oauth:grant-type:jwt-bearer"]:
                if self.exchange_error:
                    return self.exchange_error
                assertion = jwt.decode(data["assertion"][0], self.key).claims
                assert assertion["aud"] == CLIENT
                assert data["scope"] == [f"api://{API}/AgentControl.Access"]
                assert data["requested_token_use"] == ["on_behalf_of"]
                assert data["client_id"] == [CLIENT]
                assert data["client_secret"] == [self.settings.client_secret]
                return httpx2.Response(
                    200,
                    json={
                        "access_token": self.token(
                            api=True,
                            **{"oid": assertion["oid"], **self.response_claims},
                        ),
                        "token_type": "Bearer",
                        "expires_in": 3600,
                    },
                )
            if self.refresh_error and data["grant_type"] == ["refresh_token"]:
                return httpx2.Response(400, json={"error": "invalid_grant"})
            if self.refresh_unavailable and data["grant_type"] == ["refresh_token"]:
                return httpx2.Response(503, text="sensitive provider error body")
            if self.block_refresh and data["grant_type"] == ["refresh_token"]:
                self.refresh_started.set()
                await self.block_refresh.wait()
            return httpx2.Response(
                200,
                json={
                    "access_token": self.token(**self.upstream_claims),
                    "refresh_token": "synthetic-upstream-refresh",
                    "expires_in": self.upstream_lifetime,
                    "refresh_expires_in": 3600,
                    "token_type": "Bearer",
                    "scope": f"api://{CLIENT}/Mcp.Access",
                },
            )
        assert request.url.host == "api.example.test", str(request.url)
        self.api_calls.append(request)
        self.api_started.set()
        assert "cookie" not in request.headers
        if self.block_api:
            try:
                await self.block_api.wait()
            except asyncio.CancelledError:
                self.api_cancelled.set()
                raise
        if self.api_responses:
            return self.api_responses.pop(0)
        if request.url.path == "/api/capabilities/check-progress":
            return httpx2.Response(200, json={"progress": None})
        assert request.url.path == "/api/capabilities"
        return httpx2.Response(200, json={"value": []})


@pytest.fixture
def entra(settings, monkeypatch):
    fixture = Entra(settings)
    original = httpx2.AsyncClient.__init__

    def init(client, *args, **kwargs):
        kwargs.setdefault("transport", httpx2.MockTransport(fixture.route))
        kwargs["trust_env"] = False
        original(client, *args, **kwargs)

    monkeypatch.setattr(httpx2.AsyncClient, "__init__", init)
    return fixture


@pytest.fixture
async def service(settings, entra):
    runtime = build_service(settings, transport=httpx2.MockTransport(entra.route))
    sdk_app = runtime.app.app
    ready, finish = asyncio.Event(), asyncio.Event()

    async def run_lifespan():
        async with sdk_app.router.lifespan_context(sdk_app):
            ready.set()
            await finish.wait()

    task = asyncio.create_task(run_lifespan())
    await asyncio.wait_for(ready.wait(), timeout=5)
    try:
        yield runtime
    finally:
        finish.set()
        await task
        await runtime.http.aclose()


@pytest.fixture
async def browser(service):
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=service.app),
        base_url="https://mcp.example.test",
        follow_redirects=False,
    ) as client:
        yield client


@pytest.fixture(scope="session")
def source_fixtures():
    # Type-only compiler inspection; no backend module, .env or provider is executed.
    completed = subprocess.run(
        ["node", "tests/wire_contracts.mjs"],
        cwd=Path(__file__).resolve().parents[1],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(completed.stdout)


@pytest.fixture
async def rpc(browser):
    _, issued = await tokens(browser)
    return await protocol_client(browser, issued["access_token"])


async def protocol_client(browser, token, *, client_name="Synthetic client", client_version="1"):
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json, text/event-stream",
    }
    initialized = await browser.post(
        "/mcp",
        headers=headers,
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": {"name": client_name, "version": client_version},
            },
        },
    )
    assert initialized.status_code == 200, initialized.text
    headers["mcp-session-id"] = initialized.headers["mcp-session-id"]
    await browser.post(
        "/mcp",
        headers=headers,
        json={"jsonrpc": "2.0", "method": "notifications/initialized"},
    )
    call_id = 1
    trace = []

    async def call(name, request=None, *, calling_agent="synthetic-agent", meta=None):
        nonlocal call_id
        call_id += 1
        started = time.perf_counter()
        response = await browser.post(
            "/mcp",
            headers=headers,
            json={
                "jsonrpc": "2.0",
                "id": call_id,
                "method": "tools/call",
                "params": {
                    "name": name,
                    "arguments": {"request": request or {}},
                    **(
                        {"_meta": meta}
                        if meta is not None
                        else {
                            "_meta": {
                                "com.agentcontrol/origin": {"callingAgent": {"id": calling_agent}}
                            }
                        }
                        if calling_agent is not None
                        else {}
                    ),
                },
            },
        )
        trace.append(
            {
                "tool": name,
                "request": request or {},
                "status": response.status_code,
                "bytes": len(response.content),
                "seconds": time.perf_counter() - started,
            }
        )
        assert response.status_code == 200, response.text
        return response.json()["result"]

    call.headers = headers
    call.trace = trace
    return call


async def connect(
    browser,
    *,
    client_name="Synthetic client",
    redirect_uri="https://client.example.test/callback",
    register_redirects=None,
    upstream_code="synthetic-entra-code",
):
    registered = await browser.post(
        "/register",
        json={
            "client_name": client_name,
            "redirect_uris": register_redirects or [redirect_uri],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        },
    )
    assert registered.status_code == 201, registered.text
    client_id = registered.json()["client_id"]
    verifier = base64.urlsafe_b64encode(os.urandom(48)).decode().rstrip("=")
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    )
    authorize = await browser.get(
        "/authorize",
        params={
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": "Mcp.Access",
            "state": "client-state",
            "resource": "https://mcp.example.test/mcp",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        },
    )
    assert authorize.status_code in {302, 307}, authorize.text
    consent = await browser.get(authorize.headers["location"])
    assert consent.status_code == 200, consent.text
    csrf = re.search(r'name="csrf_token" value="([^"]+)"', consent.text).group(1)
    txn = re.search(r'name="txn_id" value="([^"]+)"', consent.text).group(1)
    approved = await browser.post(
        "/consent",
        data={
            "txn_id": txn,
            "csrf_token": csrf,
            "action": "approve",
        },
        headers={"Origin": "https://mcp.example.test", "Sec-Fetch-Site": "same-origin"},
    )
    assert approved.status_code == 302, approved.text
    upstream = parse_qs(urlsplit(approved.headers["location"]).query)
    assert upstream["scope"] == [f"api://{CLIENT}/Mcp.Access offline_access openid profile"] or set(
        upstream["scope"][0].split()
    ) == {
        f"api://{CLIENT}/Mcp.Access",
        "offline_access",
        "openid",
        "profile",
    }
    assert "resource" not in upstream
    assert upstream["code_challenge_method"] == ["S256"]
    callback = await browser.get(
        "/auth/callback",
        params={
            "state": upstream["state"][0],
            "code": upstream_code,
        },
    )
    assert callback.status_code == 302, callback.text
    code = parse_qs(urlsplit(callback.headers["location"]).query)["code"][0]
    # The downstream protocol caller is not the consent browser cookie jar.
    browser.cookies.clear()
    data = {
        "grant_type": "authorization_code",
        "client_id": client_id,
        "code": code,
        "redirect_uri": redirect_uri,
        "code_verifier": verifier,
        "resource": "https://mcp.example.test/mcp",
    }
    return client_id, data


async def tokens(browser, **options):
    client_id, data = await connect(browser, **options)
    response = await browser.post("/token", data=data)
    assert response.status_code == 200, response.text
    return client_id, response.json()
