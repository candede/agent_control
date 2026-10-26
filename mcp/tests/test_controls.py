import asyncio
import base64
import copy
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import parse_qs, quote

import httpx2
import pytest
from pydantic import ValidationError
from test_tools import GUID, RECORD, SOURCE, response_for

from agent_control_mcp import control_inputs as ci
from agent_control_mcp.auth import TenantAzureProvider
from agent_control_mcp.inputs import ResolvePrincipals
from agent_control_mcp.tools import OPERATIONS, operation_named

HASH = "f" * 64
PACKAGE = "Studio/Package?#Ω"
KEY = "stable-operation-001"
PRINCIPAL = {"resourceType": "user", "resourceId": SOURCE}
RECEIPT = {"receiptId": GUID, "confirmationHash": HASH, "idempotencyKey": KEY}
PACKAGE_RECEIPT = {"confirmationHash": HASH, "idempotencyKey": KEY}
ACCESS = {
    "target": "availability",
    "mode": "replace",
    "scope": "specific",
    "principals": [PRINCIPAL],
}
STUDIO = {"action": "quarantine", "snapshotId": GUID, "resourceNativeIds": ["ENV:Native/Case"]}

# Independent browser/API expectations, not paths read from the production catalog.
CASES = [
    (
        "preview_agent_control",
        "POST",
        "/api/agent-controls/preview",
        {"selectionId": GUID, "recordIds": [RECORD, "report:unmanaged"], "action": "block"},
    ),
    ("execute_agent_control", "POST", "/api/agent-controls/execute", RECEIPT),
    ("get_agent_control", "GET", f"/api/agent-controls/{GUID}", {"receiptId": GUID}),
    (
        "count_package_targets",
        "POST",
        "/api/agents/mutation-selection",
        {"selectionId": GUID, "ids": [PACKAGE]},
    ),
    (
        "preview_package_control",
        "POST",
        "/api/agents/mutation-preview",
        {"ids": [PACKAGE], "action": "block", "mutationScope": "single"},
    ),
    ("block_packages", "POST", "/api/agents/block", {"ids": [PACKAGE], **PACKAGE_RECEIPT}),
    ("unblock_packages", "POST", "/api/agents/unblock", {"ids": [PACKAGE], **PACKAGE_RECEIPT}),
    (
        "block_selected_packages",
        "POST",
        "/api/agents/block-all",
        {"selectionId": GUID, **PACKAGE_RECEIPT},
    ),
    (
        "unblock_selected_packages",
        "POST",
        "/api/agents/unblock-all",
        {"selectionId": GUID, **PACKAGE_RECEIPT},
    ),
    (
        "block_package",
        "POST",
        "/api/agents/" + quote(PACKAGE, safe="") + "/block",
        {"id": PACKAGE, **PACKAGE_RECEIPT},
    ),
    (
        "unblock_package",
        "POST",
        "/api/agents/" + quote(PACKAGE, safe="") + "/unblock",
        {"id": PACKAGE, **PACKAGE_RECEIPT},
    ),
    (
        "update_packages_access",
        "POST",
        "/api/agents/access",
        {"ids": [PACKAGE], **ACCESS, **PACKAGE_RECEIPT},
    ),
    (
        "update_package_access",
        "PATCH",
        "/api/agents/" + quote(PACKAGE, safe="") + "/access",
        {"id": PACKAGE, **ACCESS, **PACKAGE_RECEIPT},
    ),
    ("list_package_control_jobs", "GET", "/api/agents/bulk-jobs", {"limit": 20}),
    ("get_package_control_job", "GET", f"/api/agents/bulk-jobs/{GUID}", {"id": GUID}),
    (
        "list_package_control_items",
        "GET",
        f"/api/agents/bulk-jobs/{GUID}/items",
        {"id": GUID, "revision": "7", "limit": 50, "cursor": "signed:items+2/Case"},
    ),
    ("cancel_package_control", "POST", f"/api/agents/bulk-jobs/{GUID}/cancel", {"id": GUID}),
    (
        "resume_package_control",
        "POST",
        f"/api/agents/bulk-jobs/{GUID}/resume",
        {"id": GUID, "confirmed": True},
    ),
    ("reconcile_package_control", "POST", f"/api/agents/bulk-jobs/{GUID}/reconcile", {"id": GUID}),
    (
        "get_studio_status",
        "GET",
        "/api/quarantine/status",
        {"snapshotId": GUID, "nativeId": "ENV:Native/Case", "force": True},
    ),
    ("preview_studio_control", "POST", "/api/quarantine/preview", {**STUDIO, "forceStatus": True}),
    ("execute_studio_control", "POST", "/api/quarantine/jobs", {**STUDIO, **PACKAGE_RECEIPT}),
    ("list_studio_control_jobs", "GET", "/api/quarantine/jobs", {"limit": 20}),
    ("get_studio_control_job", "GET", f"/api/quarantine/jobs/{GUID}", {"id": GUID}),
    ("cancel_studio_control", "POST", f"/api/quarantine/jobs/{GUID}/cancel", {"id": GUID}),
    (
        "resume_studio_control",
        "POST",
        f"/api/quarantine/jobs/{GUID}/resume",
        {"id": GUID, "confirmed": True},
    ),
    ("reconcile_studio_control", "POST", f"/api/quarantine/jobs/{GUID}/reconcile", {"id": GUID}),
    (
        "list_studio_control_audit",
        "GET",
        "/api/quarantine/audit",
        {"limit": 100, "originChannel": "mcp", "originCallingAgentId": "caller-1"},
    ),
    (
        "search_access_principals",
        "GET",
        "/api/directory/principals",
        {"search": "Guest", "limit": 25},
    ),
    (
        "resolve_access_principals",
        "POST",
        "/api/directory/principals/resolve",
        {"principals": [PRINCIPAL]},
    ),
]


def browser_calls(cases):
    completed = subprocess.run(
        ["node", "--import", "tsx", "tests/browser_controls.mjs"],
        cwd=Path(__file__).resolve().parents[1],
        input=json.dumps(cases),
        capture_output=True,
        text=True,
        check=True,
        env={**os.environ, "TSX_DISABLE_CACHE": "1"},
    )
    return json.loads(completed.stdout)


async def test_every_control_http_capture_matches_current_browser_and_canonical_contract(
    rpc, entra, source_fixtures
):
    fixtures = []
    for name, _, _, request in CASES:
        expected = response_for(operation_named(name), source_fixtures["complete"])
        fixtures.append({"name": name, "request": request, "response": expected})
    web = browser_calls(fixtures)
    assert len(web) == len(CASES) == 30
    for (name, method, path, request), fixture, browser in zip(CASES, fixtures, web, strict=True):
        entra.api_responses.append(httpx2.Response(200, json=fixture["response"]))
        result = await rpc(name, request)
        assert not result.get("isError"), (name, result)
        assert result["structuredContent"] == fixture["response"] == browser["request"]["result"]
        sent = entra.api_calls[-1]
        assert sent.method == method == browser["request"]["method"], name
        assert sent.url.raw_path.decode().split("?")[0] == path == browser["request"]["path"], name
        body = json.loads(sent.content) if sent.content else {}
        query = {key: value[0] for key, value in parse_qs(sent.url.query.decode()).items()}
        assert body == browser["request"]["body"], name
        assert query == browser["request"]["query"], name
        assert sent.headers.get("Idempotency-Key") == request.get("idempotencyKey"), name
        assert "confirmationHash" not in sent.headers
        assert "csrf" not in " ".join(sent.headers).lower()
        assert "cookie" not in sent.headers
    assert len(entra.api_calls) == 30


@pytest.mark.parametrize("action", ["block", "unblock"])
async def test_generic_both_provider_directions_exact_ineligible_already_and_expiry_evidence(
    action, rpc, entra, source_fixtures
):
    expected = copy.deepcopy(source_fixtures["controlPreview"])
    expected.update(
        action=action,
        targetCount=4,
        eligibleCount=2,
        ineligibleCount=2,
        alreadyInStateCount=1,
        expiresAt="2026-10-16T00:00:01Z",
    )
    package = {
        "provider": "graph_packages",
        "action": action,
        "id": PACKAGE,
        "displayName": "Studio-linked explicit package",
        "alreadyInState": True,
    }
    studio = {
        "provider": "power_platform",
        "action": "quarantine" if action == "block" else "unquarantine",
        "id": "Native/Case",
        "displayName": "Native Studio",
        "environmentId": "ENV/Case",
        "botId": SOURCE,
        "alreadyInState": False,
    }
    expected["targets"] = [
        {
            "recordId": RECORD,
            "displayName": package["displayName"],
            "eligible": True,
            "reason": None,
            "effects": [package],
        },
        {
            "recordId": "agent:" + SOURCE,
            "displayName": "Native Studio",
            "eligible": True,
            "reason": None,
            "effects": [studio],
        },
        {
            "recordId": "report:unmanaged",
            "displayName": None,
            "eligible": False,
            "reason": "report_only",
            "effects": [],
        },
        {
            "recordId": "agent:" + "a" * 8 + "-aaaa-aaaa-aaaa-" + "a" * 12,
            "displayName": None,
            "eligible": False,
            "reason": "quarantine_native_identity_unavailable",
            "effects": [],
        },
    ]
    entra.api_responses.append(httpx2.Response(200, json=expected))
    request = {
        "selectionId": GUID,
        "recordIds": [row["recordId"] for row in expected["targets"]],
        "action": action,
    }
    result = await rpc("preview_agent_control", request)
    assert result["structuredContent"] == expected
    assert json.loads(entra.api_calls[-1].content) == request
    assert (
        len(entra.api_calls) == 1
    )  # No Python target joins, expiry adjustment or effect dispatch.


@pytest.mark.parametrize("action", ["quarantine", "unquarantine"])
async def test_explicit_studio_directions_keep_unknown_inventory_dates_and_exact_identity(
    action, rpc, entra, source_fixtures
):
    expected = copy.deepcopy(source_fixtures["quarantinePreview"])
    expected["summary"]["operation"] = action
    expected["summary"]["targets"][0].update(
        inventoryState=None, requestedState=action == "quarantine"
    )
    expected["statuses"][0]["inventory"].update(isQuarantined=None, quarantinedAt=None)
    entra.api_responses.append(httpx2.Response(200, json=expected))
    request = {**STUDIO, "action": action}
    result = await rpc("preview_studio_control", request)
    assert result["structuredContent"] == expected
    assert json.loads(entra.api_calls[-1].content) == request
    job = copy.deepcopy(source_fixtures["quarantineJob"])
    job["action"] = action
    entra.api_responses.append(httpx2.Response(202, json=job))
    submitted = await rpc("execute_studio_control", {**request, **PACKAGE_RECEIPT})
    assert submitted["structuredContent"] == job
    assert entra.api_calls[-1].url.path == "/api/quarantine/jobs"
    assert entra.api_calls[-1].headers["Idempotency-Key"] == KEY


@pytest.mark.parametrize("target", ["availability", "installation"])
@pytest.mark.parametrize(
    "mode,scope", [("add", "specific"), ("replace", "specific"), ("replace", "none")]
)
async def test_access_preview_flattens_exact_web_intent_without_inventing_untouched_principals(
    target, mode, scope, rpc, entra, source_fixtures
):
    request = {
        "selectionId": GUID,
        "recordIds": [RECORD],
        "action": "update-" + target,
        "mutationScope": "bulk",
        "target": target,
        "mode": mode,
        "scope": scope,
        "principals": [] if scope == "none" else [PRINCIPAL],
    }
    expected = copy.deepcopy(source_fixtures["packagePreview"])
    before = {
        "kind": "access",
        "availableTo": "some",
        "deployedTo": "none",
        "allowedUsersAndGroups": [PRINCIPAL],
        "acquireUsersAndGroups": [],
    }
    expected["summary"]["targets"][0].update(currentState=before, requestedState=before)
    expected["summary"]["operation"] = request["action"]
    entra.api_responses.append(httpx2.Response(200, json=expected))
    result = await rpc("preview_package_control", request)
    assert result["structuredContent"] == expected
    assert json.loads(entra.api_calls[-1].content) == request
    web = browser_calls(
        [{"name": "preview_package_control", "request": request, "response": expected}]
    )
    assert web[0]["request"]["body"] == request
    access = {key: request[key] for key in ("target", "mode", "scope", "principals")}
    job = copy.deepcopy(source_fixtures["packageJob"])
    job.update(action="update-" + target, accessUpdate=access)
    job.pop("targetBlockedState", None)
    job.pop("reassignUserId", None)
    submission = {"ids": [PACKAGE], **access, **PACKAGE_RECEIPT}
    entra.api_responses.append(httpx2.Response(202, json=job))
    assert (await rpc("update_packages_access", submission))["structuredContent"] == job
    assert json.loads(entra.api_calls[-1].content) == {
        key: value for key, value in submission.items() if key != "idempotencyKey"
    }
    if mode == "replace":
        single = {"id": PACKAGE, **access, **PACKAGE_RECEIPT}
        entra.api_responses.append(httpx2.Response(202, json=job))
        assert (await rpc("update_package_access", single))["structuredContent"] == job
        assert entra.api_calls[-1].method == "PATCH"
        assert json.loads(entra.api_calls[-1].content) == {
            **access,
            "confirmationHash": HASH,
        }


@pytest.mark.parametrize("name", [row[0] for row in CASES if row[1] in {"POST", "PATCH"}])
async def test_every_state_changing_control_or_lookup_is_single_attempt_on_retryable_api_error(
    name, rpc, entra
):
    request = next(row[3] for row in CASES if row[0] == name)
    entra.api_responses.append(
        httpx2.Response(
            503,
            headers={
                "Content-Type": "application/problem+json",
                "Retry-After": "0",
            },
            json={"status": 503, "code": "provider_unavailable", "detail": "Recover explicitly."},
        )
    )
    result = await rpc(name, request)
    assert result["isError"]
    assert json.loads(result["content"][0]["text"])["code"] == "provider_unavailable"
    assert len(entra.api_calls) == 1


@pytest.mark.parametrize(
    "status,code",
    [
        (403, "missing_internal_role"),
        (401, "authorization_required"),
        (401, "session_invalidated"),
        (403, "scope_mismatch"),
        (409, "confirmation_mismatch"),
        (409, "control_receipt_expired"),
        (409, "child_admission_expired"),
        (409, "idempotency_mismatch"),
        (409, "inventory_identity_ambiguous"),
        (409, "unpreservable_access_scope"),
        (409, "selection_invalidated"),
    ],
)
async def test_api_authority_receipt_revocation_and_restart_errors_have_browser_parity_no_retry(
    status, code, rpc, entra
):
    problem = {
        "status": status,
        "code": code,
        "detail": "Exact current authority/receipt required.",
    }
    entra.api_responses.append(
        httpx2.Response(
            status,
            headers={
                "Content-Type": "application/problem+json",
                "X-Request-ID": GUID,
            },
            json=problem,
        )
    )
    result = await rpc("execute_agent_control", RECEIPT)
    error = json.loads(result["content"][0]["text"])
    web = browser_calls(
        [
            {
                "name": "execute_agent_control",
                "request": RECEIPT,
                "response": problem,
                "status": status,
            }
        ]
    )[0]
    assert {key: error[key] for key in ("status", "code", "requestId")} == web["error"]
    assert len(entra.api_calls) == 1


async def test_concurrent_exact_receipt_keys_and_current_origins_do_not_replace_accepted_initiator(
    rpc, entra, source_fixtures
):
    expected = copy.deepcopy(source_fixtures["complete"]["controlExecution"])
    expected["origin"]["channel"] = "webapp"
    expected["origin"]["callingAgent"]["id"] = {"value": "first-initiator", "evidence": "reported"}
    entra.api_responses.extend(httpx2.Response(202, json=expected) for _ in range(2))
    results = await asyncio.gather(
        rpc("execute_agent_control", RECEIPT, calling_agent="current-client-one"),
        rpc("execute_agent_control", RECEIPT, calling_agent="current-client-two"),
    )
    assert [result["structuredContent"] for result in results] == [expected, expected]
    for sent in entra.api_calls:
        assert json.loads(sent.content) == {"receiptId": GUID, "confirmationHash": HASH}
        assert sent.headers["Idempotency-Key"] == KEY
    origins = [
        json.loads(base64.urlsafe_b64decode(sent.headers["X-Agent-Control-Mcp-Context"] + "=="))
        for sent in entra.api_calls
    ]
    assert {origin["callingAgent"]["id"] for origin in origins} == {
        "current-client-one",
        "current-client-two",
    }
    assert len({origin["mcpCallId"] for origin in origins}) == 2
    assert not any("first-initiator" in json.dumps(origin) for origin in origins)


async def test_partial_children_authorization_wait_and_uncertain_readback_are_not_projected_success(
    rpc, entra, source_fixtures
):
    execution = copy.deepcopy(source_fixtures["controlExecution"])
    child = execution["children"][0]
    child.update(
        provider="graph_packages",
        status="partial",
        accepted=True,
        jobId=GUID,
        final=True,
        verified=False,
        verification="readback_unknown",
        errorCode=None,
        itemsUrl=f"/api/agents/bulk-jobs/{GUID}/items",
    )
    studio = {
        **child,
        "provider": "power_platform",
        "jobId": SOURCE,
        "status": "waiting_authorization",
        "verification": "pending",
        "final": False,
        "itemsUrl": None,
    }
    missing = {
        **studio,
        "accepted": False,
        "jobId": None,
        "status": None,
        "errorCode": "child_admission_expired",
    }
    execution.update(
        outcome="partial",
        final=False,
        verified=False,
        ineligibleCount=1,
        children=[child, studio, missing],
    )
    entra.api_responses.append(httpx2.Response(200, json=execution))
    result = await rpc("get_agent_control", {"receiptId": GUID})
    assert result["structuredContent"] == execution
    assert [sent.method for sent in entra.api_calls] == ["GET"]
    job = copy.deepcopy(source_fixtures["quarantineJob"])
    job.update(status="waiting_authorization", canResume=True, canReconcile=True)
    job["results"][0].update(
        status="inconclusive",
        observedState=None,
        observedProviderUpdatedAt=None,
        observedAt=None,
        correlationId=None,
        reconciliationStatus="required",
        retryEligible=False,
    )
    entra.api_responses.append(httpx2.Response(200, json=job))
    assert (await rpc("get_studio_control_job", {"id": SOURCE}))["structuredContent"] == job
    assert [sent.method for sent in entra.api_calls] == ["GET", "GET"]
    entra.api_responses.append(httpx2.Response(202, json=job))
    await rpc("resume_studio_control", {"id": SOURCE, "confirmed": True})
    assert json.loads(entra.api_calls[-1].content) == {"confirmed": True}


async def test_multi_page_discovery_and_items_keep_exact_selection_revision_and_cursors(
    rpc, entra, source_fixtures
):
    for page in range(2):
        inventory = copy.deepcopy(source_fixtures["inventory"])
        inventory["selection"]["id"] = GUID
        inventory["value"][0]["id"] = RECORD if page == 0 else "agent:" + SOURCE
        inventory["page"].update(nextCursor="selection-page-2" if page == 0 else None)
        entra.api_responses.append(httpx2.Response(200, json=inventory))
        result = await rpc(
            "list_agents", {"selectionId": GUID, **({"cursor": "selection-page-2"} if page else {})}
        )
        assert result["structuredContent"] == inventory
    request = {"selectionId": GUID, "recordIds": [RECORD, "agent:" + SOURCE], "action": "block"}
    entra.api_responses.append(httpx2.Response(200, json=source_fixtures["controlPreview"]))
    await rpc("preview_agent_control", request)
    assert json.loads(entra.api_calls[-1].content) == request
    for page in range(2):
        expected = copy.deepcopy(source_fixtures["packageItems"])
        expected["revision"] = "8"
        expected["value"][0].update(
            status="inconclusive", reconciliationStatus="required", retryEligible=False
        )
        expected["page"].update(nextCursor="items-page-2" if page == 0 else None)
        entra.api_responses.append(httpx2.Response(200, json=expected))
        result = await rpc(
            "list_package_control_items",
            {"id": GUID, **({"revision": "8", "cursor": "items-page-2"} if page else {})},
        )
        assert result["structuredContent"] == expected
    assert len(entra.api_calls) == 5  # No hidden all-pages loop or child poller.


class LostWriteResponse(httpx2.AsyncByteStream):
    async def __aiter__(self):
        raise httpx2.ReadError("Synthetic response lost after API acceptance.")
        yield b""  # Async iterator protocol; no response body was received.


@pytest.mark.parametrize(
    "name,status_name",
    [
        ("block_packages", "get_package_control_job"),
        ("update_package_access", "get_package_control_job"),
        ("execute_studio_control", "get_studio_control_job"),
        ("execute_agent_control", "get_agent_control"),
    ],
)
async def test_lost_accepted_write_response_is_not_replayed_and_recovery_is_explicit_readback(
    name, status_name, rpc, entra, source_fixtures
):
    request = next(row[3] for row in CASES if row[0] == name)
    entra.api_responses.append(
        httpx2.Response(
            202,
            headers={"Content-Type": "application/json"},
            stream=LostWriteResponse(),
        )
    )
    failed = await rpc(name, request)
    assert failed["isError"]
    assert json.loads(failed["content"][0]["text"])["code"] == "api_unavailable"
    assert len(entra.api_calls) == 1
    expected = response_for(operation_named(status_name), source_fixtures)
    if status_name == "get_agent_control":
        expected.update(final=True, verified=False, outcome="partial")
        expected["children"][0].update(
            status="inconclusive", verification="readback_unknown", verified=False, final=True
        )
        status_request = {"receiptId": GUID}
    elif status_name == "get_studio_control_job":
        expected.update(status="inconclusive", canResume=False, canReconcile=True)
        expected["results"][0].update(
            status="inconclusive",
            reconciliationStatus="required",
            observedState=None,
            observedProviderUpdatedAt=None,
            observedAt=None,
            retryEligible=False,
        )
        status_request = {"id": GUID}
    else:
        expected.update(status="partial", reconciliationRequired=1, canResume=False)
        status_request = {"id": GUID}
    entra.api_responses.append(httpx2.Response(200, json=expected))
    recovered = await rpc(status_name, status_request)
    assert recovered["structuredContent"] == expected
    assert len(entra.api_calls) == 2
    assert entra.api_calls[-1].method == "GET"
    if status_name != "get_agent_control":
        reconcile_name = (
            "reconcile_studio_control"
            if status_name == "get_studio_control_job"
            else "reconcile_package_control"
        )
        reconciled = response_for(operation_named(reconcile_name), source_fixtures)
        entra.api_responses.append(httpx2.Response(200, json=reconciled))
        assert (await rpc(reconcile_name, {"id": GUID}))["structuredContent"] == reconciled
        assert entra.api_calls[-1].url.path.endswith("/reconcile")
    assert sum(call.url.path == entra.api_calls[0].url.path for call in entra.api_calls) == 1


@pytest.mark.parametrize(
    "name",
    [
        "cancel_package_control",
        "resume_package_control",
        "reconcile_package_control",
        "cancel_studio_control",
        "resume_studio_control",
        "reconcile_studio_control",
    ],
)
async def test_lifecycle_origin_is_current_but_returned_initiator_stays_api_owned(
    name, rpc, entra, source_fixtures
):
    expected = response_for(operation_named(name), source_fixtures["complete"])
    expected["origin"]["callingAgent"]["id"] = {
        "value": "accepted-initiator",
        "evidence": "reported",
    }
    request = next(row[3] for row in CASES if row[0] == name)
    entra.api_responses.append(httpx2.Response(200, json=expected))
    result = await rpc(name, request, calling_agent="current-lifecycle-actor")
    assert result["structuredContent"] == expected
    sent = entra.api_calls[-1]
    origin = json.loads(
        base64.urlsafe_b64decode(sent.headers["X-Agent-Control-Mcp-Context"] + "==")
    )
    assert origin["callingAgent"]["id"] == "current-lifecycle-actor"
    assert "accepted-initiator" not in sent.content.decode()
    assert "origin" not in json.loads(sent.content)
    assert len(entra.api_calls) == 1


async def test_connection_revocation_during_accepted_control_await_never_publishes_or_replays(
    rpc, entra, service, source_fixtures
):
    entra.block_api = asyncio.Event()
    entra.api_responses.append(httpx2.Response(202, json=source_fixtures["controlExecution"]))
    pending = asyncio.create_task(rpc("execute_agent_control", RECEIPT))
    try:
        for _ in range(100):
            if entra.api_calls:
                break
            await asyncio.sleep(0.005)
        assert len(entra.api_calls) == 1
        reference = rpc.headers["Authorization"].removeprefix("Bearer ")
        await service.store.put(
            TenantAzureProvider.token_key(reference),
            {"revoked": True},
            collection="revoked",
            ttl=60,
        )
        entra.block_api.set()
        result = await asyncio.wait_for(pending, 3)
        assert result["isError"]
        assert "structuredContent" not in result
        assert json.loads(result["content"][0]["text"])["code"] == "reauthorization_required"
        assert len(entra.api_calls) == 1
    finally:
        entra.block_api.set()
        if not pending.done():
            pending.cancel()


@pytest.mark.parametrize(
    "name,source,field,value",
    [
        ("preview_agent_control", "controlPreview", "providerAtomicity", 0),
        ("execute_agent_control", "controlExecution", "accepted", 1),
        ("preview_studio_control", "quarantinePreview", "risk", 1),
    ],
)
async def test_malformed_api_boolean_literals_fail_without_coercion_or_replay(
    name, source, field, value, rpc, entra, source_fixtures
):
    expected = copy.deepcopy(source_fixtures[source])
    target = expected["summary"] if field == "risk" else expected
    target[field] = value
    payload = next(row[3] for row in CASES if row[0] == name)
    entra.api_responses.append(httpx2.Response(200, json=expected))
    result = await rpc(name, payload)
    assert result["isError"]
    assert json.loads(result["content"][0]["text"])["code"] == "invalid_api_response"
    assert len(entra.api_calls) == 1


async def test_audit_rows_and_reported_labels_keep_current_browser_wire_parity(
    rpc, entra, source_fixtures
):
    expected = copy.deepcopy(source_fixtures["complete"]["audit"])
    event = expected["value"][0]
    event["origin"]["callingAgent"]["name"] = {
        "value": "=1+1,<script>inert</script>",
        "evidence": "reported",
    }
    event["action"] = "reconcile-control"
    request = {"originChannel": "mcp", "originCallingAgentId": "current-lifecycle-actor"}
    entra.api_responses.append(httpx2.Response(200, json=expected))
    result = await rpc("list_administrative_audit", request)
    web = browser_calls(
        [{"name": "list_administrative_audit", "request": request, "response": expected}]
    )[0]
    assert result["structuredContent"] == web["request"]["result"] == expected
    assert entra.api_calls[-1].method == "GET"


@pytest.mark.parametrize(
    "name,payload,query",
    [
        ("list_package_control_jobs", {}, {}),
        ("list_studio_control_jobs", {}, {}),
        ("list_studio_control_audit", {}, {}),
        (
            "get_studio_status",
            {"snapshotId": GUID, "nativeId": "Native/Case"},
            {"snapshotId": [GUID], "nativeId": ["Native/Case"]},
        ),
        ("list_package_control_items", {"id": GUID}, {}),
    ],
)
async def test_unspecified_control_defaults_stay_api_owned(
    name, payload, query, rpc, entra, source_fixtures
):
    entra.api_responses.append(
        httpx2.Response(
            200,
            json=response_for(operation_named(name), source_fixtures),
        )
    )
    result = await rpc(name, payload)
    assert not result.get("isError"), result
    assert parse_qs(entra.api_calls[-1].url.query.decode()) == query


@pytest.mark.parametrize(
    "model,payload",
    [
        (
            ci.PreviewAgentControl,
            {"selectionId": GUID, "action": "block", "recordIds": ["graph_packages:guessed"]},
        ),
        (
            ci.PreviewAgentControl,
            {"selectionId": GUID, "action": "block", "recordIds": [RECORD, RECORD]},
        ),
        (
            ci.PreviewAgentControl,
            {"selectionId": GUID, "action": "block", "recordIds": ["report:"]},
        ),
        (
            ci.PreviewAgentControl,
            {"selectionId": GUID, "action": "block", "recordIds": [RECORD] * 101},
        ),
        (ci.ExecuteAgentControl, {**RECEIPT, "scheduled": True}),
        (ci.ExecuteAgentControl, {**RECEIPT, "humanConfirmed": True}),
        (ci.ExecuteAgentControl, {**RECEIPT, "origin": {"channel": "webapp"}}),
        (ci.ExecuteAgentControl, {**RECEIPT, "confirmationHash": "guessed"}),
        (ci.ExecuteAgentControl, {"receiptId": GUID, "confirmationHash": HASH}),
        (ci.ExecuteAgentControl, {**RECEIPT, "idempotencyKey": "a\r\nheader"}),
        (ci.ExecuteAgentControl, {**RECEIPT, "idempotencyKey": "unencodable-🧭"}),
        (ci.SubmitPackages, PACKAGE_RECEIPT),
        (ci.SubmitPackages, {**PACKAGE_RECEIPT, "ids": [" ", PACKAGE]}),
        (ci.SubmitPackages, {**PACKAGE_RECEIPT, "ids": [PACKAGE, PACKAGE]}),
        (ci.SubmitSelectedPackages, {**PACKAGE_RECEIPT, "selectionId": GUID, "ids": [PACKAGE]}),
        (
            ci.PreviewPackageControl,
            {"ids": [PACKAGE], "action": "reassign", "mutationScope": "single"},
        ),
        (
            ci.PreviewPackageControl,
            {"ids": [PACKAGE], "action": "block", "mutationScope": "single", **ACCESS},
        ),
        (
            ci.PreviewPackageControl,
            {
                "ids": [PACKAGE],
                "action": "update-installation",
                "mutationScope": "single",
                **ACCESS,
            },
        ),
        (ci.UpdatePackageAccess, {"id": PACKAGE, **PACKAGE_RECEIPT, **ACCESS, "mode": "add"}),
        (ci.UpdatePackageAccess, {"id": PACKAGE, **PACKAGE_RECEIPT, **ACCESS, "scope": "all"}),
        (ci.UpdatePackageAccess, {"id": PACKAGE, **PACKAGE_RECEIPT, **ACCESS, "scope": "none"}),
        (ci.UpdatePackageAccess, {"id": PACKAGE, **PACKAGE_RECEIPT, **ACCESS, "principals": []}),
        (
            ci.UpdatePackageAccess,
            {"id": PACKAGE, **PACKAGE_RECEIPT, **ACCESS, "principals": [PRINCIPAL] * 501},
        ),
        (
            ci.UpdatePackageAccess,
            {"id": PACKAGE, **PACKAGE_RECEIPT, **ACCESS, "principals": [PRINCIPAL] * 2},
        ),
        (ci.UpdatePackagesAccess, {"ids": [PACKAGE] * 101, **PACKAGE_RECEIPT, **ACCESS}),
        (
            ci.UpdatePackagesAccess,
            {
                "ids": [PACKAGE],
                **PACKAGE_RECEIPT,
                **ACCESS,
                "principals": [{"resourceType": "user", "resourceId": "Display name"}],
            },
        ),
        (ci.PackageItems, {"id": GUID, "cursor": "unbound"}),
        (ci.PackageItems, {"id": GUID, "revision": "unknown"}),
        (ci.PackageItems, {"id": GUID, "limit": 101}),
        (ci.ResumeControl, {"id": GUID, "confirmed": False}),
        (ci.ResumeControl, {"id": GUID, "confirmed": 1}),
        (ci.ResumeControl, {"id": GUID, "confirmed": True, "replaySent": True}),
        (ci.ExecuteStudioControl, {**STUDIO, **PACKAGE_RECEIPT, "forceStatus": True}),
        (ci.ExecuteStudioControl, {**STUDIO, **PACKAGE_RECEIPT, "resourceNativeIds": []}),
        (ci.ExecuteStudioControl, {**STUDIO, **PACKAGE_RECEIPT, "resourceNativeIds": ["id"] * 26}),
        (ci.ExecuteStudioControl, {**STUDIO, **PACKAGE_RECEIPT, "snapshotId": "unknown"}),
        (ci.StudioStatus, {"snapshotId": GUID, "nativeId": None}),
        (ci.StudioStatus, {"snapshotId": GUID, "nativeId": "untrusted", "environmentId": "guess"}),
        (
            ResolvePrincipals,
            {"principals": [{"resourceType": "user", "resourceId": "Display name"}]},
        ),
    ],
)
def test_control_inputs_reject_guessed_identity_unbound_receipts_and_unsupported_intent(
    model, payload
):
    with pytest.raises(ValidationError):
        model.model_validate(payload)


def test_catalog_has_one_owner_and_no_control_gate_or_parallel_recovery_framework():
    added = {operation.name for operation in OPERATIONS} - {row[0] for row in CASES}
    assert len(added) == 94  # 96 prior tools, two directory adapters reused.
    assert len(OPERATIONS) == 124
    assert {operation.method for operation in OPERATIONS if operation.method == "PATCH"} == {
        "PATCH"
    }
    assert [operation.name for operation in OPERATIONS if operation.method == "PATCH"] == [
        "update_package_access"
    ]
    for name in (
        "execute_agent_control",
        "block_package",
        "update_package_access",
        "execute_studio_control",
    ):
        operation = operation_named(name)
        assert operation.provider and operation.destructive and operation.idempotent
