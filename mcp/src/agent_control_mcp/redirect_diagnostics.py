"""Extract safe client callback diagnostics from Docker log input."""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal, TextIO
from urllib.parse import urlsplit

from .config import ConfigurationError, checked_url

REGISTRATION_REJECTION_PREFIX = (
    "OAuth client registration rejected: invalid_redirect_uri; rejected_redirect_uris="
)
MAX_LINE_BYTES = 65536
MAX_INPUT_BYTES = 64 * 1024 * 1024
MAX_REDIRECTS = 4096
FIELDS = ("redirect_uri", "status", "count", "first_seen", "last_seen")
Status = Literal["not_allowed", "allowed_now", "invalid_or_redacted"]


class DiagnosticError(ValueError):
    pass


def redacted_redirect_uri(uri: str) -> str:
    if uri in {"[invalid callback URI]", "[unsupported callback scheme]"}:
        return uri
    safe = "".join(
        f"\\u{ord(character):04x}"
        if ord(character) < 32 or 127 <= ord(character) <= 159
        else character
        for character in uri
    )
    # urllib rejects bracketed redaction markers in an already-sanitized authority.
    try:
        parts = urlsplit(safe.replace("://[redacted]@", "://redacted@", 1))
    except ValueError:
        return "[invalid callback URI]"
    if parts.scheme not in {"https", "http"}:
        return "[unsupported callback scheme]"
    # Keep rejected spellings and empty delimiters; geturl() normalizes them.
    safe, fragment, _ = safe.partition("#")
    safe, query, _ = safe.partition("?")
    if "@" in parts.netloc:
        start = safe.index("://") + 3
        end = safe.find("/", start)
        if end < 0:
            end = len(safe)
        authority = safe[start:end]
        safe = safe[:start] + "[redacted]@" + authority.rsplit("@", 1)[1] + safe[end:]
    return safe + ("?[redacted]" if query else "") + ("#[redacted]" if fragment else "")


@dataclass
class RedirectDiagnostic:
    redirect_uri: str
    status: Status
    count: int = 0
    first_seen: datetime | None = None
    last_seen: datetime | None = None

    def record(self) -> dict[str, str | int | None]:
        return {
            "redirect_uri": self.redirect_uri,
            "status": self.status,
            "count": self.count,
            "first_seen": self.first_seen.isoformat() if self.first_seen else None,
            "last_seen": self.last_seen.isoformat() if self.last_seen else None,
        }


def configured_redirects(raw: str | None) -> set[str]:
    if raw is None:
        raise DiagnosticError(
            "MCP_ALLOWED_CLIENT_REDIRECT_URIS is missing; run inside the configured MCP container."
        )
    try:
        values = json.loads(raw)
        if (
            not isinstance(values, list)
            or not 1 <= len(values) <= 32
            or not all(isinstance(value, str) for value in values)
            or len(set(values)) != len(values)
        ):
            raise ValueError
        return {checked_url(value, redirect=True) for value in values}
    except ValueError, RecursionError:
        raise DiagnosticError("The configured callback allowlist is invalid.") from None


def collect_redirect_diagnostics(stream: TextIO, allowed: set[str]) -> list[RedirectDiagnostic]:
    diagnostics: dict[str, RedirectDiagnostic] = {}
    total = 0
    line_number = 0
    while line := stream.readline(MAX_LINE_BYTES + 1):
        line_number += 1
        size = len(line.encode("utf-8"))
        total += size
        if size > MAX_LINE_BYTES or total > MAX_INPUT_BYTES:
            raise DiagnosticError("Log input exceeds its bound; use a shorter docker logs --since.")
        marker = line.find(REGISTRATION_REJECTION_PREFIX)
        if marker < 0:
            continue
        try:
            values = json.loads(line[marker + len(REGISTRATION_REJECTION_PREFIX) :])
            if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
                raise ValueError
        except ValueError, RecursionError:
            raise DiagnosticError(f"Malformed callback diagnostic at line {line_number}.") from None
        timestamp = None
        prefix = line[:marker].split(maxsplit=1)
        if prefix and re.match(r"^\d{4}-\d{2}-\d{2}T", prefix[0]):
            try:
                timestamp = datetime.fromisoformat(prefix[0])
                if timestamp.tzinfo is None:
                    raise ValueError
                timestamp = timestamp.astimezone(UTC)
            except ValueError, OverflowError:
                raise DiagnosticError(f"Invalid Docker timestamp at line {line_number}.") from None
        for uri in dict.fromkeys(redacted_redirect_uri(value) for value in values):
            status: Status = "invalid_or_redacted"
            try:
                checked_url(uri, redirect=True)
                status = "allowed_now" if uri in allowed else "not_allowed"
            except ConfigurationError:
                pass
            if uri not in diagnostics:
                if len(diagnostics) >= MAX_REDIRECTS:
                    raise DiagnosticError(
                        "Too many distinct callbacks; shorten docker logs --since."
                    )
                diagnostics[uri] = RedirectDiagnostic(uri, status)
            item = diagnostics[uri]
            item.count += 1
            if timestamp is not None:
                item.first_seen = min(item.first_seen, timestamp) if item.first_seen else timestamp
                item.last_seen = max(item.last_seen, timestamp) if item.last_seen else timestamp
    return [diagnostics[uri] for uri in sorted(diagnostics)]


def write_diagnostics(items: list[RedirectDiagnostic], output: TextIO, format: str) -> None:
    records = [item.record() for item in items]
    if format == "json":
        json.dump(records, output, indent=2)
        output.write("\n")
    elif format == "csv":
        writer = csv.DictWriter(output, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(records)
    else:
        output.write("STATUS\tCOUNT\tFIRST SEEN (UTC)\tLAST SEEN (UTC)\tREDIRECT URI\n")
        for record in records:
            output.write(
                f"{record['status']}\t{record['count']}\t"
                f"{record['first_seen'] or '-'}\t{record['last_seen'] or '-'}\t"
                f"{record['redirect_uri']}\n"
            )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--format", choices=("table", "json", "csv"), default="table")
    args = parser.parse_args()
    if sys.stdin.isatty():
        parser.exit(
            2, "Pipe docker logs --timestamps into this command; do not use docker exec -t.\n"
        )
    try:
        allowed = configured_redirects(os.environ.get("MCP_ALLOWED_CLIENT_REDIRECT_URIS"))
        items = collect_redirect_diagnostics(sys.stdin, allowed)
        write_diagnostics(items, sys.stdout, args.format)
        if not items:
            print(
                "No retained callback rejections found. Check --since, container and retention.",
                file=sys.stderr,
            )
    except DiagnosticError as error:
        parser.exit(2, f"{error}\n")
    except OSError, UnicodeError:
        parser.exit(2, "Could not read or write callback diagnostics.\n")


if __name__ == "__main__":
    main()
