"""Real native SDK, signed same-user OAuth/OBO and canonical policy projection."""

import asyncio
import json
import os
import subprocess
from copy import deepcopy
from pathlib import Path

import httpx2
import pytest
from conftest import OTHER, USER, protocol_client, tokens
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.exceptions import MCPError

from agent_control_mcp.domains import PUBLIC_TOOLS
from agent_control_mcp.projection import AccessProfile, projected_catalog


async def discovery(browser, issued):
    browser.headers["Authorization"] = "Bearer " + issued["access_token"]
    async with streamable_http_client("https://mcp.example.test/mcp", http_client=browser) as (
        read,
        write,
    ):
        async with ClientSession(read, write) as session:
            initialized = await session.initialize()
            modern = await session.discover()
            assert modern.instructions == initialized.instructions
            assert modern.cache_scope == "private" and modern.ttl_ms == 0
            tools = (await session.list_tools()).tools
    return {
        "initialize": initialized.model_dump(mode="json", by_alias=True, exclude_none=True),
        "tools": [tool.model_dump(mode="json", by_alias=True, exclude_none=True) for tool in tools],
    }


@pytest.mark.parametrize(
    "audience,roles",
    [
        ("end_user", []),
        ("adoption", ["AgentControl.Viewer"]),
        ("uploader", ["AgentControl.UsageReportUploader"]),
        ("admin", ["AgentControl.Admin"]),
    ],
)
async def test_real_audience_schema_metadata_and_measurement(
    browser, service, entra, audience, roles
):
    entra.response_claims = {"roles": roles}
    _, issued = await tokens(browser)
    document = await discovery(browser, issued)
    expected = projected_catalog(AccessProfile.model_validate(entra.profiles[audience]))
    tools = {tool["name"]: tool for tool in document["tools"]}
    assert set(tools) == {tool.name for tool in expected}
    assert {"agent_catalog", "my_workplace", "my_discovery_profile"} <= set(tools)
    assert ("preview_end_user" in tools) is bool(roles)
    if not roles:
        assert len(tools) == 3
        assert "subject" not in json.dumps(tools["agent_catalog"]["inputSchema"])
        assert not any(name in tools for name in ("inventory", "adoption", "users", "sync"))
    if audience in {"adoption", "uploader"}:
        usage = json.dumps(tools["agent_usage"])
        assert "candidates" not in usage and "UsageCandidates" not in usage
        assert "execute_agent_control" not in tools
        probe = tools["probe_capability"]["inputSchema"]
        allowed = next(
            item
            for item in entra.profiles[audience]["operations"]
            if item["route"] == "/api/capabilities/:id/probe"
        )["inputChoices"]["capabilityId"]
        schema = probe["$defs"]["PermittedProbeInput"]
        assert schema["properties"]["id"]["enum"] == allowed
    # A native one-action family remains an action/input and action/result envelope.
    own = tools["my_discovery_profile"]
    assert "MyDiscoveryProfileReadRequest" in own["inputSchema"]["$defs"]
    assert own["inputSchema"]["$defs"]["MyDiscoveryProfileReadRequest"]["required"] == [
        "action",
        "input",
    ]
    assert own["outputSchema"]["$defs"]["MyDiscoveryProfileReadResult"]["required"] == [
        "action",
        "result",
    ]
    browser.headers.pop("Authorization", None)
    metadata = await browser.post(
        "/internal/mcp-metadata",
        headers={"X-Agent-Control-Mcp-Metadata-Token": service.api.settings.metadata_key.decode()},
        json=entra.profiles[audience],
    )
    assert metadata.status_code == 200
    assert metadata.json()["tools"] == document["tools"]
    assert metadata.json()["instructions"] == document["initialize"]["instructions"]
    assert not entra.api_calls
    assert (
        sum(request.url.path.endswith("authenticated-entry") for request in entra.authority_calls)
        == 3
    )
    print(
        "AUDIENCE_MEASUREMENT "
        + json.dumps(
            {
                "audience": audience,
                "tools": len(tools),
                "operations": sum(len(tool.branches) for tool in expected),
                "bytes": len(
                    json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode()
                ),
                "metadataBytes": len(metadata.content),
            }
        )
    )


async def test_current_authority_blocks_stale_names_actions_choices_subject_and_demotion(
    browser, entra
):
    _, issued = await tokens(browser)
    rpc = await protocol_client(browser, issued["access_token"])
    entra.profiles_by_oid[USER] = entra.profiles["adoption"]
    for name, request in (
        ("execute_agent_control", {}),
        ("agent_usage", {"action": "candidates", "input": {}}),
        ("probe_capability", {"id": "graph.package.block.manage"}),
    ):
        denied = await rpc(name, request, wire=True)
        assert denied["isError"]
    entra.profiles_by_oid[USER] = entra.profiles["end_user"]
    for name, request in (
        ("preview_end_user", {"action": "profile", "input": {"subject": "admin@example.invalid"}}),
        ("my_discovery_profile", {"action": "read", "input": {"subject": "other@example.invalid"}}),
        ("my_workplace", {"action": "read", "input": {"hide_employee_details": False}}),
        ("inventory", {"action": "health", "input": {}}),
    ):
        denied = await rpc(name, request, wire=True)
        assert denied["isError"]
        assert "admin@example.invalid" not in json.dumps(denied)
    assert not entra.api_calls


async def test_projection_failure_has_no_full_catalog_fallback_or_business_effect(browser, entra):
    _, issued = await tokens(browser)
    rpc = await protocol_client(browser, issued["access_token"])
    entra.access_error = httpx2.Response(503, json={"error": "unavailable"})
    denied = await rpc("list_capabilities", wire=True)
    assert denied["isError"]
    browser.headers["Authorization"] = "Bearer " + issued["access_token"]
    with pytest.RaisesGroup(MCPError, flatten_subgroups=True):
        await discovery(browser, issued)
    assert not entra.api_calls


async def test_concurrent_same_server_principals_never_share_catalog(browser, service, entra):
    viewer_oid = "77777777-7777-4777-8777-777777777777"
    entra.roles_by_oid = {
        USER: [],
        OTHER: ["AgentControl.Admin"],
        viewer_oid: ["AgentControl.Viewer"],
    }
    _, employee = await tokens(browser)
    entra.oid = OTHER
    _, admin = await tokens(browser)
    entra.oid = viewer_oid
    _, viewer = await tokens(browser)

    async def read(issued):
        async with httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=service.app), base_url="https://mcp.example.test"
        ) as client:
            return await discovery(client, issued)

    employee_catalog, admin_catalog, viewer_catalog = await asyncio.gather(
        read(employee), read(admin), read(viewer)
    )
    assert len(employee_catalog["tools"]) == 3
    assert len(admin_catalog["tools"]) == len(PUBLIC_TOOLS)
    assert len(viewer_catalog["tools"]) == 38
    assert "execute_agent_control" not in {tool["name"] for tool in viewer_catalog["tools"]}
    assert not entra.api_calls


@pytest.mark.parametrize(
    "audience,status",
    [
        ("end_user", 403),
        ("adoption", 200),
        ("uploader", 200),
        ("admin", 200),
    ],
)
async def test_diagnostics_uses_api_current_staff_authority(browser, entra, audience, status):
    _, issued = await tokens(browser)
    entra.profiles_by_oid[USER] = entra.profiles[audience]
    response = await browser.get(
        "/diagnostics", headers={"Authorization": "Bearer " + issued["access_token"]}
    )
    assert response.status_code == status
    assert response.headers["cache-control"] == "no-store"
    assert not entra.api_calls
    assert (await browser.get("/health")).status_code == 200
    assert (await browser.get("/.well-known/oauth-authorization-server")).status_code == 200


async def test_guest_authority_denial_never_grants_native_catalog_or_diagnostics(browser, entra):
    entra.response_claims = {"roles": []}
    _, issued = await tokens(browser)
    entra.access_error = httpx2.Response(
        403, json={"code": "member_verification_failed", "message": "No eligible member."}
    )
    with pytest.RaisesGroup(MCPError, flatten_subgroups=True):
        await discovery(browser, issued)
    response = await browser.get(
        "/diagnostics", headers={"Authorization": "Bearer " + issued["access_token"]}
    )
    assert response.status_code == 403
    assert not entra.api_calls
    assert (await browser.get("/health")).status_code == 200
    assert (await browser.get("/.well-known/oauth-authorization-server")).status_code == 200


async def test_initialize_only_refresh_and_repeated_list_always_enter_api_admission(
    browser, entra
):
    entra.response_claims = {"roles": []}
    client, issued = await tokens(browser)
    browser.headers["Authorization"] = "Bearer " + issued["access_token"]
    async with streamable_http_client("https://mcp.example.test/mcp", http_client=browser) as (
        read,
        write,
    ):
        async with ClientSession(read, write) as session:
            await session.initialize()
            assert [
                request.url.path for request in entra.authority_calls
            ] == ["/api/mcp/access-profile", "/api/mcp/authenticated-entry"]
            assert not entra.api_calls
    browser.headers.pop("Authorization", None)
    refreshed = await browser.post(
        "/token",
        data={
            "client_id": client,
            "grant_type": "refresh_token",
            "refresh_token": issued["refresh_token"],
            "resource": "https://mcp.example.test/mcp",
        },
    )
    assert refreshed.status_code == 200
    browser.headers["Authorization"] = "Bearer " + refreshed.json()["access_token"]
    async with streamable_http_client("https://mcp.example.test/mcp", http_client=browser) as (
        read,
        write,
    ):
        async with ClientSession(read, write) as session:
            await session.initialize()
            for _ in range(2):
                assert len((await session.list_tools()).tools) == 3
    assert sum(
        request.url.path.endswith("authenticated-entry") for request in entra.authority_calls
    ) == 4
    assert not entra.api_calls


@pytest.mark.parametrize(
    "employee,champion", [(False, False), (True, False), (False, True), (True, True)]
)
async def test_privacy_revision_changes_native_guidance_and_metadata_immediately(
    browser, service, entra, employee, champion
):
    entra.privacy = {"hide_employee_details": employee, "hide_champion_employee": champion}
    _, issued = await tokens(browser)
    document = await discovery(browser, issued)
    description = next(
        tool["description"] for tool in document["tools"] if tool["name"] == "agent_catalog"
    )
    assert ("Creator/owner identity is privacy-withheld" in description) is employee
    assert ("Champion identity is privacy-withheld" in description) is champion
    browser.headers.pop("Authorization", None)
    response = await browser.post(
        "/internal/mcp-metadata",
        headers={"X-Agent-Control-Mcp-Metadata-Token": service.api.settings.metadata_key.decode()},
        json={**entra.profiles["admin"], "privacy": entra.privacy},
    )
    assert response.json()["tools"] == document["tools"]


def test_generated_profile_fixture_matches_the_current_canonical_policy():
    root = Path(__file__).resolve().parents[2]
    if not (root / "backend/src/services/mcpAccess.ts").exists():
        pytest.skip("Python-only image; canonical policy drift is checked in the source workspace.")
    generated = subprocess.run(
        ["node", "--import", "tsx", "tests/access_profiles.mjs"],
        cwd=root / "mcp",
        capture_output=True,
        text=True,
        check=True,
        env={**os.environ, "SESSION_SECRET": "synthetic-profile-fixture-" + "0" * 32},
    )
    saved = json.loads((root / "mcp/tests/fixtures/access_profiles.json").read_text())
    assert json.loads(generated.stdout) == saved


async def test_tightening_privacy_reprojects_the_same_token_and_one_action_family(
    browser, entra, source_fixtures
):
    from test_tools import response_for

    entra.response_claims = {"roles": []}
    _, issued = await tokens(browser)
    original = await discovery(browser, issued)
    assert "You may contact creator/owners" in json.dumps(original)
    profile = deepcopy(entra.profiles["end_user"])
    profile["operations"][0]["inputChoices"]["operation"] = ["search"]
    entra.profiles_by_oid[USER] = profile
    entra.privacy = {
        "hide_employee_details": True,
        "hide_champion_employee": True,
    }
    current = await discovery(browser, issued)
    assert [tool["name"] for tool in current["tools"]] == ["agent_catalog"]
    schema = current["tools"][0]
    assert "DiscoveryDetail" not in json.dumps(schema)
    assert schema["annotations"]["readOnlyHint"] and schema["annotations"]["idempotentHint"]
    assert "Creator/owner identity is privacy-withheld" in schema["description"]
    operation = next(
        branch.operation
        for tool in PUBLIC_TOOLS
        for branch in tool.branches
        if branch.operation.name == "search_agent_catalog"
    )
    body = response_for(operation, source_fixtures)
    entra.api_responses.append(httpx2.Response(200, json=body))
    rpc = await protocol_client(browser, issued["access_token"])
    result = await rpc("agent_catalog", {"action": "search", "input": {}}, wire=True)
    assert result["structuredContent"] == {"action": "search", "result": body}
    assert json.loads(result["content"][0]["text"]) == result["structuredContent"]
