"""Discovery input bounds mirror the canonical API without changing valid payloads."""

import pytest
from pydantic import ValidationError

from agent_control_mcp import discovery_models as discovery

GUID = "12345678-1234-4234-8234-123456789abc"
SUBJECT = "member@example.invalid"


@pytest.mark.parametrize(
    "model,required",
    [
        (discovery.SearchInput, {}),
        (discovery.PreviewSearch, {"subject": SUBJECT}),
    ],
)
@pytest.mark.parametrize(
    "payload",
    [
        {"goal": "unsafe\ncontrol"},
        {"goal": "\u0085"},
        {"goal": "\ud800"},
        {"goal": "\U0001f9ed" * 257},
        {"goal": "\u3300" * 129},
        {"terms": [""]},
        {"terms": ["\ufeff"]},
        {"terms": ["unsafe\tcontrol"]},
        {"terms": ["\udfff"]},
        {"terms": ["\U0001f9ed" * 65]},
        {"terms": ["\u3300" * 33]},
        {"terms": ["BRD", "brd"]},
        {"terms": ["ＢＲＤ", " brd "]},
        {"terms": ["\u0130", "i\u0307"]},
        {"terms": ["\u01f0", "j\u030c"]},
        {"terms": ["a"] * 9},
        {"limit": 0},
        {"limit": 21},
        {"limit": True},
        {"goal": None},
    ],
)
def test_search_rejects_canonical_invalid_text(model, required, payload):
    with pytest.raises(ValidationError):
        model.model_validate({**required, **payload})


@pytest.mark.parametrize(
    "model,required",
    [
        (discovery.SearchInput, {}),
        (discovery.DetailInput, {"agentId": GUID}),
        (discovery.PreviewSearch, {"subject": SUBJECT}),
        (discovery.PreviewDetail, {"subject": SUBJECT, "agentId": GUID}),
    ],
)
@pytest.mark.parametrize(
    "payload",
    [
        {"cursor": "unbound"},
        {"selectionId": GUID, "cursor": ""},
        {"selectionId": GUID, "cursor": "x" * 4097},
        {"selectionId": GUID, "cursor": "\u6f22" * 1366},
        {"selectionId": GUID, "cursor": "\U0001f9ed" * 1025},
        {"selectionId": GUID, "cursor": "\ud800"},
    ],
)
def test_continuations_require_selection_and_utf8_byte_bound(model, required, payload):
    with pytest.raises(ValidationError):
        model.model_validate({**required, **payload})


@pytest.mark.parametrize(
    "model,required",
    [
        (discovery.DetailInput, {}),
        (discovery.PreviewDetail, {"subject": SUBJECT}),
    ],
)
@pytest.mark.parametrize("agent_id", ["native-id", "agent:" + GUID, " " + GUID, GUID + " "])
def test_detail_requires_canonical_agent_uuid(model, required, agent_id):
    with pytest.raises(ValidationError):
        model.model_validate({**required, "agentId": agent_id})


@pytest.mark.parametrize(
    "model,required",
    [
        (discovery.PreviewProfile, {}),
        (discovery.PreviewSearch, {}),
        (discovery.PreviewDetail, {"agentId": GUID}),
        (discovery.PreviewWorkplace, {}),
    ],
)
@pytest.mark.parametrize("subject", ["", "\ufeff", "\u0085", "\ud800", "\U0001f9ed" * 257])
def test_preview_subject_uses_canonical_text_bound(model, required, subject):
    with pytest.raises(ValidationError):
        model.model_validate({**required, "subject": subject})


@pytest.mark.parametrize(
    "model,required",
    [
        (discovery.SearchInput, {}),
        (discovery.PreviewSearch, {"subject": SUBJECT}),
    ],
)
@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"goal": ""},
        {"goal": "\U0001f9ed" * 256, "limit": 20},
        {"goal": "\u3300" * 128},
        {"terms": [str(index) + "t" * 127 for index in range(8)]},
        {"terms": ["\U0001f9ed" * 64, "\u3300" * 32]},
        {"terms": [" ＢＲＤ ", "STRASSE", "Straße"]},
        {"goal": "\ufeff", "terms": []},
    ],
)
def test_search_preserves_valid_payload_and_omissions(model, required, payload):
    request = {**required, **payload}
    assert model.model_validate(request).model_dump(exclude_unset=True) == request


@pytest.mark.parametrize(
    "model,required",
    [
        (discovery.SearchInput, {}),
        (discovery.DetailInput, {"agentId": GUID}),
        (discovery.PreviewSearch, {"subject": SUBJECT}),
        (discovery.PreviewDetail, {"subject": SUBJECT, "agentId": GUID}),
    ],
)
@pytest.mark.parametrize("cursor", ["x" * 4096, "\U0001f9ed" * 1024, "signed:page+2/Case"])
def test_bound_continuations_preserve_exact_cursor(model, required, cursor):
    request = {**required, "selectionId": GUID, "cursor": cursor}
    assert model.model_validate(request).model_dump(exclude_unset=True) == request


def test_detail_schema_advertises_uuid_and_normalizes_case():
    selection = discovery.DiscoveryInput.model_json_schema()["properties"]["selectionId"]
    pattern = selection["anyOf"][0]["pattern"]
    for model in (discovery.DetailInput, discovery.PreviewDetail):
        assert model.model_json_schema()["properties"]["agentId"]["pattern"] == pattern
    assert discovery.DetailInput(agentId=GUID.upper()).agentId == GUID


@pytest.mark.parametrize(
    "model,required",
    [
        (discovery.PreviewProfile, {}),
        (discovery.PreviewSearch, {}),
        (discovery.PreviewDetail, {"agentId": GUID}),
        (discovery.PreviewWorkplace, {}),
    ],
)
def test_preview_subject_preserves_utf16_boundary_and_exact_payload(model, required):
    request = {**required, "subject": "\U0001f9ed" * 256}
    assert model.model_validate(request).model_dump(exclude_unset=True) == request


@pytest.mark.parametrize(
    "operation,payload",
    [
        ("search_agent_catalog", {"cursor": "unbound"}),
        ("read_discovery_detail", {"agentId": "native-id"}),
        ("preview_discovery_search", {"subject": SUBJECT, "terms": ["BRD", "brd"]}),
        ("preview_discovery_profile", {"subject": "\U0001f9ed" * 257}),
    ],
)
async def test_invalid_discovery_never_dispatches(operation, payload, rpc, entra):
    result = await rpc(operation, payload)
    assert result["isError"]
    assert not entra.api_calls


@pytest.mark.parametrize("kind", ["organization_created", "microsoft"])
def test_origin_and_about_keep_independent_exact_source_memberships(kind):
    membership = {
        "source": "graph_packages",
        "generationId": GUID,
        "sourceIdentity": "ExactPackage",
        "revision": GUID,
    }
    origin = discovery.Origin.model_validate(
        {
            "kind": kind,
            "evidence": [{**membership, "field": "creatorType", "setId": GUID, "versionId": GUID}],
        }
    )
    native = discovery.Provenance.model_validate(
        {
            **membership,
            "source": "power_platform",
            "sourceIdentity": "native-source",
            "observedAt": "2026-11-08T00:00:00Z",
            "descriptionField": "details.description",
            "descriptionState": "absent",
        }
    )
    graph = discovery.Provenance.model_validate(
        {
            **membership,
            "observedAt": "2026-11-08T00:00:00Z",
            "descriptionField": "longDescription",
            "descriptionState": "available",
        }
    )
    assert origin.kind == kind
    assert native.descriptionState == "absent"
    assert graph.descriptionState == "available"
    assert graph.sourceIdentity == "ExactPackage"


@pytest.mark.parametrize("kind", ["third_party", "unknown", "locally_approved"])
def test_employee_origin_never_expands_to_third_party_or_approval(kind):
    with pytest.raises(ValidationError):
        discovery.Origin.model_validate({"kind": kind, "evidence": []})
