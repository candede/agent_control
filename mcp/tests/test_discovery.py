"""Client-visible discovery measurements and native schema/alias checks."""

import asyncio
import hashlib
import json
import os
from importlib.metadata import version
from pathlib import Path

import pytest
from conftest import tokens
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.types import PaginatedRequestParams, TextContent

from agent_control_mcp.domains import PUBLIC_TOOLS
from agent_control_mcp.errors import AdapterError
from agent_control_mcp.instructions import INSTRUCTIONS
from agent_control_mcp.tools import OPERATIONS, operation_named

BASELINE = json.loads(
    (
        Path(__file__).resolve().parents[2]
        / "docs/mcp-interface-and-settings/completions/01-discovery-baseline.measurement.json"
    ).read_text()
)
CORPUS = json.loads(
    (
        Path(__file__).resolve().parents[2] / "backend/scripts/fixtures/mcp-workflows.json"
    ).read_text()
)
RETIRED_OPERATIONS = {
    "get_agent_investigation",
    "resolve_agent_identity",
    "list_agent_purview_records",
    "get_purview_catalog",
    "start_purview_search",
    "list_purview_jobs",
    "get_purview_job",
    "resume_purview_search",
    "cancel_purview_search",
    "delete_purview_cache",
    "list_purview_records",
    "get_hunting_catalog",
    "start_hunt",
    "list_hunting_jobs",
    "get_hunting_job",
    "resume_hunt",
    "cancel_hunt",
    "delete_hunting_cache",
    "list_hunting_rows",
}


async def test_complete_sdk_discovery(browser, entra):
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
            first = CORPUS["discovery"]["firstSavedRead"]
            result = await session.call_tool(first["tool"], {"request": first["request"]})
            assert not result.is_error
            assert result.structured_content == {"action": "list", "result": {"value": []}}
            assert len(entra.api_calls) == 1
            unadvertised = (
                ({op.name for op in OPERATIONS} - {tool.name for tool in PUBLIC_TOOLS})
                | RETIRED_OPERATIONS
                | {"purview", "hunting"}
            )
            for name in sorted(unadvertised):
                rejected = await session.call_tool(
                    name,
                    {"request": {}},
                )
                assert rejected.is_error
                assert "not permitted" in "".join(
                    block.text for block in rejected.content if isinstance(block, TextContent)
                )
            assert len(entra.api_calls) == 1
    document = {
        "initialize": initialized.model_dump(mode="json", by_alias=True, exclude_none=True),
        "tools": [tool.model_dump(mode="json", by_alias=True, exclude_none=True) for tool in tools],
    }
    data = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    measurement = {
        "sdk": version("mcp"),
        "serializer": 'model_dump(mode="json", by_alias=True, exclude_none=True); '
        'json.dumps(ensure_ascii=False, separators=(",", ":")).encode("utf-8")',
        "tools": len(tools),
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "instructions": initialized.instructions,
        "operations": [
            {
                "name": op.name,
                "method": op.method,
                "path": op.path,
                "request": op.request.__name__,
                "response": op.response.__name__,
                "provider": op.provider,
                "destructive": op.destructive,
                "idempotent": op.idempotent,
            }
            for op in OPERATIONS
        ],
    }
    if destination := os.environ.get("MCP_DISCOVERY_EVIDENCE"):
        path = Path(destination)
        await asyncio.to_thread(path.parent.mkdir, parents=True, exist_ok=True)
        await asyncio.to_thread(path.write_bytes, data)
        await asyncio.to_thread(
            path.with_suffix(".measurement.json").write_text,
            json.dumps(measurement, ensure_ascii=False, indent=2) + "\n",
        )
    print(json.dumps({key: value for key, value in measurement.items() if key != "operations"}))
    assert len(tools) == len({tool.name for tool in tools}) == len(PUBLIC_TOOLS)
    assert measurement["sdk"] == BASELINE["sdk"]
    assert measurement["serializer"] == BASELINE["serializer"]
    assert [
        operation
        for operation in measurement["operations"]
        if operation["path"] not in {"/api/discovery/read", "/api/discovery/preview"}
    ] == [
        operation
        for operation in BASELINE["operations"]
        if operation["name"] not in RETIRED_OPERATIONS
    ]
    assert initialized.instructions == INSTRUCTIONS
    assert 0 < len(INSTRUCTIONS.split()) <= 800


def test_complete_unique_mapping_and_unchanged_safety():
    branches = [branch for tool in PUBLIC_TOOLS for branch in tool.branches]
    assert len(branches) == len({branch.operation.name for branch in branches}) == len(OPERATIONS)
    assert {branch.operation.name for branch in branches} == {op.name for op in OPERATIONS}
    for tool in PUBLIC_TOOLS:
        assert len({branch.action for branch in tool.branches}) == len(tool.branches)
        assert (
            len(
                {
                    (
                        op.method == "GET" and not op.provider,
                        op.provider,
                        op.destructive,
                        op.idempotent or (op.method == "GET" and not op.provider),
                    )
                    for op in (branch.operation for branch in tool.branches)
                }
            )
            == 1
        ), tool.name


def test_parked_investigation_bindings_are_removed_not_hidden():
    assert len(RETIRED_OPERATIONS) == 19
    assert not RETIRED_OPERATIONS.intersection(op.name for op in OPERATIONS)
    assert not {"purview", "hunting"}.intersection(tool.name for tool in PUBLIC_TOOLS)
    assert not any(
        op.path.startswith(
            ("/api/agent-inventory/investigations/", "/api/audit-search/", "/api/hunting/")
        )
        for op in OPERATIONS
    )
    for name in RETIRED_OPERATIONS:
        with pytest.raises(AdapterError) as rejected:
            operation_named(name)
        assert rejected.value.code == "unsupported_operation"
    assert not any(word in INSTRUCTIONS.lower() for word in ("defender", "purview", "hunting"))


async def test_family_variants_reject_invalid_actions_and_cross_variant_fields(rpc, entra):
    for request in (
        {},
        {"action": "unknown", "input": {}},
        {"action": "about", "input": {}},
        {"action": "health", "input": {"selectionId": "12345678-1234-4234-8234-123456789abc"}},
        {"action": "health", "input": {}, "path": "/api/capabilities"},
        {"action": "health", "input": {"url": "https://graph.microsoft.com"}},
    ):
        result = await rpc("inventory", request, wire=True)
        assert result["isError"]
    assert not entra.api_calls
