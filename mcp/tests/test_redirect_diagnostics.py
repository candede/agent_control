from __future__ import annotations

import csv
import io
import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

from agent_control_mcp.redirect_diagnostics import (
    REGISTRATION_REJECTION_PREFIX,
    DiagnosticError,
    collect_redirect_diagnostics,
    configured_redirects,
    redacted_redirect_uri,
    write_diagnostics,
)

ALLOWED = "https://client.example.test/callback"
REJECTED = "https://global.consent.azure-apim.net/redirect/synthetic-connector"


def event(uris: list[str], timestamp: str = "") -> str:
    prefix = f"{timestamp} " if timestamp else ""
    return (
        f"{prefix}WARNING:agent_control_mcp.auth:{REGISTRATION_REJECTION_PREFIX}"
        f"{json.dumps(uris)}\n"
    )


def test_aggregates_request_counts_current_policy_and_utc_timestamps():
    logs = (
        "2026-11-05T08:00:00Z INFO: startup\n"
        + event([REJECTED, REJECTED, ALLOWED], "2026-11-05T12:02:00.123456789+04:00")
        + event([REJECTED], "2026-11-05T08:01:00Z")
        + event([REJECTED])
    )
    rows = {
        row.redirect_uri: row for row in collect_redirect_diagnostics(io.StringIO(logs), {ALLOWED})
    }
    assert rows[REJECTED].status == "not_allowed"
    assert rows[REJECTED].count == 3
    assert rows[REJECTED].first_seen == datetime(2026, 11, 5, 8, 1, tzinfo=UTC)
    assert rows[REJECTED].last_seen == datetime(2026, 11, 5, 8, 2, 0, 123456, tzinfo=UTC)
    assert rows[ALLOWED].status == "allowed_now" and rows[ALLOWED].count == 1


async def test_real_registration_warning_is_extractable(browser, caplog):
    response = await browser.post(
        "/register",
        json={
            "client_name": "synthetic-private-client-name",
            "redirect_uris": [REJECTED],
            "token_endpoint_auth_method": "none",
        },
    )
    assert response.status_code == 400
    messages = [
        record.getMessage() for record in caplog.records if record.name == "agent_control_mcp.auth"
    ]
    assert len(messages) == 1 and REGISTRATION_REJECTION_PREFIX in messages[0]
    rows = collect_redirect_diagnostics(io.StringIO(messages[0]), {ALLOWED})
    assert len(rows) == 1 and rows[0].redirect_uri == REJECTED
    assert rows[0].status == "not_allowed" and rows[0].count == 1
    assert "synthetic-private-client-name" not in messages[0]


@pytest.mark.parametrize(
    "uris",
    [
        [f"https://client.example.test/rejected-{index}" for index in range(33)],
        ["https://client.example.test/" + "x" * 8193],
    ],
)
async def test_bounded_registration_warnings_remain_extractable(browser, caplog, uris):
    response = await browser.post(
        "/register",
        json={"redirect_uris": uris, "token_endpoint_auth_method": "none"},
    )
    assert response.status_code == 400
    messages = [
        record.getMessage() for record in caplog.records if record.name == "agent_control_mcp.auth"
    ]
    assert len(messages) == 1 and REGISTRATION_REJECTION_PREFIX in messages[0]
    rows = collect_redirect_diagnostics(io.StringIO(messages[0]), {ALLOWED})
    assert {row.redirect_uri for row in rows} == set(uris)
    assert all(row.count == 1 for row in rows)


@pytest.mark.parametrize(
    "uri",
    [
        ALLOWED.replace("https", "HTTPS", 1),
        " " + ALLOWED,
        "\x00" + ALLOWED,
        ALLOWED.replace("callback", "call\tback"),
        ALLOWED.replace("callback", "call\r\nback"),
        ALLOWED + "\t",
        ALLOWED + "\x85",
        ALLOWED + "?",
        ALLOWED + "#",
        ALLOWED + "?#",
    ],
)
def test_sanitization_does_not_turn_invalid_spelling_into_an_allowed_callback(uri):
    logged = redacted_redirect_uri(uri)
    assert redacted_redirect_uri(logged) == logged
    rows = collect_redirect_diagnostics(io.StringIO(event([uri]) + event([logged])), {ALLOWED})
    assert len(rows) == 1 and rows[0].count == 2
    assert rows[0].redirect_uri == logged
    assert rows[0].status == "invalid_or_redacted"


@pytest.mark.parametrize(
    "uri",
    [
        "https://synthetic-user:synthetic-password@studio.example.test/callback"
        "?token=synthetic-token#synthetic-fragment",
        "data:synthetic-token",
        "https://[",
        "https://studio.example.test/callback\x1b[31m",
        "HTTPS://synthetic-user:synthetic-password@studio.example.test/callback"
        "?token=synthetic-token#synthetic-fragment",
        " https://synthetic-user:synthetic-password@studio.example.test/callback"
        "?token=synthetic-token#synthetic-fragment",
    ],
)
def test_untrusted_input_is_redacted_and_flagged_in_every_output_format(uri):
    logged = redacted_redirect_uri(uri)
    assert redacted_redirect_uri(logged) == logged
    rows = collect_redirect_diagnostics(io.StringIO(event([uri]) + event([logged])), set())
    assert len(rows) == 1 and rows[0].status == "invalid_or_redacted"
    assert rows[0].redirect_uri == logged and rows[0].count == 2
    for format in ("table", "json", "csv"):
        output = io.StringIO()
        write_diagnostics(rows, output, format)
        assert "\x1b" not in output.getvalue()
        for secret in (
            "synthetic-user",
            "synthetic-password",
            "synthetic-token",
            "synthetic-fragment",
        ):
            assert secret not in output.getvalue()


@pytest.mark.parametrize(
    "value", [None, "bad", "{}", "[]", '["bad"]', "[1]", json.dumps([ALLOWED] * 2)]
)
def test_invalid_runtime_policy_is_an_explicit_error(value):
    with pytest.raises(DiagnosticError, match="allowlist|missing"):
        configured_redirects(value)


def test_policy_reuses_exact_canonical_callback_validation():
    assert configured_redirects(json.dumps([ALLOWED, "http://127.0.0.1:33418/"])) == {
        ALLOWED,
        "http://127.0.0.1:33418/",
    }
    assert redacted_redirect_uri(REJECTED) == REJECTED


@pytest.mark.parametrize("payload", ["bad", "{}", "[1]", '[["nested"]]', '["unterminated'])
def test_matching_malformed_records_fail_without_echoing_log_contents(payload):
    with pytest.raises(DiagnosticError, match="Malformed callback diagnostic at line 1"):
        collect_redirect_diagnostics(io.StringIO(REGISTRATION_REJECTION_PREFIX + payload), set())


def test_invalid_docker_timestamp_is_an_explicit_error():
    with pytest.raises(DiagnosticError, match="Invalid Docker timestamp"):
        collect_redirect_diagnostics(io.StringIO(event([REJECTED], "2026-13-05T08:00:00Z")), set())


@pytest.mark.parametrize("timestamp", ["0001-01-01T00:00:00+01:00", "9999-12-31T23:59:59-01:00"])
def test_unrepresentable_utc_timestamp_is_an_explicit_error(timestamp):
    with pytest.raises(DiagnosticError, match="Invalid Docker timestamp"):
        collect_redirect_diagnostics(io.StringIO(event([REJECTED], timestamp)), set())


def test_input_and_unique_callback_bounds_are_explicit(monkeypatch):
    monkeypatch.setattr("agent_control_mcp.redirect_diagnostics.MAX_LINE_BYTES", 16)
    with pytest.raises(DiagnosticError, match="input exceeds"):
        collect_redirect_diagnostics(io.StringIO("x" * 17), set())
    monkeypatch.setattr("agent_control_mcp.redirect_diagnostics.MAX_LINE_BYTES", 65536)
    monkeypatch.setattr("agent_control_mcp.redirect_diagnostics.MAX_INPUT_BYTES", 1)
    with pytest.raises(DiagnosticError, match="input exceeds"):
        collect_redirect_diagnostics(io.StringIO("xx"), set())
    monkeypatch.setattr("agent_control_mcp.redirect_diagnostics.MAX_INPUT_BYTES", 65536)
    monkeypatch.setattr("agent_control_mcp.redirect_diagnostics.MAX_REDIRECTS", 1)
    with pytest.raises(DiagnosticError, match="Too many distinct callbacks"):
        collect_redirect_diagnostics(io.StringIO(event([ALLOWED, REJECTED])), set())


@pytest.mark.parametrize("format", ["table", "json", "csv"])
def test_installed_module_cli_reads_stdin_and_exports(format):
    env = {
        **os.environ,
        "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src"),
        "MCP_ALLOWED_CLIENT_REDIRECT_URIS": json.dumps([ALLOWED]),
    }
    result = subprocess.run(
        [sys.executable, "-m", "agent_control_mcp.redirect_diagnostics", "--format", format],
        input=event([REJECTED], "2026-11-05T08:00:00Z"),
        capture_output=True,
        text=True,
        env=env,
        check=True,
    )
    assert result.stderr == ""
    assert REJECTED in result.stdout and "not_allowed" in result.stdout
    if format == "json":
        assert json.loads(result.stdout)[0]["count"] == 1
    elif format == "csv":
        assert list(csv.DictReader(io.StringIO(result.stdout)))[0]["count"] == "1"


def test_empty_and_malformed_cli_input_have_explicit_diagnostics():
    env = {
        **os.environ,
        "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src"),
        "MCP_ALLOWED_CLIENT_REDIRECT_URIS": json.dumps([ALLOWED]),
    }
    command = [sys.executable, "-m", "agent_control_mcp.redirect_diagnostics", "--format", "json"]
    empty = subprocess.run(command, input="", capture_output=True, text=True, env=env, check=True)
    assert json.loads(empty.stdout) == [] and "No retained callback rejections" in empty.stderr
    bad = subprocess.run(
        command,
        input=REGISTRATION_REJECTION_PREFIX + "synthetic-secret",
        capture_output=True,
        text=True,
        env=env,
    )
    assert bad.returncode == 2 and bad.stdout == ""
    assert "Malformed callback diagnostic" in bad.stderr and "synthetic-secret" not in bad.stderr


@pytest.mark.parametrize("timestamp", ["0001-01-01T00:00:00+01:00", "9999-12-31T23:59:59-01:00"])
def test_invalid_timestamp_cli_exits_without_partial_output_or_traceback(timestamp):
    env = {
        **os.environ,
        "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src"),
        "MCP_ALLOWED_CLIENT_REDIRECT_URIS": json.dumps([ALLOWED]),
    }
    result = subprocess.run(
        [sys.executable, "-m", "agent_control_mcp.redirect_diagnostics", "--format", "json"],
        input=event([REJECTED]) + event([REJECTED], timestamp),
        capture_output=True,
        text=True,
        env=env,
    )
    assert result.returncode == 2 and result.stdout == ""
    assert result.stderr == "Invalid Docker timestamp at line 2.\n"
