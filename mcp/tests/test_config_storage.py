import json
from dataclasses import replace
from pathlib import Path

import pytest
from cryptography.fernet import Fernet
from key_value.aio.errors import DecryptionError

from agent_control_mcp.config import ConfigurationError, Settings
from agent_control_mcp.storage import OAuthStore, inspect_storage


@pytest.mark.parametrize(
    "missing",
    [
        "MCP_TENANT_ID",
        "MCP_CLIENT_SECRET_FILE",
        "MCP_JWT_SIGNING_KEY_FILE",
        "MCP_OAUTH_ENCRYPTION_KEY_FILE",
        "MCP_ALLOWED_CLIENT_REDIRECT_URIS",
    ],
)
def test_missing_configuration(settings_env, missing):
    del settings_env[missing]
    with pytest.raises(ConfigurationError):
        Settings.from_env(settings_env)


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("MCP_TENANT_ID", "common"),
        ("MCP_TENANT_ID", "organizations"),
        ("MCP_CLIENT_ID", "22222222-2222-2222-2222-222222222222"),
        ("MCP_PUBLIC_URL", "http://mcp.example.test/mcp"),
        ("MCP_PUBLIC_URL", "https://mcp.example.test/mcp?tenant=anything"),
        ("MCP_PUBLIC_URL", "https://user:pass@mcp.example.test/mcp"),
        ("MCP_PUBLIC_URL", "https://mcp.example.test/diagnostics"),
        ("MCP_PUBLIC_URL", "https://MCP.example.test/mcp"),
        ("MCP_PUBLIC_URL", "https://mcp.example.test:443/mcp"),
        ("MCP_API_ORIGIN", "https://api.example.test/path"),
        ("MCP_API_ORIGIN", "https://api.example.test/../escape"),
        ("MCP_API_ORIGIN", "http://remote.example.test"),
        ("MCP_OAUTH_STORAGE_PATH", "/"),
        ("MCP_ALLOWED_CLIENT_REDIRECT_URIS", "[]"),
        ("MCP_ALLOWED_CLIENT_REDIRECT_URIS", '["https://*.example.test/callback"]'),
        ("MCP_ALLOWED_CLIENT_REDIRECT_URIS", '["http://remote.example.test/callback"]'),
        ("MCP_ALLOWED_CLIENT_REDIRECT_URIS", '["https://client.example.test/callback?x=y"]'),
    ],
)
def test_invalid_configuration(settings_env, name, value):
    settings_env[name] = value
    with pytest.raises(ConfigurationError):
        Settings.from_env(settings_env)


def test_independent_keys_and_permissions(settings_env):
    signing = Path(settings_env["MCP_JWT_SIGNING_KEY_FILE"])
    encryption = Path(settings_env["MCP_OAUTH_ENCRYPTION_KEY_FILE"])
    encryption.write_text(json.dumps([signing.read_text()]))
    with pytest.raises(ConfigurationError):
        Settings.from_env(settings_env)
    encryption.write_text(json.dumps([Fernet.generate_key().decode()]))
    signing.chmod(0o644)
    with pytest.raises(ConfigurationError):
        Settings.from_env(settings_env)


def test_secret_symlink_rejected(settings_env, tmp_path):
    source = Path(settings_env["MCP_CLIENT_SECRET_FILE"])
    link = tmp_path / "link"
    link.symlink_to(source)
    settings_env["MCP_CLIENT_SECRET_FILE"] = str(link)
    with pytest.raises(ConfigurationError):
        Settings.from_env(settings_env)


async def test_encryption_restart_rotation_and_plaintext_rejection(settings):
    store = OAuthStore(settings)
    value = {"access_token": "synthetic-sensitive-access", "refresh_token": "synthetic-refresh"}
    await store.put("connection", value, collection="connections", ttl=60)
    await store.put("synthetic-secret-authorization-code", value, collection="connections", ttl=60)
    contents = b"".join(
        path.read_bytes() for path in settings.storage_path.rglob("*") if path.is_file()
    )
    assert b"synthetic-sensitive-access" not in contents
    assert b"synthetic-refresh" not in contents
    assert b"access_token" not in contents
    assert b"synthetic-secret-authorization-code" not in contents
    assert "synthetic-secret-authorization-code" not in "\n".join(
        str(path) for path in settings.storage_path.rglob("*")
    )
    assert await OAuthStore(settings).get("connection", collection="connections") == value
    new_key = Fernet.generate_key()
    rotated_settings = replace(settings, encryption_keys=(new_key, *settings.encryption_keys))
    rotated = OAuthStore(rotated_settings)
    assert await rotated.get("connection", collection="connections") == value
    await rotated.put("new-connection", value, collection="connections", ttl=60)
    only_new = OAuthStore(replace(settings, encryption_keys=(new_key,)))
    assert await only_new.get("new-connection", collection="connections") == value
    with pytest.raises(DecryptionError):
        await only_new.get("connection", collection="connections")
    await store.files.put("plaintext", value, collection="connections", ttl=60)
    with pytest.raises(ConfigurationError):
        await store.get("plaintext", collection="connections")
    inspect_storage(settings.storage_path)
    assert all(path.stat().st_mode & 0o077 == 0 for path in settings.storage_path.rglob("*"))


async def test_retention_health_corruption_and_no_durable_api_credentials(settings):
    store = OAuthStore(settings)
    await store.check()
    await store.put("bounded", {"a": 1}, collection="connections", ttl=999999)
    _, ttl = await store.ttl("bounded", collection="connections")
    assert 0 < ttl <= 86400
    await store.put("shorter", {"a": 1}, collection="connections", ttl=5)
    _, ttl = await store.ttl("shorter", collection="connections")
    assert 0 < ttl <= 5
    with pytest.raises(ConfigurationError):
        await store.put("infinite", {}, ttl=float("inf"))
    settings.storage_path.chmod(0o755)
    with pytest.raises(ConfigurationError):
        await store.check()


def test_configuration_repr_redacted(settings):
    text = repr(settings)
    assert settings.client_secret not in text
    assert settings.signing_key.hex() not in text
    assert settings.encryption_keys[0].decode() not in text


async def test_storage_binding_wrong_keys_capacity_and_record_bounds(settings, monkeypatch):
    store = OAuthStore(settings)
    await store.check()
    with pytest.raises(ConfigurationError):
        await OAuthStore(replace(settings, public_url="https://other.example.test/mcp")).check()
    with pytest.raises(DecryptionError):
        await OAuthStore(replace(settings, encryption_keys=(Fernet.generate_key(),))).check()
    with pytest.raises(ConfigurationError):
        await store.put("oversized", {"token": "x" * 262144})
    monkeypatch.setattr("agent_control_mcp.storage.MAX_DISK_BYTES", 1)
    with pytest.raises(ConfigurationError):
        await store.put("capacity", {"a": 1})


def test_supported_private_transport_exact_loopback_and_sdk_configuration(settings_env):
    from importlib.metadata import version

    from fastmcp import settings as sdk_settings

    settings_env["MCP_API_ORIGIN"] = "http://app:3001"
    settings_env["MCP_ALLOWED_CLIENT_REDIRECT_URIS"] = '["http://127.0.0.1:49201/callback"]'
    configured = Settings.from_env(settings_env)
    assert configured.api_origin == "http://app:3001"
    assert configured.redirect_uris == ("http://127.0.0.1:49201/callback",)
    assert sdk_settings.model_config["env_file"] == "/dev/null"
    assert sdk_settings.telemetry_mode == "off"
    assert version("fastmcp") == "4.1.0"
    assert version("mcp") == "2.3.0"


@pytest.mark.parametrize(
    "callback",
    [
        "http://127.0.0.1:53110/",
        "http://127.0.0.1:19876/mcp/oauth/callback",
        "https://client.example.test/",
    ],
)
def test_native_client_callbacks_remain_exact(settings_env, callback):
    settings_env["MCP_ALLOWED_CLIENT_REDIRECT_URIS"] = json.dumps([callback])
    assert Settings.from_env(settings_env).redirect_uris == (callback,)


@pytest.fixture
def azure_env(settings_env):
    for key in ("CLIENT_SECRET", "JWT_SIGNING_KEY", "OAUTH_ENCRYPTION_KEY"):
        settings_env[f"MCP_AZURE_{key}"] = Path(settings_env.pop(f"MCP_{key}_FILE")).read_text()
    settings_env.update(
        {
            "MCP_SECRET_SOURCE": "app-service-key-vault",
            "MCP_AZURE_BLOB_ACCOUNT_URL": "https://fixturestore.blob.core.windows.net",
            "MCP_AZURE_BLOB_CONTAINER": "mcp-oauth",
            "MCP_AZURE_BLOB_NAME": "oauth-state.v1.fernet",
            "MCP_AZURE_IDENTITY_CLIENT_ID": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        }
    )
    settings_env.pop("MCP_OAUTH_STORAGE_PATH")
    return settings_env


def test_azure_native_references_use_same_separation_and_no_secret_files(azure_env):
    configured = Settings.from_env(azure_env)
    assert configured.azure_blob.blob == "oauth-state.v1.fernet"
    assert configured.azure_blob.identity_client_id == azure_env["MCP_AZURE_IDENTITY_CLIENT_ID"]
    assert configured.client_secret == azure_env["MCP_AZURE_CLIENT_SECRET"]
    assert configured.client_secret not in repr(configured)
    assert configured.encryption_keys[0].decode() not in repr(configured)


@pytest.mark.parametrize(
    "change",
    [
        {"MCP_AZURE_CLIENT_SECRET": ""},
        {"MCP_AZURE_CLIENT_SECRET": "@Microsoft.KeyVault(SecretUri=unresolved)"},
        {"MCP_AZURE_JWT_SIGNING_KEY": "@Microsoft.KeyVault(SecretUri=unresolved)"},
        {"MCP_CLIENT_SECRET_FILE": "/not-a-fallback"},
        {"MCP_OAUTH_STORAGE_PATH": "/home/oauth"},
        {"MCP_AZURE_IDENTITY_CLIENT_ID": ""},
        {"MCP_AZURE_BLOB_ACCOUNT_URL": "http://fixturestore.blob.core.windows.net"},
        {"MCP_AZURE_BLOB_ACCOUNT_URL": "https://other.example.test"},
        {"MCP_AZURE_BLOB_NAME": "other"},
        {"MCP_AZURE_BLOB_CONTAINER": "../other"},
        {"MCP_AZURE_BLOB_CONTAINER": "a--b"},
        {"MCP_AZURE_STORAGE_KEY": "synthetic-no-fallback"},
        {"MCP_SECRET_SOURCE": "files"},
        {"MCP_SECRET_SOURCE": "automatic"},
    ],
)
def test_azure_invalid_configuration_never_falls_back(azure_env, change):
    azure_env.update(change)
    with pytest.raises(ConfigurationError):
        Settings.from_env(azure_env)


def test_azure_credentials_are_explicit_uami_and_do_not_create_local_files(azure_env, monkeypatch):
    from agent_control_mcp.azure_storage import AzureOAuthBlobStore

    settings = Settings.from_env(azure_env)
    calls = []
    monkeypatch.setattr(
        "agent_control_mcp.azure_storage.ManagedIdentityCredential",
        lambda **kwargs: calls.append(kwargs) or object(),
    )
    monkeypatch.setattr("agent_control_mcp.azure_storage.BlobClient", lambda *a, **kw: object())
    AzureOAuthBlobStore(settings)
    assert calls == [{"client_id": settings.azure_blob.identity_client_id}]
