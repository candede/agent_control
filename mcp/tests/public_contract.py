"""Canonical-operation assertions transported through the current public contract.

This is a test adapter, not an advertised alias or a second dispatch catalog.
"""

import json

from agent_control_mcp.domains import PUBLIC_TOOLS


def public_request(operation, request):
    for tool in PUBLIC_TOOLS:
        for branch in tool.branches:
            if branch.operation.name == operation:
                return tool.name, (
                    {"action": branch.action, "input": request} if tool.grouped else request
                )
    return operation, request


def canonical_result(operation, result):
    name, request = public_request(operation, {})
    if "action" in request and not result.get("isError"):
        document = result["structuredContent"]
        assert document["action"] == request["action"], name
        assert json.loads(result["content"][0]["text"]) == document
        return {
            **result,
            "structuredContent": document["result"],
            "content": [
                {"type": "text", "text": json.dumps(document["result"], ensure_ascii=False)}
            ],
        }
    return result
