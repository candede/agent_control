import json

import httpx2
import pytest
from pydantic import ValidationError
from test_tools import GUID, RECORD, SOURCE, response_for

from agent_control_mcp.inventory_models import FreshnessSource, ProviderUsage, QuarantineIdentity
from agent_control_mcp.tools import operation_named

PROVENANCE = {
    "sourceSystem": "power_platform",
    "path": "properties.cdsBotId",
    "maturity": "preview",
}
METRICS = ["totalRunTimeInHours", "exceptionRate"]


@pytest.fixture(params=["inventory_packages", "inventory_power_platform"])
def freshness_source(request):
    native = request.param == "inventory_power_platform"
    # InventoryQueries.summaries projects saved membership and latest collection counts separately.
    return {
        "scope_id": SOURCE,
        "source": request.param,
        "selector": "complete",
        "row_count": "2",
        "collected_count": "1",
        "generation_id": GUID,
        "observed_at": "2026-10-16T00:00:00Z",
        "expires_at": "2026-10-16T00:10:00Z",
        "channel": "catalog",
        "environment_id": None,
        "resource_types": ["microsoft.copilotstudio/agents"] if native else [],
        "baseline_id": GUID,
        "role_scope": "unknown" if native else None,
        "agent_count": 2 if native else 0,
        "expected_count": "1",
        "page_count": 1,
        "unknown_field_count": 0,
        "wire_count": "1",
        "complete": True,
        "catalog_scope_complete": True,
        "catalog_complete": True,
        "catalog_observed_at": "2026-10-16T00:00:00Z",
        "catalog_expires_at": "2026-10-16T00:10:00Z",
        "captured_revision": "1",
        "current": True,
    }


@pytest.mark.parametrize("count_type", [int, str], ids=["integer", "postgres-bigint"])
def test_freshness_source_preserves_current_saved_projection(freshness_source, count_type):
    body = {
        **freshness_source,
        "row_count": count_type(2),
        "collected_count": count_type(1),
    }
    parsed = FreshnessSource.model_validate_json(json.dumps(body))
    assert json.loads(parsed.model_dump_json(exclude_unset=True)) == body


@pytest.mark.parametrize("extra_field", ["token_mode", "unexpected"])
def test_freshness_source_rejects_fields_outside_current_projection(freshness_source, extra_field):
    with pytest.raises(ValidationError):
        FreshnessSource.model_validate_json(
            json.dumps({**freshness_source, extra_field: "delegated"})
        )


def test_freshness_source_requires_collection_count(freshness_source):
    del freshness_source["collected_count"]
    with pytest.raises(ValidationError):
        FreshnessSource.model_validate_json(json.dumps(freshness_source))


@pytest.mark.parametrize("provenance", [None, PROVENANCE], ids=["unknown", "observed"])
def test_quarantine_identity_preserves_saved_provenance(provenance):
    body = {"environmentId": GUID, "botId": GUID, "provenance": provenance}
    parsed = QuarantineIdentity.model_validate_json(json.dumps(body))
    assert json.loads(parsed.model_dump_json(exclude_unset=True)) == body


@pytest.mark.parametrize("field", METRICS)
@pytest.mark.parametrize("value", [None, 0, 0.125, 9007199254740991])
def test_provider_telemetry_preserves_valid_values(field, value):
    body = {field: value}
    parsed = ProviderUsage.model_validate_json(json.dumps(body))
    assert json.loads(parsed.model_dump_json(exclude_unset=True)) == body


@pytest.mark.parametrize("field", METRICS)
@pytest.mark.parametrize(
    "value",
    [
        pytest.param(-0.125, id="negative"),
        pytest.param(float("nan"), id="nan"),
        pytest.param(float("inf"), id="infinite"),
        pytest.param(float("-inf"), id="negative-infinite"),
        pytest.param(9007199254740992, id="unsafe-number"),
        pytest.param(True, id="boolean"),
        pytest.param("1", id="string"),
    ],
)
def test_provider_telemetry_rejects_invalid_values(field, value):
    with pytest.raises(ValidationError):
        ProviderUsage.model_validate_json(json.dumps({field: value}))


@pytest.mark.parametrize(
    "value",
    [
        None,
        "2026-10-27T15:07:57Z",
        "2024-02-29T23:59:59.123456789Z",
        "2026-10-27T15:07:57.125+04:00",
        "2026-10-27T15:07:57+14:00",
        "2026-10-27T15:07:57-14:00",
    ],
)
def test_provider_telemetry_preserves_valid_timestamps(value):
    body = {"lastUsedDateTime": value}
    parsed = ProviderUsage.model_validate_json(json.dumps(body))
    assert json.loads(parsed.model_dump_json(exclude_unset=True)) == body


def test_provider_telemetry_preserves_omitted_fields():
    parsed = ProviderUsage.model_validate_json("{}")
    assert json.loads(parsed.model_dump_json(exclude_unset=True)) == {}


@pytest.mark.parametrize(
    "value",
    [
        "",
        "yesterday",
        "2026-10-27",
        "2026-10-27T15:07:57",
        "2026-10-27 15:07:57Z",
        "2026-02-29T15:07:57Z",
        "2026-13-01T15:07:57Z",
        "2026-10-27T24:07:57Z",
        "2026-10-27T15:60:57Z",
        "2026-10-27T15:07:60Z",
        "2026-10-27T15:07:57.1234567890Z",
        "2026-10-27T15:07:57+14:01",
        "2026-10-27T15:07:57-14:01",
        "2026-10-27T15:07:57+15:00",
        "2026-10-27T15:07:57+04:60",
        "0000-01-01T00:00:00Z",
        True,
        0,
    ],
)
def test_provider_telemetry_rejects_invalid_timestamps(value):
    with pytest.raises(ValidationError):
        ProviderUsage.model_validate_json(json.dumps({"lastUsedDateTime": value}))


def test_quarantine_identity_keeps_strict_evidence_fields():
    for provenance in ({**PROVENANCE, "unexpected": True}, {**PROVENANCE, "maturity": "invalid"}):
        with pytest.raises(ValidationError):
            QuarantineIdentity.model_validate_json(
                json.dumps({"environmentId": GUID, "botId": GUID, "provenance": provenance})
            )
    with pytest.raises(ValidationError):
        QuarantineIdentity.model_validate_json(
            json.dumps({"environmentId": GUID, "botId": GUID, "unexpected": True})
        )


@pytest.mark.parametrize("name", ["get_agent", "list_agents"])
@pytest.mark.parametrize("provenance", [None, PROVENANCE], ids=["unknown", "observed"])
async def test_sdk_preserves_native_quarantine_provenance(
    name, provenance, rpc, entra, source_fixtures
):
    operation = operation_named(name)
    body = response_for(operation, source_fixtures["complete"])
    agent = body if name == "get_agent" else body["value"][0]
    agent["powerPlatformResource"]["quarantineIdentity"] = {
        "environmentId": GUID,
        "botId": GUID,
        "provenance": provenance,
    }
    entra.api_responses.append(httpx2.Response(200, json=body))
    request = {"selectionId": GUID}
    if name == "get_agent":
        request["recordId"] = RECORD
    result = await rpc(name, request)
    assert not result.get("isError"), result
    assert result["structuredContent"] == body
    assert len(entra.api_calls) == 1


@pytest.mark.parametrize("name", ["get_agent", "list_agents", "get_package", "list_packages"])
@pytest.mark.parametrize(
    ("field", "valid_value", "invalid_value"),
    [
        ("totalRunTimeInHours", 0.125, float("nan")),
        ("exceptionRate", 0, float("inf")),
        ("lastUsedDateTime", "2026-10-27T15:07:57.123456789+04:00", "yesterday"),
    ],
)
@pytest.mark.parametrize("valid", [False, True], ids=["invalid", "valid"])
async def test_sdk_validates_provider_telemetry(
    name, field, valid_value, invalid_value, valid, rpc, entra, source_fixtures
):
    operation = operation_named(name)
    body = response_for(operation, source_fixtures["complete"])
    if name in {"get_package", "list_packages"}:
        package = body if name == "get_package" else body["value"][0]
    else:
        agent = body if name == "get_agent" else body["value"][0]
        package = agent["packages"][0]
    package["providerUsage"] = {
        field: valid_value if valid else invalid_value,
        "activeUsers": None,
    }
    entra.api_responses.append(
        httpx2.Response(200, content=json.dumps(body), headers={"Content-Type": "application/json"})
    )
    request = {"selectionId": GUID}
    if name == "get_agent":
        request["recordId"] = RECORD
    elif name == "get_package":
        request["id"] = GUID
    result = await rpc(name, request)
    if valid:
        assert not result.get("isError"), result
        assert result["structuredContent"] == body
    else:
        assert result["isError"], result
        error = json.loads(result["content"][0]["text"])
        assert error["status"] == 502
        assert error["code"] == "invalid_api_response"
    assert len(entra.api_calls) == 1


@pytest.mark.parametrize("state", ["not_collected", "preparing", "unavailable"])
async def test_sdk_preserves_first_run_inventory_state(state, rpc, entra):
    body = {"state": state, "message": "Saved inventory is not available yet."}
    entra.api_responses.append(httpx2.Response(200, json=body))
    result = await rpc("get_inventory_health")
    assert not result.get("isError"), result
    assert result["structuredContent"] == body
    assert len(entra.api_calls) == 1


@pytest.mark.parametrize(
    "name", ["get_inventory_health", "list_agents", "get_inventory_summary", "list_packages"]
)
async def test_sdk_preserves_nonempty_inventory_freshness(
    name, freshness_source, rpc, entra, source_fixtures
):
    operation = operation_named(name)
    body = response_for(operation, source_fixtures["complete"])
    body["freshness"]["sources"] = [freshness_source]
    entra.api_responses.append(httpx2.Response(200, json=body))
    request = {} if name == "get_inventory_health" else {"selectionId": GUID}
    result = await rpc(name, request)
    assert not result.get("isError"), result
    assert result["structuredContent"] == body
    assert len(entra.api_calls) == 1
