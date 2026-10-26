"""Deterministic clients, not an LLM, using the real OAuth/HTTP SDK and browser adapters.

The shared corpus pins expectations also checked by the canonical SQL owner.
Source DTO fixtures supply shape only; no business joins/ranks are implemented here.
"""

import asyncio
import base64
import copy
import json
from pathlib import Path
from urllib.parse import parse_qs

import httpx2
import pytest
from conftest import CLIENT, protocol_client, tokens
from test_controls import browser_calls
from test_tools import response_for

from agent_control_mcp.tools import operation_named

CORPUS = json.loads(
    (
        Path(__file__).resolve().parents[2] / "backend/scripts/fixtures/mcp-workflows.json"
    ).read_text()
)
IDS = CORPUS["ids"]
SEL = IDS["selection"]
INV = IDS["inventorySelection"]
PERSON = IDS["nativePerson"]


def identifier(kind, number):
    return IDS[kind + "Prefix"] + f"{number:012}"


def agent(number):
    return "agent:" + identifier("canonical", number)


def selected(fixtures, inventory=False):
    result = copy.deepcopy(fixtures["selection"])
    result["id"] = INV if inventory else SEL
    return result


def relationship_row(record_id, relationship, person=PERSON, *, report_id=None):
    return {
        "id": record_id,
        "canonicalId": record_id.removeprefix("agent:") if record_id.startswith("agent:") else None,
        "reportAgentId": report_id,
        "name": CORPUS["duplicateDisplayName"],
        "relationship": relationship,
        "personId": person,
        "reportedUsername": CORPUS["person"] if relationship == "used" else None,
        "responses": 1 if relationship == "used" else None,
        "lastActivityDateUtc": "2026-01-30T00:00:00.000Z" if relationship == "used" else None,
        "source": "userAgents" if relationship == "used" else "inventory",
        "identityState": "report_only" if record_id.startswith("report:") else "canonical",
        "sourceReferences": None
        if record_id.startswith("report:")
        else {
            "selectionId": INV,
            "path": f"/api/agent-inventory/{record_id}/members",
        },
    }


def relationships(fixtures, rows, total, cursor=None):
    result = copy.deepcopy(fixtures["savedRelationships"])
    result.update(
        value=rows,
        selection=selected(fixtures),
        inventorySelection=selected(fixtures, True),
        counts={"total": total, "distinctAgents": total, "returned": len(rows)},
        page={"limit": 50, "nextCursor": cursor},
        relationshipState="available",
        missingReasons=[],
    )
    return result


@pytest.fixture
def workflow(rpc, entra):
    paired = []

    async def call(name, request, response, *, status=200):
        entra.api_responses.append(
            httpx2.Response(
                status,
                json=response,
                headers={
                    "Content-Type": "application/problem+json"
                    if status >= 400
                    else "application/json",
                    "X-Request-ID": SEL,
                },
            )
        )
        result = await rpc(name, request)
        paired.append({"name": name, "request": request, "response": response, "status": status})
        if status >= 400:
            assert result["isError"]
            return json.loads(result["content"][0]["text"])
        assert not result.get("isError"), result
        assert result["structuredContent"] == response
        return result["structuredContent"]

    call.paired = paired
    call.trace = rpc.trace
    return call


def verify_trace_and_web(name, workflow, entra):
    trace = workflow.trace
    measured = {
        "scenario": name,
        "toolCalls": len(trace),
        "apiCalls": len(entra.api_calls),
        "jsonBytes": sum(call["bytes"] for call in trace),
        "seconds": sum(call["seconds"] for call in trace),
        "calls": trace,
    }
    assert measured["toolCalls"] <= CORPUS["budget"]["toolCalls"]
    assert measured["jsonBytes"] <= CORPUS["budget"]["jsonBytes"]
    assert measured["seconds"] <= CORPUS["budget"]["seconds"]
    assert len(trace) == len(entra.api_calls) == len(workflow.paired)
    web = browser_calls(workflow.paired)
    for sent, expected, actual in zip(entra.api_calls, workflow.paired, web, strict=True):
        captured = actual["request"]
        assert sent.method == captured["method"], expected["name"]
        assert sent.url.raw_path.decode().split("?")[0] == captured["path"], expected["name"]
        assert {
            key: values[0] for key, values in parse_qs(sent.url.query.decode()).items()
        } == captured["query"]
        assert (json.loads(sent.content) if sent.content else {}) == captured["body"]
        if expected["status"] >= 400:
            assert actual["error"] == {
                "status": expected["status"],
                "code": expected["response"]["code"],
                "requestId": SEL,
            }
        else:
            assert captured["result"] == expected["response"]
    print("phase09_workflow " + json.dumps(measured, separators=(",", ":")))


async def test_case_a_complete_person_pages_about_and_final_claims(
    workflow, entra, source_fixtures
):
    f, case = source_fixtures, CORPUS["caseA"]
    await workflow(
        "capture_agent_inventory", {"query": {"inventoryScope": "all"}}, selected(f, True)
    )
    resolution = copy.deepcopy(f["resolution"])
    resolution.update(
        username=CORPUS["person"],
        state="resolved",
        objectId=PERSON,
        directoryMatches=1,
        reportedUsername=CORPUS["person"],
        reportIdentityState="matched",
        selection=selected(f),
    )
    resolved = await workflow("resolve_user", {"username": CORPUS["person"]}, resolution)
    # Same display name is not an identity resolver; duplicate saved usernames remain ambiguous.
    duplicate = {
        **resolution,
        "username": CORPUS["duplicateUsername"],
        "state": "ambiguous",
        "objectId": None,
        "directoryMatches": 2,
        "reportedUsername": None,
        "reportIdentityState": "ambiguous",
    }
    assert (await workflow("resolve_user", {"username": CORPUS["duplicateUsername"]}, duplicate))[
        "objectId"
    ] is None
    edges = {}
    for relation in ("used", "created", "owned", "modified"):
        rows = (
            [
                relationship_row(agent(n), relation, report_id=f"P{n}")
                for n in case["usedCanonicalNumbers"]
            ]
            + [relationship_row(case["usedReportOnlyId"], relation, report_id="P_report_only")]
            if relation == "used"
            else [relationship_row(agent(n), relation) for n in case[relation]]
        )
        cursor, actual = None, []
        for offset in range(0, len(rows), 50):
            request = {
                "objectId": resolved["objectId"],
                "selectionId": SEL,
                "inventorySelectionId": INV,
                "relationship": relation,
                "limit": 50,
                **({"cursor": cursor} if cursor else {}),
            }
            next_cursor = "signed:person-used-2" if offset + 50 < len(rows) else None
            page = await workflow(
                "list_user_agent_relationships",
                request,
                relationships(f, rows[offset : offset + 50], case["counts"][relation], next_cursor),
            )
            actual.extend(page["value"])
            cursor = page["page"]["nextCursor"]
        assert cursor is None
        assert [row["id"] for row in actual] == [row["id"] for row in rows]
        assert all(row["personId"] == PERSON and row["relationship"] == relation for row in actual)
        for row in actual:
            assert row["sourceReferences"] == (
                None
                if row["identityState"] == "report_only"
                else {"selectionId": INV, "path": f"/api/agent-inventory/{row['id']}/members"}
            )
        edges[relation] = actual
    texts, missing = {}, None
    for number, field, spec in (
        (101, "long", case["longAbout"]),
        (102, "native", case["nativeAbout"]),
        (103, "long", None),
    ):
        members = {
            "value": [
                {
                    "source_scope_id": IDS["sourceScope"],
                    "source_identity": f"P{number}" if field == "long" else "native-102",
                    "source_generation_id": IDS["generation"],
                    "domain": "packages" if field == "long" else "power_platform",
                    "native_id": f"P{number}" if field == "long" else "native-102",
                    "environment_id": None,
                    "display_name": CORPUS["duplicateDisplayName"],
                    "observed_at": "2026-01-30T00:00:00Z",
                    "read_started_at": "2026-01-30T00:00:00Z",
                    "expires_at": "2026-02-01T00:00:00Z",
                    "catalog_generation": IDS["generation"],
                    "detail_generation": None,
                    "control_generation": None,
                }
            ],
            "total": 1,
            "nextCursor": None,
        }
        if number == 102:
            package = {
                **members["value"][0],
                "source_identity": "P102",
                "native_id": "P102",
                "domain": "packages",
            }
            member_pages = [[package], members["value"]]
        else:
            member_pages = [members["value"]]
        all_members, cursor = [], None
        for index, values in enumerate(member_pages):
            current_members = {
                **members,
                "value": values,
                "total": sum(map(len, member_pages)),
                "nextCursor": "signed:members-native-102"
                if index + 1 < len(member_pages)
                else None,
            }
            received_members = await workflow(
                "list_agent_members",
                {
                    "selectionId": INV,
                    "recordId": agent(number),
                    "limit": 1 if number == 102 else 50,
                    **({"cursor": cursor} if cursor else {}),
                },
                current_members,
            )
            all_members.extend(received_members["value"])
            cursor = received_members["nextCursor"]
        assert cursor is None
        member = next(
            row
            for row in all_members
            if row["domain"] == ("power_platform" if field == "native" else "packages")
        )
        assert member["source_identity"] == ("native-102" if field == "native" else f"P{number}")
        expected = spec["unit"] * spec["repeat"] + case["adversarialSuffix"] if spec else None
        segments = (
            [expected[i : i + 16384] for i in range(0, len(expected), 16384)]
            if expected
            else [None]
        )
        cursor, received, returned_bytes = None, "", 0
        for index, text in enumerate(segments):
            next_cursor = (
                f"signed:about-{number}-{index + 1}" if index + 1 < len(segments) else None
            )
            about = {
                "recordId": agent(number),
                "sourceScopeId": member["source_scope_id"],
                "sourceIdentity": member["source_identity"],
                "generationId": member["source_generation_id"],
                "field": field,
                "state": "available" if text else "missing",
                "source": "graph_packages" if field == "long" else "power_platform",
                "provenance": {
                    "path": "longDescription" if field == "long" else "details.description",
                    "maturity": "observed",
                },
                "observedAt": "2026-01-30T00:00:00Z",
                "text": text,
                "totalBytes": len(expected.encode()) if expected else 0,
                "returnedBytes": len(text.encode()) if text else 0,
                "nextCursor": next_cursor,
                "selection": selected(f, True),
            }
            result = await workflow(
                "read_agent_about",
                {
                    "selectionId": INV,
                    "recordId": agent(number),
                    "sourceScopeId": member["source_scope_id"],
                    "sourceIdentity": member["source_identity"],
                    "field": field,
                    **({"cursor": cursor} if cursor else {}),
                },
                about,
            )
            received += result["text"] or ""
            returned_bytes += result["returnedBytes"]
            cursor = result["nextCursor"]
            missing = result["state"] if number == 103 else missing
        assert cursor is None
        assert received == (expected or "")
        assert returned_bytes == len(received.encode())
        texts[number] = received
    claims = {
        "personId": resolved["objectId"],
        **{key: len(rows) for key, rows in edges.items()},
        "reportOnly": sum(row["identityState"] == "report_only" for row in edges["used"]),
        "missingAbout": "unknown" if missing == "missing" else "available",
        "providerWrites": sum(
            request.method != "GET" and request.url.path != "/api/agent-inventory/selections"
            for request in entra.api_calls
        ),
        "classification": "not_performed",
    }
    assert claims == case["claims"]
    assert all("attacker.invalid" in texts[n] for n in (101, 102))
    assert not any(
        call["tool"].startswith(("execute_", "block_", "start_")) for call in workflow.trace
    )
    verify_trace_and_web("A", workflow, entra)


async def test_case_b_top_three_only_all_associations_and_no_department_substitution(
    workflow, entra, source_fixtures
):
    f, case = source_fixtures, CORPUS["caseB"]
    await workflow(
        "capture_agent_inventory", {"query": {"inventoryScope": "all"}}, selected(f, True)
    )
    group = copy.deepcopy(f["adoption"])
    group["selection"] = selected(f)
    group["value"] = [
        {
            "id": "synthetic-company-department",
            "company": CORPUS["company"],
            "department": CORPUS["department"],
            "people": [
                {
                    "id": identifier("person", number),
                    "name": f"Person {number}",
                    "agents": count,
                    "responses": responses,
                    "champion": number in (2, 3, 4),
                }
                for number, count, responses in (
                    (1, 2, 10),
                    (2, 2, 50),
                    (3, 7, 20),
                    (4, 1, 100),
                    (5, 0, None),
                )
            ],
            "agents": [{
                "id": "report:P_extra_9", "name": "Nonchampion", "description": None,
                "creatorType": "Your org", "inventoryId": agent(9),
            }],
        }
    ]
    group["page"].update(limit=10, nextCursor=None, previousCursor=None)
    department = await workflow(
        "list_adoption_groups",
        {
            "company": CORPUS["company"],
            "department": CORPUS["department"],
            "limit": 10,
        },
        group,
    )
    assert department["value"][0]["agents"][0]["inventoryId"] == agent(9)
    champs = [
        {
            **{key: row[key] for key in ("rank", "created", "responses", "agents")},
            "objectId": identifier("person", row["person"]),
            "name": f"Person {row['person']}",
        }
        for row in case["champions"]
    ]
    rows = [
        relationship_row(
            agent(number),
            relation,
            identifier("person", person),
            report_id=f"P{number}" if relation == "used" else None,
        )
        for relation, pairs in (("created", case["createdEdges"]), ("used", case["usedEdges"]))
        for person, number in pairs
    ] + [
        relationship_row(
            case["reportOnlyEdge"]["id"], "used", identifier("person", 2), report_id="P_extra"
        )
    ]
    cursor, actual = None, []
    for offset in range(0, len(rows), 5):
        page = relationships(
            f,
            rows[offset : offset + 5],
            case["associationCount"],
            f"signed:champions-{offset + 5}" if offset + 5 < len(rows) else None,
        )
        # Distinct agents differs from edges: the same exact agent can be created and used.
        page["counts"]["distinctAgents"] = 13
        page["page"]["limit"] = 5
        page.update(company=CORPUS["company"], department=CORPUS["department"], champions=champs)
        result = await workflow(
            "list_champion_agents",
            {
                "selectionId": SEL,
                "inventorySelectionId": INV,
                "limit": 5,
                **({"cursor": cursor} if cursor else {}),
            },
            page,
        )
        assert [row["objectId"] for row in result["champions"]] == case["claims"]["championIds"]
        actual.extend(result["value"])
        cursor = result["page"]["nextCursor"]
    assert cursor is None
    assert {(row["personId"], row["id"], row["relationship"]) for row in actual} == {
        (row["personId"], row["id"], row["relationship"]) for row in rows
    }
    claims = {
        "championIds": [row["objectId"] for row in result["champions"]],
        "associationCount": len(actual),
        "distinctCanonicalAgents": len(
            {row["canonicalId"] for row in actual if row["canonicalId"]}
        ),
        "reportOnlyAgents": sorted(
            {row["id"] for row in actual if row["identityState"] == "report_only"}
        ),
        "departmentAgent9IsChampionAssociation": any(row["id"] == agent(9) for row in actual),
        "rankingAuthority": "API",
    }
    assert claims == case["claims"]
    verify_trace_and_web("B", workflow, entra)


async def test_case_c_frozen_creation_window_all_pages_no_classifier(
    workflow, entra, source_fixtures
):
    f, case = source_fixtures, CORPUS["caseC"]
    selection = selected(f, True)
    selection["evaluatedAt"] = case["clock"]
    capture = await workflow(
        "capture_agent_inventory",
        {
            "query": {
                "inventoryScope": "power_platform_only",
                "view": "all",
                "createdWithinDays": 30,
            }
        },
        selection,
    )
    actual, cursor = [], None
    for numbers in (range(1, 101), [101]):
        page = copy.deepcopy(f["inventory"])
        page.update(selection=capture, inventoryScope="power_platform_only")
        page["value"] = []
        for number in numbers:
            record = copy.deepcopy(f["agent"])
            record.update(
                id=agent(number),
                displayName=CORPUS["duplicateDisplayName"],
                presence="power_platform",
                packages=[],
                powerPlatformResource=None,
            )
            page["value"].append(record)
        page["counts"].update(
            total=case["total"], scoped=case["total"], filtered=case["filtered"], packageTargets=0
        )
        page["page"].update(
            limit=100, nextCursor="signed:creation-101" if not cursor else None, previousCursor=None
        )
        result = await workflow(
            "list_agents",
            {
                "selectionId": capture["id"],
                "limit": 100,
                **({"cursor": cursor} if cursor else {}),
            },
            page,
        )
        actual.extend(result["value"])
        assert result["selection"]["evaluatedAt"] == case["clock"]
        cursor = result["page"]["nextCursor"]
    assert cursor is None
    assert [row["id"] for row in actual] == [agent(n) for n in range(1, 102)]
    assert actual[-1]["id"] == case["lastIncluded"]
    assert not set(case["excluded"]) & {row["id"] for row in actual}
    claims = {
        "total": result["counts"]["total"],
        "filtered": len(actual),
        "unknownCreatedAtExcluded": agent(103) not in {row["id"] for row in actual},
        "classification": "not_performed",
        "providerWrites": 0,
    }
    assert claims == case["claims"]
    verify_trace_and_web("C", workflow, entra)


async def test_comparisons_complete_history_pages_honest_missing_overlap(
    workflow, entra, source_fixtures
):
    f = source_fixtures
    observed = []
    for expected in CORPUS["reports"]["comparisons"]:
        cursor, history = None, []
        for offset in (0, 3):
            response = copy.deepcopy(f["complete"]["usageHistory"])
            response.update(recordId=agent(1), value=[])
            response["page"].update(limit=3, nextCursor="signed:history-2" if offset == 0 else None)
            for window in CORPUS["reports"]["windows"][offset : offset + 3]:
                point = copy.deepcopy(f["usageHistory"]["value"][0])
                point.update(
                    setId=identifier("report", window["set"]),
                    reportingStart=window["start"],
                    reportingEnd=window["end"],
                    periodProvenance="unknown" if window["start"] is None else "operator_asserted",
                    responses=window["responses"],
                )
                response["value"].append(point)
            response["comparison"].update(
                {
                    key: expected[key]
                    for key in ("state", "reasons", "responsesDelta", "responseGrowthPercent")
                }
            )
            response["comparison"]["from"]["setId"] = identifier("report", 1)
            response["comparison"]["to"]["setId"] = identifier("report", expected["to"])
            result = await workflow(
                "list_agent_usage_history",
                {
                    "recordId": agent(1),
                    "selectionId": INV,
                    "inventorySelectionId": INV,
                    "compareFromSetId": identifier("report", 1),
                    "compareToSetId": identifier("report", expected["to"]),
                    "limit": 3,
                    **({"cursor": cursor} if cursor else {}),
                },
                response,
            )
            history.extend(result["value"])
            cursor = result["page"]["nextCursor"]
        assert cursor is None and len(history) == 5
        observed.append(result["comparison"])
    assert observed[0]["responseGrowthPercent"] == 50
    assert all(
        row["responsesDelta"] is None and row["responseGrowthPercent"] is None
        for row in observed[1:]
    )
    claims = {
        "comparableGrowthPercent": observed[0]["responseGrowthPercent"],
        "overlapTrend": "unknown",
        "unequalTrend": "unknown",
        "missingPeriodTrend": "unknown",
        "snapshotsAdditive": False,
    }
    assert claims == CORPUS["reports"]["claims"]
    verify_trace_and_web("reports", workflow, entra)


def preview(fixtures, revision, action="block"):
    result = copy.deepcopy(fixtures["controlPreview"])
    result.update(
        receiptId=identifier("report", revision),
        confirmationHash=str(revision) * 64,
        selectionId=INV,
        action=action,
        targetCount=2,
        eligibleCount=2,
        ineligibleCount=0,
        alreadyInStateCount=0,
    )
    result["targets"] = [
        {
            "recordId": agent(1),
            "displayName": "Package",
            "eligible": True,
            "reason": None,
            "effects": [
                {
                    "provider": "graph_packages",
                    "action": action,
                    "id": "P1",
                    "displayName": "Package",
                    "alreadyInState": False,
                }
            ],
        },
        {
            "recordId": agent(2),
            "displayName": "Native",
            "eligible": True,
            "reason": None,
            "effects": [
                {
                    "provider": "power_platform",
                    "action": "quarantine" if action == "block" else "unquarantine",
                    "id": "native-2",
                    "displayName": "Native",
                    "environmentId": "environment",
                    "botId": PERSON,
                    "alreadyInState": False,
                }
            ],
        },
    ]
    return result


@pytest.mark.parametrize(
    "code", ["confirmation_mismatch", "control_receipt_expired", "child_admission_expired"]
)
@pytest.mark.parametrize("action", ["block", "unblock"])
async def test_interactive_pause_is_observed_and_changed_receipts_are_redisplayed_reconfirmed(
    code,
    action,
    workflow,
    entra,
    source_fixtures,
):
    displayed, confirmed = [], []
    allow_first, allow_second = asyncio.Event(), asyncio.Event()
    at_first, at_second = asyncio.Event(), asyncio.Event()

    async def client():
        for revision, permit, reached in ((1, allow_first, at_first), (2, allow_second, at_second)):
            shown = preview(source_fixtures, revision, action)
            if revision == 2 and code == "confirmation_mismatch":
                shown["targets"][0]["displayName"] = "Package renamed 🧭"
                shown["targets"][0]["effects"][0]["id"] = "P1-new-source"
            current = await workflow(
                "preview_agent_control",
                {
                    "selectionId": INV,
                    "recordIds": [agent(1), agent(2)],
                    "action": action,
                },
                shown,
            )
            displayed.append(copy.deepcopy(current))
            reached.set()
            await permit.wait()
            confirmed.append((current["receiptId"], current["confirmationHash"]))
            request = {key: current[key] for key in ("receiptId", "confirmationHash")}
            request["idempotencyKey"] = f"interactive-{revision}"
            if revision == 1:
                result = await workflow(
                    "execute_agent_control",
                    request,
                    {
                        "status": 409,
                        "code": code,
                        "detail": "Current preview required.",
                    },
                    status=409,
                )
                assert result["code"] == code
            else:
                accepted = copy.deepcopy(source_fixtures["controlExecution"])
                accepted.update(
                    receiptId=current["receiptId"],
                    confirmationHash=current["confirmationHash"],
                    final=False,
                    verified=False,
                )
                result = await workflow("execute_agent_control", request, accepted, status=202)
                assert result["accepted"] and not result["verified"]
        return result

    task = asyncio.create_task(client())
    try:
        await asyncio.wait_for(at_first.wait(), 5)
        await asyncio.sleep(0)
        assert [request.url.path for request in entra.api_calls] == ["/api/agent-controls/preview"]
        assert confirmed == [] and not task.done()
        allow_first.set()
        await asyncio.wait_for(at_second.wait(), 5)
        await asyncio.sleep(0)
        assert [request.url.path.rsplit("/", 1)[-1] for request in entra.api_calls] == [
            "preview",
            "execute",
            "preview",
        ]
        assert len(confirmed) == 1 and not task.done()
        assert displayed[0]["confirmationHash"] != displayed[1]["confirmationHash"]
        if code == "confirmation_mismatch":
            assert displayed[0]["targets"][0]["effects"][0]["id"] == "P1"
            assert displayed[1]["targets"][0]["effects"][0]["id"] == "P1-new-source"
            assert displayed[1]["targets"][0]["displayName"] == "Package renamed 🧭"
        assert displayed[1]["targets"][1]["effects"][0]["action"] == (
            "quarantine" if action == "block" else "unquarantine"
        )
        allow_second.set()
        await asyncio.wait_for(task, 5)
        assert confirmed == [(item["receiptId"], item["confirmationHash"]) for item in displayed]
        verify_trace_and_web(f"interactive-{action}-{code}", workflow, entra)
    finally:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


async def test_scheduled_current_receipt_no_pause_and_partial_not_success(
    workflow,
    entra,
    source_fixtures,
):
    async def scheduled_client():
        current = await workflow(
            "preview_agent_control",
            {
                "selectionId": INV,
                "recordIds": [agent(1), agent(2)],
                "action": "block",
            },
            preview(source_fixtures, 1),
        )
        result = copy.deepcopy(source_fixtures["controlExecution"])
        child = result["children"][0]
        child.update(
            recordIds=[agent(1)],
            accepted=True,
            status="partial",
            final=True,
            verified=False,
            verification="readback_unknown",
            errorCode=None,
        )
        result["children"] = [
            child,
            {
                **child,
                "provider": "power_platform",
                "recordIds": [agent(2)],
                "status": "waiting_authorization",
                "final": False,
                "verification": "pending",
            },
        ]
        result.update(
            receiptId=current["receiptId"],
            confirmationHash=current["confirmationHash"],
            outcome="partial",
            final=False,
            verified=False,
        )
        await workflow(
            "execute_agent_control",
            {
                "receiptId": current["receiptId"],
                "confirmationHash": current["confirmationHash"],
                "idempotencyKey": "external-scheduled-1",
            },
            result,
            status=202,
        )
        return await workflow("get_agent_control", {"receiptId": current["receiptId"]}, result)

    result = await asyncio.wait_for(scheduled_client(), 5)
    assert [call["tool"] for call in workflow.trace] == [
        "preview_agent_control",
        "execute_agent_control",
        "get_agent_control",
    ]
    assert result["accepted"] and result["outcome"] == "partial" and not result["verified"]
    assert not result["final"] and result["children"][1]["status"] == "waiting_authorization"
    assert not any(
        "human" in key.lower() or "confirmed" in key.lower() for key in workflow.trace[1]["request"]
    )
    verify_trace_and_web("scheduled-no-pause", workflow, entra)


async def test_concurrent_authenticated_clients_are_separate_from_reported_names_and_unknown(
    browser,
    service,
    entra,
):
    one_id, one = await tokens(browser)
    two_id, two = await tokens(browser)
    first, second = await asyncio.gather(
        protocol_client(
            browser, one["access_token"], client_name="Reported Copilot", client_version="9"
        ),
        protocol_client(
            browser, two["access_token"], client_name="Reported Claude", client_version="8"
        ),
    )
    await asyncio.gather(
        first("list_capabilities", calling_agent=None),
        second(
            "list_capabilities",
            meta={"com.agentcontrol/origin": {"callingAgent": {"id": "reported-worker-2"}}},
        ),
    )
    origins = [
        json.loads(base64.urlsafe_b64decode(request.headers["X-Agent-Control-Mcp-Context"] + "=="))
        for request in entra.api_calls
    ]
    by_name = {origin["client"]["name"]: origin for origin in origins}
    assert "callingAgent" not in by_name["Reported Copilot"]
    assert by_name["Reported Claude"]["callingAgent"] == {"id": "reported-worker-2"}
    assert "id" not in by_name["Reported Copilot"]["client"]
    assert "id" not in by_name["Reported Claude"]["client"]
    for issued, client_id in ((one, one_id), (two, two_id)):
        authenticated = await service.provider.load_access_token(issued["access_token"])
        assert authenticated.client_id == client_id
        assert client_id not in json.dumps(origins)
        assert authenticated.claims["azp"] == CLIENT
    assert one_id != two_id


@pytest.mark.parametrize("kind", ["native", "guest"])
async def test_exact_private_person_missing_report_is_unknown_not_zero(
    kind,
    browser,
    service,
    entra,
    source_fixtures,
):
    oid = PERSON if kind == "native" else IDS["guestResourcePerson"]
    entra.oid = oid
    _, issued = await tokens(browser)
    call = await protocol_client(browser, issued["access_token"], client_name="Private identity")
    resolution = copy.deepcopy(source_fixtures["resolution"])
    resolution.update(
        username=CORPUS["person"],
        state="resolved",
        objectId=oid,
        directoryMatches=1,
        reportedUsername=None,
        reportIdentityState="missing",
        selection=selected(source_fixtures),
    )
    entra.api_responses.append(httpx2.Response(200, json=resolution))
    result = await call("resolve_user", {"username": CORPUS["person"]})
    assert result["structuredContent"]["objectId"] == oid
    page = relationships(source_fixtures, [], None)
    page.update(relationshipState="unavailable", missingReasons=["userAgents_report_missing"])
    entra.api_responses.append(httpx2.Response(200, json=page))
    result = await call(
        "list_user_agent_relationships",
        {
            "selectionId": SEL,
            "inventorySelectionId": INV,
            "objectId": oid,
            "relationship": "used",
        },
    )
    assert result["structuredContent"]["counts"]["total"] is None
    assert result["structuredContent"]["relationshipState"] == "unavailable"
    upstream = await service.provider.load_access_token(issued["access_token"])
    assert upstream.claims["oid"] == oid
    # The real canonical SQL fixture, not this adapter, proves the MSAL home-account key.
    assert all("guestHome" not in json.dumps(step["request"]) for step in call.trace)
    assert all(request.method == "GET" for request in entra.api_calls)


async def test_source_platforms_unknown_values_and_duplicate_names_do_not_become_client_authority(
    workflow,
    entra,
    source_fixtures,
):
    response = copy.deepcopy(source_fixtures["inventory"])
    response["selection"] = selected(source_fixtures, True)
    records = []
    for number, platform in enumerate([*CORPUS["platforms"], None], 1):
        record = copy.deepcopy(source_fixtures["agent"])
        package = copy.deepcopy(source_fixtures["package"])
        package.update(id=f"P{number}", displayName=CORPUS["duplicateDisplayName"])
        if platform is not None:
            package["platform"] = platform
        else:
            package.pop("platform", None)
        record.update(
            id=agent(number),
            displayName=CORPUS["duplicateDisplayName"],
            presence="graph_packages",
            packages=[package],
            powerPlatformResource=None,
        )
        records.append(record)
    response["value"] = records
    response["page"].update(limit=50, nextCursor=None, previousCursor=None)
    response["counts"].update(total=6, scoped=6, filtered=6, packageTargets=6)
    result = await workflow("list_agents", {"selectionId": INV, "limit": 50}, response)
    assert [row["packages"][0].get("platform") for row in result["value"]] == [
        *CORPUS["platforms"],
        None,
    ]
    assert len({row["displayName"] for row in result["value"]}) == 1
    assert len({row["id"] for row in result["value"]}) == 6
    verify_trace_and_web("platforms-reported-not-classified", workflow, entra)


@pytest.mark.parametrize(
    "status,code",
    [
        (403, "missing_internal_role"),
        (403, "scope_mismatch"),
        (401, "session_invalidated"),
        (409, "selection_invalidated"),
    ],
)
async def test_paging_denial_stops_without_recapture_source_substitution_or_write(
    status,
    code,
    workflow,
    entra,
    source_fixtures,
):
    request = {
        "selectionId": SEL,
        "inventorySelectionId": INV,
        "objectId": PERSON,
        "relationship": "used",
        "limit": 50,
    }
    first = relationships(
        source_fixtures, [relationship_row(agent(6), "used")], 99, "signed:remaining"
    )
    result = await workflow("list_user_agent_relationships", request, first)
    problem = await workflow(
        "list_user_agent_relationships",
        {
            **request,
            "cursor": result["page"]["nextCursor"],
        },
        {"status": status, "code": code, "detail": "Current exact scope is unavailable."},
        status=status,
    )
    assert problem["code"] == code
    assert [call["tool"] for call in workflow.trace] == ["list_user_agent_relationships"] * 2
    assert all(request.method == "GET" for request in entra.api_calls)
    verify_trace_and_web(f"paging-denial-{code}", workflow, entra)


async def test_explicit_refresh_and_investigation_do_not_hide_inside_saved_reads(
    workflow,
    entra,
    source_fixtures,
):
    job = response_for(operation_named("refresh_packages"), source_fixtures)
    job.update(status="running", targetCount=0, scopeKind="broad")
    await workflow(
        "list_package_refresh_jobs",
        {"limit": 20},
        {
            "value": [],
            "lastAttemptAt": None,
            "lastSuccessAt": None,
        },
    )
    context = copy.deepcopy(source_fixtures["investigation"])
    context["recordId"] = agent(1)
    context["purview"].update(status="available", mode="search", presets=["copilot_interactions"])
    await workflow("get_agent_investigation", {"recordId": agent(1)}, context)
    assert [request.method for request in entra.api_calls] == ["GET", "GET"]
    await workflow(
        "refresh_packages",
        {"mode": "delegated", "idempotencyKey": "explicit-refresh"},
        job,
        status=202,
    )
    assert len(entra.api_calls) == 3
    assert entra.api_calls[-1].headers["Idempotency-Key"] == "explicit-refresh"
    assert not any(
        "hunting/jobs" in request.url.path or "purview-audit/jobs" in request.url.path
        for request in entra.api_calls
    )
    catalogue = await workflow(
        "get_purview_catalog",
        {},
        response_for(operation_named("get_purview_catalog"), source_fixtures),
    )
    assert entra.api_calls[-1].method == "GET"
    preset = next(row for row in catalogue["presets"] if row["id"] in context["purview"]["presets"])
    submitted = response_for(operation_named("start_purview_search"), source_fixtures)
    submitted["id"] = identifier("report", 8)
    result = await workflow(
        "start_purview_search",
        {
            "tokenMode": "delegated",
            "agentRecordId": context["recordId"],
            "filters": {
                "presetId": preset["id"],
                "operations": preset["operations"],
                "startDateTime": "2026-01-30T00:00:00Z",
                "endDateTime": "2026-01-30T01:00:00Z",
            },
        },
        submitted,
        status=202,
    )
    assert entra.api_calls[-1].method == "POST"
    saved = await workflow("get_purview_job", {"id": result["id"]}, submitted)
    assert saved["id"] == identifier("report", 8)
    assert entra.api_calls[-1].method == "GET"
    assert sum(request.method == "POST" for request in entra.api_calls) == 2
    verify_trace_and_web("explicit-provider-work", workflow, entra)


async def test_claims_refresh_revocation_and_reconnect_do_not_replay_control(
    browser,
    service,
    entra,
):
    client_id, issued = await tokens(browser)
    call = await protocol_client(browser, issued["access_token"])
    claims = json.dumps({"access_token": {"acrs": {"essential": True, "value": "c1"}}})
    entra.exchange_error = httpx2.Response(
        400,
        json={
            "error": "interaction_required",
            "claims": claims,
            "error_description": "synthetic private upstream diagnostic",
        },
    )
    result = await call("list_capabilities")
    error = json.loads(result["content"][0]["text"])
    assert result["isError"] and error["code"] == "reauthorization_required"
    assert error["details"]["claims"] == claims
    assert "private upstream" not in json.dumps(result)
    assert entra.api_calls == []
    entra.exchange_error = None
    refreshed = await browser.post(
        "/token",
        data={
            "grant_type": "refresh_token",
            "client_id": client_id,
            "refresh_token": issued["refresh_token"],
            "resource": "https://mcp.example.test/mcp",
        },
    )
    assert refreshed.status_code == 200
    call = await protocol_client(browser, refreshed.json()["access_token"])
    assert not (await call("list_capabilities")).get("isError")
    authenticated = await service.provider.load_access_token(refreshed.json()["access_token"])
    await service.provider.revoke_token(authenticated)
    denied = await browser.post(
        "/mcp",
        headers=call.headers,
        json={
            "jsonrpc": "2.0",
            "id": 100,
            "method": "tools/call",
            "params": {"name": "list_capabilities", "arguments": {"request": {}}},
        },
    )
    assert denied.status_code == 401
    _, reconnected = await tokens(browser)
    recovered = await protocol_client(browser, reconnected["access_token"])
    assert not (await recovered("list_capabilities")).get("isError")
    assert len(entra.api_calls) == 2 and all(request.method == "GET" for request in entra.api_calls)
    assert all(request.url.path == "/api/capabilities" for request in entra.api_calls)
