"""Agent Control's tenant-bound protocol adapter; business authority remains in the API."""

import logging
import os
from typing import Any

# Apply the SDK's supported switch before importing it: never discover a host .env.
os.environ["FASTMCP_ENV_FILE"] = os.devnull
os.environ["FASTMCP_TELEMETRY_MODE"] = "off"

_record_factory = logging.getLogRecordFactory()


def _safe_record(*args: Any, **kwargs: Any) -> logging.LogRecord:
    record = _record_factory(*args, **kwargs)
    # The pinned SDK logs rejected OAuth codes verbatim, even at ERROR.
    if record.name.startswith(("fastmcp.server.auth", "mcp.server.auth")):
        record.msg = "OAuth lifecycle event."
        record.args = ()
        record.exc_info = None
        record.exc_text = None
    return record


logging.setLogRecordFactory(_safe_record)
