import copy
import json
from typing import get_args

import httpx2
import pytest
from pydantic import ValidationError

from agent_control_mcp.job_models import AuditAction, AuditEvents, Origin, StudioTargets, SyncSource

AUDIT_ACTIONS = get_args(AuditAction)
INVALID_AUDIT_TARGETS = [
    pytest.param("block", {}, id="block-missing-target"),
    pytest.param("unblock", {}, id="unblock-missing-target"),
    pytest.param("block", {"targetBlockedState": None}, id="block-null-target"),
    pytest.param("unblock", {"targetBlockedState": 0}, id="unblock-numeric-target"),
    pytest.param(
        "export-administrative-audit",
        {"targetBlockedState": False},
        id="non-block-with-target",
    ),
    pytest.param(
        "associate-agent-usage", {"targetBlockedState": None}, id="non-block-with-null-target"
    ),
]


def audit_body(source_fixtures, action, target):
    body = copy.deepcopy(source_fixtures["complete"]["audit"])
    event = body["value"][0]
    event.pop("targetBlockedState", None)
    event.update(action=action, **target)
    return body


@pytest.mark.parametrize("action", AUDIT_ACTIONS)
async def test_sdk_preserves_each_administrative_audit_action(action, rpc, entra, source_fixtures):
    target = {"targetBlockedState": action == "block"} if action in {"block", "unblock"} else {}
    body = audit_body(source_fixtures, action, target)
    parsed = AuditEvents.model_validate_json(json.dumps(body))
    assert json.loads(parsed.model_dump_json(exclude_unset=True)) == body
    entra.api_responses.append(httpx2.Response(200, json=body))
    result = await rpc("list_administrative_audit", {"action": action})
    assert not result.get("isError"), result
    assert result["structuredContent"] == body
    assert len(entra.api_calls) == 1


@pytest.mark.parametrize(("action", "target"), INVALID_AUDIT_TARGETS)
def test_audit_events_reject_action_target_mismatches(action, target, source_fixtures):
    with pytest.raises(ValidationError):
        AuditEvents.model_validate_json(json.dumps(audit_body(source_fixtures, action, target)))


@pytest.mark.parametrize(("action", "target"), INVALID_AUDIT_TARGETS)
async def test_sdk_rejects_action_target_mismatches(action, target, rpc, entra, source_fixtures):
    body = audit_body(source_fixtures, action, target)
    entra.api_responses.append(httpx2.Response(200, json=body))
    result = await rpc("list_administrative_audit", {"action": action})
    assert result["isError"], result
    error = json.loads(result["content"][0]["text"])
    assert error["status"] == 502
    assert error["code"] == "invalid_api_response"
    assert len(entra.api_calls) == 1


def test_audit_schema_requires_action_specific_target_fields():
    schema = AuditEvents.model_json_schema()
    event = schema["properties"]["value"]["items"]
    assert event["discriminator"]["propertyName"] == "action"
    mapping = event["discriminator"]["mapping"]
    assert set(mapping) == set(AUDIT_ACTIONS)
    for action, reference in mapping.items():
        variant = schema["$defs"][reference.rsplit("/", 1)[1]]
        if action in {"block", "unblock"}:
            assert "targetBlockedState" in variant["required"]
            assert variant["properties"]["targetBlockedState"]["type"] == "boolean"
        else:
            assert "targetBlockedState" not in variant["properties"]
        assert variant["additionalProperties"] is False


@pytest.mark.parametrize("value", [True, False, "1", None])
def test_origin_version_rejects_non_integer_values(value, source_fixtures):
    body = copy.deepcopy(source_fixtures["complete"]["audit"]["value"][0]["origin"])
    body["version"] = value
    with pytest.raises(ValidationError):
        Origin.model_validate_json(json.dumps(body))


@pytest.mark.parametrize("value", [1, 1.0, False, "true", None])
def test_native_snapshot_requires_exact_true(value, source_fixtures):
    body = copy.deepcopy(source_fixtures["complete"]["studioTargets"])
    body["snapshot"]["current"] = value
    with pytest.raises(ValidationError):
        StudioTargets.model_validate_json(json.dumps(body))


@pytest.mark.parametrize(
    ("name", "source", "field", "value"),
    [
        ("list_administrative_audit", "audit", "version", True),
        ("resolve_studio_targets", "studioTargets", "current", 1),
    ],
)
async def test_sdk_rejects_coerced_job_literals(
    name, source, field, value, rpc, entra, source_fixtures
):
    body = copy.deepcopy(source_fixtures["complete"][source])
    if source == "audit":
        body["value"][0]["origin"][field] = value
        request = {}
    else:
        body["snapshot"][field] = value
        request = {"snapshotId": body["snapshot"]["id"], "selected": [body["value"][0]["nativeId"]]}
    entra.api_responses.append(httpx2.Response(200, json=body))
    result = await rpc(name, request)
    assert result["isError"], result
    error = json.loads(result["content"][0]["text"])
    assert error["status"] == 502
    assert error["code"] == "invalid_api_response"
    assert len(entra.api_calls) == 1


@pytest.mark.parametrize("running", [False, True], ids=["first-run", "automatic-sync"])
async def test_sdk_reads_initial_sync_state_without_dispatch(running, rpc, entra, source_fixtures):
    body = copy.deepcopy(source_fixtures["sync"])
    source = body["sources"][0]
    body["sources"] = [
        {
            **source,
            "source": name,
            "status": "not_started",
            "jobId": None,
            "count": None,
            "lastSuccessAt": None,
            "updatedAt": None,
        }
        for name in get_args(SyncSource)
    ]
    body.update(onboardingRequired=True, usageImportRequired=True, run=None)
    if running:
        body["run"] = {
            **source_fixtures["run"],
            "mode": "initial",
            "automatic": True,
            "status": "running",
            "completedAt": None,
            "sources": [
                {**status, "status": "queued", "count": 0}
                for status in body["sources"]
                if status["source"] != "usage_reports"
            ],
        }
    entra.api_responses.append(httpx2.Response(200, json=body))
    result = await rpc("get_sync_state")
    assert not result.get("isError"), result
    assert result["structuredContent"] == body
    assert len(entra.api_calls) == 1
    assert entra.api_calls[0].method == "GET"
    assert entra.api_calls[0].url.path == "/api/data-sync/state"
