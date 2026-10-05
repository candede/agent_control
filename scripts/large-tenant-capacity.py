"""Exact-owned, fixed-budget capacity runner; no install, host ports or provider credentials."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid
import signal
import fnmatch

ROOT = Path(__file__).resolve().parent.parent
BASELINE = "agent-control-scale-5096-operator:local"
BASELINE_ID = "sha256:78f3cb9fa91e7a64960699899d8fe2eb56bdd77c8ee56490f1f5255855b3c235"
BROWSER = "agent-control:permission-browser-test-phase06"
BROWSER_ID = "sha256:b4eda044a9e58194703b1aa3e3209d3a7ea9cc219f9df14d36d418db873bb60b"
MiB = 1024**2
ENV = {**os.environ, "NPM_CONFIG_REGISTRY": "https://packagefeedproxy.microsoft.io/npm/",
       "PIP_INDEX_URL": "https://packagefeedproxy.microsoft.io/pypi/simple"}


def docker(*args, check=True, timeout=None):
    result = subprocess.run(["docker", *args], cwd=ROOT, env=ENV, text=True, capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f"docker {args[0]} failed ({result.returncode}): {result.stderr[-4000:]}")
    return result


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def owned_volume_bytes(pg, record):
    for attempt in range(1, 4):
        try:
            result = docker("exec", pg, "du", "-sk", "/var/lib/postgresql/data", check=False, timeout=5)
        except (OSError, subprocess.TimeoutExpired) as error:
            record({"attempt": attempt, "accepted": False, "exit": None, "bytes": None,
                    "error": str(error)[:2048], "at": time.time()})
            return None
        match = re.fullmatch(r"([0-9]{1,20})\s+/var/lib/postgresql/data/?", result.stdout.strip())
        value = int(match[1])*1024 if result.returncode == 0 and match else None
        record({"attempt": attempt, "accepted": value is not None, "exit": result.returncode,
                "bytes": value, "stdout": result.stdout[:2048], "stderr": result.stderr[:2048], "at": time.time()})
        if value is not None:
            return value
        if attempt < 3:
            time.sleep(.2)
    return None


def build(directory, project):
    if docker("image", "inspect", "--format", "{{.Id}}", BASELINE).stdout.strip() != BASELINE_ID:
        raise RuntimeError("protected_baseline_identity")
    if docker("image", "inspect", "--format", "{{.Id}}", BROWSER).stdout.strip() != BROWSER_ID:
        raise RuntimeError("protected_browser_identity")
    if docker("image", "inspect", "--format", "{{.Architecture}}", BASELINE).stdout != \
            docker("image", "inspect", "--format", "{{.Architecture}}", BROWSER).stdout:
        raise RuntimeError("capacity_browser_architecture")
    proof = docker("run", "--rm", "--network", "none", "--name", project+"-dependency-proof",
                   "--label", "com.docker.compose.project="+project, "--memory", "128m", "--cpus", ".25",
                   "--volume", f"{directory}/unused-pgdata:/var/lib/postgresql/data", "--entrypoint", "node", BASELINE,
                   "-e", 'const fs=require("node:fs"),c=require("node:crypto");console.log(JSON.stringify(Object.fromEntries('
                   '["package.json","package-lock.json","backend/package.json","frontend/package.json"].map(p=>'
                   '[p,c.createHash("sha256").update(fs.readFileSync("/app/"+p)).digest("hex")]))))')
    hashes = json.loads(proof.stdout)
    assert all(hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == value for name, value in hashes.items())
    save(directory / "dependency-manifests.json", hashes)
    paths = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
                           cwd=ROOT, text=True, capture_output=True, check=True).stdout.split("\0")
    selected = sorted(set(path for path in paths if path.startswith(("backend/", "frontend/", "scripts/", "docs/"))
                          or path in ("compose.yaml", "compose.large-tenant-test.yaml")))
    source = {path: hashlib.sha256((ROOT/path).read_bytes()).hexdigest() if (ROOT/path).is_file() else None for path in selected}
    save(directory / "source-before-build.json", source)
    expected = {path: value for path, value in source.items()
                if not any(part in ("node_modules", "dist", "coverage") for part in Path(path).parts)
                and not any(fnmatch.fnmatch(Path(path).name, pattern)
                            for pattern in (".env*", ".npmrc", "*.sqlite*", "*.db", "*.csv", "*.pem", "*.pfx", "*.key"))}
    save(directory / "runtime-source-expected.json", expected)
    # No dependency installation and no network during build.
    recipe = directory / "Dockerfile"
    recipe.write_text(f"FROM {BASELINE} AS application\n"
                      "RUN rm -rf /app/backend/src /app/backend/scripts /app/backend/dist /app/frontend/src /app/frontend/browser /app/frontend/dist /app/scripts /app/docs /app/plans\n"
                      "COPY backend /app/backend\nCOPY frontend /app/frontend\nCOPY scripts /app/scripts\n"
                      "COPY docs /app/docs\nCOPY compose.yaml compose.large-tenant-test.yaml /app/\n"
                      "RUN NPM_CONFIG_REGISTRY=https://packagefeedproxy.microsoft.io/npm/ npm run build --workspace frontend\n"
                      f"FROM {BROWSER} AS browser_controller\n"
                      "RUN rm -rf /app /browser\nCOPY --from=application /app /app\n"
                      "COPY --from=application /usr/local /usr/local\nWORKDIR /app\n")
    image = f"{project}-capacity:local"
    controller_image = f"{project}-controller:local"
    with (directory / "build.log").open("w") as log:
        for target,tag in (("application",image),("browser_controller",controller_image)):
            subprocess.run(["docker", "build", "--network", "none", "--target",target,"-f", str(recipe), "-t", tag, str(ROOT)],
                           cwd=ROOT, env=ENV, stdout=log, stderr=subprocess.STDOUT, check=True)
    save(directory / "image.json", {"tag": image, "id": docker("image", "inspect", "--format", "{{.Id}}", image).stdout.strip(),
                                   "baseline": BASELINE_ID})
    save(directory / "controller-image.json", {"tag": controller_image,
        "id": docker("image", "inspect", "--format", "{{.Id}}", controller_image).stdout.strip(),
        "browserBaseline": BROWSER_ID,"applicationBaseline": BASELINE_ID})
    for tag,prefix in ((image,""),(controller_image,"controller-")):
        actual = docker("run", "--rm", "--network", "none", "--name", project+"-"+prefix+"source-proof",
                        "--label", "com.docker.compose.project="+project, "--memory", "128m", "--cpus", ".25",
                        "--volume", f"{directory}:/evidence:ro", "--volume", f"{directory}/unused-pgdata:/var/lib/postgresql/data",
                        "--entrypoint", "node", tag, "-e",
                        'const fs=require("node:fs"),c=require("node:crypto"),files=JSON.parse(fs.readFileSync("/evidence/runtime-source-expected.json"));'
                        'console.log(JSON.stringify(Object.fromEntries(Object.keys(files).map(p=>[p,fs.existsSync("/app/"+p)?'
                        'c.createHash("sha256").update(fs.readFileSync("/app/"+p)).digest("hex"):null]))))')
        runtime_source = json.loads(actual.stdout)
        save(directory / (prefix+"source-in-image.json"), runtime_source)
        if expected != runtime_source:
            raise RuntimeError("candidate_source_or_tombstone_drift")
    return image,controller_image


def fixture(directory, project, image, controller_image=None):
    control = "agentcontrol_test_" + project.rsplit("-", 1)[1] + "_control"
    shared = {"image": image, "networks": ["fixture"], "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"],
              "environment": {"AGENT_CONTROL_ISOLATED_TESTS": "1", "NPM_CONFIG_REGISTRY": ENV["NPM_CONFIG_REGISTRY"],
                              "HOME": "/evidence", "TMPDIR": "/evidence", "NODE_OPTIONS": "--max-old-space-size=768"},
              "volumes": [f"{directory}:/evidence", f"{directory}/unused-pgdata:/var/lib/postgresql/data"]}
    app = {**shared, "mem_limit": 1536*MiB, "cpus": 1.5, "entrypoint": ["sh", "-c", "while :; do sleep 1; done"],
           "environment": {**shared["environment"], "PGHOST": "test-postgres", "PGDATABASE": control,
                           "PGUSER": "agentcontrol_admin", "PGPASSWORD": "isolated-fixture-admin-password-never-production-01",
                           "APP_PGPASSWORD": "isolated-fixture-password-never-production-01",
                           "PGSSLMODE": "disable", "SESSION_SECRET": "synthetic-capacity-session-secret-not-for-production",
                           "TENANTS_JSON": json.dumps([{"tenantId": "11111111-1111-4111-8111-111111111111",
                                                       "clientId": "33333333-3333-4333-8333-333333333333",
                                                       "clientSecret": "synthetic-never-production",
                                                       "domains": ["example.invalid"]}]),
                           "FRONTEND_ORIGIN": "http://test-db:8081",
                           "REDIRECT_URI": "http://test-db:8081/api/auth/callback"}}
    controller = {**shared, "mem_limit": 1024*MiB, "cpus": 1,
                  "image": controller_image or image,
                  "environment": {**shared["environment"],"PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright"},
                  "entrypoint": ["node", "--max-old-space-size=768", "--trace-gc-nvp", "--import", "tsx", "backend/scripts/capacityProvider.ts"]}
    postgres = {"image": "postgres:17-bookworm", "mem_limit": 1024*MiB, "cpus": .5, "networks": ["fixture"],
                "environment": {"POSTGRES_USER": "agentcontrol_admin", "POSTGRES_PASSWORD": "isolated-fixture-admin-password-never-production-01",
                                "POSTGRES_DB": control, "PGDATA": "/var/lib/postgresql/data/pgdata"},
                "volumes": ["large-tenant-data:/var/lib/postgresql/data"],
                "command": ["postgres", "-c", "shared_buffers=32MB", "-c", "work_mem=4MB", "-c", "maintenance_work_mem=64MB",
                            "-c", "max_parallel_workers_per_gather=0", "-c", "statement_timeout=15000", "-c", "max_connections=20",
                            "-c", "log_min_duration_statement=15000", "-c", "log_lock_waits=on"],
                "healthcheck": {"test": ["CMD", "pg_isready", "-U", "agentcontrol_admin", "-d", control], "interval": "1s",
                                "timeout": "3s", "retries": 90}}
    model = {"services": {"test-postgres": postgres, "test-db": app, "controller": controller},
             "volumes": {"large-tenant-data": {}}, "networks": {"fixture": {"internal": True}}}
    path = directory / "capacity.compose.json"
    save(path, model)
    return ["compose", "--project-directory", str(ROOT), "-f", str(path), "-p", project], control


def inspect_owned(project):
    directory = ROOT / "artifacts" / "large-tenant-data-platform" / project.removeprefix("agent-control-ltdp-")
    for kind, name in [("network", project + "_fixture"), ("volume", project + "_large-tenant-data")]:
        inspected = docker(kind, "inspect", name, check=False)
        if inspected.returncode == 0:
            resource = json.loads(inspected.stdout)[0]
            assert resource.get("Labels", {}).get("com.docker.compose.project") == project
            if kind == "network":
                assert resource["Internal"] is True
    names = docker("ps", "-aq", "--filter", f"label=com.docker.compose.project={project}").stdout.split()
    result = {}
    for name in names:
        item = json.loads(docker("inspect", name).stdout)[0]
        assert item["Config"]["Labels"]["com.docker.compose.project"] == project
        service = item["Config"]["Labels"]["com.docker.compose.service"]
        assert service in ("test-db", "test-postgres", "controller")
        assert not item["HostConfig"]["PortBindings"]
        assert list(item["NetworkSettings"]["Networks"]) == [project + "_fixture"]
        if service == "test-postgres":
            assert len(item["Mounts"]) == 1
            assert item["Mounts"][0]["Name"] == project + "_large-tenant-data"
            assert item["Mounts"][0]["Destination"] == "/var/lib/postgresql/data"
            assert item["Mounts"][0]["Type"] == "volume"
        else:
            expected = {"/evidence": str(directory), "/var/lib/postgresql/data": str(directory / "unused-pgdata")}
            assert len(item["Mounts"]) == len(expected)
            assert all(mount["Type"] == "bind" and expected.get(mount["Destination"]) == mount["Source"]
                       for mount in item["Mounts"])
            receipt = "controller-image.json" if service=="controller" and (directory/"controller-image.json").exists() else "image.json"
            assert item["Image"] == json.loads((directory / receipt).read_text())["id"]
        result[service] = item
    return result


def snapshot(directory, project, suffix):
    owned = inspect_owned(project)
    result = {}
    for service, item in owned.items():
        host = item["HostConfig"]
        result[service] = {k: item[k] for k in ("Id", "Image", "State", "RestartCount", "Mounts")}
        result[service]["limits"] = {k: host.get(k) for k in ("Memory", "MemorySwap", "NanoCpus", "Tmpfs")}
        if item["State"]["Running"]:
            counters = docker("exec", item["Id"], "sh", "-c",
                              'for f in memory.current memory.peak memory.max memory.events memory.stat memory.swap.current memory.swap.max cpu.max cpu.stat; '
                              'do echo "$f"; if [ -r /sys/fs/cgroup/"$f" ]; then cat /sys/fs/cgroup/"$f"; else echo unavailable; fi; done', check=False)
            (directory / f"{service}-{suffix}-cgroup.txt").write_text(counters.stdout + counters.stderr)
        logs = docker("logs", "--tail", "2000", item["Id"], check=False)
        (directory / f"{service}-{suffix}.log").write_text(logs.stdout + logs.stderr)
    save(directory / f"containers-{suffix}.json", result)
    return owned


def run_mode(directory, project, owned, mode):
    app = owned["test-db"]["Id"]
    args = ["node", "--max-old-space-size=768", "--trace-gc-nvp"]
    args += ["--expose-gc"] if mode == "probe" else []
    args += ["--import", "tsx", "backend/scripts/large-tenant-capacity.ts"]
    args += ["--probe", "transient-heap"] if mode == "probe" else [mode]
    with (directory / f"{mode}-stdout.log").open("w") as log:
        started = time.monotonic()
        process = subprocess.Popen(["docker", "exec", app, *args], cwd=ROOT, env=ENV, stdout=log, stderr=subprocess.STDOUT)
        stopped = None
        while process.poll() is None:
            time.sleep(5)
            def record_counter(value):
                with (directory / "disk-counter-events.jsonl").open("a") as output:
                    output.write(json.dumps({"mode": mode, **value})+"\n")
            volume_used = owned_volume_bytes(owned["test-postgres"]["Id"], record_counter)
            if volume_used is None:
                stopped = "disk_counter_unavailable"
            else:
                wal = docker("exec", owned["test-postgres"]["Id"], "du", "-sk",
                             "/var/lib/postgresql/data/pgdata/pg_wal", check=False)
                wal_used = int(wal.stdout.split()[0])*1024 if wal.returncode == 0 and wal.stdout.split() else None
                backup_used = sum(path.stat().st_size for path in directory.glob("*.dump"))
                used = volume_used + backup_used
                with (directory / "disk-samples.jsonl").open("a") as output:
                    output.write(json.dumps({"at": time.time(), "used": used, "volume": volume_used, "wal": wal_used,
                                             "backups": backup_used})+"\n")
                if used >= 48*1024**3:
                    stopped = "disk_stop_48GiB"
            if log.tell() >= 1024**3 or any(path.stat().st_size >= 1024**3 for path in directory.glob("*continuous*log")):
                stopped = "gc_log_limit_inconclusive"
            # Full qualification contains multiple separately deadline-bounded
            # sources plus real-time churn/retry profiles; their sum is not a
            # single four-hour Graph refresh. Disk/log guards remain active.
            if mode != "full" and time.monotonic()-started > 4*3600:
                stopped = "diagnostic_watchdog_4h"
            if stopped:
                snapshot(directory, project, "before-guard-stop")
                identity = directory / f"{mode}-memory.jsonl"
                if not identity.exists():
                    raise RuntimeError("guard_stop_missing_worker_identity")
                with identity.open() as source:
                    pid = json.loads(source.readline())["pid"]
                cmd = docker("exec", app, "sh", "-c", f'tr "\\000" " " < /proc/{pid}/cmdline').stdout
                if "backend/scripts/large-tenant-capacity.ts" not in cmd:
                    raise RuntimeError("guard_stop_worker_identity_mismatch")
                docker("exec", app, "sh", "-c", f"kill -TERM {int(pid)}")
                process.wait(timeout=30)
                break
    save(directory / f"{mode}-command.json", {"command": args, "exit": process.returncode, "guardStop": stopped,
                                            "elapsedSeconds": time.monotonic()-started})
    return process.returncode


def verify_effective_postgres(text):
    observed = {}
    for line in text.splitlines():
        fields = line.split("|")
        if len(fields) == 3:
            observed[fields[0]] = fields[1:]
    expected = {"shared_buffers": ["4096", "8kB"], "work_mem": ["4096", "kB"],
                "maintenance_work_mem": ["65536", "kB"], "max_parallel_workers_per_gather": ["0", ""],
                "statement_timeout": ["15000", "ms"], "data_directory": ["/var/lib/postgresql/data/pgdata", ""],
                "temp_tablespaces": ["", ""]}
    for key, value in expected.items():
        if observed.get(key) != value:
            raise RuntimeError(f"capacity_postgres_setting_drift:{key}:{observed.get(key)}!={value}")
    return observed


def run(mode):
    receipts = []
    for attempt in range(1 if mode in ("query", "probe") else 3):
        identity = uuid.uuid4().hex
        project = "agent-control-ltdp-" + identity
        directory = ROOT / "artifacts" / "large-tenant-data-platform" / identity
        directory.mkdir(parents=True)
        (directory / "unused-pgdata").mkdir()
        print(f"CAPACITY_ATTEMPT {attempt+1} {directory}", flush=True)
        failure = None
        commands = []
        compose = None
        try:
            image,controller_image = build(directory, project)
            compose, control = fixture(directory, project, image,controller_image)
            docker(*compose, "up", "-d", "--no-build", "--wait", "--wait-timeout", "90")
            owned = snapshot(directory, project, "before")
            for service, memory, cpus in [("test-db", 1536*MiB, 1.5), ("test-postgres", 1024*MiB, .5), ("controller", 1024*MiB, 1)]:
                item = owned[service]
                assert item["HostConfig"]["Memory"] == memory and item["HostConfig"]["NanoCpus"] == int(cpus*1e9)
            pg = owned["test-postgres"]["Id"]
            mount = owned["test-postgres"]["Mounts"]
            assert len(mount) == 1 and mount[0]["Type"] == "volume" and mount[0]["Name"] == project + "_large-tenant-data"
            assert json.loads(docker("network", "inspect", project + "_fixture").stdout)[0]["Internal"]
            disk = docker("exec", pg, "df", "-Pk", "/var/lib/postgresql/data").stdout
            (directory / "disk-before.txt").write_text(disk)
            free = int(disk.splitlines()[-1].split()[3]) * 1024
            if free < 64*1024**3:
                raise RuntimeError(f"capacity_disk_unavailable: free={free}, required={64*1024**3}")
            app = owned["test-db"]["Id"]
            ready = docker("exec", app, "node", "-e", "fetch('http://controller:8080/ready').then(r=>{if(!r.ok)process.exit(1);return r.text()}).then(console.log)")
            (directory / "provider-ready.json").write_text(ready.stdout)
            save(directory / "engine.json", json.loads(docker("info", "--format", "{{json .}}").stdout))
            host = subprocess.run(["sh", "-c", "sysctl hw.memsize hw.logicalcpu; df -Pk ."], cwd=ROOT,
                                  text=True, capture_output=True)
            (directory / "host-resources.txt").write_text(host.stdout+host.stderr)
            settings = docker("exec", pg, "psql", "-U", "agentcontrol_admin", "-d", control, "-At", "-c",
                              "SELECT name,setting,unit FROM pg_settings WHERE name IN "
                              "('shared_buffers','work_mem','maintenance_work_mem','max_parallel_workers_per_gather','statement_timeout','data_directory','temp_tablespaces',"
                              "'max_wal_size','min_wal_size','checkpoint_timeout','checkpoint_completion_target','wal_compression');"
                              "SELECT version();").stdout
            (directory / "postgres-effective.txt").write_text(settings)
            verify_effective_postgres(settings)
            monitors = []
            handles = []
            log_processes = []
            sample = ('echo $$; while :; do date +%s.%N; '
                      'for f in memory.current memory.peak memory.max memory.events memory.stat memory.swap.current memory.swap.max cpu.max cpu.stat; '
                      'do echo "$f"; if [ -r /sys/fs/cgroup/"$f" ]; then cat /sys/fs/cgroup/"$f"; else echo unavailable; fi; done; '
                      'grep -H -E "^(Name|VmRSS|VmHWM):" /proc/[0-9]*/status 2>/dev/null; sleep 0.25; done')
            try:
                for service, suffix in [("controller", "gc"), ("test-postgres", "postgres")]:
                    handle = (directory / f"{service}-continuous-{suffix}.log").open("w"); handles.append(handle)
                    log_processes.append(subprocess.Popen(["docker", "logs", "--follow", owned[service]["Id"]],
                                                          stdout=handle, stderr=subprocess.STDOUT, env=ENV))
                for service in ("test-postgres", "test-db", "controller"):
                    handle = (directory / f"{service}-continuous-cgroup.log").open("w"); handles.append(handle)
                    monitor = subprocess.Popen(["docker", "exec", owned[service]["Id"], "sh", "-c", sample],
                                               stdout=handle, stderr=subprocess.STDOUT, env=ENV)
                    monitors.append((service, monitor))
                for current in (["probe", "query"] if mode == "query" else ["probe"] if mode == "probe" else ["probe", "full"]):
                    commands.append({"mode": current, "exit": run_mode(directory, project, owned, current)})
            finally:
                for process in log_processes:
                    process.terminate()
                    process.wait(timeout=20)
                for service, monitor in monitors:
                    with (directory / f"{service}-continuous-cgroup.log").open() as capture:
                        pid = capture.readline().strip()
                    if not pid.isdigit():
                        raise RuntimeError("monitor_owner_pid_unavailable")
                    docker("exec", owned[service]["Id"], "sh", "-c", f"kill -TERM {int(pid)}", check=False)
                    monitor.wait(timeout=20)
                for handle in handles:
                    handle.close()
        except Exception as error:
            failure = str(error)
        finally:
            cleanup = []
            if compose:
                verified = False
                try:
                    inspect_owned(project)
                    verified = True
                    snapshot(directory, project, "final")
                except Exception as error:
                    cleanup.append("diagnostics: " + str(error))
                try:
                    if not verified:
                        raise RuntimeError("cleanup_ownership_not_verified")
                    docker(*compose, "down", "--volumes", "--timeout", "10")
                    for kind in ("container", "network", "volume"):
                        args = ["ps", "-aq"] if kind == "container" else [kind, "ls", "-q"]
                        remaining = docker(*args, "--filter", f"label=com.docker.compose.project={project}").stdout.strip()
                        if remaining:
                            cleanup.append(f"{kind}: {remaining}")
                except Exception as error:
                    cleanup.append(str(error))
            for command in commands:
                parsed = subprocess.run(["python3", str(ROOT / "scripts/capacity-results.py"), str(directory), "--mode", command["mode"]],
                                        cwd=ROOT, env=ENV, text=True, capture_output=True)
                if parsed.returncode:
                    cleanup.append("result_interpretation: " + parsed.stderr[-1000:])
            receipt = {"project": project, "directory": str(directory.relative_to(ROOT)), "failure": failure,
                       "commands": commands, "cleanupErrors": cleanup, "finishedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
            save(directory / "result.json", receipt)
            receipts.append(receipt)
            print(json.dumps(receipt), flush=True)
    save(ROOT / "artifacts" / "phase06" / f"{mode}-{uuid.uuid4().hex}-attempts.json", receipts)
    return 1 if any(r["failure"] or r["cleanupErrors"] or any(c["exit"] for c in r["commands"]) for r in receipts) else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("query", "probe", "full"), default="full")
    args = parser.parse_args()
    for key in os.environ:
        if re.match(r"^(PG|APP_PG|TENANT|CLIENT_|SESSION_SECRET)", key) and os.environ[key]:
            raise RuntimeError(f"capacity_fixture_rejects_inherited_{key}")
    raise SystemExit(run(args.mode))
