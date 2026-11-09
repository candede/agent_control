"""Typed native domains over the current finite canonical bindings."""

from dataclasses import dataclass
from functools import reduce
from operator import or_
from typing import Annotated, Literal

from pydantic import BaseModel, Field, RootModel, create_model

from .inputs import Input
from .tools import OPERATIONS, Operation, operation_named


class DomainRequest(Input):
    action: str
    input: BaseModel


@dataclass(frozen=True)
class Branch:
    action: str
    operation: Operation


@dataclass(frozen=True)
class PublicTool:
    name: str
    branches: tuple[Branch, ...]
    request: type[BaseModel]
    response: type[BaseModel]
    description: str
    grouped: bool = False


def family(name: str, branches: tuple[Branch, ...]) -> PublicTool:
    requests: list[type[BaseModel]] = []
    responses: list[type[BaseModel]] = []
    for branch in branches:
        title = "".join(word.title() for word in f"{name}_{branch.action}".split("_"))
        action_type = Literal[branch.action]  # type: ignore[name-defined]
        requests.append(
            create_model(
                title + "Request",
                __base__=DomainRequest,
                action=(action_type, Field(description=branch.operation.description)),
                input=(branch.operation.request, ...),
            )
        )
        responses.append(
            create_model(
                title + "Result",
                __base__=Input,
                action=(action_type, ...),
                result=(branch.operation.response, ...),
            )
        )
    # Concrete Pydantic classes retain every nested DTO and its validators. The
    # SDK receives the actual discriminated union, not an optional-field bag.
    request_union: object = (
        requests[0]
        if len(requests) == 1
        else Annotated[reduce(or_, requests), Field(discriminator="action")]
    )
    response_union: object = (
        responses[0]
        if len(responses) == 1
        else Annotated[reduce(or_, responses), Field(discriminator="action")]
    )
    title = "".join(word.title() for word in name.split("_"))
    request_model = create_model(
        title + "Request",
        __base__=RootModel[request_union],  # type: ignore[valid-type]
    )
    response_model = create_model(
        title + "Result",
        __base__=RootModel[response_union],  # type: ignore[valid-type]
    )
    return PublicTool(
        name,
        branches,
        request_model,
        response_model,
        " ".join(f"{branch.action}: {branch.operation.description}" for branch in branches),
        True,
    )


def _family(name: str, **actions: str) -> PublicTool:
    return family(
        name, tuple(Branch(action, operation_named(op)) for action, op in actions.items())
    )


_FAMILIES = (
    _family(
        "adoption_content",
        list="list_adoption_content",
        detail="read_adoption_content",
        create="create_adoption_content",
        update="update_adoption_content",
        progress="progress_adoption_action",
        delete="delete_adoption_content",
        follow_up="follow_up_adoption_content",
    ),
    _family("shared_learning", read="read_shared_learning"),
    _family("agent_catalog", search="search_agent_catalog", detail="read_discovery_detail"),
    _family("my_workplace", read="read_my_workplace"),
    _family("my_discovery_profile", read="read_my_discovery_profile"),
    _family(
        "preview_end_user",
        profile="preview_discovery_profile",
        search="preview_discovery_search",
        detail="preview_discovery_detail",
        workplace="preview_discovery_workplace",
        learning="preview_shared_learning",
    ),
    _family("capabilities", list="list_capabilities", progress="get_capability_check_progress"),
    _family(
        "inventory",
        list="list_agents",
        health="get_inventory_health",
        summary="get_inventory_summary",
        facets="list_agent_facets",
        detail="get_agent",
        members="list_agent_members",
        children="list_agent_children",
        sections="list_agent_sections",
        about="read_agent_about",
        responsibility="list_agent_responsibility",
    ),
    _family("packages", list="list_packages", detail="get_package"),
    _family(
        "native_inventory",
        activity="get_native_agent_activity",
        studio_targets="resolve_studio_targets",
    ),
    _family(
        "users",
        list="list_users",
        facets="list_user_facets",
        unresolved="list_unresolved_users",
        resolve="resolve_user",
        detail="get_user",
        service_plans="list_user_service_plans",
        used_agents="list_user_used_agents",
        relationships="list_user_agent_relationships",
    ),
    _family(
        "adoption",
        groups="list_adoption_groups",
        facets="list_adoption_facets",
        summary="get_adoption_summary",
        departments="list_adoption_departments",
        history="list_adoption_history",
        opportunities="list_department_opportunities",
        opportunity_people="list_opportunity_people",
        champion_agents="list_champion_agents",
    ),
    _family(
        "office_adoption",
        context="get_office_context",
        summary="get_office_summary",
        comparison="get_office_comparison",
        history="list_office_history",
        groups="list_office_groups",
        departments="list_office_departments",
        facets="list_office_facets",
        people="list_office_people",
    ),
    _family(
        "report_agents",
        list="list_report_agents",
        facets="list_report_agent_facets",
        detail="get_report_agent",
        users="list_report_agent_users",
    ),
    _family(
        "report_users",
        list="list_report_users",
        facets="list_report_user_facets",
        detail="get_report_user",
        agents="list_report_user_agents",
        directory="get_report_user_directory",
        service_plans="list_report_user_service_plans",
    ),
    _family(
        "report_datasets",
        relationships="list_report_relationships",
        history="list_report_history",
        options="list_report_options",
        observations="list_report_observations",
        overview="get_report_overview",
    ),
    _family(
        "agent_usage",
        summary="get_agent_usage",
        history="list_agent_usage_history",
        users="list_agent_usage_users",
        associations="list_agent_usage_associations",
        candidates="list_agent_usage_candidates",
    ),
    _family("sync", state="get_sync_state", run="get_sync_run"),
    _family("collect_sync", start="start_sync", retry="retry_sync"),
    _family(
        "collect_packages",
        catalog="refresh_packages",
        package="refresh_package",
        selection="refresh_selected_packages",
    ),
    _family(
        "package_refresh_jobs",
        list="list_package_refresh_jobs",
        detail="get_package_refresh_job",
        targets="list_package_refresh_targets",
    ),
    _family(
        "studio_refresh_jobs",
        list="list_studio_refresh_jobs",
        detail="get_studio_refresh_job",
    ),
    _family(
        "access_principals",
        search="search_access_principals",
        resolve="resolve_access_principals",
    ),
    _family(
        "package_control_jobs",
        list="list_package_control_jobs",
        detail="get_package_control_job",
        items="list_package_control_items",
    ),
    _family(
        "studio_control_jobs",
        list="list_studio_control_jobs",
        detail="get_studio_control_job",
        audit="list_studio_control_audit",
    ),
    _family(
        "set_package_block",
        block_ids="block_packages",
        unblock_ids="unblock_packages",
        block_selection="block_selected_packages",
        unblock_selection="unblock_selected_packages",
        block_one="block_package",
        unblock_one="unblock_package",
    ),
    _family(
        "set_package_access",
        ids="update_packages_access",
        one="update_package_access",
    ),
)

_GROUPED = {branch.operation.name for tool in _FAMILIES for branch in tool.branches}
PUBLIC_TOOLS = _FAMILIES + tuple(
    PublicTool(
        operation.name,
        (Branch("", operation),),
        operation.request,
        operation.response,
        operation.description,
    )
    for operation in OPERATIONS
    if operation.name not in _GROUPED
)
