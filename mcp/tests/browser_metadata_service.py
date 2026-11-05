"""Real registered MCP metadata service, exclusively for the isolated browser owner."""

import json
import os
import socket
import sys
from pathlib import Path

import uvicorn
from cryptography.fernet import Fernet

from agent_control_mcp.config import Settings, key_bytes
from agent_control_mcp.service import build_service

if (
    os.environ.get("AGENT_CONTROL_FIXTURE_MODE") != "browser"
    or os.environ.get("NODE_ENV") != "test"
):
    raise SystemExit("Isolated browser fixture required.")
directory = Path(sys.argv[1])
if (
    not directory.is_absolute()
    or directory.is_symlink()
    or not directory.name.startswith("browser-mcp-")
):
    raise SystemExit("Owned fixture path required.")
if not directory.is_dir() or directory.stat().st_mode & 0o077:
    raise SystemExit("Protected fixture directory required.")
metadata = os.environ["MCP_FIXTURE_METADATA_TOKEN"]
key_bytes(metadata)
env = {
    "MCP_TENANT_ID": "11111111-1111-1111-1111-111111111111",
    "MCP_CLIENT_ID": "33333333-3333-3333-3333-333333333333",
    "MCP_API_CLIENT_ID": "22222222-2222-2222-2222-222222222222",
    "MCP_API_ORIGIN": "http://localhost:3001",
    "MCP_PUBLIC_URL": "https://browser-mcp.example.invalid/mcp",
    "MCP_ALLOWED_CLIENT_REDIRECT_URIS": '["http://localhost:53109/client/callback"]',
    "MCP_OAUTH_STORAGE_PATH": str(directory / "oauth"),
}
for name, value in (
    ("CLIENT_SECRET", "synthetic-browser-mcp-client-secret"),
    ("JWT_SIGNING_KEY", Fernet.generate_key().decode()),
    ("OAUTH_ENCRYPTION_KEY", json.dumps([Fernet.generate_key().decode()])),
    ("METADATA_TOKEN", metadata),
):
    path = directory / name
    with path.open("x", encoding="utf-8") as file:
        path.chmod(0o600)
        file.write(value)
    env[f"MCP_{name}_FILE"] = str(path)
service = build_service(Settings.from_env(env))
listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen(128)
print(json.dumps({"event": "browser_mcp_metadata", "port": listener.getsockname()[1]}), flush=True)
server = uvicorn.Server(
    uvicorn.Config(service.app, log_level="warning", access_log=False, lifespan="on")
)
server.run(sockets=[listener])
