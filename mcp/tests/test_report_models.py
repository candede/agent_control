import copy
import json

import httpx2
import pytest
from pydantic import ValidationError

from agent_control_mcp.report_models import UsageAssociation, UsageAssociations

GUID = "12345678-1234-4234-8234-123456789abc"
PACKAGE_TARGET = {
    "source": "graph_packages",
    "packageId": "Package/Case%Exact",
    "snapshotId": GUID,
}
NATIVE_TARGET = {
    "source": "power_platform",
    "nativeId": "Native/Case%Exact",
    "environmentId": "Environment/Case%Exact",
    "snapshotId": GUID,
}
VALID_TARGETS = [
    PACKAGE_TARGET,
    NATIVE_TARGET,
    {**NATIVE_TARGET, "environmentId": None},
]
INVALID_TARGETS = [
    pytest.param(
        {key: value for key, value in PACKAGE_TARGET.items() if key != "packageId"},
        id="missing-package-id",
    ),
    pytest.param({**PACKAGE_TARGET, "packageId": None}, id="null-package-id"),
    pytest.param({**PACKAGE_TARGET, "nativeId": "WrongSource"}, id="package-with-native-id"),
    pytest.param({**PACKAGE_TARGET, "environmentId": None}, id="package-with-environment-id"),
    pytest.param(
        {key: value for key, value in NATIVE_TARGET.items() if key != "nativeId"},
        id="missing-native-id",
    ),
    pytest.param({**NATIVE_TARGET, "nativeId": None}, id="null-native-id"),
    pytest.param(
        {key: value for key, value in NATIVE_TARGET.items() if key != "environmentId"},
        id="missing-environment-id",
    ),
    pytest.param({**NATIVE_TARGET, "packageId": "WrongSource"}, id="native-with-package-id"),
    pytest.param(
        {key: value for key, value in PACKAGE_TARGET.items() if key != "snapshotId"},
        id="missing-package-snapshot",
    ),
    pytest.param(
        {key: value for key, value in NATIVE_TARGET.items() if key != "snapshotId"},
        id="missing-native-snapshot",
    ),
]


@pytest.mark.parametrize(
    "target", VALID_TARGETS, ids=["package", "native", "native-null-environment"]
)
def test_usage_association_targets_round_trip(target, source_fixtures):
    body = copy.deepcopy(source_fixtures["usageAssociations"])
    body["value"][0]["target"] = target
    parsed = UsageAssociations.model_validate_json(json.dumps(body))
    assert json.loads(parsed.model_dump_json(exclude_unset=True, by_alias=True)) == body


@pytest.mark.parametrize("target", INVALID_TARGETS)
def test_usage_association_rejects_invalid_source_target(target):
    body = {
        "reportAgentId": "Report/Case%Exact",
        "agentName": "Saved report agent",
        "responses": 1,
        "basis": "reviewed",
        "target": target,
    }
    with pytest.raises(ValidationError):
        UsageAssociation.model_validate_json(json.dumps(body))


def test_usage_association_schema_requires_exact_source_fields():
    schema = UsageAssociations.model_json_schema()
    target = schema["$defs"]["UsageAssociation"]["properties"]["target"]
    assert target["discriminator"]["propertyName"] == "source"
    assert len(target["oneOf"]) == 2
    for source, fields in (
        ("graph_packages", {"source", "packageId", "snapshotId"}),
        ("power_platform", {"source", "nativeId", "environmentId", "snapshotId"}),
    ):
        reference = target["discriminator"]["mapping"][source]
        variant = schema["$defs"][reference.rsplit("/", 1)[1]]
        assert set(variant["required"]) == fields
        assert set(variant["properties"]) == fields
        assert variant["additionalProperties"] is False


@pytest.mark.parametrize(
    "target", VALID_TARGETS, ids=["package", "native", "native-null-environment"]
)
async def test_sdk_preserves_valid_usage_association_targets(target, rpc, entra, source_fixtures):
    body = copy.deepcopy(source_fixtures["usageAssociations"])
    body["value"][0]["target"] = target
    entra.api_responses.append(httpx2.Response(200, json=body))
    result = await rpc(
        "list_agent_usage_associations",
        {"recordId": "agent:" + GUID, "selectionId": GUID},
    )
    assert not result.get("isError"), result
    assert result["structuredContent"] == body
    assert len(entra.api_calls) == 1


@pytest.mark.parametrize("target", INVALID_TARGETS)
async def test_sdk_reports_invalid_usage_association_targets(target, rpc, entra, source_fixtures):
    body = copy.deepcopy(source_fixtures["usageAssociations"])
    body["value"][0]["target"] = target
    entra.api_responses.append(httpx2.Response(200, json=body))
    result = await rpc(
        "list_agent_usage_associations",
        {"recordId": "agent:" + GUID, "selectionId": GUID},
    )
    assert result["isError"], result
    error = json.loads(result["content"][0]["text"])
    assert error["status"] == 502
    assert error["code"] == "invalid_api_response"
    assert len(entra.api_calls) == 1
