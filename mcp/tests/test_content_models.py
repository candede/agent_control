import pytest
from pydantic import ValidationError

from agent_control_mcp.content_models import Draft, EvidenceQuery, Narrative


def test_exact_business_nulls_are_valid_without_weakening_optional_null_rejection():
    payload = {
        "kind": "brief",
        "title": "Manual",
        "scope": {"company": None, "department": None},
        "narrative": dict.fromkeys(Narrative.model_fields, ""),
        "learning": None,
        "evidenceKind": "contributor_provided",
        "visibility": "staff_only",
        "assigneeId": None,
        "dueDate": None,
        "status": "open",
        "progress": "",
        "agentIds": [],
        "linkedIds": [],
    }
    assert Draft.model_validate(payload).model_dump(exclude_unset=True) == payload
    for field in ("title", "narrative", "baseline", "role"):
        with pytest.raises(ValidationError):
            Draft.model_validate({**payload, field: None})


def test_selected_evidence_filters_match_create_and_follow_up_contracts():
    query = {
        "company": None,
        "department": None,
        "officeSelectionId": "10000000-0000-4000-8000-000000000001",
        "reportSelectionId": "10000000-0000-4000-8000-000000000002",
        "officeBaseline": "10000000-0000-4000-8000-000000000003",
        "inventorySelectionId": "10000000-0000-4000-8000-000000000004",
    }
    assert EvidenceQuery.model_validate(query).model_dump(exclude_unset=True) == query
