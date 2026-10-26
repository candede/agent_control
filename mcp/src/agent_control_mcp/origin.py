from __future__ import annotations

import base64
import json
import re
import unicodedata
from typing import TYPE_CHECKING, Any

from .errors import AdapterError

if TYPE_CHECKING:
    from fastmcp import Context

HEADER = "X-Agent-Control-Mcp-Context"


def label(value: object, maximum: int = 256) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= maximum
        or any(unicodedata.category(char) in {"Cc", "Cf", "Cs"} for char in value)
    ):
        raise AdapterError(400, "invalid_action_origin", "Calling-client labels are malformed.")
    return value


def origin_header(ctx: Context) -> str:
    rc = ctx.request_context
    meta = rc.meta if rc else None
    reported: Any = meta.get("com.agentcontrol/origin", {}) if meta else {}
    if not isinstance(reported, dict) or set(reported) - {"client", "callingAgent"}:
        raise AdapterError(400, "invalid_action_origin", "Calling-client metadata is malformed.")
    client: dict[str, str] = {}
    params = ctx.session.client_params
    if params:
        client["name"] = label(params.client_info.name)
        client["version"] = label(params.client_info.version, 64)
    descriptor: dict[str, Any] = {"version": 1}
    for key, allowed in (("client", {"id", "name", "version"}), ("callingAgent", {"id", "name"})):
        incoming = reported.get(key, {})
        if not isinstance(incoming, dict) or set(incoming) - allowed:
            raise AdapterError(
                400, "invalid_action_origin", "Calling-client metadata is malformed."
            )
        fields = client.copy() if key == "client" else {}
        for name, value in incoming.items():
            fields[name] = label(value, 64 if name == "version" else 256)
        if fields:
            descriptor[key] = fields
    call_id = str(rc.request_id) if rc else ""
    if re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", call_id):
        descriptor["mcpCallId"] = call_id
    encoded = json.dumps(descriptor, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > 4096:
        raise AdapterError(400, "invalid_action_origin", "Calling-client metadata is too large.")
    return base64.urlsafe_b64encode(encoded).decode().rstrip("=")
