from __future__ import annotations

from dataclasses import dataclass

from pydantic import JsonValue


@dataclass(repr=False)
class AdapterError(Exception):
    status: int
    code: str
    message: str
    request_id: str | None = None
    retry_after_seconds: int | None = None
    details: dict[str, JsonValue] | None = None

    def __str__(self) -> str:
        return f"{self.status} {self.code}: {self.message}"

    def __repr__(self) -> str:
        return f"AdapterError(status={self.status}, code={self.code!r})"

    def as_dict(self) -> dict[str, JsonValue]:
        return {
            "status": self.status,
            "code": self.code,
            "message": self.message,
            "requestId": self.request_id,
            "retryAfterSeconds": self.retry_after_seconds,
            "details": self.details,
        }
