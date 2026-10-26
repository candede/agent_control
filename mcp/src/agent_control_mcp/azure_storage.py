from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import time
from collections.abc import AsyncIterator, Mapping, Sequence
from contextlib import asynccontextmanager
from typing import Any, SupportsFloat

from azure.core import MatchConditions
from azure.identity.aio import ManagedIdentityCredential
from azure.storage.blob.aio import BlobClient, BlobLeaseClient
from cryptography.fernet import Fernet, MultiFernet

from .config import ConfigurationError, Settings
from .storage import MAX_DISK_BYTES, MAX_FILES, MAX_RECORD_BYTES, MAX_RETENTION_SECONDS

logger = logging.getLogger(__name__)
LEASE_SECONDS = 15
RENEW_SECONDS = 4
IO_SECONDS = 5
MAX_MAP_BYTES = 48 * 1024 * 1024 - 1024


class OAuthAuthorityUnavailable(ConfigurationError):
    def __init__(self) -> None:
        super().__init__("OAuth storage authority unavailable; stop and reconcile before restart.")


class AzureOAuthBlobStore:
    """One encrypted OAuth map; the exact data blob is also the server-fenced lease."""

    def __init__(self, settings: Settings, *, client: BlobClient | None = None) -> None:
        target = settings.azure_blob
        if target is None:
            raise ConfigurationError("Azure OAuth Blob requires its exact hosting profile.")
        self.binding = {
            "version": 1,
            "tenant": settings.tenant_id,
            "client": settings.client_id,
            "api": settings.api_client_id,
            "resource": settings.public_url,
            "account": target.account_url,
            "container": target.container,
            "blob": target.blob,
        }
        self.fernet = MultiFernet([Fernet(key) for key in settings.encryption_keys])
        self.credential = (
            ManagedIdentityCredential(client_id=target.identity_client_id)
            if client is None
            else None
        )
        self.client = client or BlobClient(
            target.account_url,
            target.container,
            target.blob,
            credential=self.credential,
            retry_total=0,
            retry_connect=0,
            retry_read=0,
            retry_status=0,
            connection_timeout=2,
            read_timeout=4,
            max_single_put_size=MAX_DISK_BYTES,
            max_single_get_size=MAX_DISK_BYTES,
            max_chunk_get_size=MAX_DISK_BYTES,
            logging_enable=False,
        )
        self.lease: BlobLeaseClient | None = None
        self.deadline = 0.0
        self.failed = False
        self.lock = asyncio.Lock()
        self.renewal: asyncio.Task[None] | None = None
        self.initializing = True

    def _halt(self) -> None:
        if not self.failed:
            logger.error("OAuth Blob authority lost or storage outcome unknown; issuance stopped.")
        self.failed = True

    def _current(self) -> BlobLeaseClient:
        if self.failed or self.lease is None or time.monotonic() >= self.deadline:
            self._halt()
            raise OAuthAuthorityUnavailable()
        return self.lease

    async def _renew(self) -> None:
        lease = self._current()
        started = time.monotonic()
        async with asyncio.timeout(IO_SECONDS):
            await lease.renew(timeout=4)
        # Measure from request start, never response receipt: network delay cannot extend authority.
        self.deadline = started + LEASE_SECONDS - IO_SECONDS
        self._current()

    @asynccontextmanager
    async def _operation(self) -> AsyncIterator[None]:
        try:
            async with asyncio.timeout(10), self.lock:
                await self._renew()
                yield
                self._current()
        except BaseException as error:
            self._halt()
            if isinstance(error, asyncio.CancelledError):
                raise
            raise OAuthAuthorityUnavailable() from None

    async def start(self) -> None:
        if self.lease is not None or self.failed:
            raise OAuthAuthorityUnavailable()
        try:
            started = time.monotonic()
            async with asyncio.timeout(IO_SECONDS):
                self.lease = await self.client.acquire_lease(
                    lease_duration=LEASE_SECONDS, timeout=4
                )
            self.deadline = started + LEASE_SECONDS - IO_SECONDS
            # The prepared object must already exist. No unleased create, overwrite or fallback.
            async with self._operation():
                records, etag, _ = await self._read()
                await self._write(records, etag)
            self.initializing = False
            self.renewal = asyncio.create_task(self._renew_until_closed())
        except BaseException as error:
            self._halt()
            await self.aclose()
            if isinstance(error, asyncio.CancelledError):
                raise
            raise OAuthAuthorityUnavailable() from None

    async def _renew_until_closed(self) -> None:
        try:
            while True:
                await asyncio.sleep(RENEW_SECONDS)
                await self.assert_authority()
        except asyncio.CancelledError:
            raise
        except OAuthAuthorityUnavailable:
            # Terminal, not a retry/reacquisition loop. Readiness and every request fail closed.
            return

    async def assert_authority(self) -> None:
        async with self._operation():
            pass

    async def aclose(self) -> None:
        self.failed = True
        if self.renewal is not None:
            self.renewal.cancel()
            await asyncio.gather(self.renewal, return_exceptions=True)
            self.renewal = None
        try:
            if self.lease is not None:
                async with asyncio.timeout(IO_SECONDS):
                    await self.lease.release(timeout=4)
        except Exception:
            logger.error("OAuth Blob lease release unconfirmed; wait for finite lease expiry.")
        finally:
            self.lease = None
            await self.client.close()
            if self.credential is not None:
                await self.credential.close()

    @staticmethod
    def _key(key: str, collection: str | None) -> str:
        if len(key) > 32768 or collection is not None and len(collection) > 256:
            raise ConfigurationError("OAuth state lookup exceeds its bound.")
        return hashlib.sha256(json.dumps([collection, key]).encode()).hexdigest()

    async def _read(self) -> tuple[dict[str, Any], str, int]:
        async with asyncio.timeout(IO_SECONDS):
            download = await self.client.download_blob(lease=self._current(), timeout=4)
            if download.size > MAX_DISK_BYTES:
                raise ConfigurationError("OAuth Blob capacity exceeded.")
            content = await download.readall()
        if not content and self.initializing:
            return {}, str(download.properties.etag), 0
        plaintext = self.fernet.decrypt(content)
        if len(plaintext) > MAX_MAP_BYTES:
            raise ConfigurationError("OAuth map capacity exceeded.")
        value = json.loads(plaintext)
        if (
            not isinstance(value, dict)
            or set(value) != {"binding", "records"}
            or value["binding"] != self.binding
            or not isinstance(value["records"], dict)
            or len(value["records"]) > MAX_FILES
        ):
            raise ConfigurationError("OAuth Blob binding or format mismatch; reconnect required.")
        records = value["records"]
        now = time.time()
        for key, entry in records.items():
            if (
                len(key) != 64
                or any(char not in "0123456789abcdef" for char in key)
                or not isinstance(entry, dict)
                or set(entry) != {"value", "expires"}
                or not isinstance(entry["value"], dict)
                or type(entry["expires"]) not in (int, float)
                or not math.isfinite(entry["expires"])
                or entry["expires"] > now + MAX_RETENTION_SECONDS
                or len(json.dumps(entry["value"], allow_nan=False).encode()) > MAX_RECORD_BYTES
            ):
                raise ConfigurationError("OAuth Blob record is incompatible.")
        return (
            {key: entry for key, entry in records.items() if entry["expires"] > now},
            str(download.properties.etag),
            download.size,
        )

    async def _write(self, records: dict[str, Any], etag: str) -> None:
        if len(records) > MAX_FILES:
            raise ConfigurationError("OAuth state record capacity exceeded.")
        plaintext = json.dumps(
            {"binding": self.binding, "records": records}, allow_nan=False, separators=(",", ":")
        ).encode()
        if len(plaintext) > MAX_MAP_BYTES:
            raise ConfigurationError("OAuth map capacity exceeded.")
        content = self.fernet.encrypt(plaintext)
        if len(content) > MAX_DISK_BYTES:
            raise ConfigurationError("OAuth Blob capacity exceeded.")
        async with asyncio.timeout(IO_SECONDS):
            await self.client.upload_blob(
                content,
                overwrite=True,
                lease=self._current(),
                etag=etag,
                match_condition=MatchConditions.IfNotModified,
                max_concurrency=1,
                timeout=4,
            )

    async def get(self, key: str, *, collection: str | None = None) -> dict[str, Any] | None:
        return (await self.ttl(key, collection=collection))[0]

    async def ttl(
        self, key: str, *, collection: str | None = None
    ) -> tuple[dict[str, Any] | None, float | None]:
        lookup = self._key(key, collection)
        async with self._operation():
            records, _, _ = await self._read()
            entry = records.get(lookup)
            return (
                (entry["value"], max(0, entry["expires"] - time.time())) if entry else (None, None)
            )

    async def get_many(
        self, keys: Sequence[str], *, collection: str | None = None
    ) -> list[dict[str, Any] | None]:
        return [value for value, _ in await self.ttl_many(keys, collection=collection)]

    async def ttl_many(
        self, keys: Sequence[str], *, collection: str | None = None
    ) -> list[tuple[dict[str, Any] | None, float | None]]:
        if len(keys) > MAX_FILES:
            raise ConfigurationError("OAuth state batch exceeds its bound.")
        lookups = [self._key(key, collection) for key in keys]
        async with self._operation():
            records, _, _ = await self._read()
            return [
                (records[key]["value"], max(0, records[key]["expires"] - time.time()))
                if key in records
                else (None, None)
                for key in lookups
            ]

    async def put(
        self,
        key: str,
        value: Mapping[str, Any],
        *,
        collection: str | None = None,
        ttl: SupportsFloat | None = None,
    ) -> None:
        await self.put_many([key], [value], collection=collection, ttl=ttl)

    async def put_many(
        self,
        keys: Sequence[str],
        values: Sequence[Mapping[str, Any]],
        *,
        collection: str | None = None,
        ttl: SupportsFloat | None = None,
    ) -> None:
        if len(keys) != len(values) or len(keys) > MAX_FILES:
            raise ConfigurationError("OAuth state batch exceeds its bound.")
        seconds = MAX_RETENTION_SECONDS if ttl is None else float(ttl)
        if not math.isfinite(seconds) or seconds <= 0:
            raise ConfigurationError("OAuth state requires finite positive retention.")
        additions = {}
        for key, value in zip(keys, values, strict=True):
            if len(json.dumps(dict(value), allow_nan=False).encode()) > MAX_RECORD_BYTES:
                raise ConfigurationError("OAuth state record exceeds its bound.")
            additions[self._key(key, collection)] = {
                "value": dict(value),
                "expires": time.time() + min(seconds, MAX_RETENTION_SECONDS),
            }
        async with self._operation():
            records, etag, _ = await self._read()
            records.update(additions)
            await self._write(records, etag)

    async def delete(self, key: str, *, collection: str | None = None) -> bool:
        return bool(await self.delete_many([key], collection=collection))

    async def delete_many(self, keys: Sequence[str], *, collection: str | None = None) -> int:
        if len(keys) > MAX_FILES:
            raise ConfigurationError("OAuth state batch exceeds its bound.")
        lookups = [self._key(key, collection) for key in keys]
        async with self._operation():
            records, etag, _ = await self._read()
            count = sum(records.pop(key, None) is not None for key in lookups)
            await self._write(records, etag)
            return count

    async def cull(self) -> None:
        async with self._operation():
            records, etag, _ = await self._read()
            await self._write(records, etag)

    async def usage(self) -> tuple[int, int]:
        async with self._operation():
            records, _, size = await self._read()
            return len(records), size
