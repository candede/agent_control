"""Falsify request-scoped feasibility on the installed native SDK before cutover."""

from conftest import tokens
from fastmcp.server.middleware import Middleware
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


async def test_supported_initialize_list_call_hooks_are_identity_scoped(browser, service, entra):
    observed = []

    class Hooks(Middleware):
        async def on_initialize(self, context, call_next):
            async with service.api.invocation(context.fastmcp_context) as invocation:
                token = await invocation.token()
                observed.append(("initialize", token.claims["roles"]))
            return await call_next(context)

        async def on_list_tools(self, context, call_next):
            async with service.api.invocation(context.fastmcp_context) as invocation:
                token = await invocation.token()
                tools = await call_next(context)
                observed.append(("list", token.claims["roles"]))
                return tools

        async def on_call_tool(self, context, call_next):
            observed.append(("call", context.message.name))
            return await call_next(context)

    service.mcp.add_middleware(Hooks())
    counts = []
    for roles in ([], ["AgentControl.Viewer"]):
        browser.headers.pop("Authorization", None)
        entra.response_claims = {"roles": roles}
        _, issued = await tokens(browser)
        browser.headers["Authorization"] = "Bearer " + issued["access_token"]
        async with streamable_http_client("https://mcp.example.test/mcp", http_client=browser) as (
            read,
            write,
        ):
            async with ClientSession(read, write) as session:
                await session.initialize()
                listed = await session.list_tools()
                counts.append(len(listed.tools))
                if not roles:
                    assert {tool.name for tool in listed.tools} == {
                        "agent_catalog",
                        "my_workplace",
                        "my_discovery_profile",
                        "shared_learning",
                    }
                if roles:
                    result = await session.call_tool(
                        "capabilities", {"request": {"action": "list", "input": {}}}
                    )
                    assert not result.is_error
    assert counts[0] == 4 and counts[1] > 4
    assert ("initialize", []) in observed
    assert ("initialize", ["AgentControl.Viewer"]) in observed
    assert observed.count(("call", "capabilities")) == 1
