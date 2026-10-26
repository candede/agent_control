from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx2
from fastmcp import FastMCP
from key_value.aio.errors import BaseKeyValueError
from mcp.server.auth.middleware.bearer_auth import AuthenticatedUser
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .api import CanonicalApi
from .auth import ApiTokenExchange, TenantAzureProvider
from .config import ConfigurationError, Settings
from .errors import AdapterError
from .storage import MAX_DISK_BYTES, MAX_FILES, OAuthStore
from .tools import OPERATIONS, register_tools

logger = logging.getLogger(__name__)


class ProtocolBoundary:
    def __init__(self, app: ASGIApp, settings: Settings, store: OAuthStore | None = None) -> None:
        self.app = app
        self.settings = settings
        self.store = store

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        if self.store is not None and scope["path"] != "/health":
            try:
                await self.store.assert_authority()
            except ConfigurationError:
                await JSONResponse(
                    {"error": "oauth_authority_unavailable"},
                    status_code=503,
                    headers={"Cache-Control": "no-store"},
                )(scope, receive, send)
                return
        headers = scope.get("headers", [])
        authorizations = [value for key, value in headers if key.lower() == b"authorization"]
        cookies = [value for key, value in headers if key.lower() == b"cookie" and value]
        if len(authorizations) > 1 or authorizations and cookies:
            await JSONResponse(
                {"error": "ambiguous_authentication"},
                status_code=400,
            )(scope, receive, send)
            return
        body = bytearray()
        if scope["method"] == "POST":
            try:
                async with asyncio.timeout(30):
                    while True:
                        message = await receive()
                        if message["type"] == "http.disconnect":
                            return
                        chunk = message.get("body", b"")
                        if len(body) + len(chunk) > 524288:
                            await JSONResponse(
                                {"error": "request_limit"},
                                status_code=413,
                            )(scope, receive, send)
                            return
                        body.extend(chunk)
                        if not message.get("more_body", False):
                            break
            except TimeoutError:
                await JSONResponse({"error": "request_deadline"}, status_code=408)(
                    scope, receive, send
                )
                return
        path = scope["path"]
        if path == "/auth/callback":
            try:
                raw = scope.get("query_string", b"")
                if len(raw) > 16384:
                    raise ValueError
                params = parse_qs(raw.decode(), keep_blank_values=True, max_num_fields=8)
                if any(len(values) != 1 for values in params.values()):
                    raise ValueError
                if "error" in params:
                    safe_errors = {
                        "access_denied",
                        "interaction_required",
                        "login_required",
                        "consent_required",
                        "invalid_request",
                        "invalid_scope",
                        "server_error",
                        "temporarily_unavailable",
                        "unauthorized_client",
                    }
                    if params["error"][0] not in safe_errors:
                        params["error"] = ["access_denied"]
                    params["error_description"] = [
                        "Authorization did not complete; restart authorization."
                    ]
                    scope = {**scope, "query_string": urlencode(params, doseq=True).encode()}
            except ValueError, UnicodeError:
                await JSONResponse({"error": "invalid_request"}, status_code=400)(
                    scope,
                    receive,
                    send,
                )
                return
        if path == "/revoke" and scope["method"] == "POST":
            try:
                if len(body) > 65536:
                    raise ValueError
                form = parse_qs(body.decode(), keep_blank_values=True, max_num_fields=8)
                if any(len(values) != 1 for values in form.values()):
                    raise ValueError
                # MCP SDK2.3's public-client revocation model requires the optional
                # client_secret field to be present. Empty is not an added credential.
                form.setdefault("client_secret", [""])
                body = bytearray(urlencode(form, doseq=True).encode())
                scope = {
                    **scope,
                    "headers": [
                        (key, value) for key, value in headers if key.lower() != b"content-length"
                    ]
                    + [(b"content-length", str(len(body)).encode())],
                }
            except ValueError, UnicodeError:
                await JSONResponse({"error": "invalid_request"}, status_code=400)(
                    scope,
                    receive,
                    send,
                )
                return
        if path in {"/authorize", "/token"}:
            try:
                raw = (
                    scope.get("query_string", b"")
                    if path == "/authorize" and scope["method"] == "GET"
                    else bytes(body)
                )
                if len(raw) > 65536:
                    raise ValueError
                params = parse_qs(raw.decode("utf-8"), keep_blank_values=True, max_num_fields=32)
                if any(len(values) != 1 for values in params.values()):
                    raise ValueError
                if params.get("resource") != [self.settings.public_url]:
                    raise ValueError
                if path == "/authorize" and params.get("code_challenge_method") != ["S256"]:
                    raise ValueError
                if path == "/token" and params.get("grant_type") not in (
                    ["authorization_code"],
                    ["refresh_token"],
                ):
                    raise ValueError
            except ValueError, UnicodeError:
                await JSONResponse(
                    {
                        "error": "invalid_request",
                        "error_description": "Exact resource and PKCE required.",
                    },
                    status_code=400,
                    headers={"Cache-Control": "no-store"},
                )(scope, receive, send)
                return
        consumed = False

        async def replay() -> Message:
            nonlocal consumed
            if not consumed and scope["method"] == "POST":
                consumed = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        started = False
        discarded = False

        async def safe_send(message: Message) -> None:
            nonlocal started, discarded
            if discarded:
                return
            if (
                message["type"] == "http.response.body"
                and self.store is not None
                and self.store.blob is not None
                and path != "/health"
            ):
                # Headers may already be sent: terminate rather than publish a stale body.
                await self.store.assert_authority()
            if message["type"] == "http.response.start":
                if self.store is not None and path != "/health":
                    try:
                        await self.store.assert_authority()
                    except ConfigurationError:
                        discarded = True
                        await JSONResponse(
                            {"error": "oauth_authority_unavailable"},
                            status_code=503,
                            headers={"Cache-Control": "no-store"},
                        )(scope, replay, send)
                        return
                started = True
                if path == "/auth/callback":
                    if message["status"] >= 400:
                        discarded = True
                        await JSONResponse(
                            {
                                "error": "authorization_failed",
                                "error_description": (
                                    "Authorization did not complete; restart authorization."
                                ),
                            },
                            status_code=message["status"],
                            headers={"Cache-Control": "no-store"},
                        )(scope, replay, send)
                        return
                    message = {
                        **message,
                        "headers": [
                            (key, value)
                            for key, value in message.get("headers", [])
                            if key.lower() not in {b"cache-control", b"pragma"}
                        ]
                        + [(b"cache-control", b"no-store"), (b"pragma", b"no-cache")],
                    }
            await send(message)

        if path in {"/authorize", "/token", "/register", "/consent", "/revoke", "/auth/callback"}:
            try:
                async with asyncio.timeout(30):
                    await self.app(scope, replay, safe_send)
            except TimeoutError:
                if discarded:
                    return
                if started:
                    raise
                await JSONResponse(
                    {"error": "temporarily_unavailable"},
                    status_code=504,
                    headers={"Cache-Control": "no-store"},
                )(scope, replay, send)
            except ConfigurationError:
                if discarded:
                    return
                if started:
                    raise
                await JSONResponse(
                    {"error": "oauth_authority_unavailable"},
                    status_code=503,
                    headers={"Cache-Control": "no-store"},
                )(scope, replay, send)
        else:
            await self.app(scope, replay, safe_send)


@dataclass
class Service:
    mcp: FastMCP
    app: ASGIApp
    api: CanonicalApi
    provider: TenantAzureProvider
    store: OAuthStore
    http: httpx2.AsyncClient


def build_service(
    settings: Settings, *, transport: httpx2.AsyncBaseTransport | None = None
) -> Service:
    store = OAuthStore(settings)
    http = httpx2.AsyncClient(
        timeout=httpx2.Timeout(10),
        follow_redirects=False,
        trust_env=False,
        limits=httpx2.Limits(max_connections=16, max_keepalive_connections=8),
        transport=transport,
    )
    provider = TenantAzureProvider(settings, store, http)
    api = CanonicalApi(settings, http, ApiTokenExchange(settings, http), store)

    @asynccontextmanager
    async def lifespan(server: FastMCP) -> AsyncIterator[dict[str, Any]]:
        try:
            await store.start()
            yield {"api": api}
        finally:
            await store.aclose()
            await http.aclose()

    mcp = FastMCP(
        "Agent Control",
        version="0.1.0",
        auth=provider,
        lifespan=lifespan,
        mask_error_details=True,
        strict_input_validation=True,
        tasks=False,
    )
    register_tools(mcp, api)

    @mcp.custom_route("/health", methods=["GET"])
    async def health(request: Request) -> JSONResponse:
        return JSONResponse({"status": "ok"})

    @mcp.custom_route("/ready", methods=["GET"])
    async def ready(request: Request) -> JSONResponse:
        try:
            await store.check()
        except ConfigurationError, OSError, BaseKeyValueError:
            logger.error("OAuth storage readiness verification failed.")
            return JSONResponse({"status": "unavailable"}, status_code=503)
        return JSONResponse({"status": "ready"})

    @mcp.custom_route("/diagnostics", methods=["GET"])
    async def diagnostics(request: Request) -> JSONResponse:
        user = request.scope.get("user")
        if not isinstance(user, AuthenticatedUser):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        verified = user.access_token
        try:
            count, size = await store.usage()
        except ConfigurationError, OSError:
            logger.error("OAuth storage diagnostics verification failed.")
            return JSONResponse({"status": "unavailable"}, status_code=503)
        return JSONResponse(
            {
                "service": "agent-control-mcp",
                "version": "0.1.0",
                "fastmcp": "4.1.0",
                "resource": settings.public_url,
                "transport": "streamable-http",
                "businessTools": len(OPERATIONS),
                "authenticatedOAuthClientId": verified.client_id,
                "apiAuthority": "canonical",
                "oauthStorage": "encrypted-leased-blob"
                if store.blob is not None
                else "encrypted-file",
                "oauthStorageUsage": {
                    "files": count,
                    "bytes": size,
                    "fileLimit": MAX_FILES,
                    "byteLimit": MAX_DISK_BYTES,
                },
            },
            headers={"Cache-Control": "no-store"},
        )

    sdk_app: Starlette = mcp.http_app(
        path=settings.mcp_path,
        transport="streamable-http",
        json_response=True,
        stateless_http=False,
        host_origin_protection=True,
        allowed_hosts=[urlsplit(settings.public_url).netloc],
        allowed_origins=[settings.public_origin],
    )

    async def auth_error(request: Request, exception: Exception) -> JSONResponse:
        assert isinstance(exception, AdapterError)
        headers = {"Cache-Control": "no-store"}
        if exception.retry_after_seconds is not None:
            headers["Retry-After"] = str(exception.retry_after_seconds)
        return JSONResponse(
            {"error": "temporarily_unavailable", "error_description": exception.message},
            status_code=exception.status,
            headers=headers,
        )

    sdk_app.add_exception_handler(AdapterError, auth_error)
    return Service(mcp, ProtocolBoundary(sdk_app, settings, store), api, provider, store, http)


def create_app() -> ASGIApp:
    return build_service(Settings.from_env()).app
