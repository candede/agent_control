from __future__ import annotations

import asyncio
import hashlib
import json
import math
import re
import time
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from email.utils import parsedate_to_datetime
from typing import Any, cast

import httpx2
from fastmcp.server.auth.auth import AccessToken
from fastmcp.server.auth.oauth_proxy.upstream import OAuthError
from fastmcp.server.auth.providers.azure import AzureProvider
from fastmcp.server.auth.providers.jwt import JWTVerifier
from fastmcp.server.dependencies import get_access_token
from mcp.server.auth.provider import AccessToken as SDKAccessToken
from mcp.server.auth.provider import (
    AuthorizationCode,
    AuthorizationParams,
    AuthorizeError,
    RefreshToken,
    RegistrationError,
    TokenError,
)
from mcp.server.auth.settings import RevocationOptions
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken
from pydantic import Field, JsonValue

from .config import ConfigurationError, Settings, guid
from .errors import AdapterError
from .storage import OAuthStore


def valid_claims(
    claims: dict[str, Any] | None,
    settings: Settings,
    *,
    api: bool = False,
    expected_oid: str | None = None,
) -> bool:
    now = time.time()
    if claims is None:
        return False
    try:
        times = [claims.get(name) for name in ("iat", "nbf", "exp")]
        if any(type(value) is not int or value <= 0 for value in times):
            return False
        iat, nbf, exp = cast(tuple[int, int, int], tuple(times))
        oid = guid(claims.get("oid"))
        roles = claims.get("roles", [])
        return bool(
            claims.get("iss") == settings.issuer
            and claims.get("tid") == settings.tenant_id
            and claims.get("aud") == (settings.api_client_id if api else settings.client_id)
            and claims.get("azp") == settings.client_id
            and claims.get("ver") == "2.0"
            and isinstance(claims.get("sub"), str)
            and 1 <= len(claims["sub"]) <= 256
            and isinstance(claims.get("scp"), str)
            and ("AgentControl.Access" if api else "Mcp.Access") in claims["scp"].split()
            and not any(key in claims for key in ("nonce", "appid", "fastmcp_grant"))
            and claims.get("idtyp") != "app"
            and nbf <= now
            and iat <= now < exp
            and nbf <= exp
            and 0 < exp - iat <= 86400
            and (expected_oid is None or oid == expected_oid)
            and (
                not api
                or now - iat < 300
                and isinstance(roles, list)
                and any(role in {"AgentControl.Viewer", "AgentControl.Admin"} for role in roles)
            )
        )
    except ConfigurationError, TypeError, ValueError:
        return False


class ReferenceAccessToken(AccessToken):
    reference: str = Field(exclude=True, repr=False)


class TenantAzureProvider(AzureProvider):
    """Narrow supported public AzureProvider hooks; never inspect SDK-private stores."""

    def __init__(
        self,
        settings: Settings,
        store: OAuthStore,
        http_client: httpx2.AsyncClient,
    ) -> None:
        self.settings = settings
        self.store = store
        self.authorization_code_lock = asyncio.Lock()
        super().__init__(
            client_id=settings.client_id,
            client_secret=settings.client_secret,
            tenant_id=settings.tenant_id,
            required_scopes=["Mcp.Access"],
            additional_authorize_scopes=["openid", "profile"],
            identifier_uri=f"api://{settings.client_id}",
            base_url=settings.public_origin,
            resource_base_url=settings.public_origin,
            issuer_url=settings.public_origin,
            redirect_path="/auth/callback",
            allowed_client_redirect_uris=list(settings.redirect_uris),
            client_storage=store,
            jwt_signing_key=settings.signing_key,
            require_authorization_consent=True,
            forward_resource=False,
            fallback_refresh_token_expiry_seconds=86400,
            fastmcp_access_token_expiry_seconds=900,
            token_expiry_threshold_seconds=60,
            http_client=http_client,
            enable_cimd=False,
        )
        self.revocation_options = RevocationOptions(enabled=True)

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        if (
            len(client_info.model_dump_json().encode()) > 16384
            or client_info.client_name is not None
            and len(client_info.client_name) > 256
        ):
            raise RegistrationError(
                error="invalid_client_metadata",
                error_description="Client metadata exceeds its bound.",
            )
        if not client_info.redirect_uris or any(
            str(uri) not in self.settings.redirect_uris for uri in client_info.redirect_uris
        ):
            raise RegistrationError(
                error="invalid_redirect_uri",
                error_description="Only exact approved client redirects are supported.",
            )
        await super().register_client(client_info)

    async def authorize(
        self,
        client: OAuthClientInformationFull,
        params: AuthorizationParams,
    ) -> str:
        if params.resource != self.settings.public_url:
            raise AuthorizeError(
                error="invalid_target",
                error_description="The exact configured resource is required.",
            )
        if (
            not re.fullmatch(r"[A-Za-z0-9_-]{43}", params.code_challenge)
            or str(params.redirect_uri) not in self.settings.redirect_uris
        ):
            raise AuthorizeError(
                error="invalid_request", error_description="Invalid PKCE or redirect."
            )
        async with asyncio.timeout(10):
            return await super().authorize(client, params)

    async def load_access_token(self, token: str) -> AccessToken | None:
        if not token or len(token) > 32768:
            return None
        try:
            async with asyncio.timeout(10):
                if await self.store.get(self.token_key(token), collection="revoked"):
                    return None
                verified = await super().load_access_token(token)
                if verified is None or not valid_claims(verified.claims, self.settings):
                    return None
                reference_claims = self.jwt_issuer.verify_token(token)
                if not same_user(reference_claims.get("upstream_claims"), verified.claims):
                    return None
                client_id = reference_claims.get("client_id")
                if not isinstance(client_id, str) or not 1 <= len(client_id) <= 256:
                    return None
                if await self.store.get(self.token_key(token), collection="revoked"):
                    return None
                # Preserve the verified upstream JWT/claims for OBO, while the SDK's
                # transport owner binds the user AND the signed downstream OAuth client.
                return ReferenceAccessToken(
                    **{**verified.model_dump(), "client_id": client_id},
                    reference=token,
                )
        except TimeoutError, ConfigurationError:
            return None

    @staticmethod
    def token_key(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    async def load_refresh_token(
        self,
        client: OAuthClientInformationFull,
        refresh_token: str,
    ) -> RefreshToken | None:
        if await self.store.get(self.token_key(refresh_token), collection="revoked"):
            return None
        return await super().load_refresh_token(client, refresh_token)

    async def revoke_token(self, token: SDKAccessToken | RefreshToken) -> None:
        reference = token.reference if isinstance(token, ReferenceAccessToken) else token.token
        await self.store.put(
            self.token_key(reference),
            {"revoked": True},
            collection="revoked",
            ttl=86400,
        )
        await super().revoke_token(token)

    async def exchange_authorization_code(
        self,
        client: OAuthClientInformationFull,
        authorization_code: AuthorizationCode,
    ) -> OAuthToken:
        # Serialize SDK get-and-consume locally; Azure additionally fences every
        # persisted step on the exact data blob across replacement processes.
        try:
            async with asyncio.timeout(10), self.authorization_code_lock:
                result = await super().exchange_authorization_code(client, authorization_code)
                await self.store.assert_authority()
                return result
        except TimeoutError:
            raise AdapterError(
                504,
                "authorization_deadline",
                "Authorization deadline exceeded.",
            ) from None

    async def exchange_refresh_token(
        self,
        client: OAuthClientInformationFull,
        refresh_token: RefreshToken,
        scopes: list[str],
    ) -> OAuthToken:
        original = self.jwt_issuer.verify_token(refresh_token.token, expected_token_use="refresh")
        if await self.store.get(self.token_key(refresh_token.token), collection="revoked"):
            raise TokenError("invalid_grant", "Refresh credential was revoked.")
        try:
            async with asyncio.timeout(10):
                issued = await super().exchange_refresh_token(client, refresh_token, scopes)
            renewed = self.jwt_issuer.verify_token(issued.access_token)
            if not same_user(
                original.get("upstream_claims"), renewed.get("upstream_claims")
            ) or await self.store.get(self.token_key(refresh_token.token), collection="revoked"):
                for reference in (issued.access_token, issued.refresh_token):
                    if reference:
                        await self.store.put(
                            self.token_key(reference),
                            {"revoked": True},
                            collection="revoked",
                            ttl=86400,
                        )
                await self.revoke_token(refresh_token)
                raise TokenError("invalid_grant", "Connection changed or was revoked; reconnect.")
            await self.store.assert_authority()
            return issued
        except TimeoutError, httpx2.TimeoutException:
            raise AdapterError(
                504,
                "authorization_deadline",
                "Authorization deadline exceeded.",
            ) from None
        except httpx2.HTTPError:
            raise AdapterError(
                503,
                "authorization_unavailable",
                "Authorization is temporarily unavailable.",
            ) from None
        except OAuthError as error:
            if error.error in {"temporarily_unavailable", "server_error"}:
                raise AdapterError(
                    503,
                    "authorization_unavailable",
                    "Authorization is temporarily unavailable.",
                ) from None
            raise TokenError(
                "invalid_grant", "Upstream authorization requires reconnect."
            ) from None


def same_user(left: object, right: object) -> bool:
    return bool(
        isinstance(left, dict)
        and isinstance(right, dict)
        and all(
            isinstance(left.get(key), str) and left[key] == right.get(key)
            for key in ("oid", "tid", "sub", "azp")
        )
    )


def verified_upstream(settings: Settings) -> AccessToken:
    token = get_access_token()
    if token is None or not valid_claims(token.claims, settings):
        raise AdapterError(401, "reauthorization_required", "Reconnect this signed-in account.")
    return token


class ApiTokenExchange:
    def __init__(self, settings: Settings, http_client: httpx2.AsyncClient) -> None:
        self.settings = settings
        self.http = http_client
        self.verifier = JWTVerifier(
            jwks_uri=f"{settings.authority}/discovery/v2.0/keys",
            issuer=settings.issuer,
            audience=settings.api_client_id,
            algorithm="RS256",
            required_scopes=["AgentControl.Access"],
            http_client=http_client,
        )

    async def exchange(self, upstream: AccessToken) -> AccessToken:
        if not valid_claims(upstream.claims, self.settings):
            raise AdapterError(401, "reauthorization_required", "Reconnect this signed-in account.")
        try:
            async with asyncio.timeout(10):
                async with request_stream(
                    self.http,
                    "POST",
                    f"{self.settings.authority}/oauth2/v2.0/token",
                    data={
                        "client_id": self.settings.client_id,
                        "client_secret": self.settings.client_secret,
                        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                        "requested_token_use": "on_behalf_of",
                        "assertion": upstream.token,
                        "scope": f"api://{self.settings.api_client_id}/AgentControl.Access",
                    },
                ) as response:
                    body = await bounded_body(response, 65536)
                    if response.status_code == 429:
                        raise AdapterError(
                            429,
                            "authorization_throttled",
                            "Authorization is temporarily throttled.",
                            retry_after_seconds=retry_after(response.headers.get("Retry-After")),
                        )
                    if response.status_code not in {200, 400, 401, 403}:
                        raise AdapterError(
                            503,
                            "authorization_unavailable",
                            "Authorization is temporarily unavailable.",
                            retry_after_seconds=retry_after(response.headers.get("Retry-After")),
                        )
                    if response.status_code != 200:
                        # Only the standards-defined bounded claims object may leave this boundary.
                        details = claims_details(body)
                        raise AdapterError(
                            401,
                            "reauthorization_required",
                            "Reconnect this signed-in account.",
                            details=details,
                        )
                payload = json.loads(body)
                assertion = payload.get("access_token") if isinstance(payload, dict) else None
                if (
                    not isinstance(assertion, str)
                    or len(assertion) > 32768
                    or payload.get("token_type", "").lower() != "bearer"
                ):
                    raise ValueError
                verified = await self.verifier.verify_token(assertion)
                if verified is None or not valid_claims(
                    verified.claims,
                    self.settings,
                    api=True,
                    expected_oid=upstream.claims["oid"],
                ):
                    raise ValueError
                return verified
        except TimeoutError, httpx2.TimeoutException:
            raise AdapterError(
                504, "authorization_deadline", "Authorization deadline exceeded."
            ) from None
        except httpx2.HTTPError:
            raise AdapterError(
                503, "authorization_unavailable", "Authorization is unavailable."
            ) from None
        except ValueError, KeyError, TypeError:
            raise AdapterError(
                401, "reauthorization_required", "Reconnect this signed-in account."
            ) from None


async def bounded_body(response: httpx2.Response, maximum: int) -> bytes:
    if response.headers.get("content-encoding", "identity").strip().lower() != "identity":
        raise AdapterError(502, "invalid_api_response", "Compressed responses are not admitted.")
    chunks = bytearray()
    async for chunk in response.aiter_bytes():
        if len(chunks) + len(chunk) > maximum:
            raise AdapterError(413, "output_limit", "Response exceeds the adapter output limit.")
        chunks.extend(chunk)
    return bytes(chunks)


@asynccontextmanager
async def request_stream(
    client: httpx2.AsyncClient,
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    data: dict[str, str] | None = None,
    params: Mapping[str, str | list[str]] | None = None,
    json_body: dict[str, JsonValue] | None = None,
) -> AsyncIterator[httpx2.Response]:
    # A bare Request never inherits a shared client's cookie jar or auth defaults.
    request = httpx2.Request(
        method,
        url,
        headers={"Accept-Encoding": "identity", **(headers or {})},
        data=data,
        params=params,
        json=json_body,
    )
    response = await client.send(request, stream=True, follow_redirects=False)
    try:
        yield response
    finally:
        await response.aclose()


def retry_after(value: str | None) -> int | None:
    if value and re.fullmatch(r"[0-9]{1,6}", value):
        return min(int(value), 86400)
    if value and len(value) <= 128:
        try:
            return max(
                0, min(86400, math.ceil(parsedate_to_datetime(value).timestamp() - time.time()))
            )
        except TypeError, ValueError, OverflowError:
            return None
    return None


def claims_details(body: bytes) -> dict[str, Any] | None:
    try:
        payload = json.loads(body)
        claims = payload.get("claims") if isinstance(payload, dict) else None
        if isinstance(claims, str) and len(claims.encode()) <= 4096:
            parsed = json.loads(claims)
            if not isinstance(parsed, dict) or set(parsed) != {"access_token"}:
                return None
            requested = parsed["access_token"]
            if not isinstance(requested, dict) or len(requested) > 16:
                return None
            for key, claim in requested.items():
                if (
                    not re.fullmatch(r"[A-Za-z0-9_]{1,64}", key)
                    or not isinstance(claim, dict)
                    or set(claim) - {"essential", "value", "values"}
                    or "essential" in claim
                    and type(claim["essential"]) is not bool
                    or "value" in claim
                    and not challenge_value(claim["value"])
                    or "values" in claim
                    and (
                        not isinstance(claim["values"], list)
                        or len(claim["values"]) > 16
                        or not all(challenge_value(value) for value in claim["values"])
                    )
                ):
                    return None
            return {"claims": claims}
    except ValueError, TypeError:
        pass
    return None


def challenge_value(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,256}", value) is not None
