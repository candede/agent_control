import re
import stat
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import yaml

from agent_control_mcp import __main__, healthcheck, initialize_storage, recording
from agent_control_mcp.config import ConfigurationError, guid

ROOT = Path(__file__).resolve().parents[2]


def test_local_build_guard_checks_parent_links_and_repository_boundary(tmp_path):
    root = tmp_path / "repository"
    target = tmp_path / "outside"
    root.mkdir()
    target.mkdir()
    (target / "input.ts").write_text("synthetic-source")
    (root / "backend").symlink_to(target, target_is_directory=True)
    leaf = root / "backend/input.ts"
    assert leaf.is_file() and not leaf.is_symlink() and leaf.parent.is_symlink()

    source = (ROOT / "scripts/local-runtime.ps1").read_text()
    guard = source.split("function Assert-LocalBuildPath {", 1)[1].split(
        "\nfunction Get-LocalSourceFiles {", 1
    )[0]
    assert "[IO.Path]::GetFullPath($Root)" in guard
    assert "[IO.Path]::GetFullPath($Path)" in guard
    assert "[StringComparison]::OrdinalIgnoreCase" in guard
    assert "$current.StartsWith($prefix,$comparison)" in guard
    assert "while ($true)" in guard
    assert "Get-Item -LiteralPath $current -Force -ErrorAction Stop).LinkType" in guard
    assert "[string]::Equals($current,$boundary,$comparison)" in guard
    assert "$current = [IO.Path]::GetDirectoryName($current)" in guard


@pytest.mark.parametrize(
    ("function", "guard", "consumption"),
    [
        (
            "Get-LocalSourceFiles",
            "Assert-LocalBuildPath $Root $file",
            "Test-Path -LiteralPath $file -PathType Leaf",
        ),
        (
            "New-LocalBuildSnapshot",
            "Assert-LocalBuildPath $Context.Root $directory",
            "[IO.Directory]::CreateDirectory($source)",
        ),
        (
            "New-LocalBuildSnapshot",
            "Assert-LocalBuildPath $Context.Root (Join-Path $Context.Root $path)",
            "[IO.File]::Copy((Join-Path $Context.Root $path),$destination)",
        ),
        (
            "Read-LocalCandidate",
            "Assert-LocalBuildPath $Context.Root $file",
            "Get-FileHash -LiteralPath $file",
        ),
        (
            "Read-LocalCandidate",
            "Assert-LocalBuildPath $Context.Root $path",
            "Get-FileHash -LiteralPath $candidate.sourceManifest",
        ),
        (
            "Read-LocalCandidate",
            "Assert-LocalBuildPath $candidate.sourceRoot $source",
            "Get-FileHash -LiteralPath $source",
        ),
    ],
)
def test_local_build_inputs_are_guarded_before_consumption(function, guard, consumption):
    source = (ROOT / "scripts/local-runtime.ps1").read_text()
    body = source.split(f"function {function} {{", 1)[1].split("\nfunction ", 1)[0]
    assert body.index(guard) < body.index(consumption)


def test_local_snapshot_setup_is_inside_cleanup_scope():
    source = (ROOT / "scripts/local-runtime.ps1").read_text()
    snapshot = source.split("function New-LocalBuildSnapshot {", 1)[1].split(
        "\nfunction Build-LocalArtifact {", 1
    )[0]
    assert (
        snapshot.index("try {")
        < snapshot.index("[IO.Directory]::CreateDirectory($source)")
        < snapshot.index("Protect-LocalPath $directory -Directory")
        < snapshot.index("} catch {")
    )
    cleanup = snapshot.split("} catch {", 1)[1]
    assert (
        "if (Test-Path -LiteralPath $directory) { "
        "Remove-Item -LiteralPath $directory -Recurse -Force }"
    ) in cleanup
    assert "throw" in cleanup


@pytest.mark.parametrize("suffix", ["", "\n", "\r\n", " ", "\0"])
def test_local_setup_guid_guard_matches_exact_runtime_boundary(suffix):
    source = (ROOT / "scripts/local-mcp.ps1").read_text()
    guard = re.search(r"\$Mcp\[\$name\] -cnotmatch '([^']+)'", source)
    assert guard is not None
    value = "33333333-3333-3333-3333-333333333333" + suffix
    # Python 3.14 and .NET share the $ and \z boundary semantics used here.
    assert (re.search(guard.group(1), value) is not None) == (suffix == "")
    if suffix:
        with pytest.raises(ConfigurationError):
            guid(value)
    else:
        assert guid(value) == value


def test_server_has_bounded_drain_without_proxy_trust(monkeypatch):
    run = Mock()
    monkeypatch.setattr(__main__.uvicorn, "run", run)
    __main__.main()
    args, values = run.call_args
    assert args == ("agent_control_mcp.service:create_app",)
    assert values == {
        "factory": True,
        "host": "0.0.0.0",
        "port": 8000,
        "proxy_headers": False,
        "access_log": False,
        "limit_concurrency": 32,
        "backlog": 64,
        "timeout_keep_alive": 5,
        "timeout_graceful_shutdown": 65,
    }


def test_health_uses_loopback_with_exact_public_host_and_no_proxy(monkeypatch):
    monkeypatch.setenv("MCP_PUBLIC_URL", "https://mcp.example.test/mcp")
    opener = Mock()
    opener.open.return_value.__enter__ = Mock(return_value=Mock(status=200))
    opener.open.return_value.__exit__ = Mock(return_value=False)
    build = Mock(return_value=opener)
    monkeypatch.setattr(healthcheck, "build_opener", build)
    healthcheck.main()
    assert build.call_args.args[0].proxies == {}
    request = opener.open.call_args.args[0]
    assert request.full_url == "http://127.0.0.1:8000/ready"
    assert request.headers == {"Host": "mcp.example.test"}
    assert opener.open.call_args.kwargs == {"timeout": 4}


def test_optional_compose_keeps_api_independent_and_authority_separate():
    base = yaml.safe_load((ROOT / "compose.yaml").read_text())
    assert "mcp" not in base["services"]
    assert set(base["services"]["app"]["depends_on"]) == {"postgres"}
    overlay = yaml.safe_load((ROOT / "compose.mcp.yaml").read_text())
    assert set(overlay) == {"services", "volumes"}
    assert set(overlay["volumes"]) == {"mcp-oauth", "mcp-recordings"}
    assert overlay["volumes"]["mcp-recordings"] == {
        "labels": {"io.agent-control.purpose": "mcp-session-recordings"}
    }
    assert set(overlay["services"]) == {"app", "mcp"}
    assert overlay["services"]["app"] == {
        "environment": {
            "MCP_METADATA_ORIGIN": "http://mcp:8000",
            "MCP_TENANT_ID": "${MCP_TENANT_ID}",
            "MCP_CLIENT_ID": "${MCP_CLIENT_ID}",
            "MCP_API_CLIENT_ID": "${MCP_API_CLIENT_ID}",
            "MCP_PUBLIC_URL": "${MCP_PUBLIC_URL}",
            "MCP_LOCAL_HOST_PORT": "${MCP_PORT}",
            "MCP_HIDE_EMPLOYEE_DETAILS": "${MCP_HIDE_EMPLOYEE_DETAILS:-false}",
            "MCP_HIDE_CHAMPION_EMPLOYEE": "${MCP_HIDE_CHAMPION_EMPLOYEE:-false}",
        }
    }
    metadata = yaml.safe_load((ROOT / "compose.mcp-metadata.yaml").read_text())
    assert set(metadata) == {"services"}
    assert set(metadata["services"]) == {"app", "mcp"}
    for name, service in metadata["services"].items():
        environment = {"MCP_METADATA_TOKEN_FILE": "/run/secrets/mcp-metadata"}
        if name == "app":
            environment |= {
                "MCP_HIDE_EMPLOYEE_DETAILS": "${MCP_HIDE_EMPLOYEE_DETAILS:-false}",
                "MCP_HIDE_CHAMPION_EMPLOYEE": "${MCP_HIDE_CHAMPION_EMPLOYEE:-false}",
            }
        assert service == {
            "environment": environment,
            "volumes": [
                {
                    "type": "bind",
                    "source": "${LOCAL_STATE_DIR}/secrets/mcp-metadata",
                    "target": "/run/secrets/mcp-metadata",
                    "read_only": True,
                    "bind": {"create_host_path": False},
                }
            ],
        }
    mcp = overlay["services"]["mcp"]
    assert "MCP_HIDE_EMPLOYEE_DETAILS" not in mcp["environment"]
    assert "MCP_HIDE_CHAMPION_EMPLOYEE" not in mcp["environment"]
    assert "depends_on" not in mcp
    assert mcp["environment"]["MCP_API_ORIGIN"] == "http://app:3001"
    assert mcp["environment"]["MCP_RECORDING_STORAGE_PATH"] == (
        "/var/lib/agent-control-mcp/recordings"
    )
    assert not any(
        key.startswith("MCP_RECORDING_") and key != "MCP_RECORDING_STORAGE_PATH"
        for key in mcp["environment"]
    )
    assert mcp["environment"]["MCP_PUBLIC_URL"].startswith("${MCP_PUBLIC_URL:?")
    assert mcp["ports"] == ["127.0.0.1:${MCP_PORT:?MCP loopback port is required}:8000"]
    assert mcp["read_only"] is True
    assert mcp["cap_drop"] == ["ALL"]
    assert mcp["security_opt"] == ["no-new-privileges:true"]
    assert mcp["cpus"] == 0.5 and mcp["mem_limit"] == "512m" and mcp["pids_limit"] == 128
    assert mcp["stop_grace_period"] == "75s"
    assert mcp["logging"]["options"] == {"max-size": "5m", "max-file": "2"}
    assert len(mcp["volumes"]) == 5
    for mount in mcp["volumes"][:3]:
        assert mount["type"] == "bind"
        assert mount["bind"] == {"create_host_path": False}
        assert mount.get("read_only", False) == mount["target"].startswith("/run/secrets/")
        assert "postgres" not in mount["source"]
        assert "tenants" not in mount["source"]
    assert mcp["volumes"][3:] == [
        {
            "type": "volume",
            "source": "mcp-oauth",
            "target": "/var/lib/agent-control-mcp/oauth",
            "volume": {"nocopy": True},
        },
        {
            "type": "volume",
            "source": "mcp-recordings",
            "target": "/var/lib/agent-control-mcp/recordings",
            "volume": {"nocopy": True},
        },
    ]


def test_image_is_pinned_nonroot_locked_and_uses_only_approved_python_feed():
    dockerfile = (ROOT / "mcp/Dockerfile").read_text()
    runtime = dockerfile.split(" AS runtime\n", 1)[1].split("\nFROM ", 1)[0]
    assert "python:3.14.6-slim-bookworm@sha256:" in dockerfile
    assert "uv==0.12.17" in dockerfile
    assert "uv sync --frozen --no-dev --no-editable" in dockerfile
    assert "--index-url https://packagefeedproxy.microsoft.io/pypi/simple" in dockerfile
    assert "PIP_EXTRA_INDEX_URL=" in dockerfile
    assert "UV_PYTHON_DOWNLOADS=never" in dockerfile
    assert "USER 10001:10001" in runtime
    assert "mcp/tests" not in runtime and "container_service" not in runtime
    assert "COPY --from=runtime-dependencies /opt/mcp/.venv .venv" in runtime
    assert 'ENTRYPOINT ["agent-control-mcp"]' in runtime
    assert "secrets/" not in dockerfile
    assert "STOPSIGNAL SIGTERM" in runtime
    assert "TMPDIR=/work" in dockerfile and "TMPDIR=" not in runtime


def test_image_reuses_locked_dependencies_and_replaces_only_the_application_offline():
    dockerfile = (ROOT / "mcp/Dockerfile").read_text()
    dependencies = dockerfile.split(" AS dependencies\n", 1)[1].split("\nFROM ", 1)[0]
    application = dockerfile.split(" AS application\n", 1)[1].split("\nFROM ", 1)[0]
    assert "ARG MCP_DEPENDENCY_BASE=python:3.14.6-slim-bookworm@sha256:" in dockerfile
    assert 'if [ "$REUSE_INSTALLED_DEPENDENCIES" != 1 ]' in dependencies
    assert "--no-install-project" in dependencies and "COPY mcp/src" not in dependencies
    assert application.index("rm -rf src") < application.index("COPY mcp/src src")
    assert "uv build --wheel --offline" in application
    assert "uv pip install --offline --no-deps --reinstall-package agent-control-mcp" in application
    assert "uv sync" not in application and "pip install" not in dependencies.split("COPY mcp/")[1]
    assert "uv sync --frozen --no-dev --no-editable --offline" in dockerfile


@pytest.mark.parametrize(
    ("uid", "gid", "mode", "nonempty", "allowed"),
    [
        (0, 0, 0o755, False, True),
        (0, 0, 0o700, True, False),
        (501, 20, 0o700, True, True),
        (501, 20, 0o755, True, False),
        (502, 20, 0o700, True, False),
        (501, 21, 0o700, True, False),
    ],
)
@pytest.mark.parametrize("storage_kind", ["oauth", "recording"])
def test_volume_initialization_never_repairs_nonempty_or_foreign_state(
    monkeypatch, uid, gid, mode, nonempty, allowed, storage_kind
):
    root = Mock()
    root.lstat.return_value = SimpleNamespace(st_uid=uid, st_gid=gid, st_mode=stat.S_IFDIR | mode)
    root.iterdir.return_value = iter(["existing"] if nonempty else [])
    chown = Mock()
    monkeypatch.setattr(initialize_storage.os, "getuid", lambda: 0)
    monkeypatch.setattr(initialize_storage.os, "chown", chown)
    if storage_kind == "oauth":
        monkeypatch.setattr(initialize_storage, "ROOT", root)
        monkeypatch.setattr(initialize_storage.sys, "argv", ["initialize-storage", "501", "20"])

    def initialize():
        if storage_kind == "oauth":
            initialize_storage.main()
        else:
            recording.initialize(root, 501, 20)

    if allowed:
        initialize()
    else:
        with pytest.raises(ValueError):
            initialize()
    if uid == 0 and not nonempty:
        root.chmod.assert_called_once_with(0o700)
        chown.assert_called_once_with(root, 501, 20)
    else:
        root.chmod.assert_not_called()
        chown.assert_not_called()


def test_recording_initializer_uses_volume_env_without_starting_tracing(monkeypatch):
    path = Path("/var/lib/agent-control-mcp/recordings")
    initialize = Mock()
    store = Mock(root=path)
    factory = Mock(return_value=store)
    monkeypatch.setenv("MCP_RECORDING_STORAGE_PATH", str(path))
    monkeypatch.setattr(recording.sys, "argv", ["recording", "initialize", "501", "20"])
    monkeypatch.setattr(recording, "RecordingStore", factory)
    monkeypatch.setattr(recording, "initialize", initialize)
    recording.main()
    factory.assert_called_once_with(path)
    initialize.assert_called_once_with(path, 501, 20)
    store.start.assert_not_called()


@pytest.mark.parametrize("mode", [0o644, 0o640, 0o666])
def test_container_secret_permissions_remain_strict(settings_env, mode):
    from agent_control_mcp.config import ConfigurationError, Settings

    Path(settings_env["MCP_CLIENT_SECRET_FILE"]).chmod(mode)
    with pytest.raises(ConfigurationError, match="owned 0600"):
        Settings.from_env(settings_env)
