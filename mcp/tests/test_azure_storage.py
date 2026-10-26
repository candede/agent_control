import asyncio
import base64
import json
import time
from dataclasses import replace
from uuid import uuid4

import httpx2
import pytest
from azure.core.exceptions import HttpResponseError
from azure.storage.blob.aio import BlobClient, BlobServiceClient
from conftest import OTHER, connect, tokens
from cryptography.fernet import Fernet

from agent_control_mcp.azure_storage import AzureOAuthBlobStore, OAuthAuthorityUnavailable
from agent_control_mcp.config import AzureBlobSettings
from agent_control_mcp.service import ProtocolBoundary, build_service
from agent_control_mcp.storage import OAuthStore

SYNTHETIC_KEY = base64.b64encode(b"synthetic-emulator-key-not-a-production-secret").decode()


@pytest.fixture
async def prepared_blob(settings, request):
    endpoint = request.config.getoption("--azure-oauth-endpoint")
    if endpoint is None:
        pytest.skip("Requires the guarded isolated Azure OAuth emulator toolkit.")
    assert endpoint.startswith("http://127.0.0.1:")
    credential = {"account_name": "fixtureoauth", "account_key": SYNTHETIC_KEY}
    account_url = endpoint + "/fixtureoauth"
    container = "oauth-" + uuid4().hex
    blob_name = "oauth-state.v1.fernet"
    target = AzureBlobSettings(
        "https://fixtureoauth.blob.core.windows.net",
        container,
        blob_name,
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    )
    configured = replace(settings, azure_blob=target)
    clients = []
    stores = []
    async with BlobServiceClient(account_url, credential=credential, retry_total=0) as admin:
        await admin.create_container(container)

        def client():
            result = BlobClient(
                account_url,
                container,
                blob_name,
                credential=credential,
                retry_total=0,
                max_single_put_size=64 * 1024 * 1024,
            )
            clients.append(result)
            return result

        bootstrap = client()
        await bootstrap.upload_blob(b"")

        def store(overrides=None):
            result = AzureOAuthBlobStore(overrides or configured, client=client())
            stores.append(result)
            return result

        try:
            yield configured, store, bootstrap, client
        finally:
            for value in stores:
                await value.aclose()
            await admin.delete_container(container)
            for value in clients:
                await value.close()


async def test_real_sdk_active_holder_blocks_second_instance_and_release_replacement(prepared_blob):
    _, factory, _, _ = prepared_blob
    first, second = factory(), factory()
    await first.start()
    await first.put("connection", {"access_token": "synthetic-sensitive"}, ttl=60)
    with pytest.raises(OAuthAuthorityUnavailable):
        await second.start()
    assert second.failed
    await first.aclose()
    replacement = factory()
    await replacement.start()
    assert await replacement.get("connection") == {"access_token": "synthetic-sensitive"}
    with pytest.raises(OAuthAuthorityUnavailable):
        await first.get("connection")


async def test_real_sdk_crashed_expired_writer_is_rejected_by_storage_server(prepared_blob):
    _, factory, bootstrap, _ = prepared_blob
    first = factory()
    await first.start()
    await first.put("kept", {"v": 1})
    stale_lease = first.lease
    first.renewal.cancel()
    await asyncio.gather(first.renewal, return_exceptions=True)
    first.renewal = None
    await asyncio.sleep(16)
    with pytest.raises(OAuthAuthorityUnavailable):
        await first.get("kept")
    second = factory()
    await second.start()
    await second.put("replacement", {"v": 2})
    # No mock: the actual storage server must reject the old lease on the data object.
    with pytest.raises(HttpResponseError) as rejected:
        await bootstrap.upload_blob(
            b"stale-writer-must-not-persist", overwrite=True, lease=stale_lease
        )
    assert rejected.value.status_code == 412
    with pytest.raises(OAuthAuthorityUnavailable):
        await first.get("kept")
    with pytest.raises(OAuthAuthorityUnavailable):
        await first.put("stale", {"v": 3})
    assert await second.get("replacement") == {"v": 2}
    assert await second.get("stale") is None


async def test_real_sdk_renews_only_during_lifespan_and_shutdown_releases(prepared_blob):
    _, factory, bootstrap, _ = prepared_blob
    first = factory()
    await first.start()
    await asyncio.sleep(16)
    assert await first.get("unused") is None
    assert (await bootstrap.get_blob_properties()).lease.status == "locked"
    task = first.renewal
    await first.aclose()
    assert task.done() and first.renewal is None
    assert (await bootstrap.get_blob_properties()).lease.status == "unlocked"
    second = factory()
    await second.start()


async def test_real_sdk_ciphertext_reload_rotation_and_revocation(prepared_blob):
    settings, factory, bootstrap, _ = prepared_blob
    first = factory()
    await first.start()
    await first.put("synthetic-sensitive-key", {"access_token": "synthetic-sensitive-token"})
    await first.put("revoked-token-hash", {"revoked": True}, collection="revoked")
    raw = await (await bootstrap.download_blob()).readall()
    assert raw.startswith(b"gAAAA")
    assert b"synthetic-sensitive" not in raw and b"access_token" not in raw
    await first.aclose()
    key = Fernet.generate_key()
    rotated = factory(replace(settings, encryption_keys=(key, *settings.encryption_keys)))
    await rotated.start()
    assert await rotated.get("synthetic-sensitive-key") == {
        "access_token": "synthetic-sensitive-token",
    }
    assert await rotated.get("revoked-token-hash", collection="revoked") == {"revoked": True}
    await rotated.aclose()
    only_new = factory(replace(settings, encryption_keys=(key,)))
    await only_new.start()
    assert await only_new.get("revoked-token-hash", collection="revoked") == {"revoked": True}


@pytest.mark.parametrize("failure", ["binding", "key", "plaintext", "format", "oversize"])
async def test_real_sdk_invalid_state_fails_closed_without_overwrite(prepared_blob, failure):
    settings, factory, bootstrap, _ = prepared_blob
    first = factory()
    await first.start()
    await first.put("kept", {"v": 1})
    await first.aclose()
    configured = settings
    if failure == "binding":
        configured = replace(settings, public_url="https://different.example.test/mcp")
    elif failure == "key":
        configured = replace(settings, encryption_keys=(Fernet.generate_key(),))
    elif failure == "plaintext":
        await bootstrap.upload_blob(b'{"access_token":"synthetic-plaintext"}', overwrite=True)
    elif failure == "format":
        await bootstrap.upload_blob(first.fernet.encrypt(b'{"records":{}}'), overwrite=True)
    else:
        await bootstrap.upload_blob(
            first.fernet.encrypt(
                json.dumps(
                    {
                        "binding": first.binding,
                        "records": {
                            "f" * 64: {
                                "value": {"v": "x" * 262144},
                                "expires": time.time() + 60,
                            }
                        },
                    }
                ).encode()
            ),
            overwrite=True,
        )
    before = await (await bootstrap.download_blob()).readall()
    candidate = factory(configured)
    with pytest.raises(OAuthAuthorityUnavailable):
        await candidate.start()
    assert await (await bootstrap.download_blob()).readall() == before
    with pytest.raises(OAuthAuthorityUnavailable):
        await candidate.get("kept")


async def test_real_sdk_ttl_culling_and_record_count_object_byte_limits(prepared_blob, monkeypatch):
    _, factory, _, _ = prepared_blob
    store = factory()
    await store.start()
    await store.put("expired", {"v": 1}, ttl=0.05)
    await asyncio.sleep(0.08)
    await store.cull()
    assert await store.get("expired") is None
    await store.put("bounded", {"v": 1}, ttl=9999999)
    assert 0 < (await store.ttl("bounded"))[1] <= 86400
    with pytest.raises(ValueError):
        await store.put("bad", {}, ttl=float("inf"))
    with pytest.raises(ValueError):
        await store.put("large", {"v": "x" * 262144})
    assert not store.failed  # Invalid caller input never reaches storage.
    await store.put_many([f"entry-{index}" for index in range(4095)], [{}] * 4095)
    assert (await store.usage())[0] == 4096
    with pytest.raises(OAuthAuthorityUnavailable):
        await store.put("entry-4097", {})
    await store.aclose()
    replacement = factory()
    await replacement.start()
    monkeypatch.setattr("agent_control_mcp.azure_storage.MAX_MAP_BYTES", 1)
    with pytest.raises(OAuthAuthorityUnavailable):
        await replacement.put("bounded", {})


@pytest.mark.parametrize("limit", ["MAX_MAP_BYTES", "MAX_DISK_BYTES"])
async def test_real_sdk_serialized_and_encrypted_object_capacity_is_nonmutating(
    prepared_blob,
    monkeypatch,
    limit,
):
    _, factory, bootstrap, _ = prepared_blob
    store = factory()
    await store.start()
    before = await (await bootstrap.download_blob()).readall()
    monkeypatch.setattr("agent_control_mcp.azure_storage." + limit, len(before) + 500)
    with pytest.raises(OAuthAuthorityUnavailable):
        await store.put("too-much", {"value": "x" * 4096})
    assert await (await bootstrap.download_blob()).readall() == before


async def test_real_sdk_missing_prepared_object_is_never_created(prepared_blob):
    _, factory, bootstrap, _ = prepared_blob
    await bootstrap.delete_blob()
    with pytest.raises(OAuthAuthorityUnavailable):
        await factory().start()
    assert not await bootstrap.exists()


async def test_real_sdk_loss_after_response_headers_cannot_publish_response_body(prepared_blob):
    settings, factory, _, _ = prepared_blob
    blob = factory()
    await blob.start()
    store = OAuthStore(replace(settings, azure_blob=None))
    store.blob = blob
    sent = []

    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await blob.lease.break_lease(lease_break_period=0)
        await send({"type": "http.response.body", "body": b"must-not-be-published"})

    async def send(message):
        sent.append(message)

    async def receive():
        return {"type": "http.request", "body": b""}

    boundary = ProtocolBoundary(app, settings, store)
    with pytest.raises(OAuthAuthorityUnavailable):
        await boundary(
            {"type": "http", "method": "GET", "path": "/diagnostics", "headers": []}, receive, send
        )
    assert len(sent) == 1 and sent[0]["type"] == "http.response.start"


@pytest.mark.parametrize("failure", ["unknown-write", "cancelled-write", "unknown-renewal"])
async def test_real_sdk_ambiguous_mutation_and_cancellation_halt_authority(
    prepared_blob,
    monkeypatch,
    failure,
    caplog,
):
    _, factory, bootstrap, _ = prepared_blob
    first = factory()
    await first.start()
    upload = first.client.upload_blob
    completed = asyncio.Event()

    async def unknown(*args, **kwargs):
        await upload(*args, **kwargs)
        completed.set()
        if failure == "cancelled-write":
            await asyncio.Event().wait()
        raise TimeoutError("synthetic-sensitive-service-details")

    if failure == "unknown-renewal":
        renew = first.lease.renew

        async def renewal(*args, **kwargs):
            await renew(*args, **kwargs)
            raise TimeoutError("synthetic-sensitive-lease-details")

        monkeypatch.setattr(first.lease, "renew", renewal)
        with pytest.raises(OAuthAuthorityUnavailable):
            await first.get("never-cached")
    else:
        monkeypatch.setattr(first.client, "upload_blob", unknown)
        if failure == "cancelled-write":
            task = asyncio.create_task(first.put("possibly-persisted", {"v": 1}))
            await asyncio.wait_for(completed.wait(), timeout=5)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            with pytest.raises(OAuthAuthorityUnavailable):
                await first.put("possibly-persisted", {"v": 1})
    assert first.failed
    with pytest.raises(OAuthAuthorityUnavailable):
        await first.get("possibly-persisted")
    with pytest.raises(OAuthAuthorityUnavailable):
        await first.put("no-replay", {})
    assert "synthetic-sensitive" not in caplog.text
    await first.aclose()
    replacement = factory()
    await replacement.start()
    if failure != "unknown-renewal":
        assert await replacement.get("possibly-persisted") == {"v": 1}
    assert await replacement.get("no-replay") is None
    assert (await bootstrap.get_blob_properties()).lease.status == "locked"


@pytest.fixture
async def azure_browser(prepared_blob, entra, monkeypatch):
    settings, factory, _, _ = prepared_blob
    blob = factory()
    monkeypatch.setattr("agent_control_mcp.azure_storage.AzureOAuthBlobStore", lambda _: blob)
    runtime = build_service(settings, transport=httpx2.MockTransport(entra.route))
    app = runtime.app.app
    ready, finish = asyncio.Event(), asyncio.Event()

    async def run():
        async with app.router.lifespan_context(app):
            ready.set()
            await finish.wait()

    task = asyncio.create_task(run())
    await asyncio.wait_for(ready.wait(), timeout=10)
    try:
        async with httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=runtime.app),
            base_url=settings.public_origin,
            follow_redirects=False,
        ) as browser:
            yield browser, runtime, blob
    finally:
        finish.set()
        await task


async def test_real_blob_sdk_oauth_revocation_account_change_and_code_critical_section(
    azure_browser,
    entra,
):
    browser, runtime, _ = azure_browser
    client, issued = await tokens(browser)
    assert await runtime.provider.load_access_token(issued["access_token"])
    revoked = await browser.post(
        "/revoke",
        data={
            "token": issued["access_token"],
            "token_type_hint": "access_token",
            "client_id": client,
        },
    )
    assert revoked.status_code == 200
    assert await runtime.provider.load_access_token(issued["access_token"]) is None
    entra.oid = OTHER
    changed = await browser.post(
        "/token",
        data={
            "grant_type": "refresh_token",
            "refresh_token": issued["refresh_token"],
            "client_id": client,
            "resource": runtime.provider.settings.public_url,
        },
    )
    assert changed.status_code in {400, 401}
    _, data = await connect(browser)
    responses = await asyncio.gather(
        browser.post("/token", data=data), browser.post("/token", data=data)
    )
    assert sum(response.status_code == 200 for response in responses) == 1


async def test_real_blob_lost_lease_blocks_readiness_token_publication_and_api(
    azure_browser,
    entra,
):
    browser, runtime, blob = azure_browser
    _, issued = await tokens(browser)
    await blob.lease.break_lease(lease_break_period=0)
    assert await runtime.provider.load_access_token(issued["access_token"]) is None
    for path in ("/ready", "/.well-known/oauth-authorization-server", "/diagnostics"):
        response = await browser.get(
            path, headers={"Authorization": f"Bearer {issued['access_token']}"}
        )
        assert response.status_code == 503
        assert response.json()["error"] == "oauth_authority_unavailable"
        assert issued["access_token"] not in response.text
    assert (await browser.get("/health")).status_code == 200
    before = len(entra.api_calls)
    response = await browser.post(
        "/mcp",
        headers={"Authorization": f"Bearer {issued['access_token']}"},
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
    )
    assert response.status_code == 503
    assert len(entra.api_calls) == before


@pytest.mark.parametrize("endpoint", ["register", "token"])
async def test_ambiguous_last_sdk_write_cannot_publish_cached_token_success(
    azure_browser,
    monkeypatch,
    endpoint,
):
    browser, _, blob = azure_browser
    upload = blob.client.upload_blob
    data = (await connect(browser))[1] if endpoint == "token" else None

    async def ambiguous(*args, **kwargs):
        await upload(*args, **kwargs)
        raise TimeoutError("synthetic-sensitive-no-publication")

    monkeypatch.setattr(blob.client, "upload_blob", ambiguous)
    response = (
        await browser.post("/token", data=data)
        if endpoint == "token"
        else await browser.post(
            "/register",
            json={
                "client_name": "Synthetic",
                "redirect_uris": ["https://client.example.test/callback"],
                "token_endpoint_auth_method": "none",
            },
        )
    )
    assert response.status_code == 503
    assert "client_id" not in response.text and "synthetic-sensitive" not in response.text
    assert "access_token" not in response.text
    assert blob.failed
