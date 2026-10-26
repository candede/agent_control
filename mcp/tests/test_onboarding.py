"""Documented client wire profiles against the SDK, never vendor-client qualification."""

import json

import pytest
from conftest import protocol_client, tokens

VSCODE_REDIRECTS = [
    "https://insiders.vscode.dev/redirect",
    "https://vscode.dev/redirect",
    "http://127.0.0.1/",
    "http://127.0.0.1:33418/",
]
HOSTED = "https://claude.ai/api/mcp/auth_callback"
CODE = "http://localhost:53109/callback"
PROFILES = [
    ("VS Code 1.142.0", VSCODE_REDIRECTS, VSCODE_REDIRECTS[1]),
    ("Claude web documented 2026-10-17", [HOSTED], HOSTED),
    ("Claude Desktop documented 2026-10-17", [HOSTED], HOSTED),
    ("Claude Cowork documented 2026-10-17", [HOSTED], HOSTED),
    ("Claude Code fixed callback documented 2026-10-17", [CODE], CODE),
    # Studio's generated callback is environment-specific; this is not a vendor URI.
    (
        "Copilot Studio synthetic callback",
        ["https://studio.example.test/generated-callback"],
        "https://studio.example.test/generated-callback",
    ),
]


@pytest.fixture(params=PROFILES, ids=[row[0] for row in PROFILES])
def profile(request):
    return request.param


@pytest.fixture
def settings_env(settings_env, profile):
    return {**settings_env, "MCP_ALLOWED_CLIENT_REDIRECT_URIS": json.dumps(profile[1])}


async def test_profile_discovery_exact_dcr_pkce_catalog_refresh_and_revocation(
    profile,
    browser,
    service,
):
    name, redirects, redirect = profile
    unauthorized = await browser.post("/mcp", json={})
    assert unauthorized.status_code == 401
    assert "/.well-known/oauth-protected-resource/mcp" in unauthorized.headers["WWW-Authenticate"]
    protected = (await browser.get("/.well-known/oauth-protected-resource/mcp")).json()
    assert protected["resource"] == "https://mcp.example.test/mcp"
    assert protected["scopes_supported"] == ["Mcp.Access"]
    metadata = (await browser.get("/.well-known/oauth-authorization-server")).json()
    assert metadata["code_challenge_methods_supported"] == ["S256"]
    assert metadata["registration_endpoint"] == "https://mcp.example.test/register"
    assert not metadata.get("client_id_metadata_document_supported", False)
    client_id, issued = await tokens(
        browser,
        client_name=name,
        redirect_uri=redirect,
        register_redirects=redirects,
    )
    client = await service.provider.get_client(client_id)
    assert {str(uri) for uri in client.redirect_uris} == set(redirects)
    call = await protocol_client(browser, issued["access_token"], client_name=name)
    result = await browser.post(
        "/mcp",
        headers=call.headers,
        json={
            "jsonrpc": "2.0",
            "id": 100,
            "method": "tools/list",
            "params": {},
        },
    )
    tools = result.json()["result"]["tools"]
    assert len(tools) == 124
    for tool in tools:
        assert tool["inputSchema"]["required"] == ["request"]
        assert set(tool["inputSchema"]["properties"]) == {"request"}
    assert not (await call("list_capabilities")).get("isError")
    refreshed = await browser.post(
        "/token",
        data={
            "client_id": client_id,
            "grant_type": "refresh_token",
            "refresh_token": issued["refresh_token"],
            "resource": protected["resource"],
        },
    )
    assert refreshed.status_code == 200
    current = refreshed.json()
    assert current["refresh_token"] != issued["refresh_token"]
    loaded = await service.provider.load_access_token(current["access_token"])
    assert loaded and loaded.client_id == client_id
    revoked = await browser.post(
        "/revoke",
        data={
            "client_id": client_id,
            "token": current["refresh_token"],
            "token_type_hint": "refresh_token",
        },
    )
    assert revoked.status_code == 200
    denied = await browser.post(
        "/token",
        data={
            "client_id": client_id,
            "grant_type": "refresh_token",
            "refresh_token": current["refresh_token"],
            "resource": protected["resource"],
        },
    )
    assert denied.status_code == 401
    assert denied.json()["error"] == "invalid_grant"
    wrong_callback = await browser.post(
        "/register",
        json={
            "redirect_uris": [redirect + "/not-approved"],
            "token_endpoint_auth_method": "none",
        },
    )
    assert wrong_callback.status_code == 400
    assert wrong_callback.json()["error"] == "invalid_redirect_uri"
    print(f"phase09_client_profile {name}: SDK profile passed; vendor onboarding unavailable")
