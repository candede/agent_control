import asyncio
import base64
import gzip
import json
import time
from types import SimpleNamespace
from urllib.parse import parse_qs

import httpx2
import pytest
from conftest import OTHER, tokens
from fastmcp import Context
from pydantic import ValidationError

import agent_control_mcp.auth as auth
from agent_control_mcp.api import ApiInvocation
from agent_control_mcp.errors import AdapterError
from agent_control_mcp.inputs import AboutInput, Empty
from agent_control_mcp.origin import HEADER, origin_header


def context(name="client", agent="agent", request_id=12):
    return SimpleNamespace(
        request_context=SimpleNamespace(
            request_id=request_id,
            meta={"com.agentcontrol/origin": {"callingAgent": {"id": agent}}},
        ),
        session=SimpleNamespace(
            client_params=SimpleNamespace(
                client_info=SimpleNamespace(name=name, version="1"),
            )
        ),
    )


@pytest.fixture
async def invocation(browser, service):
    _, issued = await tokens(browser)
    upstream = await service.provider.load_access_token(issued["access_token"])
    return ApiInvocation(service.api, upstream, origin_header(context()))


async def test_real_sdk_obo_audience_and_typed_canonical_progress(invocation, entra):
    entra.api_responses.append(
        httpx2.Response(
            200,
            json={
                "progress": {
                    "checks": [{"capabilityId": "graph.directory.read", "state": "complete"}]
                },
            },
            headers={"X-Request-ID": "12345678-1234-4234-8234-123456789abc"},
        )
    )
    result = await invocation.get_check_progress(retry_failed=True)
    assert result.progress.checks[0].state == "complete"
    request = entra.api_calls[-1]
    assert request.url.path == "/api/capabilities/check-progress"
    assert request.url.query == b"retry=failed"
    assert request.headers["Authorization"].startswith("Bearer ")
    assert invocation.api_token.claims["aud"] == invocation.api.settings.api_client_id
    assert invocation.authenticated_client_id == invocation.upstream.client_id
    assert invocation.exchanges == 1
    assert invocation.requests == 1
    assert invocation.request_ids == ["12345678-1234-4234-8234-123456789abc"]
    assert invocation.api_token.token != invocation.upstream.token
    contents = b"".join(
        path.read_bytes() for path in invocation.api.store.root.rglob("*") if path.is_file()
    )
    assert invocation.api_token.token.encode() not in contents


async def test_nonempty_typed_capability_preserves_unknown_and_provider_evidence(invocation, entra):
    body = {
        "value": [
            {
                "definition": {
                    "id": "graph.directory.read",
                    "displayName": "Directory",
                    "purpose": "Saved people",
                    "provider": "Microsoft Graph",
                    "maturity": "v1.0",
                    "cloud": "global",
                    "audience": "https://graph.microsoft.com",
                    "mode": "delegated",
                    "permissions": ["User.ReadBasic.All"],
                    "providerRoles": [],
                    "licenses": [],
                    "configuration": [],
                    "sources": ["users"],
                    "dataClass": "directory",
                    "internalRoles": ["AgentControl.Viewer"],
                    "probe": {
                        "kind": "provider_read",
                        "adapterRegistered": True,
                        "description": "Read",
                    },
                },
                "decision": {
                    "capabilityId": "graph.directory.read",
                    "status": "unknown",
                    "authorized": False,
                    "fresh": False,
                    "previewQualification": "not_required",
                    "remediation": [],
                    "evidence": {"phase": "token_acquisition", "httpStatus": 403},
                },
                "enabled": True,
            }
        ]
    }
    entra.api_responses.append(httpx2.Response(200, json=body))
    result = await invocation.get_capabilities()
    assert result.model_dump(exclude_unset=True) == body
    assert result.value[0].decision.status == "unknown"


@pytest.mark.parametrize(
    "claims",
    [
        {"aud": "33333333-3333-3333-3333-333333333333"},
        {"aud": ["22222222-2222-2222-2222-222222222222", "another-audience"]},
        {"azp": "44444444-4444-4444-4444-444444444444"},
        {"oid": OTHER},
        {"tid": OTHER},
        {"nonce": "id-token"},
        {"scp": "Mcp.Access"},
        {"roles": []},
        {"roles": ["GlobalAdministrator"]},
        {"iat": int(time.time()) - 310},
        {"nbf": int(time.time()) + 120},
        {"exp": int(time.time()) - 1},
    ],
)
async def test_obo_denies_wrong_or_stale_authority(invocation, entra, claims):
    entra.response_claims = claims
    with pytest.raises(AdapterError) as error:
        await invocation.get_capabilities()
    assert error.value.status == 401
    assert entra.api_calls == []


async def test_claims_challenge_redaction_and_throttling(invocation, entra):
    challenge = json.dumps({"access_token": {"acrs": {"essential": True, "value": "c1"}}})
    entra.exchange_error = httpx2.Response(
        400,
        json={
            "error": "interaction_required",
            "claims": challenge,
            "error_description": "sensitive-provider-diagnostic",
            "access_token": "private",
        },
    )
    with pytest.raises(AdapterError) as error:
        await invocation.get_capabilities()
    assert error.value.details == {"claims": challenge}
    assert "sensitive-provider-diagnostic" not in repr(error.value.as_dict())
    entra.exchange_error = httpx2.Response(429, headers={"Retry-After": "37"})
    with pytest.raises(AdapterError) as throttled:
        await invocation.get_capabilities()
    assert throttled.value.retry_after_seconds == 37
    assert throttled.value.status == 429
    assert len(entra.api_calls) == 0


@pytest.mark.parametrize(
    "challenge",
    [
        {"id_token": {"acrs": {"value": "c1"}}},
        {"access_token": {}, "id_token": {}},
        {},
        {"access_token": []},
        {"access_token": {"acrs": {"credential": "private"}}},
        {"access_token": {"bad-name": {"value": "c1"}}},
        {"access_token": {"acrs": {"essential": "true"}}},
        {"access_token": {"acrs": {"value": "sensitive provider diagnostic"}}},
        {"access_token": {"acrs": {"values": ["c1", None]}}},
    ],
)
async def test_obo_challenges_share_the_api_access_token_allowlist(invocation, entra, challenge):
    entra.exchange_error = httpx2.Response(
        400,
        json={"error": "interaction_required", "claims": json.dumps(challenge)},
    )
    with pytest.raises(AdapterError) as error:
        await invocation.get_capabilities()
    assert error.value.status == 401
    assert error.value.code == "reauthorization_required"
    assert error.value.details is None
    assert entra.api_calls == []


async def test_obo_upstream_outage_remains_retryable_and_redacted(
    invocation,
    entra,
    monkeypatch,
):
    entra.exchange_error = httpx2.Response(
        503,
        text="sensitive provider error body",
        headers={"Retry-After": "20"},
    )
    with pytest.raises(AdapterError) as error:
        await invocation.get_capabilities()
    assert error.value.status == 503
    assert error.value.retry_after_seconds == 20
    assert "sensitive provider" not in str(error.value.as_dict())

    async def timed_out(*args, **kwargs):
        raise httpx2.ReadTimeout("sensitive transport diagnostics")

    monkeypatch.setattr(invocation.api.http, "send", timed_out)
    with pytest.raises(AdapterError) as deadline:
        await invocation.get_capabilities()
    assert deadline.value.status == 504
    assert "sensitive transport" not in str(deadline.value.as_dict())


@pytest.mark.parametrize("status", [400, 401, 403, 404, 409, 413, 429, 503, 504])
async def test_problem_status_code_safe_details_and_no_false_empty_success(
    invocation, entra, status
):
    entra.api_responses.append(
        httpx2.Response(
            status,
            json={
                "status": status,
                "code": "stale_selection",
                "detail": "Exact selection expired.",
                "details": {"selectionId": "saved-selection", "access_token": "secret"},
            },
            headers={
                "content-type": "application/problem+json",
                "Retry-After": "60",
                "X-Request-ID": "12345678-1234-4234-8234-123456789abc",
            },
        )
    )
    with pytest.raises(AdapterError) as error:
        await invocation.get_capabilities()
    assert error.value.status == status
    assert error.value.code == "stale_selection"
    assert error.value.details == {"selectionId": "saved-selection"}
    assert error.value.request_id == "12345678-1234-4234-8234-123456789abc"
    assert len(entra.api_calls) == 1


async def test_allowlist_malformed_output_bounds_and_safe_read_retry(invocation, entra):
    with pytest.raises(AdapterError, match="unsupported_operation"):
        await invocation.call("https://attacker.example.test", Empty())
    assert not hasattr(invocation, "request")
    with pytest.raises(AdapterError, match="invalid_request"):
        await invocation.get_check_progress(retry_failed="failed")
    entra.api_responses.extend(
        [
            httpx2.Response(429, headers={"Retry-After": "0"}),
            httpx2.Response(200, json={"progress": None}),
        ]
    )
    assert (await invocation.get_check_progress()).progress is None
    assert invocation.requests == 2
    entra.api_responses.append(httpx2.Response(200, json={"not_the_contract": []}))
    with pytest.raises(AdapterError, match="invalid_api_response"):
        await invocation.get_capabilities()
    entra.api_responses.append(httpx2.Response(200, content=b"x" * 524289))
    with pytest.raises(AdapterError, match="output_limit"):
        await invocation.get_capabilities()
    entra.api_responses.append(httpx2.Response(302, headers={"Location": "https://attacker.test"}))
    with pytest.raises(AdapterError) as redirected:
        await invocation.get_capabilities()
    assert redirected.value.status == 302
    assert all(request.url.host == "api.example.test" for request in entra.api_calls)
    entra.api_responses.append(
        httpx2.Response(200, headers={"Content-Encoding": "identity"}, json={"value": []})
    )
    assert (await invocation.get_capabilities()).value == []
    for request in entra.api_calls:
        assert request.headers["Accept-Encoding"] == "identity"
    entra.api_responses.append(
        httpx2.Response(
            200,
            headers={"Content-Encoding": "gzip"},
            content=gzip.compress(b'{"value":[]}'),
        )
    )
    with pytest.raises(AdapterError, match="invalid_api_response"):
        await invocation.get_capabilities()


async def test_expiry_exchange_budget_and_invocation_deadline(invocation, entra):
    await invocation.get_capabilities()
    invocation.api_token.claims["iat"] = int(time.time()) - 301
    await invocation.get_capabilities()
    assert invocation.exchanges == 2
    invocation.api_token.claims["iat"] = int(time.time()) - 301
    with pytest.raises(AdapterError, match="exchange budget"):
        await invocation.get_capabilities()
    invocation.started -= 61
    with pytest.raises(AdapterError, match="invocation_deadline"):
        await invocation.get_capabilities()


async def test_output_byte_limit_accepts_exact_ceiling_not_one_byte_more(invocation):
    invocation.account_output(524287)
    invocation.account_output(1)
    assert invocation.output_bytes == 524288
    with pytest.raises(AdapterError, match="output_limit"):
        invocation.account_output(1)


async def test_bounded_concurrency_coalesced_exchange_request_budget_and_cancellation(
    invocation,
    entra,
):
    entra.block_api = asyncio.Event()
    tasks = [asyncio.create_task(invocation.get_check_progress()) for _ in range(8)]
    for _ in range(200):
        if len(entra.api_calls) == 4:
            break
        await asyncio.sleep(0.001)
    assert len(entra.api_calls) == 4
    assert invocation.exchanges == 1
    entra.block_api.set()
    await asyncio.gather(*tasks)
    assert invocation.requests == 8
    with pytest.raises(AdapterError, match="invocation_budget"):
        await invocation.get_capabilities()
    invocation.requests = 0
    entra.block_api.clear()
    pending = asyncio.create_task(invocation.get_capabilities())
    await asyncio.sleep(0.01)
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    assert invocation.requests == 1


async def test_cookie_jar_never_crosses_principals_and_revocation_fences_after_await(
    invocation,
    entra,
):
    invocation.api.http.cookies.set("session", "not-an-api-credential", domain="api.example.test")
    await invocation.get_capabilities()
    assert "Cookie" not in entra.api_calls[-1].headers
    entra.block_api = asyncio.Event()
    pending = asyncio.create_task(invocation.get_capabilities())
    for _ in range(100):
        if len(entra.api_calls) == 2:
            break
        await asyncio.sleep(0.001)
    await invocation.api.store.put(
        auth.TenantAzureProvider.token_key(invocation.upstream.reference),
        {"revoked": True},
        collection="revoked",
        ttl=60,
    )
    entra.block_api.set()
    with pytest.raises(AdapterError) as error:
        await pending
    assert error.value.status == 401


async def test_exact_about_page_preserves_sources_cursor_and_unknowns(invocation, entra):
    request = AboutInput(
        recordId="agent:12345678-1234-4234-8234-123456789abc",
        selectionId="12345678-1234-4234-8234-123456789abc",
        sourceScopeId="12345678-1234-4234-8234-123456789abd",
        sourceIdentity="CaseSensitive_Source",
        field="native",
        cursor="opaque-page-2",
    )
    body = {
        "recordId": request.recordId,
        "sourceScopeId": request.sourceScopeId,
        "sourceIdentity": request.sourceIdentity,
        "generationId": "exact-generation",
        "field": "native",
        "state": "missing",
        "source": "power_platform",
        "provenance": {"path": None, "maturity": "unknown"},
        "observedAt": "2026-10-16T00:00:00Z",
        "text": None,
        "totalBytes": 0,
        "returnedBytes": 0,
        "nextCursor": "opaque-page-3",
        "selection": {
            "id": request.selectionId,
            "revision": "exact-revision",
            "expiresAt": "2026-10-16T00:10:00Z",
            "evaluatedAt": "2026-10-16T00:00:00Z",
            "validatedAt": "2026-10-16T00:00:00Z",
            "publicationRevisions": {
                "graph_packages": "a" * 64,
                "power_platform": "b" * 64,
                "users": "c" * 64,
            },
        },
    }
    entra.api_responses.append(httpx2.Response(200, json=body))
    result = await invocation.get_agent_about(request)
    assert result.model_dump() == body
    query = parse_qs(entra.api_calls[-1].url.query.decode())
    assert query["cursor"] == ["opaque-page-2"]
    assert query["sourceIdentity"] == ["CaseSensitive_Source"]
    with pytest.raises(ValidationError):
        AboutInput(**{**request.model_dump(), "recordId": "../configuration"})


@pytest.mark.parametrize(
    "reported",
    [
        {"channel": "authenticated"},
        {"client": {"evidence": "authenticated"}},
        {"callingAgent": {"id": "a\nbad"}},
        {"callingAgent": {"id": "a" * 257}},
        {"client": {"version": "a" * 65}},
    ],
)
def test_origin_reserved_authority_and_unicode_bounds(reported):
    ctx = context()
    ctx.request_context.meta = {"com.agentcontrol/origin": reported}
    with pytest.raises(AdapterError):
        origin_header(ctx)


def test_origin_missing_unknown_and_invalid_trace_omission():
    ctx = context(request_id="unsafe trace\n")
    ctx.session.client_params = None
    ctx.request_context.meta = None
    assert json.loads(base64.urlsafe_b64decode(origin_header(ctx) + "==")) == {"version": 1}


async def test_real_sdk_context_concurrent_principal_client_and_agent_attribution(
    browser,
    service,
    entra,
):
    @service.mcp.tool(name="synthetic_phase05_probe")
    async def probe(ctx: Context) -> dict:
        async with service.api.invocation(ctx) as invocation:
            await invocation.get_check_progress()
            return {"authenticatedClient": invocation.authenticated_client_id}

    first_client, first = await tokens(browser)
    entra.oid = OTHER
    second_client, second = await tokens(browser)

    async def call(issued, client_name, agent):
        headers = {
            "Authorization": f"Bearer {issued['access_token']}",
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
                    "clientInfo": {"name": client_name, "version": "1"},
                },
            },
        )
        assert initialized.status_code == 200
        headers["mcp-session-id"] = initialized.headers["mcp-session-id"]
        await browser.post(
            "/mcp",
            headers=headers,
            json={
                "jsonrpc": "2.0",
                "method": "notifications/initialized",
            },
        )
        response = await browser.post(
            "/mcp",
            headers=headers,
            json={
                "jsonrpc": "2.0",
                "id": agent,
                "method": "tools/call",
                "params": {
                    "name": "synthetic_phase05_probe",
                    "arguments": {},
                    "_meta": {"com.agentcontrol/origin": {"callingAgent": {"id": agent}}},
                },
            },
        )
        assert response.status_code == 200, response.text
        assert not response.json()["result"].get("isError"), response.text
        return response.json()["result"]

    a, b = await asyncio.gather(call(first, "first", "agent-a"), call(second, "second", "agent-b"))
    assert a["structuredContent"]["authenticatedClient"] == first_client
    assert b["structuredContent"]["authenticatedClient"] == second_client
    descriptors = [
        json.loads(base64.urlsafe_b64decode(request.headers[HEADER] + "=="))
        for request in entra.api_calls
    ]
    assert {
        (item["client"]["name"], item["callingAgent"]["id"], item["mcpCallId"])
        for item in descriptors
    } == {("first", "agent-a", "agent-a"), ("second", "agent-b", "agent-b")}
    assert all(
        "integrationClientId" not in item and "evidence" not in json.dumps(item)
        for item in descriptors
    )


async def test_safe_error_redaction_request_deadline_and_closed_invocation(
    invocation,
    entra,
    monkeypatch,
):
    secret = invocation.api.settings.client_secret
    entra.api_responses.append(
        httpx2.Response(
            403,
            json={
                "status": 403,
                "code": "forbidden",
                "detail": f"Do not expose {secret}",
                "details": {"unsafe": invocation.upstream.token, "cursor": "preserve-me"},
            },
            headers={"content-type": "application/problem+json"},
        )
    )
    with pytest.raises(AdapterError) as error:
        await invocation.get_capabilities()
    serialized = json.dumps(error.value.as_dict())
    assert secret not in serialized
    assert invocation.upstream.token not in serialized
    assert error.value.details["cursor"] == "preserve-me"
    invocation.started = time.monotonic() - 59.99
    entra.block_api = asyncio.Event()
    with pytest.raises(AdapterError) as deadline:
        await invocation.get_capabilities()
    assert deadline.value.status == 504
    monkeypatch.setattr(auth, "get_access_token", lambda: invocation.upstream)
    async with invocation.api.invocation(context()) as bounded:
        assert bounded.upstream == invocation.upstream
    assert bounded.closed and bounded.api_token is None
    with pytest.raises(AdapterError):
        await bounded.get_capabilities()


def test_allowlist_is_a_subset_of_the_canonical_operation_table():
    import re
    from pathlib import Path

    from agent_control_mcp.tools import OPERATIONS

    document = Path("../docs/mcp-integration.md").read_text()
    for operation in OPERATIONS:
        path = re.sub(r"\{(\w+)\}", r":\1", operation.path)
        assert f"| `{operation.method} {path}` |" in document
        assert f"| {operation.name} |" in document
