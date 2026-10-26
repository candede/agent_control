"""Configuration syntax and modeled SDK requests, never native OAuth interoperability."""

import json
import re
from pathlib import Path
from urllib.parse import urlsplit

import pytest
import yaml
from conftest import protocol_client, tokens
from test_onboarding import PROFILES, VSCODE_REDIRECTS

ROOT = Path(__file__).resolve().parents[2]
EXAMPLES = ROOT / "mcp" / "examples" / "clients"
DOC = ROOT / "docs" / "mcp-clients.md"
FILES = {
    "vscode": "vscode/mcp.json",
    "claude-code": "claude-code/.mcp.json",
    "copilot-cli": "copilot-cli/mcp-config.json",
    "github-cloud": "github-cloud/mcp-config.json",
    "opencode": "opencode/opencode.json",
    "copilot-studio": "copilot-studio/agent-control.openapi.yaml",
}


@pytest.fixture
def examples():
    return {
        name: (
            yaml.safe_load((EXAMPLES / path).read_text())
            if path.endswith(".yaml")
            else json.loads((EXAMPLES / path).read_text())
        )
        for name, path in FILES.items()
    }


@pytest.fixture
def modeled_callback_shapes(examples):
    code = examples["claude-code"]["mcpServers"]["agentControl"]
    cli = examples["copilot-cli"]["mcpServers"]["agentControl"]
    opencode = examples["opencode"]["mcp"]["agentControl"]
    return {
        "vscode": VSCODE_REDIRECTS,
        "claude-code": [f"http://localhost:{code['oauth']['callbackPort']}/callback"],
        # Reported/prospective CLI shape, not a captured or source-verified native redirect.
        "copilot-cli": [f"http://127.0.0.1:{cli['auth']['redirectPort']}/"],
        "opencode": [f"http://127.0.0.1:{opencode['oauth']['callbackPort']}/mcp/oauth/callback"],
    }


@pytest.fixture
def settings_env(settings_env, modeled_callback_shapes):
    redirects = json.loads(settings_env["MCP_ALLOWED_CLIENT_REDIRECT_URIS"])
    redirects.extend(uri for group in modeled_callback_shapes.values() for uri in group)
    return {
        **settings_env,
        "MCP_ALLOWED_CLIENT_REDIRECT_URIS": json.dumps(list(dict.fromkeys(redirects))),
    }


def test_every_template_is_a_native_document_and_linked_from_the_guide():
    assert {str(path.relative_to(EXAMPLES)) for path in EXAMPLES.rglob("*") if path.is_file()} == (
        set(FILES.values())
    )
    guide = DOC.read_text()
    for path in FILES.values():
        assert f"../mcp/examples/clients/{path}" in guide
    assert "no documented remote-connector JSON import" in guide
    assert "not full delegated OAuth support" in guide
    assert "2025-10-25" in guide


@pytest.mark.parametrize("product", ["vscode", "claude-code", "copilot-cli", "github-cloud"])
def test_http_client_settings_use_the_product_root_and_only_supported_fields(product, examples):
    document = examples[product]
    root = "servers" if product == "vscode" else "mcpServers"
    assert set(document) == {root}
    assert set(document[root]) == {"agentControl"}
    server = document[root]["agentControl"]
    extra = {
        "vscode": set(),
        "claude-code": {"oauth"},
        "copilot-cli": {"tools", "auth"},
        "github-cloud": {"tools", "headers"},
    }[product]
    assert set(server) == {"type", "url"} | extra
    assert server["type"] == "http"
    if product == "claude-code":
        assert set(server["oauth"]) == {"callbackPort"}
        assert 1 <= server["oauth"]["callbackPort"] <= 65535
    if product == "copilot-cli":
        assert set(server["auth"]) == {"redirectPort"}
        assert 1 <= server["auth"]["redirectPort"] <= 65535
        assert server["tools"] == ["*"]


def test_opencode_uses_remote_oauth_dcr_without_a_static_client_or_secret(examples):
    document = examples["opencode"]
    assert set(document) == {"$schema", "mcp"}
    assert document["$schema"] == "https://opencode.ai/config.json"
    assert set(document["mcp"]) == {"agentControl"}
    server = document["mcp"]["agentControl"]
    assert set(server) == {"type", "url", "oauth"}
    assert server["type"] == "remote"
    assert set(server["oauth"]) == {"scope", "callbackPort"}
    assert 1 <= server["oauth"]["callbackPort"] <= 65535


def test_studio_import_is_the_documented_streamable_openapi_transport(examples):
    document = examples["copilot-studio"]
    assert set(document) == {"swagger", "info", "host", "basePath", "schemes", "paths"}
    assert document["swagger"] == "2.0"
    assert document["schemes"] == ["https"]
    assert document["basePath"] == "/"
    assert set(document["paths"]) == {"/mcp"}
    operation = document["paths"]["/mcp"]["post"]
    assert set(operation) == {
        "summary",
        "x-ms-agentic-protocol",
        "operationId",
        "responses",
    }
    assert operation["x-ms-agentic-protocol"] == "mcp-streamable-1.0"
    assert operation["operationId"] == "InvokeMCP"
    assert "200" in operation["responses"]


def test_cloud_header_is_an_agents_secret_reference_not_a_credential(examples):
    server = examples["github-cloud"]["mcpServers"]["agentControl"]
    assert server["headers"] == {"Authorization": "Bearer $COPILOT_MCP_AGENT_CONTROL_ACCESS_TOKEN"}
    assert server["tools"] and "*" not in server["tools"]
    assert not any("control" in tool for tool in server["tools"])


@pytest.mark.parametrize("product", FILES)
def test_examples_contain_only_synthetic_resource_locations_and_no_embedded_tokens(
    product, examples
):
    document = examples[product]
    if product == "copilot-studio":
        resource = f"https://{document['host']}{document['basePath'].rstrip('/')}/mcp"
    else:
        root = (
            "servers" if product == "vscode" else ("mcp" if product == "opencode" else "mcpServers")
        )
        resource = document[root]["agentControl"]["url"]
    parsed = urlsplit(resource)
    assert (parsed.scheme, parsed.hostname, parsed.path) == (
        "https",
        "mcp.example.test",
        "/mcp",
    )
    assert not parsed.username and not parsed.password and not parsed.query and not parsed.fragment
    serialized = json.dumps(document)
    assert "PRIVATE KEY" not in serialized
    assert not re.search(r"\beyJ[\w-]+\.[\w-]+\.[\w-]+\b", serialized)
    assert not re.search(
        r'"(?:clientId|client_id|oauthClientId|clientSecret|client_secret|'
        r'access_token|refresh_token|apiKey|api_key)"\s*:',
        serialized,
    )


def test_documented_callback_shapes_match_templates_and_existing_wire_profiles(
    modeled_callback_shapes,
):
    guide = DOC.read_text()
    for redirects in modeled_callback_shapes.values():
        for redirect in redirects:
            assert redirect in guide
    for _, redirects, _ in PROFILES:
        for redirect in redirects:
            assert redirect in guide
    assert "MCP_ALLOWED_CLIENT_REDIRECT_URIS" in guide
    assert "environment-specific callback" in guide


async def test_templates_match_the_actual_discovery_resource_scope_and_auth_contract(
    browser, examples
):
    protected = (await browser.get("/.well-known/oauth-protected-resource/mcp")).json()
    metadata = (await browser.get("/.well-known/oauth-authorization-server")).json()
    assert metadata["registration_endpoint"].endswith("/register")
    assert metadata["code_challenge_methods_supported"] == ["S256"]
    assert not metadata.get("client_id_metadata_document_supported", False)
    for product in ("vscode", "claude-code", "copilot-cli", "github-cloud", "opencode"):
        root = (
            "servers" if product == "vscode" else ("mcp" if product == "opencode" else "mcpServers")
        )
        assert examples[product][root]["agentControl"]["url"] == protected["resource"]
    studio = examples["copilot-studio"]
    assert f"https://{studio['host']}/mcp" == protected["resource"]
    assert (
        examples["opencode"]["mcp"]["agentControl"]["oauth"]["scope"].split()
        == (protected["scopes_supported"])
    )


@pytest.mark.parametrize("product", ["vscode", "claude-code", "copilot-cli", "opencode"])
async def test_modeled_callback_sets_use_exact_registration_policy_not_native_client_code(
    browser, modeled_callback_shapes, product
):
    redirects = modeled_callback_shapes[product]
    metadata = {
        "client_name": f"{product} example wire check, not vendor proof",
        "redirect_uris": redirects,
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    }
    registered = await browser.post("/register", json=metadata)
    assert registered.status_code == 201
    assert registered.json()["client_id"] != "*"
    assert set(registered.json()["redirect_uris"]) == set(redirects)
    denied = await browser.post(
        "/register", json={**metadata, "redirect_uris": [redirects[0] + "not-approved"]}
    )
    assert denied.status_code == 400
    assert denied.json()["error"] == "invalid_redirect_uri"


async def test_cloud_example_filters_to_real_read_only_tools_with_typed_inputs(browser, examples):
    _, issued = await tokens(browser)
    call = await protocol_client(browser, issued["access_token"])
    result = await browser.post(
        "/mcp",
        headers=call.headers,
        json={"jsonrpc": "2.0", "id": 100, "method": "tools/list", "params": {}},
    )
    catalog = {tool["name"]: tool for tool in result.json()["result"]["tools"]}
    assert len(catalog) == 124
    for name in examples["github-cloud"]["mcpServers"]["agentControl"]["tools"]:
        tool = catalog[name]
        assert tool["annotations"]["readOnlyHint"] is True
        assert tool["inputSchema"]["required"] == ["request"]
        assert set(tool["inputSchema"]["properties"]) == {"request"}
    assert not (await call("list_capabilities")).get("isError")
