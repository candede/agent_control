"""Distributed assets against native schemas and actual OAuth/HTTP wire, not model proof."""

import copy
import hashlib
import json
import re
import zipfile
from pathlib import Path
from urllib.parse import parse_qs, urldefrag

import httpx2
import pytest
import yaml
from conftest import canonical_profiles, protocol_client, tokens
from pydantic import ValidationError
from test_tools import GUID, RECORD, response_for

from agent_control_mcp.domains import PUBLIC_TOOLS
from agent_control_mcp.projection import AccessProfile, projected_catalog
from agent_control_mcp.report_models import DirectoryIdentity

ROOT = Path(__file__).resolve().parents[2]
KIT = ROOT / "frontend/public/customer-kit/adoption-intelligence"
CORPUS = json.loads((KIT / "recipes.json").read_text())
TEMPLATES = json.loads((KIT / "templates.json").read_text())
PROMPTS = json.loads((KIT / "prompts.json").read_text())
TOOLS = {tool.name: tool for tool in PUBLIC_TOOLS}


def values():
    return {
        "$company": "Example",
        "$department": "Office",
        "$setId": GUID,
        "$inventorySelectionId": GUID,
        "$groupSelectionId": GUID,
        "$userSelectionId": GUID,
        "$personId": GUID,
        "$officeSelectionId": GUID,
        "$reportSelectionId": GUID,
        "$recordId": RECORD,
        "$sourceScopeId": GUID,
        "$sourceIdentity": "Exact-Synthetic-Package",
        "$discoverySelectionId": GUID,
        "$agentId": GUID,
        "$requestId": "1794168000000." + GUID,
        "$draft": TEMPLATES["draft"],
        "$contentId": GUID,
        "$groupId": "a" * 64,
        "$followUpQuery": {
            "company": "Example",
            "department": "Office",
            "officeSelectionId": GUID,
            "reportSelectionId": GUID,
        },
        "$deleteConfirmation": "delete:" + GUID,
    }


def bind(value, bindings):
    if isinstance(value, str):
        return copy.deepcopy(bindings[value]) if value.startswith("$") else value
    if isinstance(value, dict):
        return {key: bind(item, bindings) for key, item in value.items()}
    if isinstance(value, list):
        return [bind(item, bindings) for item in value]
    return value


def operation(step):
    tool = TOOLS[step["tool"]]
    return next(
        branch.operation
        for branch in tool.branches
        if not tool.grouped or branch.action == step["request"]["action"]
    )


def test_skill_frontmatter_and_all_packaged_links_are_self_contained():
    text = (KIT / "SKILL.md").read_text()
    front = yaml.safe_load(text.split("---", 2)[1])
    assert front["name"] == KIT.name
    assert re.fullmatch(r"[a-z0-9-]{1,64}", front["name"])
    assert 20 < len(front["description"]) < 1024
    for keyword in ("adoption", "learning", "Office", "saves", "recovery"):
        assert keyword in front["description"]
    for path in KIT.glob("*.md"):
        for link in re.findall(r"\]\(([^)]+)\)", path.read_text()):
            if link.startswith("https://"):
                continue
            target, _ = urldefrag(link)
            assert target.startswith("./"), (path, link)
            assert (path.parent / target).resolve().is_relative_to(KIT)
            assert (path.parent / target).is_file(), (path, link)
    assert not (ROOT / "backend/scripts/fixtures/mcp-workflows.json").exists()
    serialized = "\n".join(path.read_text() for path in KIT.iterdir())
    assert not re.search(
        r"SEHA|devtunnels\.ms|FY27|PRIVATE KEY|eyJ[\w-]+\.[\w-]+\.[\w-]+", serialized
    )


@pytest.mark.parametrize(
    "step",
    [step for recipe in CORPUS["recipes"].values() for step in recipe],
    ids=lambda step: step["id"],
)
def test_every_distributed_recipe_uses_the_current_native_schema(step):
    request = bind(step["request"], values())
    TOOLS[step["tool"]].request.model_validate(request)
    assert step["output"]
    if step["tool"] == "agent_usage":
        invalid = copy.deepcopy(request)
        invalid["input"]["selectionId"] = "b" * 8 + GUID[8:]
        with pytest.raises(ValidationError):
            TOOLS["agent_usage"].request.model_validate(invalid)


@pytest.mark.parametrize("prompt", PROMPTS["prompts"], ids=lambda prompt: prompt["id"])
def test_every_prompt_has_deterministic_role_evidence_output_contract(prompt):
    assert prompt["role"] in {"staff", "employee"}
    assert prompt["sourceState"] and len(prompt["output"]) >= 2
    assert len(prompt["novice"]) > 40 and len(prompt["experienced"]) > 60
    assert prompt["recipe"] in CORPUS["recipes"]
    assert len(PROMPTS["contract"]["evidenceChecklist"]) == 7
    assert len(PROMPTS["contract"]["outputChecklist"]) == 5
    assert PROMPTS["contract"]["failureThreshold"] == 1
    for evidence in prompt["evidence"]:
        tool, action = evidence.split(".")
        assert tool in TOOLS
        assert action in {branch.action for branch in TOOLS[tool].branches}
        if prompt["role"] == "employee":
            assert tool in {
                "agent_catalog",
                "my_workplace",
                "my_discovery_profile",
                "shared_learning",
            }
    assert len(PROMPTS["prompts"][:16]) == 16
    assert all(prompt["role"] == "staff" for prompt in PROMPTS["prompts"][:16])


def test_actual_end_user_projection_and_content_mutation_guidance():
    employee = projected_catalog(AccessProfile.model_validate(canonical_profiles()["end_user"]))
    assert {tool.name for tool in employee} == {
        "agent_catalog",
        "my_discovery_profile",
        "my_workplace",
        "shared_learning",
    }
    assert sum(len(tool.branches) for tool in employee) == 5
    admin = projected_catalog(AccessProfile.model_validate(canonical_profiles()["admin"]))
    content = next(tool for tool in admin if tool.name == "adoption_content")
    assert "exact preview" not in content.description
    assert all(operation(step).saved_read for step in CORPUS["recipes"]["employee"])
    assert operation(CORPUS["recipes"]["save"][0]).idempotent
    assert operation(CORPUS["recipes"]["save"][-1]).destructive


def test_department_email_uses_existing_reads_and_keeps_work_iq_separate():
    guide = PROMPTS["conversations"][0]
    assert guide["id"] == "department-adoption-email" and guide["role"] == "staff"
    assert guide["recipe"] == "department-email" and len(guide["steps"]) == 2
    analysis, draft = guide["steps"]
    assert "complete all needed lookups and analysis yourself" in analysis["prompt"]
    assert "Do not write an email, create an Outlook draft" in analysis["prompt"]
    assert "Explain missing evidence and continue with what is available" not in analysis["prompt"]
    assert "only if it materially changes a recommendation or blocks the task" in analysis["prompt"]
    assert "final findings and recommendations we agreed" in draft["prompt"]
    assert "Preserve our agreed edits" in draft["prompt"]
    assert "do not add disclaimer or appendix sections unless requested" in draft["prompt"]
    assert "Fetch every page of Agent Control users.list" in draft["prompt"]
    assert "Pass the email addresses or UPNs returned by Agent Control directly" in draft["prompt"]
    assert "Do not ask Work IQ to search for people or confirm these addresses" in draft["prompt"]
    assert "Do not create a recipient-less draft" in draft["prompt"]
    assert "update that draft instead of creating a duplicate" in draft["prompt"]
    assert "resolve addresses with Work IQ rather than guessing" not in draft["prompt"]
    steps = {step["id"]: step for step in CORPUS["recipes"][guide["recipe"]]}
    assert all(
        not operation(step).provider
        and not operation(step).destructive
        and (
            operation(step).method == "GET"
            or operation(step).saved_read
            or operation(step).name == "capture_agent_inventory"
        )
        for step in steps.values()
    )
    assert all(step["tool"] != "adoption_content" for step in steps.values())
    assert set(steps["roster"]["request"]["input"]) == {"company", "department", "setId", "limit"}
    assert "Work IQ people-search confirmation is not required" in steps["roster"]["output"]
    relationships = steps["member-used-agents"]["request"]["input"]
    assert relationships["selectionId"] == "$userSelectionId"
    assert relationships["relationship"] == "used"
    assert steps["champions"]["request"]["input"]["selectionId"] == "$groupSelectionId"
    assert "reportSelectionId" in steps["support-users"]["request"]["input"]
    assert "setId" not in steps["support-users"]["request"]["input"]
    assert "whole-department" in steps["group"]["output"]
    assert "not the full department recipient roster" in steps["opportunity"]["output"]
    assert "Never send" in guide["steps"][-1]["prompt"]
    assert "Work IQ" in guide["steps"][-1]["prompt"]


def test_department_email_requires_findings_and_grounded_proposals_not_invented_roles():
    analysis, draft = PROMPTS["conversations"][0]["steps"]
    for requirement in (
        "returned department-level counts and valid denominators",
        "what is working well",
        "specific improvement opportunities supported by the evidence",
        "internally trace the department task",
        "concrete supported input and output",
        "Do not personalize a generic prompt merely by adding the department name",
        "Use actual job titles or role context only when returned or supplied",
        "do not invent them or make them a prerequisite",
        "not actual employee prompts or verified successful workflows",
        "without requiring observed departmental use or inventory presence",
    ):
        assert requirement in analysis["prompt"]
    for requirement in (
        "introduce us as the Copilot Adoption Team",
        "stated reporting period",
        "short factual usage summary",
        "what is working well and where we can improve",
        "do not replace the analysis with an agent catalog",
        "why its documented capability fits that task",
        "prompt labeled Suggested example",
        "inspect the saved body through the tool result or supported read-back",
        "do not make read-back support a prerequisite to drafting",
    ):
        assert requirement in draft["prompt"]
    steps = {step["id"]: step for step in CORPUS["recipes"]["department-email"]}
    assert "API-owned department counts" in steps["group"]["output"]
    assert (
        "adding a department name to a generic example is insufficient" in steps["about"]["output"]
    )
    assert "never captured employee prompts" in steps["about"]["output"]
    assert (
        "do not require observed departmental use or inventory presence"
        in steps["starter-detail"]["output"]
    )
    assert "jobTitle" not in DirectoryIdentity.model_fields
    staff = " ".join((KIT / "staff.md").read_text().split())
    assert "saved users.list roster does not return job titles" in staff


def test_department_email_presentation_ships_enterprise_context_and_readable_fallback():
    staff = (KIT / "staff.md").read_text()
    staff_text = " ".join(staff.split())
    skill = (KIT / "SKILL.md").read_text()
    draft = PROMPTS["conversations"][0]["steps"][1]["prompt"]
    assert "staff.md#department-email-presentation" in skill
    assert "## Department email presentation" in staff
    for requirement in (
        "wide responsive column capped at 960px",
        "16px body text with 26px line height",
        "24px between sections",
    ):
        assert requirement in draft and requirement in staff_text
    assert "preserve the HTML/rich-text body using its supported mail-body format" in draft
    assert "Do not require a separate formatting probe, approval or extra user step" in staff_text
    assert "If the tool explicitly cannot preserve rich formatting" in staff_text
    assert "Do not block drafting just for styling" in draft
    assert "do not silently downgrade" in staff_text
    layout = staff.split("```html\n", 1)[1].split("\n```", 1)[0]
    assert 'lang="en"' in layout and 'name="viewport"' in layout
    assert "max-width:960px" in layout and "font-size:16px;line-height:26px" in layout
    assert "<h1" in layout and "<h2" in layout and "<h3" in layout
    for required in (
        "We are the Copilot Adoption Team",
        "[Company]",
        "[Reporting period]",
        "Findings at a glance",
        "What is working",
        "Where we can improve",
        "[Department fit and supported capability]",
        "<strong>Suggested example:</strong>",
        "Recommended next step",
    ):
        assert required in layout
    for forbidden in (
        "<script",
        "<style",
        "<img",
        "href=",
        "display:flex",
        "display:grid",
        "max-width:640px",
        "&#",
        "border-radius",
        'bgcolor="#eef2ff"',
        "Make everyday work easier",
    ):
        assert forbidden not in layout


def test_built_download_package_bytes_hashes_and_employee_projection():
    built = ROOT / "frontend/dist/customer-kit"
    manifest = json.loads((built / "manifest.json").read_text())
    digest = hashlib.sha256()
    for path in sorted(KIT.iterdir()):
        digest.update(path.name.encode() + b"\0" + path.read_bytes() + b"\0")
    assert manifest["version"] == digest.hexdigest()
    with zipfile.ZipFile(built / "adoption-intelligence.zip") as package:
        assert package.testzip() is None
        assert set(package.namelist()) == {
            "adoption-intelligence/" + file["path"] for file in manifest["files"]
        }
        for file in manifest["files"]:
            path = file["path"]
            copied = (built / "adoption-intelligence" / path).read_bytes()
            assert copied == package.read("adoption-intelligence/" + path)
            assert len(copied) == file["bytes"]
            assert hashlib.sha256(copied).hexdigest() == file["sha256"]
            if path != "employee-prompts.json":
                assert copied == (KIT / path).read_bytes()
    projected = json.loads((built / "adoption-intelligence/employee-prompts.json").read_text())
    assert projected["prompts"] == [p for p in PROMPTS["prompts"] if p["role"] == "employee"]
    assert "staffRole" not in projected["contract"]
    assert len(projected["prompts"]) == 4
    assert projected["conversations"] == [
        guide for guide in PROMPTS["conversations"] if guide["role"] == "employee"
    ]
    assert "department-adoption-email" not in json.dumps(projected)


async def test_distributed_department_recipe_full_peers_about_and_explicit_save(
    rpc, entra, source_fixtures, record_property
):
    bindings = values()
    trace = []

    async def call(step, response):
        request = bind(step["request"], bindings)
        op = operation(step)
        op.response.model_validate(response)
        entra.api_responses.append(httpx2.Response(200, json=response))
        result = await rpc(step["tool"], request, wire=True)
        assert not result.get("isError"), result
        expected = (
            {"action": request["action"], "result": response}
            if TOOLS[step["tool"]].grouped
            else response
        )
        assert result["structuredContent"] == expected
        trace.append(step["id"])
        return response

    steps = {step["id"]: step for step in CORPUS["recipes"]["department"]}
    await call(steps["periods"], response_for(operation(steps["periods"]), source_fixtures))
    inventory = await call(
        steps["inventory"], response_for(operation(steps["inventory"]), source_fixtures)
    )
    bindings["$inventorySelectionId"] = inventory["id"]
    opportunity = await call(
        steps["opportunity"], response_for(operation(steps["opportunity"]), source_fixtures)
    )
    bindings["$officeSelectionId"] = opportunity["context"]["office"]["selection"]["id"]
    bindings["$reportSelectionId"] = opportunity["context"]["report"]["selection"]["id"]
    group = await call(steps["group"], response_for(operation(steps["group"]), source_fixtures))
    bindings["$groupSelectionId"] = group["selection"]["id"]
    champions = response_for(operation(steps["peers"]), source_fixtures)
    champions["champions"] = [
        {
            "objectId": f"20000000-0000-4000-8000-{index:012}",
            "name": f"Peer {index}",
            "rank": index,
            "created": 1,
            "responses": 1,
            "agents": 1,
        }
        for index in range(1, 4)
    ]
    row = champions["value"][0]
    edges = [
        {
            **row,
            "id": f"agent:10000000-0000-4000-8000-{index:012}",
            "canonicalId": f"10000000-0000-4000-8000-{index:012}",
            "personId": champions["champions"][index - 1]["objectId"],
            "relationship": relationship,
        }
        for index in range(1, 4)
        for relationship in ("used", "created")
    ]
    seen = []
    for offset in (0, 3):
        page = copy.deepcopy(champions)
        page["value"] = edges[offset : offset + 3]
        page["counts"] = {"total": 6, "distinctAgents": 3, "returned": 3}
        page["page"] = {"limit": 50, "nextCursor": "synthetic:peers" if offset == 0 else None}
        step = copy.deepcopy(steps["peers"])
        if offset:
            step["request"]["input"]["cursor"] = "synthetic:peers"
        seen.extend((await call(step, page))["value"])
    assert seen == edges
    for index in range(1, 4):
        bindings["$recordId"] = f"agent:10000000-0000-4000-8000-{index:012}"
        members = response_for(operation(steps["members"]), source_fixtures)
        member = members["value"][0]
        bindings["$sourceScopeId"] = member["source_scope_id"]
        bindings["$sourceIdentity"] = member["source_identity"]
        await call(steps["members"], members)
        about = response_for(operation(steps["about"]), source_fixtures)
        text = "Declared synthetic task fit. " * 100
        about.update(
            recordId=bindings["$recordId"],
            sourceScopeId=bindings["$sourceScopeId"],
            sourceIdentity=bindings["$sourceIdentity"],
            text=text,
            state="available",
            totalBytes=len(text.encode()),
            returnedBytes=len(text.encode()),
            nextCursor=None,
        )
        received = await call(steps["about"], about)
        assert (
            received["returnedBytes"] == received["totalBytes"] and received["nextCursor"] is None
        )
    bindings["$draft"] = copy.deepcopy(TEMPLATES["draft"])
    bindings["$draft"]["scope"] = {
        "company": bindings["$company"],
        "department": bindings["$department"],
    }
    bindings["$draft"]["baseline"] = bind(TEMPLATES["measuredBaseline"], bindings)
    save = CORPUS["recipes"]["save"][0]
    saved_response = response_for(operation(save), source_fixtures)
    saved_response.update(state="saved", record=source_fixtures["contentRecord"])
    saved = await call(save, saved_response)
    assert saved["state"] == "saved" and saved["id"]
    assert trace.count("peers") == 2 and trace.count("members") == trace.count("about") == 3
    assert trace[-1] == "create" and len(trace) == 13
    measured = {
        "calls": len(rpc.trace),
        "bytes": sum(item["bytes"] for item in rpc.trace),
        "seconds": sum(item["seconds"] for item in rpc.trace),
    }
    assert measured["calls"] <= 16 and measured["bytes"] <= 1048576 and measured["seconds"] <= 180
    record_property("distributed_recipe", json.dumps(measured))
    print("phase04_distributed_recipe " + json.dumps(measured))


@pytest.mark.parametrize("group_over_limit", [False, True], ids=["full-group", "paged-fallback"])
async def test_department_email_native_wire_preserves_full_roster_and_non_champion_agents(
    rpc, entra, source_fixtures, group_over_limit
):
    bindings = values()
    steps = {step["id"]: step for step in CORPUS["recipes"]["department-email"]}
    people = [f"20000000-0000-4000-8000-{index:012}" for index in range(1, 6)]
    agent_ids = [f"10000000-0000-4000-8000-{index:012}" for index in range(1, 3)]

    def body(step_id):
        return response_for(operation(steps[step_id]), source_fixtures)

    async def call(step_id, response, **extra_input):
        request = bind(steps[step_id]["request"], bindings)
        for key, value in extra_input.items():
            if value is None:
                request["input"].pop(key, None)
            else:
                request["input"][key] = value
        TOOLS[steps[step_id]["tool"]].request.model_validate(request)
        operation(steps[step_id]).response.model_validate(response)
        entra.api_responses.append(httpx2.Response(200, json=response))
        result = await rpc(steps[step_id]["tool"], request, wire=True)
        assert not result.get("isError"), result
        expected = (
            {"action": request["action"], "result": response} if "action" in request else response
        )
        assert result["structuredContent"] == expected
        return parse_qs(entra.api_calls[-1].url.query.decode())

    await call("periods", body("periods"))
    inventory = body("inventory")
    inventory["id"] = "11000000-0000-4000-8000-000000000001"
    await call("inventory", inventory)
    bindings["$inventorySelectionId"] = inventory["id"]

    roster = body("roster")
    roster["selection"]["id"] = "22000000-0000-4000-8000-000000000001"
    users = []
    for index, person_id in enumerate(people, 1):
        user = copy.deepcopy(roster["value"][0])
        user["directory"].update(
            objectId=person_id,
            userPrincipalName=f"person{index}@example.invalid",
            displayName=f"Person {index}",
            accountEnabled=True,
            companyName=bindings["$company"],
            department=bindings["$department"],
        )
        users.append(user)
    recipients = []
    for offset in (0, 3):
        page = copy.deepcopy(roster)
        page["value"] = users[offset : offset + 3]
        page["counts"].update(total=5, filtered=5)
        page["page"].update(limit=50, nextCursor="synthetic:roster" if offset == 0 else None)
        continuation = (
            {"setId": None, "selectionId": roster["selection"]["id"], "cursor": "synthetic:roster"}
            if offset
            else {}
        )
        query = await call("roster", page, **continuation)
        assert query["company"] == ["~string:" + bindings["$company"]]
        assert query["department"] == ["~string:" + bindings["$department"]]
        assert not {"cohort", "entitlement", "activityState"} & query.keys()
        if offset:
            assert query["selectionId"] == [roster["selection"]["id"]]
            assert "setId" not in query
        recipients.extend(page["value"])
    bindings["$userSelectionId"] = roster["selection"]["id"]
    assert len(recipients) == 5 and all("mail" not in user["directory"] for user in recipients)
    assert [user["directory"]["userPrincipalName"] for user in recipients] == [
        f"person{index}@example.invalid" for index in range(1, 6)
    ]

    group = body("group")
    group["selection"]["id"] = "33000000-0000-4000-8000-000000000001"
    group["page"]["nextCursor"] = None
    department = group["value"][0]
    department.update(company=bindings["$company"], department=bindings["$department"])
    department["people"] = [
        {
            "id": person_id,
            "name": f"Person {index}",
            "agents": 1 if index <= 3 else 2 if index == 4 else 0,
            "responses": 10 - index if index <= 3 else 2 if index == 4 else 0,
            "champion": index <= 3,
        }
        for index, person_id in enumerate(people, 1)
    ]
    department["agents"] = [
        {
            "id": agent_id,
            "name": f"Department agent {index}",
            "description": "Preview only",
            "creatorType": "unknown",
            "inventoryId": f"agent:{agent_id}",
        }
        for index, agent_id in enumerate(agent_ids, 1)
    ] + [
        {
            "id": "report-only",
            "name": "Unmapped reported agent",
            "description": None,
            "creatorType": "unknown",
            "inventoryId": None,
        }
    ]
    if group_over_limit:
        entra.api_responses.append(httpx2.Response(413, json={"error": "result_too_large"}))
        result = await rpc("adoption", bind(steps["group"]["request"], bindings), wire=True)
        assert result["isError"], result
    else:
        await call("group", group)
        bindings["$groupSelectionId"] = group["selection"]["id"]
        champions = body("champions")
        champions["selection"] = group["selection"]
        champions["inventorySelection"]["id"] = inventory["id"]
        champions["champions"] = [
            {
                "objectId": person_id,
                "name": f"Person {index}",
                "rank": index,
                "created": 0,
                "responses": 10 - index,
                "agents": 1,
            }
            for index, person_id in enumerate(people[:3], 1)
        ]
        champions["value"] = [
            {
                **champions["value"][0],
                "id": f"agent:{agent_ids[0]}",
                "canonicalId": agent_ids[0],
                "personId": person_id,
                "relationship": "used",
                "identityState": "canonical",
            }
            for person_id in people[:3]
        ]
        champions["counts"] = {"total": 3, "distinctAgents": 1, "returned": 3}
        champions["page"] = {"limit": 50, "nextCursor": None}
        query = await call("champions", champions)
        assert query["selectionId"] == [group["selection"]["id"]]
        assert not any(row["canonicalId"] == agent_ids[1] for row in champions["value"])

    used = []
    for index, person_id in enumerate(people, 1):
        bindings["$personId"] = person_id
        relationships = body("member-used-agents")
        row = relationships["value"][0]
        if index <= 3:
            rows = [
                {
                    **row,
                    "id": f"agent:{agent_ids[0]}",
                    "canonicalId": agent_ids[0],
                    "personId": person_id,
                    "relationship": "used",
                    "identityState": "canonical",
                }
            ]
        elif index == 4:
            rows = [
                {
                    **row,
                    "id": f"agent:{agent_ids[1]}",
                    "canonicalId": agent_ids[1],
                    "personId": person_id,
                    "relationship": "used",
                    "identityState": "canonical",
                },
                {
                    **row,
                    "id": "report-only",
                    "canonicalId": None,
                    "reportAgentId": "report-only",
                    "personId": person_id,
                    "relationship": "used",
                    "identityState": "report_only",
                },
            ]
        else:
            rows = []
        for offset in range(max(1, len(rows))):
            page = copy.deepcopy(relationships)
            page["selection"] = roster["selection"]
            page["inventorySelection"]["id"] = inventory["id"]
            page["value"] = rows[offset : offset + 1]
            page["counts"] = {
                "total": len(rows),
                "distinctAgents": len(rows),
                "returned": len(page["value"]),
            }
            page["page"] = {
                "limit": 50,
                "nextCursor": "synthetic:used" if offset + 1 < len(rows) else None,
            }
            query = await call(
                "member-used-agents", page, **({"cursor": "synthetic:used"} if offset else {})
            )
            assert query["selectionId"] == [roster["selection"]["id"]]
            assert query["inventorySelectionId"] == [inventory["id"]]
            assert query["relationship"] == ["used"]
            assert entra.api_calls[-1].url.path.endswith(f"/users/{person_id}/agent-relationships")
            used.extend(page["value"])
    assert {row["id"] for row in used} == {
        agent["inventoryId"] or agent["id"] for agent in department["agents"]
    }
    assert any(row["personId"] == people[3] and row["canonicalId"] == agent_ids[1] for row in used)
    assert any(row["canonicalId"] is None and row["identityState"] == "report_only" for row in used)

    opportunity = body("opportunity")
    opportunity["context"]["office"]["selection"]["id"] = "44000000-0000-4000-8000-000000000001"
    opportunity["context"]["report"]["selection"]["id"] = "55000000-0000-4000-8000-000000000001"
    await call("opportunity", opportunity)
    bindings["$officeSelectionId"] = opportunity["context"]["office"]["selection"]["id"]
    bindings["$reportSelectionId"] = opportunity["context"]["report"]["selection"]["id"]
    support = body("support-users")
    support["context"] = opportunity["context"]
    support["value"] = [support["value"][0]]
    support["value"][0]["person"].update(
        identity=people[-1], userPrincipalName="person5@example.invalid"
    )
    support["value"][0]["agentEvidence"] = "no_reported"
    support["page"]["nextCursor"] = None
    query = await call("support-users", support)
    assert "setId" not in query and query["cohort"] == ["no_reported"]
    assert query["officeSelectionId"] == [bindings["$officeSelectionId"]]
    assert query["reportSelectionId"] == [bindings["$reportSelectionId"]]
    assert len(support["value"]) < len(recipients)

    for agent_id in agent_ids:
        bindings["$recordId"] = f"agent:{agent_id}"
        members = body("members")
        await call("members", members)
        member = members["value"][0]
        bindings["$sourceScopeId"] = member["source_scope_id"]
        bindings["$sourceIdentity"] = member["source_identity"]
        text = "Declared task capability, not a proven colleague workflow. " * 60
        chunks = [text[:2048], text[2048:]]
        received = ""
        for index, chunk in enumerate(chunks):
            about = body("about")
            about.update(
                recordId=bindings["$recordId"],
                sourceScopeId=bindings["$sourceScopeId"],
                sourceIdentity=bindings["$sourceIdentity"],
                text=chunk,
                state="available",
                totalBytes=len(text.encode()),
                returnedBytes=len(chunk.encode()),
                nextCursor="synthetic:description" if index == 0 else None,
            )
            query = await call(
                "about", about, **({"cursor": "synthetic:description"} if index else {})
            )
            assert query["sourceIdentity"] == [member["source_identity"]]
            received += about["text"]
        assert received == text and len(received) > 2048

    starters = body("microsoft-starters")
    await call("microsoft-starters", starters)
    bindings["$discoverySelectionId"] = starters["selection"]["id"]
    bindings["$agentId"] = starters["value"][0]["id"]
    await call("starter-detail", body("starter-detail"))
    assert all(
        request.method == "GET"
        or request.url.path in {"/api/agent-inventory/selections", "/api/discovery/read"}
        for request in entra.api_calls
    )
    assert all("adoption-content" not in request.url.path for request in entra.api_calls)


async def test_employee_recipe_uses_actual_roleless_wire_and_preserves_safe_results(
    browser, entra, source_fixtures
):
    entra.response_claims = {"roles": []}
    _, issued = await tokens(browser)
    client = await protocol_client(browser, issued["access_token"])
    for step in CORPUS["recipes"]["employee"]:
        response = response_for(operation(step), source_fixtures)
        entra.api_responses.append(httpx2.Response(200, json=response))
        result = await client(step["tool"], bind(step["request"], values()), wire=True)
        assert not result.get("isError"), result
        assert result["structuredContent"] == {
            "action": step["request"]["action"],
            "result": response,
        }
    assert len(client.trace) == 4
    assert all(
        item["tool"] in {"my_discovery_profile", "agent_catalog", "shared_learning"}
        for item in client.trace
    )


async def test_expired_recipe_read_reports_error_without_silent_recapture_or_save_replay(
    rpc, entra
):
    step = CORPUS["recipes"]["department"][4]
    entra.api_responses.append(
        httpx2.Response(
            409,
            json={
                "status": 409,
                "code": "selection_invalidated",
                "detail": "Explicit fresh selection required.",
            },
            headers={"Content-Type": "application/problem+json"},
        )
    )
    result = await rpc(step["tool"], bind(step["request"], values()), wire=True)
    assert result["isError"]
    assert "selection_invalidated" in result["content"][0]["text"]
    assert len(rpc.trace) == len(entra.api_calls) == 1
