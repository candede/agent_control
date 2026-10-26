from __future__ import annotations

import asyncio
import json
import re
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import TypeVar
from urllib.parse import quote
from uuid import UUID, uuid4

import httpx2
from fastmcp import Context
from fastmcp.server.auth.auth import AccessToken
from pydantic import BaseModel, JsonValue, ValidationError

from .auth import (
    ApiTokenExchange,
    ReferenceAccessToken,
    TenantAzureProvider,
    bounded_body,
    request_stream,
    retry_after,
    valid_claims,
    verified_upstream,
)
from .config import Settings
from .errors import AdapterError
from .inputs import AboutInput
from .models import AgentAboutPage, Capabilities, CheckProgress
from .origin import HEADER, origin_header
from .storage import OAuthStore

MAX_OUTPUT = 524288
MAX_REQUESTS = 8
MAX_EXCHANGES = 2
T = TypeVar("T", bound=BaseModel)


def safe_json(value: JsonValue, depth: int = 0, secrets: tuple[str, ...] = ()) -> JsonValue:
    if depth > 8:
        return "[bounded]"
    if isinstance(value, dict):
        return {
            key: safe_json(item, depth + 1, secrets)
            for key, item in list(value.items())[:64]
            if not re.search(
                r"token|secret|password|assertion|authorization|cookie|credential", key, re.I
            )
        }
    if isinstance(value, list):
        return [safe_json(item, depth + 1, secrets) for item in value[:100]]
    if isinstance(value, str):
        for secret in secrets:
            value = value.replace(secret, "[redacted]")
        if re.search(r"Bearer\s|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.", value, re.I):
            return "[redacted]"
        return value[:4096]
    return value


def problem(
    response: httpx2.Response,
    body: bytes,
    secrets: tuple[str, ...] = (),
) -> AdapterError:
    code = "api_error"
    message = "The canonical API rejected the request."
    details: dict[str, JsonValue] | None = None
    request_id = response.headers.get("X-Request-ID")
    try:
        request_id = str(UUID(request_id)) if request_id else None
    except ValueError:
        request_id = None
    if response.headers.get("content-type", "").split(";")[0] == "application/problem+json":
        try:
            value = json.loads(body)
            if isinstance(value, dict) and value.get("status") == response.status_code:
                if isinstance(value.get("code"), str) and re.fullmatch(
                    r"[a-z][a-z0-9_]{0,127}",
                    value["code"],
                ):
                    if not any(secret in value["code"] for secret in secrets):
                        code = value["code"]
                if isinstance(value.get("detail"), str):
                    sanitized = safe_json(value["detail"], secrets=secrets)
                    if isinstance(sanitized, str):
                        message = sanitized[:1024]
                sanitized_details = safe_json(value.get("details"), secrets=secrets)
                if isinstance(sanitized_details, dict):
                    details = sanitized_details
        except ValueError, TypeError:
            pass
    return AdapterError(
        response.status_code,
        code,
        message,
        request_id,
        retry_after(response.headers.get("Retry-After")),
        details,
    )


class CanonicalApi:
    def __init__(
        self,
        settings: Settings,
        http_client: httpx2.AsyncClient,
        exchange: ApiTokenExchange,
        store: OAuthStore,
    ) -> None:
        self.settings = settings
        self.http = http_client
        self.exchange = exchange
        self.store = store

    @asynccontextmanager
    async def invocation(self, ctx: Context) -> AsyncIterator[ApiInvocation]:
        upstream = verified_upstream(self.settings)
        invocation = ApiInvocation(self, upstream, origin_header(ctx))
        try:
            async with asyncio.timeout(60):
                yield invocation
        except TimeoutError:
            raise AdapterError(
                504, "invocation_deadline", "Invocation deadline exceeded."
            ) from None
        finally:
            invocation.closed = True
            invocation.api_token = None


class ApiInvocation:
    def __init__(self, api: CanonicalApi, upstream: AccessToken, origin: str) -> None:
        self.api = api
        self.upstream = upstream
        self.origin = origin
        self.started = time.monotonic()
        self.requests = 0
        self.exchanges = 0
        self.output_bytes = 0
        self.closed = False
        self.authenticated_client_id = upstream.client_id
        self.request_ids: list[str] = []
        self.api_token: AccessToken | None = None
        self.semaphore = asyncio.Semaphore(4)
        self.exchange_lock = asyncio.Lock()

    def account_output(self, size: int) -> None:
        self.output_bytes += size
        if self.output_bytes > MAX_OUTPUT:
            raise AdapterError(413, "output_limit", "Invocation output limit exceeded.")

    async def assert_current(self) -> None:
        if self.closed or time.monotonic() - self.started >= 60:
            raise AdapterError(504, "invocation_deadline", "Invocation is closed or expired.")
        if not valid_claims(self.upstream.claims, self.api.settings):
            raise AdapterError(401, "reauthorization_required", "Reconnect this signed-in account.")
        if isinstance(self.upstream, ReferenceAccessToken) and await self.api.store.get(
            TenantAzureProvider.token_key(self.upstream.reference),
            collection="revoked",
        ):
            raise AdapterError(401, "reauthorization_required", "Reconnect this signed-in account.")

    async def token(self) -> AccessToken:
        async with self.exchange_lock:
            await self.assert_current()
            if self.api_token and valid_claims(self.api_token.claims, self.api.settings, api=True):
                return self.api_token
            if self.exchanges >= MAX_EXCHANGES:
                raise AdapterError(
                    401, "reauthorization_required", "Authorization exchange budget used."
                )
            self.exchanges += 1
            self.api_token = await self.api.exchange.exchange(self.upstream)
            await self.assert_current()
            return self.api_token

    async def get_capabilities(self) -> Capabilities:
        from .inputs import Empty

        result = await self.call("list_capabilities", Empty())
        assert isinstance(result, Capabilities)
        return result

    async def get_check_progress(self, *, retry_failed: bool = False) -> CheckProgress:
        if type(retry_failed) is not bool:
            raise AdapterError(400, "invalid_request", "retry_failed must be a boolean.")
        from .inputs import CheckInput

        result = await self.call(
            "get_capability_check_progress",
            CheckInput(retry="failed") if retry_failed else CheckInput(),
        )
        assert isinstance(result, CheckProgress)
        return result

    async def get_agent_about(self, request: AboutInput) -> AgentAboutPage:
        if not isinstance(request, AboutInput):
            raise AdapterError(400, "invalid_request", "A typed exact About request is required.")
        result = await self.call("read_agent_about", request)
        assert isinstance(result, AgentAboutPage)
        return result

    async def call(self, name: str, request: BaseModel) -> BaseModel:
        from .tools import operation_named

        operation = operation_named(name)
        if not isinstance(request, operation.request):
            raise AdapterError(400, "invalid_request", "Use the operation's exact typed input.")
        values = request.model_dump(mode="json", exclude_unset=True, by_alias=True)
        path = operation.path
        for field in operation.path_fields:
            value = values.pop(field)
            if not isinstance(value, str) or value in {".", ".."}:
                raise AdapterError(400, "invalid_request", "Use an exact path identity.")
            path = path.replace("{" + field + "}", quote(value, safe=""))
        key = values.pop("idempotencyKey", None)
        headers = {"Idempotency-Key": key} if isinstance(key, str) else {}
        params: dict[str, str | list[str]] | None = None
        body: dict[str, JsonValue] | None = None
        if operation.method == "GET":
            params = wire_query(values)
        elif name == "check_capabilities":
            params = wire_query(values)
            body = {}
        else:
            body = values
            if name in {"capture_agent_inventory", "capture_packages"}:
                query = values["query"]
                if not isinstance(query, dict):
                    raise AdapterError(400, "invalid_request", "Expected a typed inventory query.")
                body["query"] = {key: str(value) for key, value in wire_query(query).items()}
        return await self._request(
            operation.method,
            path,
            operation.response,
            params=params,
            body=body,
            headers=headers,
            deleted_id=request.model_dump().get("id"),
        )

    async def _request(
        self,
        method: str,
        path: str,
        result: type[T],
        *,
        params: dict[str, str | list[str]] | None = None,
        body: dict[str, JsonValue] | None = None,
        headers: dict[str, str] | None = None,
        deleted_id: str | None = None,
    ) -> T:
        async with self.semaphore:
            await self.assert_current()
            for attempt in range(2):
                token = await self.token()
                if self.requests >= MAX_REQUESTS:
                    raise AdapterError(429, "invocation_budget", "Invocation request budget used.")
                self.requests += 1
                try:
                    async with asyncio.timeout(min(30, 60 - (time.monotonic() - self.started))):
                        async with request_stream(
                            self.api.http,
                            method,
                            self.api.settings.api_origin + path,
                            params=params,
                            json_body=body,
                            headers={
                                "Authorization": f"Bearer {token.token}",
                                "Accept": "application/json",
                                HEADER: self.origin,
                                "X-Request-ID": str(uuid4()),
                                **(headers or {}),
                            },
                        ) as response:
                            response_body = await bounded_body(response, MAX_OUTPUT)
                            await self.assert_current()
                            correlation = response.headers.get("X-Request-ID")
                            if correlation:
                                try:
                                    self.request_ids.append(str(UUID(correlation)))
                                except ValueError:
                                    pass
                            if (
                                method == "GET"
                                and response.status_code in {429, 503}
                                and attempt == 0
                            ):
                                delay = retry_after(response.headers.get("Retry-After"))
                                if (
                                    delay is not None
                                    and delay <= 2
                                    and (time.monotonic() - self.started + delay < 60)
                                ):
                                    await asyncio.sleep(delay)
                                    continue
                            if response.status_code not in (
                                {200}
                                if method == "GET"
                                else {204}
                                if method == "DELETE"
                                else {200, 201, 202}
                            ):
                                raise problem(
                                    response,
                                    response_body,
                                    (
                                        self.api.settings.client_secret,
                                        self.upstream.token,
                                        token.token,
                                    ),
                                )
                            if response.status_code == 204:
                                if response_body:
                                    raise AdapterError(
                                        502,
                                        "invalid_api_response",
                                        "Expected an empty API response.",
                                    )
                                parsed = result.model_validate({"deleted": True, "id": deleted_id})
                            elif (
                                response.headers.get("content-type", "").split(";")[0]
                                != "application/json"
                            ):
                                raise AdapterError(
                                    502, "invalid_api_response", "Expected API JSON."
                                )
                            else:
                                parsed = result.model_validate_json(response_body)
                            self.account_output(
                                len(
                                    parsed.model_dump_json(
                                        exclude_unset=True, by_alias=True
                                    ).encode()
                                )
                            )
                            return parsed
                except TimeoutError, httpx2.TimeoutException:
                    raise AdapterError(
                        504, "api_deadline", "API request deadline exceeded."
                    ) from None
                except httpx2.HTTPError:
                    raise AdapterError(
                        503, "api_unavailable", "The canonical API is unavailable."
                    ) from None
                except ValueError, ValidationError:
                    raise AdapterError(
                        502, "invalid_api_response", "Invalid canonical API response."
                    ) from None
        raise AssertionError("Finite API retry loop exhausted without a result.")


def wire_query(values: dict[str, JsonValue]) -> dict[str, str | list[str]]:
    result: dict[str, str | list[str]] = {}
    for key, value in values.items():
        if key in {"company", "department", "type", "publisher", "availableTo", "host", "platform"}:
            result[key] = (
                "~null"
                if value is None
                else (
                    "~some-or-all"
                    if key == "availableTo" and value == "~some-or-all"
                    else "~string:" + str(value)
                )
            )
        elif value is None:
            continue
        elif isinstance(value, bool):
            result[key] = "true" if value else "false"
        elif isinstance(value, str | int):
            result[key] = str(value)
        elif isinstance(value, list) and all(isinstance(item, str) for item in value):
            result[key] = [str(item) for item in value]
        else:
            raise AdapterError(400, "invalid_request", "Expected a finite scalar API query.")
    return result
