from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import stat
from collections.abc import Mapping, Sequence
from itertools import chain
from pathlib import Path
from typing import TYPE_CHECKING, Any, SupportsFloat

from cryptography.fernet import Fernet, MultiFernet
from key_value.aio.protocols import AsyncKeyValue
from key_value.aio.stores.filetree import FileTreeStore, FileTreeV1KeySanitizationStrategy
from key_value.aio.wrappers.base import BaseWrapper
from key_value.aio.wrappers.encryption import FernetEncryptionWrapper

from .config import ConfigurationError, Settings

if TYPE_CHECKING:
    from .azure_storage import AzureOAuthBlobStore

MAX_FILES = 4096
MAX_DISK_BYTES = 64 * 1024 * 1024
MAX_RETENTION_SECONDS = 86400
MAX_RECORD_BYTES = 262144


class PrivateLookupKeys(FileTreeV1KeySanitizationStrategy):
    """OAuth codes can be lookup keys; never expose them in filenames."""

    def sanitize(self, value: str) -> str:
        return super().sanitize(hashlib.sha256(value.encode("utf-8")).hexdigest())


def inspect_storage(root: Path) -> tuple[int, int]:
    if root.is_symlink():
        raise ConfigurationError("OAuth storage cannot be a symbolic link.")
    count, size = 0, 0
    for path in chain((root,), root.rglob("*")):
        info = path.lstat()
        if (
            info.st_uid != os.getuid()
            or info.st_mode & 0o077
            or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode))
        ):
            raise ConfigurationError("OAuth storage must be owned and access-restricted.")
        if stat.S_ISREG(info.st_mode):
            count += 1
            size += info.st_size
            if count >= MAX_FILES or size >= MAX_DISK_BYTES:
                raise ConfigurationError("OAuth storage capacity exceeded; prune expired state.")
    return count, size


class EncryptedEnvelopeStore(BaseWrapper):
    """Reject the SDK wrapper's permissive plaintext-read fallback."""

    def __init__(self, store: AsyncKeyValue) -> None:
        self.key_value = store

    @staticmethod
    def checked(value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value is not None and (
            set(value) != {"__encrypted_data__", "__encryption_version__"}
            or value["__encryption_version__"] != 1
            or not isinstance(value["__encrypted_data__"], str)
        ):
            raise ConfigurationError("Unencrypted or incompatible OAuth state; reconnect required.")
        return value

    async def get(self, key: str, *, collection: str | None = None) -> dict[str, Any] | None:
        return self.checked(await self.key_value.get(key, collection=collection))

    async def get_many(
        self, keys: Sequence[str], *, collection: str | None = None
    ) -> list[dict[str, Any] | None]:
        return [
            self.checked(value)
            for value in await self.key_value.get_many(keys, collection=collection)
        ]

    async def ttl(
        self, key: str, *, collection: str | None = None
    ) -> tuple[dict[str, Any] | None, float | None]:
        value, ttl = await self.key_value.ttl(key, collection=collection)
        return self.checked(value), ttl

    async def ttl_many(
        self, keys: Sequence[str], *, collection: str | None = None
    ) -> list[tuple[dict[str, Any] | None, float | None]]:
        return [
            (self.checked(value), ttl)
            for value, ttl in await self.key_value.ttl_many(keys, collection=collection)
        ]


class OAuthStore(BaseWrapper):
    def __init__(self, settings: Settings) -> None:
        self.binding = {
            "version": 1,
            "tenant": settings.tenant_id,
            "client": settings.client_id,
            "api": settings.api_client_id,
            "resource": settings.public_url,
        }
        self.root = settings.storage_path
        self.blob: AzureOAuthBlobStore | None = None
        if settings.azure_blob is not None:
            from .azure_storage import AzureOAuthBlobStore

            self.blob = AzureOAuthBlobStore(settings)
            self.key_value = self.blob
            self.lock = asyncio.Lock()
            return
        os.umask(0o077)
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        inspect_storage(self.root)
        self.files = FileTreeStore(
            data_directory=self.root,
            key_sanitization_strategy=PrivateLookupKeys(self.root),
        )
        self.key_value = FernetEncryptionWrapper(
            EncryptedEnvelopeStore(self.files),
            fernet=MultiFernet([Fernet(key) for key in settings.encryption_keys]),
            raise_on_decryption_error=True,
        )
        self.lock = asyncio.Lock()

    async def put(
        self,
        key: str,
        value: Mapping[str, Any],
        *,
        collection: str | None = None,
        ttl: SupportsFloat | None = None,
    ) -> None:
        seconds = MAX_RETENTION_SECONDS if ttl is None else float(ttl)
        if not math.isfinite(seconds) or seconds <= 0:
            raise ConfigurationError("OAuth state requires finite positive retention.")
        record_bytes = len(json.dumps(dict(value), allow_nan=False).encode("utf-8"))
        if record_bytes > MAX_RECORD_BYTES:
            raise ConfigurationError("OAuth state record exceeds its bounded storage limit.")
        async with self.lock:
            if self.blob is None:
                count, size = await asyncio.to_thread(inspect_storage, self.root)
                if count + 2 >= MAX_FILES or size + record_bytes * 2 + 4096 >= MAX_DISK_BYTES:
                    raise ConfigurationError(
                        "OAuth storage capacity exceeded; prune expired state."
                    )
            await self.key_value.put(
                key, value, collection=collection, ttl=min(seconds, MAX_RETENTION_SECONDS)
            )

    async def put_many(
        self,
        keys: Sequence[str],
        values: Sequence[Mapping[str, Any]],
        *,
        collection: str | None = None,
        ttl: SupportsFloat | None = None,
    ) -> None:
        if len(keys) != len(values):
            raise ValueError("Mismatched OAuth state batch.")
        for key, value in zip(keys, values, strict=True):
            await self.put(key, value, collection=collection, ttl=ttl)

    async def check(self) -> None:
        if self.blob is not None:
            await self.blob.cull()
            return
        await asyncio.to_thread(inspect_storage, self.root)
        await self.files.cull()
        binding = await self.get("binding", collection="service")
        if binding is not None and binding != self.binding:
            raise ConfigurationError("OAuth state belongs to another resource; reconnect required.")
        await self.put("binding", self.binding, collection="service", ttl=86400)
        await self.put("probe", {"version": 1}, collection="health", ttl=30)
        if await self.get("probe", collection="health") != {"version": 1}:
            raise ConfigurationError("OAuth persistence verification failed.")
        await self.delete("probe", collection="health")

    async def start(self) -> None:
        if self.blob is not None:
            await self.blob.start()
        await self.check()

    async def assert_authority(self) -> None:
        if self.blob is not None:
            await self.blob.assert_authority()

    async def aclose(self) -> None:
        if self.blob is not None:
            await self.blob.aclose()

    async def usage(self) -> tuple[int, int]:
        if self.blob is not None:
            return await self.blob.usage()
        return await asyncio.to_thread(inspect_storage, self.root)
