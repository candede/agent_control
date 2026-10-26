import stat
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import yaml

from agent_control_mcp import __main__, healthcheck, initialize_storage

ROOT = Path(__file__).resolve().parents[2]


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
    assert set(overlay["volumes"]) == {"mcp-oauth"}
    assert set(overlay["services"]) == {"mcp"}
    mcp = overlay["services"]["mcp"]
    assert "depends_on" not in mcp
    assert mcp["environment"]["MCP_API_ORIGIN"] == "http://app:3001"
    assert mcp["environment"]["MCP_PUBLIC_URL"].startswith("${MCP_PUBLIC_URL:?")
    assert mcp["ports"] == ["127.0.0.1:${MCP_PORT:?MCP loopback port is required}:8000"]
    assert mcp["read_only"] is True
    assert mcp["cap_drop"] == ["ALL"]
    assert mcp["security_opt"] == ["no-new-privileges:true"]
    assert mcp["cpus"] == 0.5 and mcp["mem_limit"] == "512m" and mcp["pids_limit"] == 128
    assert mcp["stop_grace_period"] == "75s"
    assert mcp["logging"]["options"] == {"max-size": "5m", "max-file": "2"}
    assert len(mcp["volumes"]) == 4
    for mount in mcp["volumes"][:3]:
        assert mount["type"] == "bind"
        assert mount["bind"] == {"create_host_path": False}
        assert mount.get("read_only", False) == mount["target"].startswith("/run/secrets/")
        assert "postgres" not in mount["source"]
        assert "tenants" not in mount["source"]
    assert mcp["volumes"][-1] == {
        "type": "volume",
        "source": "mcp-oauth",
        "target": "/var/lib/agent-control-mcp/oauth",
        "volume": {"nocopy": True},
    }


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
    assert "COPY --from=dependencies /opt/mcp/.venv .venv" in runtime
    assert 'ENTRYPOINT ["agent-control-mcp"]' in runtime
    assert "secrets/" not in dockerfile
    assert "STOPSIGNAL SIGTERM" in runtime
    assert "TMPDIR=/work" in dockerfile and "TMPDIR=" not in runtime


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
def test_volume_initialization_never_repairs_nonempty_or_foreign_state(
    monkeypatch, uid, gid, mode, nonempty, allowed
):
    root = Mock()
    root.lstat.return_value = SimpleNamespace(st_uid=uid, st_gid=gid, st_mode=stat.S_IFDIR | mode)
    root.iterdir.return_value = iter(["existing"] if nonempty else [])
    chown = Mock()
    monkeypatch.setattr(initialize_storage, "ROOT", root)
    monkeypatch.setattr(initialize_storage.os, "getuid", lambda: 0)
    monkeypatch.setattr(initialize_storage.os, "chown", chown)
    monkeypatch.setattr(initialize_storage.sys, "argv", ["initialize-storage", "501", "20"])
    if allowed:
        initialize_storage.main()
    else:
        with pytest.raises(ValueError):
            initialize_storage.main()
    if uid == 0 and not nonempty:
        root.chmod.assert_called_once_with(0o700)
        chown.assert_called_once_with(root, 501, 20)
    else:
        root.chmod.assert_not_called()
        chown.assert_not_called()


@pytest.mark.parametrize("mode", [0o644, 0o640, 0o666])
def test_container_secret_permissions_remain_strict(settings_env, mode):
    from agent_control_mcp.config import ConfigurationError, Settings

    Path(settings_env["MCP_CLIENT_SECRET_FILE"]).chmod(mode)
    with pytest.raises(ConfigurationError, match="owned 0600"):
        Settings.from_env(settings_env)
