"""Restricted, on-demand MCP session recording and Docker admin controls."""

from __future__ import annotations

import argparse
import asyncio
import copy
import fcntl
import hashlib
import hmac
import json
import logging
import os
import re
import stat
import sys
import tarfile
import time
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, BinaryIO
from uuid import uuid4

from mcp.server.auth.middleware.bearer_auth import AuthenticatedUser
from pydantic import JsonValue
from starlette.types import ASGIApp, Message, Receive, Scope, Send

logger = logging.getLogger(__name__)
MIB = 1024 * 1024
MAX_EVENT = 8 * MIB
MAX_QUEUED = 16 * MIB
MAX_FILES = 4096
DRAIN_SECONDS = 65
METADATA_RESERVE = MIB
IDENTIFIER = re.compile(r"^[a-f0-9]{32}$")
SECRET_FIELDS = {
    "access_token",
    "refresh_token",
    "id_token",
    "client_secret",
    "password",
    "secret",
    "authorization",
    "cookie",
    "set-cookie",
    "api_key",
    "apikey",
    "assertion",
    "credential",
    "credentials",
    "signing_key",
    "encryption_key",
}
SECRET_FIELDS = {name.replace("_", "").replace("-", "") for name in SECRET_FIELDS}
OWNED_FILE = re.compile(r"^(manifest\.json|catalog\.json|[a-f0-9]{64}\.jsonl)$")
SSE_BOUNDARY = re.compile(rb"(?:\r\n|\r(?!\n)|(?<!\r)\n){2}")


class RecordingError(ValueError):
    pass


def utc() -> str:
    return datetime.now(UTC).isoformat()


def sanitize(value: JsonValue, secrets: tuple[str, ...]) -> JsonValue:
    if isinstance(value, dict):
        return {
            key: "[redacted]"
            if key.lower().replace("_", "").replace("-", "") in SECRET_FIELDS
            else sanitize(item, secrets)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [sanitize(item, secrets) for item in value]
    if isinstance(value, str):
        for secret in secrets:
            if secret:
                value = value.replace(secret, "[redacted]")
        if value.startswith(("{", "[")):
            try:
                nested: JsonValue = json.loads(value)
            except ValueError, RecursionError:
                pass
            else:
                cleaned = sanitize(nested, secrets)
                if cleaned != nested:
                    value = json.dumps(cleaned, ensure_ascii=True, separators=(",", ":"))
        return re.sub(
            r"(?i)Bearer\s+[A-Za-z0-9_.~+/-]+=*|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
            "[redacted]",
            re.sub(
                r"(?i)\b(access_token|refresh_token|client_secret|password|api_key)\b"
                r'(["\']?\s*[=:]\s*["\']?)[^\s"\'&,}]+',
                r"\1\2[redacted]",
                value,
            ),
        )
    return value


def payload(raw: bytes, secrets: tuple[str, ...]) -> JsonValue:
    if not raw:
        return None
    try:
        value: JsonValue = json.loads(raw)
    except ValueError, UnicodeError, RecursionError:
        value = {"invalid_json": raw.decode("utf-8", errors="replace")}
    return sanitize(value, secrets)


def encoded(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=True, separators=(",", ":"), allow_nan=False) + "\n"
    ).encode()


def private_directory(path: Path) -> None:
    info = path.lstat()
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid != os.getuid()
        or stat.S_IMODE(info.st_mode) != 0o700
        or path.resolve() != path
    ):
        raise RecordingError("Recording directory must be an owned, non-linked 0700 directory.")


def private_file(path: Path, flags: int) -> int:
    fd = os.open(path, flags | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    info = os.fstat(fd)
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != os.getuid()
        or stat.S_IMODE(info.st_mode) != 0o600
        or info.st_nlink != 1
    ):
        os.close(fd)
        raise RecordingError("Recording file ownership/type/permissions differ.")
    return fd


class RecordingStore:
    def __init__(self, root: Path) -> None:
        if not root.is_absolute() or ".." in root.parts:
            raise RecordingError("Recording storage needs an exact absolute path.")
        self.root = root

    @contextmanager
    def lock(self) -> Iterator[None]:
        private_directory(self.root)
        fd = private_file(self.root / ".lock", os.O_RDWR | os.O_CREAT)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    def read(self, path: Path) -> dict[str, Any]:
        fd = private_file(path, os.O_RDONLY)
        with os.fdopen(fd, "rb") as stream:
            raw = stream.read(MAX_EVENT + 1)
        if len(raw) > MAX_EVENT:
            raise RecordingError("Recording metadata exceeds its bound.")
        try:
            value = json.loads(raw)
        except ValueError, UnicodeError, RecursionError:
            raise RecordingError("Recording metadata is invalid.") from None
        if not isinstance(value, dict):
            raise RecordingError("Recording metadata must be an object.")
        if path.name == "control.json" and (
            not isinstance(value.get("id"), str)
            or not IDENTIFIER.fullmatch(value["id"])
            or not isinstance(value.get("enabled"), bool)
        ):
            raise RecordingError("Recording control fields are invalid.")
        if path.name == "manifest.json" and (
            value.get("id") != path.parent.name
            or value.get("status") not in {"armed", "active", "stopping", "stopped", "incomplete"}
            or not isinstance(value.get("complete"), bool)
            or not isinstance(value.get("streams"), dict)
            or any(
                not isinstance(value.get(key), int | float) or isinstance(value.get(key), bool)
                for key in (
                    "deadline",
                    "expiresAt",
                    "sessionLimit",
                    "totalLimit",
                    "capturedBytes",
                    "events",
                    "retentionSeconds",
                )
            )
            or "reason" not in value
        ):
            raise RecordingError("Recording manifest fields are invalid.")
        return value

    def write(self, path: Path, value: object) -> None:
        if path.exists() or path.is_symlink():
            existing = private_file(path, os.O_RDONLY)
            os.close(existing)
        temporary = path.with_name("." + uuid4().hex)
        fd = private_file(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(encoded(value))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def directory(self, recording_id: str) -> Path:
        if not IDENTIFIER.fullmatch(recording_id):
            raise RecordingError("Expected an exact recording ID.")
        path = self.root / recording_id
        private_directory(path)
        return path

    def control(self) -> dict[str, Any] | None:
        path = self.root / "control.json"
        if path.is_symlink():
            raise RecordingError("Recording control cannot be linked.")
        return self.read(path) if path.exists() else None

    def cleanup(self) -> int:
        size = 0
        files = 0
        for directory in self.root.iterdir():
            if not IDENTIFIER.fullmatch(directory.name):
                continue
            private_directory(directory)
            manifest = self.read(directory / "manifest.json")
            for path in directory.iterdir():
                if not OWNED_FILE.fullmatch(path.name):
                    raise RecordingError("Unexpected file in recording storage.")
            if manifest["expiresAt"] <= time.time() and manifest["status"] in {
                "stopped",
                "incomplete",
            }:
                for path in directory.iterdir():
                    fd = private_file(path, os.O_RDONLY)
                    os.close(fd)
                    path.unlink()
                directory.rmdir()
                control = self.control()
                if control and control["id"] == directory.name:
                    (self.root / "control.json").unlink()
                continue
            for path in directory.iterdir():
                fd = private_file(path, os.O_RDONLY)
                info = os.fstat(fd)
                os.close(fd)
                size += info.st_size
                files += 1
                if files > MAX_FILES:
                    raise RecordingError("Recording file inventory exceeds its bound.")
        return size

    def start(
        self, duration: int, retention: int, session_limit: int, total_limit: int
    ) -> dict[str, Any]:
        if not 1 <= duration <= 86400 or not 1 <= retention <= 168 * 3600:
            raise RecordingError("Duration must be 1-86400 seconds; retention 1-604800 seconds.")
        if not 1 <= session_limit <= total_limit <= 4096 * MIB or total_limit <= METADATA_RESERVE:
            raise RecordingError(
                "Recording size limits must be positive and at most 4096 MiB total."
            )
        with self.lock():
            control = self.control()
            if control:
                old = self.read(self.directory(control["id"]) / "manifest.json")
                if old["status"] in {"armed", "active", "stopping"}:
                    raise RecordingError("A recording is already armed or active; stop it first.")
            if self.cleanup() >= total_limit:
                raise RecordingError(
                    "Retained recordings fill the size budget; wait for retention expiry."
                )
            identifier = uuid4().hex
            directory = self.root / identifier
            directory.mkdir(mode=0o700)
            now = time.time()
            manifest = {
                "version": 1,
                "id": identifier,
                "status": "armed",
                "complete": True,
                "startedAt": utc(),
                "deadline": now + duration,
                "expiresAt": now + duration + retention,
                "retentionSeconds": retention,
                "sessionLimit": session_limit,
                "totalLimit": total_limit,
                "grouping": "authenticated-mcp-session",
                "streams": {},
                "events": 0,
                "capturedBytes": 0,
                "reason": None,
            }
            self.write(directory / "manifest.json", manifest)
            self.write(self.root / "control.json", {"id": identifier, "enabled": True})
            return manifest

    def status(self) -> dict[str, Any]:
        with self.lock():
            control = self.control()
            if not control:
                return {"status": "off"}
            return self.read(self.directory(control["id"]) / "manifest.json")

    def stop(self) -> dict[str, Any]:
        with self.lock():
            control = self.control()
            if not control:
                return {"status": "off"}
            self.write(self.root / "control.json", {"id": control["id"], "enabled": False})
            manifest = self.read(self.directory(control["id"]) / "manifest.json")
            if manifest["status"] == "armed":
                manifest.update(
                    status="stopped",
                    stoppedAt=utc(),
                    reason="operator_stop",
                    expiresAt=time.time() + manifest["retentionSeconds"],
                )
                self.write(self.directory(control["id"]) / "manifest.json", manifest)
            return manifest

    def export(self, identifier: str | None, output: BinaryIO) -> None:
        with self.lock():
            control = self.control()
            identifier = identifier or (control["id"] if control else None)
            if not identifier:
                raise RecordingError("There is no recording to export.")
            directory = self.directory(identifier)
            manifest = self.read(directory / "manifest.json")
            if manifest["status"] in {"armed", "active", "stopping"}:
                raise RecordingError("Stop recording and wait for finalized status before export.")
            with tarfile.open(fileobj=output, mode="w|gz") as archive:
                for path in sorted(directory.iterdir()):
                    if not OWNED_FILE.fullmatch(path.name):
                        raise RecordingError("Unexpected file in recording storage.")
                    fd = private_file(path, os.O_RDONLY)
                    with os.fdopen(fd, "rb") as stream:
                        item = tarfile.TarInfo(identifier + "/" + path.name)
                        item.size = os.fstat(stream.fileno()).st_size
                        item.mode = 0o600
                        archive.addfile(item, stream)


@dataclass
class Window:
    manifest: dict[str, Any]
    salt: bytes = field(default_factory=lambda: os.urandom(32))
    accepting: bool = True
    pending: int = 0
    sequence: int = 0
    queued: int = 0
    file_bytes: dict[str, int] = field(default_factory=dict)
    drain_until: float | None = None
    finalized: bool = False


@dataclass
class Capture:
    window: Window
    stream: str
    exchange: str
    started: float
    secrets: tuple[str, ...]


class Recorder:
    def __init__(
        self,
        root: Path | None,
        secrets: tuple[str, ...],
        snapshot: Callable[[], Awaitable[dict[str, Any]]],
    ) -> None:
        self.store = RecordingStore(root) if root else None
        self.secrets = secrets
        self.snapshot = snapshot
        self.window: Window | None = None
        self.queue: asyncio.Queue[tuple[Window, str, bytes]] = asyncio.Queue(maxsize=128)
        self.task: asyncio.Task[None] | None = None
        self.closed = False
        self.failure: str | None = None

    async def start(self) -> None:
        if self.store:
            self.task = asyncio.create_task(self.run())

    def fail(self, window: Window, reason: str) -> None:
        window.accepting = False
        window.manifest.update(complete=False, reason=reason)
        logger.error("MCP recording stopped: %s. Normal MCP execution is unchanged.", reason)

    def emit(self, window: Window, stream: str, event: dict[str, JsonValue]) -> None:
        if window.finalized or not window.manifest["complete"]:
            return
        window.sequence += 1
        event.update(sequence=window.sequence, time=utc())
        try:
            raw = encoded(event)
        except ValueError, RecursionError:
            self.fail(window, "event_encoding_failed")
            return
        if len(raw) > MAX_EVENT or window.queued + len(raw) > MAX_QUEUED or self.queue.full():
            self.fail(window, "event_or_queue_limit")
            return
        window.queued += len(raw)
        self.queue.put_nowait((window, stream, raw))

    def begin(
        self,
        scope: Scope,
        session: str,
        raw: bytes,
        started: float,
        received: str | None = None,
    ) -> Capture | None:
        window = self.window
        user = scope.get("user")
        if not window or not window.accepting or not isinstance(user, AuthenticatedUser):
            return None
        if time.time() >= window.manifest["deadline"]:
            window.accepting = False
            return None
        token = user.access_token
        oid = token.claims.get("oid") if isinstance(token.claims, dict) else None
        owner = json.dumps([token.client_id, oid, session]).encode()
        stream = hmac.new(window.salt, owner, hashlib.sha256).hexdigest()
        if stream not in window.manifest["streams"]:
            if len(window.manifest["streams"]) >= 256:
                self.fail(window, "session_inventory_limit")
                return None
            window.manifest["streams"][stream] = {
                "clientId": token.client_id,
                "userFingerprint": hmac.new(
                    window.salt, str(oid).encode(), hashlib.sha256
                ).hexdigest(),
            }
        secrets = list(self.secrets)
        for key, value in scope.get("headers", []):
            if key.lower() == b"authorization":
                secrets.append(value.decode("latin-1").removeprefix("Bearer "))
        capture = Capture(window, stream, uuid4().hex, started, tuple(secrets))
        window.pending += 1
        try:
            document = payload(raw, capture.secrets)
        except ValueError, RecursionError:
            window.pending -= 1
            self.fail(window, "request_encoding_failed")
            return None
        conversation = None
        if isinstance(document, dict):
            params = document.get("params")
            meta = params.get("_meta") if isinstance(params, dict) else None
            supplied = meta.get("com.agentcontrol/recording") if isinstance(meta, dict) else None
            identifier = supplied.get("conversationId") if isinstance(supplied, dict) else None
            if (
                isinstance(identifier, str)
                and 1 <= len(identifier) <= 256
                and identifier.isprintable()
            ):
                conversation = identifier
        self.emit(
            window,
            stream,
            {
                "event": "request",
                "receivedAt": received or utc(),
                "exchangeId": capture.exchange,
                "httpMethod": scope["method"],
                "payload": document,
                "reportedConversationId": conversation,
            },
        )
        return capture

    def finish(self, capture: Capture, status: int, raw: bytes, interrupted: bool) -> None:
        try:
            self.emit(
                capture.window,
                capture.stream,
                {
                    "event": "response",
                    "exchangeId": capture.exchange,
                    "httpStatus": status,
                    "durationMs": round((time.monotonic() - capture.started) * 1000, 3),
                    "payload": payload(raw, capture.secrets),
                    "interrupted": interrupted,
                },
            )
            if interrupted:
                self.fail(capture.window, "interrupted_response")
        except ValueError, RecursionError:
            self.fail(capture.window, "response_encoding_failed")
        finally:
            capture.window.pending -= 1

    def persist_event(self, window: Window, stream: str, raw: bytes) -> None:
        assert self.store is not None
        with self.store.lock():
            total = window.manifest["retainedBytes"] + window.manifest["capturedBytes"]
            size = window.file_bytes.get(stream, 0)
            if (
                size + len(raw) > window.manifest["sessionLimit"]
                or total + len(raw) > window.manifest["totalLimit"]
            ):
                self.fail(window, "storage_limit")
                return
            path = self.store.directory(window.manifest["id"]) / (stream + ".jsonl")
            fd = private_file(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT)
            with os.fdopen(fd, "ab") as output:
                output.write(raw)
                output.flush()
            window.file_bytes[stream] = size + len(raw)
            window.manifest["capturedBytes"] += len(raw)
            window.manifest["events"] += 1

    def poll(self) -> dict[str, Any] | None:
        assert self.store is not None
        with self.store.lock():
            control = self.store.control()
            if not control:
                return None
            return {
                **control,
                "manifest": self.store.read(self.store.directory(control["id"]) / "manifest.json"),
            }

    def activate(self, manifest: dict[str, Any], snapshot: dict[str, Any]) -> bool:
        assert self.store is not None
        with self.store.lock():
            control = self.store.control()
            if (
                not control
                or control["id"] != manifest["id"]
                or not control["enabled"]
                or self.store.read(self.store.directory(manifest["id"]) / "manifest.json")["status"]
                != "armed"
            ):
                return False
            retained = self.store.cleanup()
            data = sanitize(snapshot, self.secrets)
            size = len(encoded(data))
            if retained + size + METADATA_RESERVE >= manifest["totalLimit"]:
                raise RecordingError("The recording snapshot fills the storage budget.")
            self.store.write(self.store.directory(manifest["id"]) / "catalog.json", data)
            manifest.update(
                status="active",
                activatedAt=utc(),
                retainedBytes=retained + size + METADATA_RESERVE,
            )
            self.store.write(self.store.directory(manifest["id"]) / "manifest.json", manifest)
            return True

    async def save(self, window: Window) -> None:
        window.manifest.update(lastUpdatedAt=utc(), pendingRequests=window.pending)
        await asyncio.to_thread(
            self.save_manifest, copy.deepcopy(window.manifest), window.finalized
        )

    def save_manifest(self, manifest: dict[str, Any], finalized: bool) -> None:
        assert self.store is not None
        with self.store.lock():
            self.store.write(self.store.directory(manifest["id"]) / "manifest.json", manifest)
            if finalized:
                control = self.store.control()
                if control and control["id"] == manifest["id"]:
                    self.store.write(
                        self.store.root / "control.json",
                        {"id": control["id"], "enabled": False},
                    )

    async def run(self) -> None:
        assert self.store is not None
        last_cleanup = 0.0
        last_retention = 0.0
        window: Window | None = None
        try:
            while not self.closed or self.window or not self.queue.empty():
                if time.monotonic() - last_retention >= 60 and not self.closed:
                    await asyncio.to_thread(self.cleanup)
                    last_retention = time.monotonic()
                if time.monotonic() - last_cleanup >= 0.25 and not self.closed:
                    control = await asyncio.to_thread(self.poll)
                    last_cleanup = time.monotonic()
                    if control and (not self.window or self.window.manifest["id"] != control["id"]):
                        manifest = control["manifest"]
                        if (
                            control["enabled"]
                            and manifest["status"] == "armed"
                            and time.time() < manifest["deadline"]
                        ):
                            snapshot = await self.snapshot()
                            window = Window(manifest, accepting=False)
                            self.window = window
                            if await asyncio.to_thread(self.activate, manifest, snapshot):
                                window.accepting = True
                                await self.save(window)
                            else:
                                self.window = None
                        elif manifest["status"] in {"active", "stopping", "armed"}:
                            manifest.update(
                                status="incomplete",
                                complete=False,
                                reason="process_restart_or_expired",
                                stoppedAt=utc(),
                                expiresAt=time.time() + manifest["retentionSeconds"],
                            )
                            await self.save(Window(manifest))
                    window = self.window
                    if window:
                        enabled = (
                            control
                            and control["id"] == window.manifest["id"]
                            and control["enabled"]
                        )
                        if not enabled or time.time() >= window.manifest["deadline"]:
                            window.accepting = False
                        if not window.accepting:
                            window.manifest["status"] = "stopping"
                window = self.window
                if window and not window.accepting and window.drain_until is None:
                    window.drain_until = time.monotonic() + DRAIN_SECONDS
                try:
                    queued_window, stream, raw = await asyncio.wait_for(
                        self.queue.get(), timeout=0.1
                    )
                except TimeoutError:
                    window = self.window
                else:
                    try:
                        await asyncio.to_thread(self.persist_event, queued_window, stream, raw)
                    finally:
                        queued_window.queued -= len(raw)
                        self.queue.task_done()
                    window = queued_window
                if window:
                    expired = (
                        window.drain_until is not None and time.monotonic() >= window.drain_until
                    )
                    if (
                        not window.accepting
                        and window.queued == 0
                        and (window.pending == 0 or expired)
                    ):
                        if window.pending:
                            self.fail(window, "inflight_at_drain_timeout")
                        window.manifest.update(
                            status="stopped" if window.manifest["complete"] else "incomplete",
                            stoppedAt=utc(),
                            reason=window.manifest["reason"] or "operator_stop_or_deadline",
                            expiresAt=time.time() + window.manifest["retentionSeconds"],
                        )
                        window.finalized = True
                    await self.save(window)
                    if window.finalized:
                        self.window = None
        except (OSError, RecordingError, ValueError) as error:
            self.failure = type(error).__name__
            if self.window:
                self.fail(self.window, "recording_storage_unavailable")
                self.window.manifest.update(status="incomplete", stoppedAt=utc())
                self.window.finalized = True
                try:
                    await self.save(self.window)
                except OSError, RecordingError:
                    logger.error("MCP recording status could not be persisted.")
            logger.error("MCP recorder unavailable (%s); normal execution continues.", self.failure)
            while not self.queue.empty():
                self.queue.get_nowait()
                self.queue.task_done()

    def cleanup(self) -> None:
        assert self.store is not None
        with self.store.lock():
            self.store.cleanup()

    async def close(self) -> None:
        self.closed = True
        if self.window:
            self.window.accepting = False
        if self.task:
            await self.task


class RecordingMiddleware:
    def __init__(self, app: ASGIApp, recorder: Recorder, path: str) -> None:
        self.app = app
        self.recorder = recorder
        self.path = path

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or scope["path"] != self.path
            or not self.recorder.window
            or not self.recorder.window.accepting
        ):
            await self.app(scope, receive, send)
            return
        request = bytearray()
        response = bytearray()
        capture = None
        status = 0
        interrupted = True
        headers = dict(scope.get("headers", []))
        session = headers.get(b"mcp-session-id", b"").decode("latin-1")
        started = time.monotonic()
        received = utc()
        sse = False

        async def read() -> Message:
            nonlocal capture
            message = await receive()
            if message["type"] == "http.request":
                request.extend(message.get("body", b""))
                if not message.get("more_body", False) and session and capture is None:
                    capture = self.recorder.begin(scope, session, bytes(request), started, received)
            return message

        async def write(message: Message) -> None:
            nonlocal capture, status, interrupted, sse
            if message["type"] == "http.response.start":
                status = message["status"]
                sse = b"text/event-stream" in dict(message.get("headers", [])).get(
                    b"content-type", b""
                )
                if capture is None:
                    returned = dict(message.get("headers", [])).get(b"mcp-session-id", b"")
                    owner = returned.decode("latin-1") or session
                    if owner:
                        capture = self.recorder.begin(
                            scope, owner, bytes(request), started, received
                        )
            if message["type"] == "http.response.body" and capture:
                chunk = message.get("body", b"")
                if len(response) + len(chunk) > MAX_EVENT:
                    self.recorder.fail(capture.window, "response_size_limit")
                elif capture.window.manifest["complete"]:
                    response.extend(chunk)
                    if sse:
                        self.sse_events(
                            capture, response, final=not message.get("more_body", False)
                        )
            await send(message)
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                interrupted = False

        try:
            await self.app(scope, read, write)
        finally:
            if capture:
                self.recorder.finish(capture, status, bytes(response), interrupted)

    def sse_events(self, capture: Capture, buffer: bytearray, *, final: bool) -> None:
        consumed = 0
        for boundary in SSE_BOUNDARY.finditer(buffer):
            # A trailing CR may be the first half of a split CRLF.
            if not final and boundary.end() == len(buffer) and buffer.endswith(b"\r"):
                break
            frame = buffer[consumed : boundary.start()]
            consumed = boundary.end()
            data = b"\n".join(
                line[5:].lstrip() for line in frame.splitlines() if line.startswith(b"data:")
            )
            if data:
                try:
                    self.recorder.emit(
                        capture.window,
                        capture.stream,
                        {
                            "event": "server_message",
                            "exchangeId": capture.exchange,
                            "payload": payload(data, capture.secrets),
                        },
                    )
                except ValueError, RecursionError:
                    self.recorder.fail(capture.window, "sse_encoding_failed")
        del buffer[:consumed]


def initialize(root: Path, uid: int, gid: int) -> None:
    if os.getuid() != 0 or uid <= 0 or gid < 0:
        raise RecordingError("Initialization needs root and a non-root target UID.")
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode):
        raise RecordingError("Recording volume must be a real directory.")
    if info.st_uid == 0 and not any(root.iterdir()):
        root.chmod(0o700)
        os.chown(root, uid, gid)
    elif info.st_uid != uid or info.st_gid != gid or stat.S_IMODE(info.st_mode) != 0o700:
        raise RecordingError("Existing recording volume ownership differs; recover it explicitly.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    start = sub.add_parser(
        "start", help="Record all authenticated MCP sessions; files contain business data."
    )
    start.add_argument("--duration", type=int, default=1800, help="Seconds; default 1800.")
    start.add_argument(
        "--retention", type=int, default=86400, help="Seconds after the window ends."
    )
    start.add_argument("--session-mib", type=int, default=100)
    start.add_argument("--total-mib", type=int, default=500)
    sub.add_parser("status")
    sub.add_parser("stop")
    export = sub.add_parser("export")
    export.add_argument("--id")
    init = sub.add_parser("initialize")
    init.add_argument("uid", type=int)
    init.add_argument("gid", type=int)
    args = parser.parse_args()
    try:
        raw = os.environ.get("MCP_RECORDING_STORAGE_PATH")
        if not raw:
            raise RecordingError("MCP_RECORDING_STORAGE_PATH is not configured.")
        store = RecordingStore(Path(raw))
        if args.command == "initialize":
            initialize(store.root, args.uid, args.gid)
            return
        if args.command == "export":
            store.export(args.id, sys.stdout.buffer)
            return
        if args.command == "start":
            result = store.start(
                args.duration, args.retention, args.session_mib * MIB, args.total_mib * MIB
            )
        elif args.command == "stop":
            result = store.stop()
        else:
            result = store.status()
        print(json.dumps(result, indent=2))
    except (RecordingError, OSError, ValueError) as error:
        message = (
            str(error)
            if isinstance(error, RecordingError)
            else "Recording storage/control is unavailable."
        )
        parser.exit(2, message + "\n")


if __name__ == "__main__":
    main()
