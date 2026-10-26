from __future__ import annotations

import base64
import json
import os
import re
import stat
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID

from cryptography.fernet import Fernet
from pydantic import AnyHttpUrl, ValidationError


class ConfigurationError(ValueError):
    pass


def guid(value: object) -> str:
    if not isinstance(value, str) or not re.fullmatch(
        r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", value
    ):
        raise ConfigurationError("Expected an exact GUID.")
    return str(UUID(value))


def checked_url(value: str, *, resource: bool = False, redirect: bool = False) -> str:
    try:
        url = urlsplit(value)
        port = url.port
    except ValueError:
        raise ConfigurationError("Invalid configured URL.") from None
    loopback = url.hostname in {"localhost", "127.0.0.1", "::1"}
    if (
        len(value) > 2048
        or not url.hostname
        or url.username
        or url.password
        or url.query
        or url.fragment
        or "*" in value
        or "\\" in value
        or "%" in value
        or re.search(r"[\s\x00-\x1f\x7f]", value)
        or "//" in url.path
        or any(part in {".", ".."} for part in url.path.split("/"))
        or url.scheme not in {"https", "http"}
        or (url.scheme != "https" and (resource or redirect and not loopback))
        or (url.scheme == "http" and not redirect and not loopback and "." in url.hostname)
        or (resource and (not url.path or url.path == "/" or url.path.endswith("/")))
        or (not resource and not redirect and url.path)
        or (redirect and not url.path)
        or (port is not None and not 1 <= port <= 65535)
    ):
        raise ConfigurationError("URL must be exact, without credentials, wildcards or query.")
    try:
        canonical = str(AnyHttpUrl(value))
    except ValidationError:
        raise ConfigurationError("Configured URL is invalid.") from None
    if not resource and not redirect:
        canonical = canonical.rstrip("/")
    if canonical != value:
        raise ConfigurationError("Configure the canonical URL spelling.")
    if resource and (
        url.path
        in {
            "/health",
            "/ready",
            "/diagnostics",
            "/authorize",
            "/token",
            "/consent",
            "/auth/callback",
            "/register",
            "/revoke",
        }
        or url.path.startswith("/.well-known/")
    ):
        raise ConfigurationError("The MCP resource path cannot replace an authentication endpoint.")
    return value


def protected_file(path: Path) -> str:
    try:
        info = path.lstat()
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_mode & 0o077
            or not 1 <= info.st_size <= 8192
        ):
            raise ConfigurationError("Secret file must be an owned 0600 regular file.")
        return path.read_text(encoding="utf-8").strip()
    except OSError, UnicodeError:
        raise ConfigurationError("Cannot read protected secret file.") from None


def key_bytes(value: str) -> bytes:
    try:
        raw = base64.b64decode(value, altchars=b"-_", validate=True)
        if len(raw) != 32 or base64.urlsafe_b64encode(raw).decode() != value:
            raise ValueError
        return raw
    except ValueError:
        raise ConfigurationError("Keys must encode 32 independent random bytes.") from None


@dataclass(frozen=True)
class AzureBlobSettings:
    account_url: str
    container: str
    blob: str
    identity_client_id: str

    @classmethod
    def from_env(cls, values: Mapping[str, str]) -> AzureBlobSettings:
        account = values.get("MCP_AZURE_BLOB_ACCOUNT_URL", "")
        container = values.get("MCP_AZURE_BLOB_CONTAINER", "")
        blob = values.get("MCP_AZURE_BLOB_NAME", "")
        identity = values.get("MCP_AZURE_IDENTITY_CLIENT_ID", "")
        if (
            not re.fullmatch(r"https://[a-z0-9]{3,24}\.blob\.core\.windows\.net", account)
            or not re.fullmatch(r"[a-z0-9](?:[a-z0-9]|-(?!-)){1,61}[a-z0-9]", container)
            or blob != "oauth-state.v1.fernet"
            or guid(identity) != identity
        ):
            raise ConfigurationError("Azure requires exact Blob account/container/object/UAMI.")
        return cls(account, container, blob, identity)


@dataclass(frozen=True)
class Settings:
    tenant_id: str
    client_id: str
    api_client_id: str
    api_origin: str
    public_url: str
    redirect_uris: tuple[str, ...]
    storage_path: Path
    client_secret: str = field(repr=False)
    signing_key: bytes = field(repr=False)
    encryption_keys: tuple[bytes, ...] = field(repr=False)
    azure_blob: AzureBlobSettings | None = None

    @property
    def authority(self) -> str:
        return f"https://login.microsoftonline.com/{self.tenant_id}"

    @property
    def issuer(self) -> str:
        return f"{self.authority}/v2.0"

    @property
    def public_origin(self) -> str:
        url = urlsplit(self.public_url)
        return f"{url.scheme}://{url.netloc}"

    @property
    def mcp_path(self) -> str:
        return urlsplit(self.public_url).path

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Settings:
        values = os.environ if env is None else env
        names = (
            "TENANT_ID",
            "CLIENT_ID",
            "API_CLIENT_ID",
            "API_ORIGIN",
            "PUBLIC_URL",
            "CLIENT_SECRET_FILE",
            "JWT_SIGNING_KEY_FILE",
            "OAUTH_ENCRYPTION_KEY_FILE",
            "OAUTH_STORAGE_PATH",
            "ALLOWED_CLIENT_REDIRECT_URIS",
        )
        source = values.get("MCP_SECRET_SOURCE", "files")
        azure = source == "app-service-key-vault"
        if source not in {"files", "app-service-key-vault"}:
            raise ConfigurationError("Unsupported MCP secret source.")
        required = names[:5] + names[9:] if azure else names
        if any(not values.get(f"MCP_{name}") for name in required):
            raise ConfigurationError(
                "Required MCP configuration or independent secret file is missing."
            )
        tenant, client, api = (guid(values[f"MCP_{name}"]) for name in names[:3])
        if client == api:
            raise ConfigurationError("MCP and API registrations must be distinct.")
        if azure:
            allowed_azure = {
                "MCP_AZURE_CLIENT_SECRET",
                "MCP_AZURE_JWT_SIGNING_KEY",
                "MCP_AZURE_OAUTH_ENCRYPTION_KEY",
                "MCP_AZURE_BLOB_ACCOUNT_URL",
                "MCP_AZURE_BLOB_CONTAINER",
                "MCP_AZURE_BLOB_NAME",
                "MCP_AZURE_IDENTITY_CLIENT_ID",
            }
            if values.get("MCP_OAUTH_STORAGE_PATH") or any(
                name.startswith("MCP_AZURE_") and name not in allowed_azure for name in values
            ):
                raise ConfigurationError("Azure Blob and local file storage profiles cannot mix.")
            secret, signing, encryption = (
                values.get(f"MCP_AZURE_{name}", "")
                for name in ("CLIENT_SECRET", "JWT_SIGNING_KEY", "OAUTH_ENCRYPTION_KEY")
            )
            if any(values.get(f"MCP_{name}") for name in names[5:8]) or any(
                not value or len(value.encode()) > 8192 or value.startswith("@Microsoft.")
                for value in (secret, signing, encryption)
            ):
                raise ConfigurationError(
                    "Azure requires three resolved native Key Vault references."
                )
        else:
            if any(name.startswith("MCP_AZURE_") for name in values):
                raise ConfigurationError(
                    "Azure storage/credentials require the explicit Azure source."
                )
            paths = [Path(values[f"MCP_{name}"]) for name in names[5:8]]
            if len({str(path.resolve()) for path in paths}) != 3:
                raise ConfigurationError("Secret files must be independent.")
            secret, signing, encryption = map(protected_file, paths)
        try:
            redirects = json.loads(values["MCP_ALLOWED_CLIENT_REDIRECT_URIS"])
            keys = json.loads(encryption)
        except ValueError:
            raise ConfigurationError("Redirects and encryption keys must be JSON arrays.") from None
        if (
            not isinstance(redirects, list)
            or not 1 <= len(redirects) <= 32
            or not all(isinstance(uri, str) for uri in redirects)
            or len(set(redirects)) != len(redirects)
            or not isinstance(keys, list)
            or not 1 <= len(keys) <= 3
            or not all(isinstance(key, str) for key in keys)
            or len(set(keys)) != len(keys)
        ):
            raise ConfigurationError("Invalid bounded redirects or encryption key ring.")
        signing_bytes = key_bytes(signing)
        encryption_bytes = tuple(key_bytes(key) for key in keys)
        if signing_bytes in encryption_bytes or secret in {signing, *keys} or len(secret) < 16:
            raise ConfigurationError(
                "Confidential, signing and encryption secrets must be independent."
            )
        for key in keys:
            Fernet(key.encode())
        storage = Path(values.get("MCP_OAUTH_STORAGE_PATH", "/unused/azure-blob"))
        if not azure and (
            not storage.is_absolute() or len(storage.parts) < 3 or ".." in storage.parts
        ):
            raise ConfigurationError("OAuth storage must be an exact absolute dedicated path.")
        return cls(
            tenant,
            client,
            api,
            checked_url(values["MCP_API_ORIGIN"]),
            checked_url(values["MCP_PUBLIC_URL"], resource=True),
            tuple(checked_url(uri, redirect=True) for uri in redirects),
            storage,
            secret,
            signing_bytes,
            tuple(key.encode() for key in keys),
            AzureBlobSettings.from_env(values) if azure else None,
        )
