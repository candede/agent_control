import asyncio
import time
from dataclasses import replace

import httpx2
import pytest
from conftest import OTHER, connect, tokens
from cryptography.fernet import Fernet

from agent_control_mcp.auth import TenantAzureProvider
from agent_control_mcp.config import ConfigurationError
from agent_control_mcp.service import build_service
from agent_control_mcp.storage import OAuthStore
from agent_control_mcp.tools import OPERATIONS


async def test_readiness_failure_has_safe_operator_diagnostics(
    browser, service, monkeypatch, caplog
):
    async def unavailable():
        raise ConfigurationError("synthetic-sensitive-storage-details")

    monkeypatch.setattr(service.store, "check", unavailable)
    response = await browser.get("/ready")
    assert response.status_code == 503
    assert response.json() == {"status": "unavailable"}
    assert "OAuth storage readiness verification failed." in caplog.text
    assert "synthetic-sensitive-storage-details" not in caplog.text
    assert "synthetic-sensitive-storage-details" not in response.text


async def test_forwarded_headers_cannot_rebind_public_oauth_resource(browser):
    response = await browser.get(
        "/.well-known/oauth-authorization-server",
        headers={
            "X-Forwarded-Host": "attacker.invalid",
            "X-Forwarded-Proto": "http",
            "Forwarded": "host=attacker.invalid;proto=http",
        },
    )
    assert response.status_code == 200
    assert response.json()["issuer"] == "https://mcp.example.test/"
    protected = await browser.get(
        "/.well-known/oauth-protected-resource/mcp",
        headers={"X-Forwarded-Host": "attacker.invalid"},
    )
    assert protected.json()["resource"] == "https://mcp.example.test/mcp"


async def test_authenticated_storage_diagnostics_failure_is_redacted(browser, monkeypatch, caplog):
    _, issued = await tokens(browser)

    def unavailable(*args):
        raise ConfigurationError("synthetic-sensitive-storage-details")

    monkeypatch.setattr("agent_control_mcp.storage.inspect_storage", unavailable)
    response = await browser.get(
        "/diagnostics", headers={"Authorization": f"Bearer {issued['access_token']}"}
    )
    assert response.status_code == 503
    assert response.json() == {"status": "unavailable"}
    assert "OAuth storage diagnostics verification failed." in caplog.text
    assert "synthetic-sensitive-storage-details" not in caplog.text + response.text
    assert issued["access_token"] not in caplog.text + response.text


async def test_discovery_initialization_authenticated_catalog_and_diagnostics(browser, service):
    discovery = await browser.get("/.well-known/oauth-authorization-server")
    assert discovery.status_code == 200
    metadata = discovery.json()
    assert metadata["issuer"] == "https://mcp.example.test/"
    assert metadata["code_challenge_methods_supported"] == ["S256"]
    assert metadata["authorization_endpoint"] == "https://mcp.example.test/authorize"
    assert metadata["revocation_endpoint"] == "https://mcp.example.test/revoke"
    assert (await browser.get("/health")).json() == {"status": "ok"}
    assert (await browser.get("/ready")).json() == {"status": "ready"}
    assert (await browser.get("/diagnostics")).status_code == 401
    _, issued = await tokens(browser)
    headers = {
        "Authorization": f"Bearer {issued['access_token']}",
        "Accept": "application/json, text/event-stream",
    }
    protected = await browser.get("/.well-known/oauth-protected-resource/mcp")
    assert protected.status_code == 200
    assert protected.json()["resource"] == "https://mcp.example.test/mcp"
    result = await browser.post(
        "/mcp",
        headers=headers,
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": {"name": "Synthetic SDK", "version": "1"},
            },
        },
    )
    assert result.status_code == 200, result.text
    assert result.json()["result"]["serverInfo"]["name"] == "Agent Control"
    session = result.headers["mcp-session-id"]
    headers["mcp-session-id"] = session
    await browser.post(
        "/mcp",
        headers=headers,
        json={
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
        },
    )
    listed = await browser.post(
        "/mcp",
        headers=headers,
        json={
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
        },
    )
    assert listed.status_code == 200, listed.text
    assert {tool["name"] for tool in listed.json()["result"]["tools"]} == {
        operation.name for operation in OPERATIONS
    }
    unauthenticated = await browser.post(
        "/mcp",
        headers={
            "mcp-session-id": session,
            "Accept": "application/json, text/event-stream",
        },
        json={"jsonrpc": "2.0", "id": 3, "method": "tools/list"},
    )
    assert unauthenticated.status_code == 401
    diagnostics = await browser.get("/diagnostics", headers=headers)
    assert diagnostics.status_code == 200
    assert diagnostics.json()["businessTools"] == len(OPERATIONS)
    usage = diagnostics.json()["oauthStorageUsage"]
    assert 0 < usage["files"] < usage["fileLimit"] == 4096
    assert 0 < usage["bytes"] < usage["byteLimit"] == 67108864
    assert issued["access_token"] not in diagnostics.text


async def test_pkce_wrong_verifier_wrong_client_and_replay(browser):
    _, grant = await connect(browser)
    wrong = await browser.post("/token", data={**grant, "code_verifier": "b" * 64})
    assert wrong.status_code in {400, 401}
    missing_resource = await browser.post(
        "/token", data={key: value for key, value in grant.items() if key != "resource"}
    )
    assert missing_resource.status_code == 400
    response = await browser.post("/token", data=grant)
    assert response.status_code == 200, response.text
    replay = await browser.post("/token", data=grant)
    assert replay.status_code in {400, 401}


@pytest.mark.parametrize(
    "resource",
    [None, "https://wrong.example.test/mcp", "https://mcp.example.test/mcp?tenant=other"],
)
async def test_exact_resource_and_no_pkce_downgrade(browser, resource):
    params = {
        "client_id": "unregistered",
        "response_type": "code",
        "redirect_uri": "https://client.example.test/callback",
        "code_challenge": "a" * 43,
        "code_challenge_method": "plain",
    }
    if resource:
        params["resource"] = resource
    response = await browser.get("/authorize", params=params)
    assert response.status_code == 400


async def test_dynamic_consumers_do_not_require_a_vendor_client_id(browser, settings):
    identifiers = set()
    for name in ("Synthetic desktop", "Synthetic coding agent", "Any other consumer"):
        response = await browser.post(
            "/register",
            json={
                "client_name": name,
                "redirect_uris": ["https://client.example.test/callback"],
                "token_endpoint_auth_method": "none",
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
            },
        )
        assert response.status_code == 201, response.text
        client = response.json()
        assert client["client_name"] == name
        assert client["client_id"] not in {settings.client_id, settings.api_client_id}
        assert client["redirect_uris"] == ["https://client.example.test/callback"]
        identifiers.add(client["client_id"])
    assert len(identifiers) == 3
    assert (await browser.get("/diagnostics")).status_code == 401


@pytest.mark.parametrize(
    "callback",
    ["http://127.0.0.1:53110/", "http://127.0.0.1:19876/mcp/oauth/callback"],
)
async def test_exact_native_callback_oauth_flow(settings, entra, callback):
    runtime = build_service(
        replace(settings, redirect_uris=(callback,)),
        transport=httpx2.MockTransport(entra.route),
    )
    sdk_app = runtime.app.app
    try:
        async with sdk_app.router.lifespan_context(sdk_app):
            async with httpx2.AsyncClient(
                transport=httpx2.ASGITransport(app=runtime.app),
                base_url=settings.public_origin,
                follow_redirects=False,
            ) as browser:
                _, issued = await tokens(
                    browser, client_name="Synthetic native client", redirect_uri=callback
                )
                authenticated = await browser.get(
                    "/diagnostics",
                    headers={"Authorization": f"Bearer {issued['access_token']}"},
                )
                assert authenticated.status_code == 200
                alternate_host = await browser.post(
                    "/register",
                    json={
                        "redirect_uris": [callback.replace("127.0.0.1", "localhost")],
                        "token_endpoint_auth_method": "none",
                    },
                )
                assert alternate_host.status_code == 400
    finally:
        await runtime.http.aclose()


async def test_rejects_unapproved_redirect_and_mixed_credentials(browser):
    redirect = await browser.post(
        "/register",
        json={
            "redirect_uris": ["https://attacker.example.test/callback"],
            "token_endpoint_auth_method": "none",
        },
    )
    assert redirect.status_code == 400, redirect.text
    mixed = await browser.get(
        "/diagnostics",
        headers={
            "Authorization": "Bearer wrong",
            "Cookie": "session=wrong",
        },
    )
    assert mixed.status_code == 400
    for value in ("wrong", "Basic credential"):
        response = await browser.get("/diagnostics", headers={"Authorization": value})
        assert response.status_code == 401


async def test_public_upstream_recovery_restart_refresh_revocation_and_signing_rotation(
    browser,
    service,
    settings,
    entra,
):
    client_id, issued = await tokens(browser)
    reference = issued["access_token"]
    verified = await service.provider.load_access_token(reference)
    assert verified and verified.token != reference
    assert verified.claims["aud"] == settings.client_id
    assert verified.client_id == client_id
    assert issued["expires_in"] == 900
    restarted = TenantAzureProvider(settings, OAuthStore(settings), service.http)
    restarted.set_mcp_path(settings.mcp_path)
    assert await restarted.load_access_token(reference)
    refreshed = await browser.post(
        "/token",
        data={
            "grant_type": "refresh_token",
            "refresh_token": issued["refresh_token"],
            "client_id": client_id,
            "resource": settings.public_url,
        },
    )
    assert refreshed.status_code == 200, refreshed.text
    assert await restarted.load_access_token(refreshed.json()["access_token"])
    await restarted.revoke_token(verified)
    assert await restarted.load_access_token(reference) is None
    again = TenantAzureProvider(settings, OAuthStore(settings), service.http)
    again.set_mcp_path(settings.mcp_path)
    assert await again.load_access_token(reference) is None
    client = await again.get_client(client_id)
    refresh = await again.load_refresh_token(client, refreshed.json()["refresh_token"])
    assert refresh
    await again.revoke_token(refresh)
    assert await again.load_refresh_token(client, refresh.token) is None
    rotated = TenantAzureProvider(
        replace(settings, signing_key=Fernet.generate_key()),
        OAuthStore(settings),
        service.http,
    )
    rotated.set_mcp_path(settings.mcp_path)
    assert await rotated.load_access_token(refreshed.json()["access_token"]) is None


async def test_callback_errors_and_deadlines_do_not_expose_provider_diagnostics(
    browser,
    service,
    entra,
    monkeypatch,
):
    for params in (
        {"error": "access_denied", "error_description": "synthetic sensitive provider diagnostic"},
        {"error": "synthetic sensitive provider diagnostic", "state": "not-a-transaction"},
    ):
        response = await browser.get("/auth/callback", params=params)
        assert response.status_code == 400
        assert "synthetic sensitive" not in response.text
        assert response.headers["cache-control"] == "no-store"
    entra.authorization_error = True
    with pytest.raises(AssertionError) as failed:
        await connect(browser)
    assert "synthetic sensitive" not in str(failed.value)

    async def timed_out(*args, **kwargs):
        raise TimeoutError

    monkeypatch.setattr(service.app, "app", timed_out)
    deadline = await browser.get("/auth/callback")
    assert deadline.status_code == 504
    assert deadline.json()["error"] == "temporarily_unavailable"


async def test_signing_key_rotation_returns_invalid_grant_for_old_refresh(
    browser, settings, entra
):
    client_id, issued = await tokens(browser)
    runtime = build_service(
        replace(settings, signing_key=Fernet.generate_key()),
        transport=httpx2.MockTransport(entra.route),
    )
    provider_calls = len(entra.calls)
    try:
        async with runtime.app.app.router.lifespan_context(runtime.app.app):
            async with httpx2.AsyncClient(
                transport=httpx2.ASGITransport(app=runtime.app),
                base_url=settings.public_origin,
            ) as restarted:
                response = await restarted.post(
                    "/token",
                    data={
                        "grant_type": "refresh_token",
                        "refresh_token": issued["refresh_token"],
                        "client_id": client_id,
                        "resource": settings.public_url,
                    },
                )
                assert response.status_code == 401, response.text
                assert response.json()["error"] == "invalid_grant"
                assert issued["refresh_token"] not in response.text
                assert len(entra.calls) == provider_calls
                new_client, reconnected = await tokens(restarted)
                renewed = await restarted.post(
                    "/token",
                    data={
                        "grant_type": "refresh_token",
                        "refresh_token": reconnected["refresh_token"],
                        "client_id": new_client,
                        "resource": settings.public_url,
                    },
                )
                assert renewed.status_code == 200
                authenticated = await restarted.get(
                    "/diagnostics",
                    headers={"Authorization": f"Bearer {renewed.json()['access_token']}"},
                )
                assert authenticated.status_code == 200
    finally:
        await runtime.http.aclose()


async def test_refresh_denial_reconnect_and_isolated_principals(browser, service, entra, settings):
    first_client, first = await tokens(browser)
    entra.oid = OTHER
    second_client, second = await tokens(browser)
    a, b = await asyncio.gather(
        service.provider.load_access_token(first["access_token"]),
        service.provider.load_access_token(second["access_token"]),
    )
    assert a.claims["oid"] != b.claims["oid"]
    assert a.client_id == first_client and b.client_id == second_client
    cross = await browser.post(
        "/token",
        data={
            "grant_type": "refresh_token",
            "refresh_token": first["refresh_token"],
            "client_id": second_client,
            "resource": settings.public_url,
        },
    )
    assert cross.status_code in {400, 401}
    entra.refresh_error = True
    denied = await browser.post(
        "/token",
        data={
            "grant_type": "refresh_token",
            "refresh_token": first["refresh_token"],
            "client_id": first_client,
            "resource": settings.public_url,
        },
    )
    assert denied.status_code in {400, 401}
    assert "synthetic-upstream-refresh" not in denied.text


@pytest.mark.parametrize(
    "claims",
    [
        {"aud": "api://33333333-3333-3333-3333-333333333333"},
        {"aud": ["33333333-3333-3333-3333-333333333333", "mixed"]},
        {"tid": OTHER},
        {"azp": OTHER},
        {"nonce": "id-token"},
        {"ver": "1.0"},
        {"scp": "AgentControl.Access"},
        {"idtyp": "app"},
        {"nbf": int(time.time()) + 300},
        {"exp": None},
    ],
)
async def test_strict_upstream_claims_after_real_sdk_signature_verification(
    browser,
    service,
    entra,
    claims,
):
    entra.upstream_claims = claims
    _, issued = await tokens(browser)
    assert await service.provider.load_access_token(issued["access_token"]) is None


async def test_proactive_refresh_and_changed_identity_never_crosses_accounts(
    browser,
    service,
    entra,
    settings,
):
    entra.upstream_lifetime = 30
    client_id, issued = await tokens(browser)
    verified = await service.provider.load_access_token(issued["access_token"])
    assert verified
    refresh_calls = [
        request for request in entra.calls if b"grant_type=refresh_token" in request.content
    ]
    assert refresh_calls
    entra.oid = OTHER
    assert await service.provider.load_access_token(issued["access_token"]) is None
    changed = await browser.post(
        "/token",
        data={
            "grant_type": "refresh_token",
            "refresh_token": issued["refresh_token"],
            "client_id": client_id,
            "resource": settings.public_url,
        },
    )
    assert changed.status_code in {400, 401}


async def test_actual_revocation_endpoint_is_client_bound_and_durable(browser, service, settings):
    first_client, first = await tokens(browser)
    second_client, second = await tokens(browser)
    wrong_client = await browser.post(
        "/revoke",
        data={
            "token": first["access_token"],
            "token_type_hint": "access_token",
            "client_id": second_client,
        },
    )
    assert wrong_client.status_code == 200
    assert await service.provider.load_access_token(first["access_token"])
    revoked = await browser.post(
        "/revoke",
        data={
            "token": first["access_token"],
            "token_type_hint": "access_token",
            "client_id": first_client,
        },
    )
    assert revoked.status_code == 200, revoked.text
    assert await service.provider.load_access_token(first["access_token"]) is None
    assert await service.provider.load_access_token(second["access_token"])
    revoked_refresh = await browser.post(
        "/revoke",
        data={
            "token": first["refresh_token"],
            "token_type_hint": "refresh_token",
            "client_id": first_client,
        },
    )
    assert revoked_refresh.status_code == 200
    client = await service.provider.get_client(first_client)
    assert await service.provider.load_refresh_token(client, first["refresh_token"]) is None


async def test_session_id_cannot_transfer_between_clients_even_for_same_user(browser):
    _, first = await tokens(browser)
    _, second = await tokens(browser)
    common = {"Accept": "application/json, text/event-stream"}
    initialized = await browser.post(
        "/mcp",
        headers={
            **common,
            "Authorization": f"Bearer {first['access_token']}",
        },
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": {"name": "first", "version": "1"},
            },
        },
    )
    assert initialized.status_code == 200
    hijack = await browser.post(
        "/mcp",
        headers={
            **common,
            "Authorization": f"Bearer {second['access_token']}",
            "mcp-session-id": initialized.headers["mcp-session-id"],
        },
        json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    )
    assert hijack.status_code in {403, 404}


async def test_bounded_registration_authorize_post_and_raw_tokens_are_not_credentials(
    browser,
    service,
):
    registration = {
        "redirect_uris": ["https://client.example.test/callback"],
        "token_endpoint_auth_method": "none",
    }
    oversized = await browser.post(
        "/register",
        json={
            **registration,
            "client_name": "x" * 257,
        },
    )
    assert oversized.status_code == 400
    registered = await browser.post("/register", json=registration)
    assert registered.status_code == 201
    authorized = await browser.post(
        "/authorize",
        data={
            "client_id": registered.json()["client_id"],
            "response_type": "code",
            "redirect_uri": "https://client.example.test/callback",
            "resource": "https://mcp.example.test/mcp",
            "scope": "Mcp.Access",
            "code_challenge": "a" * 43,
            "code_challenge_method": "S256",
        },
    )
    assert authorized.status_code in {302, 307}
    browser.cookies.clear()
    _, issued = await tokens(browser)
    verified = await service.provider.load_access_token(issued["access_token"])
    response = await browser.get(
        "/diagnostics",
        headers={
            "Authorization": f"Bearer {verified.token}",
        },
    )
    assert response.status_code == 401
    forged = issued["access_token"][:-12] + "abcdefghijkl"
    assert await service.provider.load_access_token(forged) is None
    too_large = await browser.post("/mcp", content=b"x" * 524289)
    assert too_large.status_code == 413


async def test_upstream_outage_is_not_invalid_grant_and_does_not_destroy_refresh(
    browser,
    service,
    entra,
    settings,
):
    client_id, issued = await tokens(browser)
    entra.refresh_unavailable = True
    data = {
        "grant_type": "refresh_token",
        "refresh_token": issued["refresh_token"],
        "client_id": client_id,
        "resource": settings.public_url,
    }
    unavailable = await browser.post("/token", data=data)
    assert unavailable.status_code == 503, unavailable.text
    assert unavailable.json()["error"] == "temporarily_unavailable"
    assert "sensitive provider" not in unavailable.text
    entra.refresh_unavailable = False
    recovered = await browser.post("/token", data=data)
    assert recovered.status_code == 200


async def test_authorization_code_is_single_use_under_concurrent_redemption(browser, caplog):
    _, grant = await connect(browser)
    results = await asyncio.gather(
        browser.post("/token", data=grant),
        browser.post("/token", data=grant),
    )
    statuses = sorted(result.status_code for result in results)
    assert statuses[0] == 200 and statuses[1] in {400, 401}
    assert grant["code"] not in caplog.text


async def test_revocation_during_refresh_cannot_reissue_credentials(
    browser,
    service,
    entra,
    settings,
):
    client_id, issued = await tokens(browser)
    refresh = await service.provider.load_refresh_token(
        await service.provider.get_client(client_id),
        issued["refresh_token"],
    )
    entra.block_refresh = asyncio.Event()
    pending = asyncio.create_task(
        browser.post(
            "/token",
            data={
                "grant_type": "refresh_token",
                "refresh_token": issued["refresh_token"],
                "client_id": client_id,
                "resource": settings.public_url,
            },
        )
    )
    await asyncio.wait_for(entra.refresh_started.wait(), 2)
    await service.provider.revoke_token(refresh)
    entra.block_refresh.set()
    response = await pending
    assert response.status_code in {400, 401}
    assert response.json()["error"] == "invalid_grant"
    assert (
        await service.provider.load_refresh_token(
            await service.provider.get_client(client_id),
            issued["refresh_token"],
        )
        is None
    )
