"""Synthetic container entrypoint; never copied into the production runtime image."""

import asyncio
import base64
import json
import sys
from pathlib import Path
from urllib.parse import parse_qs

import httpx2
import uvicorn
from conftest import API, CLIENT, OTHER, TENANT, USER, Entra
from joserfc import jwt
from joserfc.jwk import RSAKey
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from agent_control_mcp.config import Settings
from agent_control_mcp.service import build_service

KEY = RSAKey.import_key(json.loads(Path("/fixture/key.json").read_text()))


def api_app():
    async def respond(request: Request):
        if request.url.path == "/api/ready":
            return JSONResponse({"ok": True})
        if request.url.path == "/":
            return JSONResponse({"fixture": "synthetic web independent of MCP"})
        token = request.headers.get("authorization", "").removeprefix("Bearer ")
        try:
            claims = jwt.decode(token, KEY).claims
            assert claims["aud"] == API and claims["azp"] == CLIENT and claims["tid"] == TENANT
            assert claims["scp"] == "AgentControl.Access"
        except Exception:
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if request.url.path == "/api/capabilities":
            return JSONResponse({"value": []})
        if request.url.path == "/api/capabilities/check-progress":
            await asyncio.sleep(3)
            if request.query_params.get("retry") == "failed":
                origin = json.loads(
                    base64.urlsafe_b64decode(request.headers["X-Agent-Control-Mcp-Context"] + "==")
                )
                assert claims["oid"] in {USER, OTHER}
                assert origin["callingAgent"]["id"] == claims["oid"]
                assert origin["client"]["name"] == (
                    "Capacity A" if claims["oid"] == USER else "Capacity B"
                )
                return JSONResponse(
                    {
                        "progress": {
                            "checks": [
                                {
                                    "capabilityId": "graph.directory.read",
                                    "state": "complete" if claims["oid"] == USER else "checking",
                                }
                            ]
                        }
                    }
                )
            return JSONResponse({"progress": None})
        return JSONResponse({"error": "not_found"}, status_code=404)

    return Starlette(routes=[Route("/{path:path}", respond)])


def mcp_app():
    settings = Settings.from_env()
    entra = Entra(settings)
    entra.key = KEY
    real_client = httpx2.AsyncClient
    network = real_client(trust_env=False, follow_redirects=False)

    async def route(request):
        if request.url.host == "login.microsoftonline.com":
            if request.url.path.endswith("/token"):
                data = parse_qs(request.content.decode())
                if data.get("code") == ["synthetic-entra-code-other"]:
                    return httpx2.Response(
                        200,
                        json={
                            "access_token": entra.token(oid=OTHER),
                            "refresh_token": "synthetic-other-upstream-refresh",
                            "expires_in": 3600,
                            "token_type": "Bearer",
                            "scope": f"api://{CLIENT}/Mcp.Access",
                        },
                    )
            return await entra.route(request)
        assert request.url.host == "app", "Fixture cannot contact external providers"
        return await network.send(request)

    original = real_client.__init__

    def init(client, *args, **kwargs):
        kwargs.setdefault("transport", httpx2.MockTransport(route))
        original(client, *args, **kwargs)

    real_client.__init__ = init
    app = build_service(settings, transport=httpx2.MockTransport(route)).app

    async def observed(scope, receive, send):
        try:
            await app(scope, receive, send)
        except Exception:
            print(
                "FIXTURE_STORAGE_METADATA",
                [
                    (p.name, p.lstat().st_uid, oct(p.lstat().st_mode))
                    for p in [settings.storage_path, *settings.storage_path.rglob("*")]
                ],
                flush=True,
            )
            raise

    return observed


if __name__ == "__main__":
    uvicorn.run(
        api_app() if sys.argv[1] == "api" else mcp_app(),
        host="0.0.0.0",
        port=3001 if sys.argv[1] == "api" else 8000,
        access_log=False,
        proxy_headers=False,
        timeout_graceful_shutdown=65,
        limit_concurrency=32,
        backlog=64,
    )
