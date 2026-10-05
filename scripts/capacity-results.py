"""Streaming, fail-closed interpretation of raw capacity receipts."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re

MIB = 1024 ** 2
GC = re.compile(r"^\[(\d+):([^\]]+)\]\s+([\d.]+)\s+ms:")
NUMBER = re.compile(r"\b([a-z_]+)=([0-9.e+-]+)(?=\s|$)")
STAGES = {"provider.parse", "batch.stringify", "sql.result", "import.transform", "response.serialize", "export.encode"}


def read_json(path):
    return json.loads(path.read_text()) if path.exists() else None


def cgroup_summary(directory, service):
    path = directory / f"{service}-continuous-cgroup.log"
    result = {"memoryPeak": None, "memoryMax": None, "fileCacheMax": None, "swapCurrentMax": None,
              "events": {}, "cpu": {}, "backendRssMax": None, "backendRssSumMax": None, "samples": 0}
    section, names, rss = "", {}, {}
    if not path.exists():
        return result
    def flush():
        values = [value for pid, value in rss.items() if names.get(pid) == "postgres"]
        if values:
            result["backendRssMax"] = max(result["backendRssMax"] or 0, max(values))
            result["backendRssSumMax"] = max(result["backendRssSumMax"] or 0, sum(values))
    with path.open(errors="replace") as source:
        for raw in source:
            line = raw.strip()
            if re.fullmatch(r"\d{10}\.\d+", line):
                flush(); names, rss = {}, {}; result["samples"] += 1
            elif line.startswith(("memory.", "cpu.")):
                section = line
            elif section in ("memory.peak", "memory.max", "memory.swap.current") and line.isdigit():
                key = {"memory.peak": "memoryPeak", "memory.max": "memoryMax", "memory.swap.current": "swapCurrentMax"}[section]
                result[key] = max(result[key] or 0, int(line))
            elif section in ("memory.events", "memory.stat", "cpu.stat"):
                value = re.fullmatch(r"([a-z_]+) (\d+)", line)
                if value:
                    key, number = value[1], int(value[2])
                    if section == "memory.stat" and key == "file":
                        result["fileCacheMax"] = max(result["fileCacheMax"] or 0, number)
                    elif section != "memory.stat":
                        target = result["events" if section == "memory.events" else "cpu"]
                        target[key] = max(target.get(key, 0), number)
            process = re.fullmatch(r"/proc/(\d+)/status:(Name|VmRSS):\s+(.+)", line)
            if process:
                if process[2] == "Name":
                    names[process[1]] = process[3]
                else:
                    rss[process[1]] = int(process[3].split()[0]) * 1024
    flush()
    return result


def worker_memory(directory, gc):
    workers = []
    for path in sorted(directory.glob("lease-worker-*-memory.jsonl"), key=lambda path: path.name):
        identity, summary, samples, numeric_samples, malformed = None, None, 0, 0, 0
        heap, rss, stages, pool_covered, memory_covered = 0, 0, {}, True, True
        with path.open() as source:
            for line in source:
                try:
                    row = json.loads(line)
                except ValueError:
                    malformed += 1
                    continue
                if row.get("event") == "identity":
                    identity = row
                elif row.get("event") == "summary":
                    summary = row
                elif row.get("event") == "sample":
                    samples += 1
                    numeric = ("rss", "heapUsed", "heapTotal", "external", "arrayBuffers", "eventLoopMaxMs")
                    complete = all(isinstance(row.get(key), (int, float)) and math.isfinite(row[key]) and row[key] >= 0 for key in numeric)
                    memory_covered = memory_covered and complete and bool(identity and row.get("pid") == identity.get("pid")
                                                                         and row.get("isolate") == identity.get("isolate"))
                    if complete:
                        numeric_samples += 1
                        heap = max(heap, row["heapUsed"])
                        rss = max(rss, row["rss"])
                    pool = row.get("pool")
                    pool_covered = pool_covered and isinstance(pool, dict) and all(isinstance(pool.get(key), int) and pool[key] >= 0
                        for key in ("total", "waiting", "idle", "maximum", "foreground", "queue"))
                    pool_covered = pool_covered and pool["maximum"] == 4 and pool["total"] <= 4
                elif row.get("event") == "checkpoint":
                    if identity and row.get("pid") == identity.get("pid") and row.get("isolate") == identity.get("isolate"):
                        stages[row["stage"]] = max(stages.get(row["stage"], 0), row["heapUsed"])
                    else:
                        malformed += 1
        raw = [row for row in gc.values() if identity and row["pid"] == identity.get("pid")
               and row["isolate"].endswith(":"+str(identity.get("isolate")))]
        pre = max((row["gcPreHeapUsedMax"] for row in raw if row["gcPreHeapUsedMax"] is not None), default=None)
        scope = bool(identity and path.name == f"lease-worker-{identity.get('pid')}-memory.jsonl"
                     and identity.get("node") and identity.get("v8") and identity.get("heap", {}).get("heap_size_limit")
                     and "--max-old-space-size=768" in identity.get("execArgv", []))
        covered = (scope and samples > 0 and memory_covered and pool_covered and "sql.result" in stages and summary is not None
                   and summary.get("dropped") == 0 and not malformed and sum(row["records"] for row in raw) > 0
                   and summary.get("pid") == identity.get("pid") and summary.get("isolate") == identity.get("isolate")
                   and not any(row["incomplete"] for row in raw))
        observed = max(([heap] if numeric_samples else []) + list(stages.values()) + ([pre] if pre is not None else []), default=None)
        workers.append({"file": path.name, "identity": identity, "samples": samples, "poolCovered": pool_covered and samples > 0,
                        "memoryCovered": memory_covered and samples > 0,
                        "sampledHeapUsedMax": heap if numeric_samples else None, "sampledRssMax": rss if numeric_samples else None,
                        "stageCheckpointHeapUsedMax": max(stages.values(), default=None),
                        "gcPreHeapUsedMax": pre, "observedHeapUsedMax": observed,
                        "finalSummaryPresent": summary is not None, "dropped": summary.get("dropped") if summary else None,
                        "malformed": malformed, "stages": sorted(stages), "covered": bool(covered),
                        "scope": "Real lease-only worker: SQL-result checkpoints, raw GC, timer and terminal receipt; no provider/import/export data work."})
    return workers


def summarize(directory, mode):
    gc, malformed = {}, 0
    functional = read_json(directory / f"{mode}-result.json")
    windows = [{**window,"count": row["count"],"gcPreHeapUsedMax": None,"closed": False} for row in (functional or {}).get("comparison",[])
               for window in row.get("requestWindows",[])]
    active_window = None
    raw = directory / f"{mode}-stdout.log"
    if raw.exists():
        with raw.open(errors="replace") as source:
            for line in source:
                if line.startswith("CAPACITY_REQUEST_WINDOW "):
                    try:
                        marker = json.loads(line.removeprefix("CAPACITY_REQUEST_WINDOW "))
                        if marker["state"] == "begin":
                            active_window = next((window for window in windows if window["count"]==marker["count"] and window["index"]==marker["index"]),None)
                            if active_window is not None:
                                active_window["pid"] = marker["pid"]
                        elif active_window is not None and all(active_window[key]==marker[key] for key in ("pid","count","index")):
                            active_window["closed"] = True
                            active_window = None
                    except (ValueError,KeyError):
                        malformed += 1
                    continue
                identity = GC.match(line)
                if "gc=" not in line:
                    continue
                if not identity:
                    malformed += 1
                    continue
                fields = {key: float(value) for key, value in NUMBER.findall(line)}
                before = fields.get("start_object_size", fields.get("total_size_before"))
                after = fields.get("end_object_size", fields.get("total_size_after"))
                allocated = fields.get("allocated")
                key = f"{identity[1]}:{identity[2]}"
                record = gc.setdefault(key, {"pid": int(identity[1]), "isolate": identity[2],
                                            "records": 0, "incomplete": 0, "gcPreHeapUsedMax": None,
                                            "gcPostHeapUsedMax": None, "allocatedBytes": 0})
                if before is None or after is None or allocated is None or not all(math.isfinite(value) for value in (before, after, allocated)):
                    record["incomplete"] += 1
                    continue
                record["records"] += 1
                record["gcPreHeapUsedMax"] = max(record["gcPreHeapUsedMax"] or 0, int(before))
                record["gcPostHeapUsedMax"] = max(record["gcPostHeapUsedMax"] or 0, int(after))
                record["allocatedBytes"] += int(allocated)
                if active_window is not None and active_window["pid"]==int(identity[1]) and key.endswith(":0"):
                    active_window["gcPreHeapUsedMax"] = max(active_window["gcPreHeapUsedMax"] or 0,int(before))
    summary, identity, stages, samples, query_max, pool_max = None, None, {}, 0, 0, 0
    response_times, categories, cycles, reader_rejections, checkpoints, rss, heap, peak = {}, {}, [], 0, 0, 0, 0, None
    publications, publication_max, publication_rejections, lock_wait_max = {}, 0, 0, None
    publication_classes, http_requests, http_failures = {}, 0, 0
    connection_max, connection_samples, connection_missing, connection_failures = None, 0, 0, 0
    unsuccessful_timings = {"failed": 0,"unknown": 0}
    mutation_probes, sweep_results = {}, []
    memory = directory / f"{mode}-memory.jsonl"
    if memory.exists():
        with memory.open() as source:
            for line in source:
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    malformed += 1
                    continue
                event = record.get("event")
                if event == "identity":
                    identity = record
                elif event == "summary":
                    summary = record
                elif event == "checkpoint":
                    stages[record["stage"]] = max(stages.get(record["stage"], 0), record["heapUsed"])
                    checkpoints = max(checkpoints, record["heapUsed"])
                elif event == "sample":
                    samples += 1
                    rss, heap = max(rss, record["rss"]), max(heap, record["heapUsed"])
                    group = record.get("cgroup") or {}
                    value = group.get("memory.peak", "")
                    if value.isdigit():
                        peak = max(peak or 0, int(value))
                    pool = record.get("pool") or {}
                    pool_max = max(pool_max, pool.get("waiting", 0), pool.get("queue", 0))
                elif event == "sql":
                    query_max = max(query_max, record["milliseconds"])
                elif event == "reader-rejection":
                    reader_rejections += 1
                elif event == "publication":
                    if record["committed"]:
                        publication_max = max(publication_max,record["milliseconds"])
                        bucket = int(record["milliseconds"]//10)*10
                        publications[bucket] = publications.get(bucket,0)+1
                        histogram = publication_classes.setdefault(record["kind"],{})
                        histogram[bucket] = histogram.get(bucket,0)+1
                    else:
                        publication_rejections += 1
                elif event == "database-diagnostics":
                    if record.get("longest_lock_wait_seconds") is not None:
                        lock_wait_max = max(lock_wait_max or 0,float(record["longest_lock_wait_seconds"]))
                    count = record.get("application_connections")
                    if type(count) is int and count >= 1:
                        connection_max = max(connection_max or 0,count)
                        connection_samples += 1
                    else:
                        connection_missing += 1
                elif event == "database-diagnostics-failed":
                    connection_failures += 1
                elif event == "http-controller" and record.get("action")=="readers" and record.get("status")==200:
                    value = record["result"]
                    http_requests += value.get("requests",0); http_failures += value.get("failures",0)
                    for reader in value.get("readers",[]):
                        histograms = reader.get("successfulHistograms")
                        if histograms is None:
                            if reader.get("failures") != 0:
                                unsuccessful_timings["unknown"] += reader.get("requests",0)
                                continue
                            histograms = {"http-detail" if reader["reader"]>=10 else "http-inventory-page": reader["histogram"]}
                        for kind,buckets in histograms.items():
                            histogram = categories.setdefault(kind,{})
                            for bucket, count in buckets.items():
                                upper = max(int(bucket),reader["maximumMs"]) if int(bucket)==20000 else int(bucket)
                                key = math.ceil(upper/10)*10-10
                                histogram[key] = histogram.get(key,0)+count
                elif event == "reader":
                    if record.get("succeeded") is not True:
                        unsuccessful_timings["failed" if record.get("succeeded") is False else "unknown"] += 1
                        continue
                    # Fixed-width histogram avoids retaining one value per unbounded request.
                    bucket = int(record["milliseconds"] // 10) * 10
                    response_times[bucket] = response_times.get(bucket, 0) + 1
                    histogram = categories.setdefault(record.get("kind", "unspecified"), {})
                    histogram[bucket] = histogram.get(bucket, 0) + 1
                elif event == "cycle":
                    cycles.append({"cycle": record["cycle"], "complete": record.get("complete"),
                                   "rss": record["settled"]["rss"], "heapUsed": record["settled"]["heapUsed"]})
                elif event == "fixed-mutation-probe":
                    mutation_probes[record["count"]] = {key: record.get(key) for key in ("keys","physical","wal","coverage")}
                elif event == "detail-sweep":
                    sweep_results.append(record)
    pre = max((r["gcPreHeapUsedMax"] for r in gc.values() if r["gcPreHeapUsedMax"] is not None), default=None)
    incomplete = malformed + sum(r["incomplete"] for r in gc.values())
    probe = read_json(directory / "probe.json")
    if probe is None:
        probe = read_json(directory / "probe-result.json")
    workers = worker_memory(directory, gc)
    heap = max([heap, *[worker["sampledHeapUsedMax"] for worker in workers if worker["sampledHeapUsedMax"] is not None]])
    rss = max([rss, *[worker["sampledRssMax"] for worker in workers if worker["sampledRssMax"] is not None]])
    checkpoints = max([checkpoints, *[worker["stageCheckpointHeapUsedMax"] for worker in workers if worker["stageCheckpointHeapUsedMax"] is not None]])
    observed = max(([heap] if samples else []) + list(stages.values()) + ([pre] if pre is not None else [])
                   + [worker["observedHeapUsedMax"] for worker in workers if worker["observedHeapUsedMax"] is not None], default=None)
    workers_covered = all(worker["covered"] for worker in workers) and (mode != "full" or len(workers) >= 2)
    coverage = {"timerIsLowerBound": True, "rawGcRecords": sum(r["records"] for r in gc.values()),
                "workloadGcRecords": sum(r["records"] for r in gc.values() if identity and r["pid"] == identity["pid"]
                                         and r["isolate"].endswith(":"+str(identity["isolate"]))),
                "malformedOrIncomplete": incomplete, "finalSummaryPresent": summary is not None,
                "missingStages": sorted(STAGES - set(stages)), "dropped": summary.get("dropped") if summary else None,
                "probePassed": bool(probe and probe.get("status") == "passed"),
                "isolates": list(gc.values()),
                "leaseWorkers": workers, "leaseWorkersCovered": workers_covered,
                "scope": "Sample/stage maxima include workload and lease processes. Raw GC also includes loader isolates. Workload stages and separately declared lease-worker SQL/timer/terminal coverage are required."}
    covered = (coverage["workloadGcRecords"] > 0 and not incomplete and summary is not None
               and not coverage["missingStages"] and coverage["dropped"] == 0 and coverage["probePassed"] and workers_covered)
    gates = {
        "heapObserved615MiB": "failed" if observed is not None and observed > 615*MIB else "passed" if covered else "inconclusive",
        "appCharged80Percent": "inconclusive" if peak is None else "passed" if peak <= .8*1536*MIB else "failed",
        "ordinarySql15Seconds": "inconclusive" if not query_max else "passed" if query_max <= 15000 else "failed",
        "readerAdmissionFailures": "failed" if reader_rejections else "inconclusive" if not response_times else "passed",
    }
    reported_connections = (functional or {}).get("applicationConnections") or {}
    bootstrap = (functional or {}).get("appBootstrap") or {}
    reported_max = reported_connections.get("maximumObserved")
    reported_valid = type(reported_max) is int and reported_max >= 1
    connection_exceeded = ((reported_valid and reported_max > 4)
                          or (connection_max is not None and connection_max > 4))
    connection_drift = (reported_connections.get("sharedApplicationPool") is False
                        or bootstrap.get("sharedApplicationPool") is False
                        or reported_connections.get("limit") not in (None,4)
                        or bootstrap.get("poolMaximum") not in (None,4)
                        or bootstrap.get("user") not in (None,"agentcontrol_app"))
    bootstrap_routes = bootstrap.get("routes",[])
    bootstrap_complete = (len(bootstrap_routes) == 3 and
        {route.get("path") for route in bootstrap_routes if route.get("status") == 200} ==
        {"/api/capabilities","/api/data-sync/state","/api/inventory/refresh-jobs"})
    connection_covered = (reported_valid and reported_max == connection_max and connection_samples > 0
        and not connection_missing and not connection_failures and summary is not None and summary.get("dropped") == 0
        and reported_connections.get("limit") == 4 and reported_connections.get("sharedApplicationPool") is True
        and reported_connections.get("status") == "passed" and bool(reported_connections.get("coverage"))
        and bootstrap.get("sharedApplicationPool") is True and bootstrap.get("poolMaximum") == 4
        and bootstrap.get("user") == "agentcontrol_app" and bootstrap_complete
        and bool(re.fullmatch(r"agentcontrol_test_[a-f0-9]{32}",bootstrap.get("database","")))
        and bootstrap.get("database") == (functional or {}).get("database"))
    gates["applicationConnectionBudget4"] = ("failed" if connection_exceeded or connection_drift else
        "passed" if connection_covered else "inconclusive")
    groups = {service: cgroup_summary(directory, service) for service in ("test-db", "test-postgres","controller")}
    for service, group in groups.items():
        present = all(key in group["events"] for key in ("oom", "oom_kill", "max"))
        gates[f"{service}ZeroOomAndMaxEvents"] = ("inconclusive" if not present else
            "passed" if all(group["events"][key] == 0 for key in ("oom", "oom_kill", "max")) else "failed")
    pg = groups["test-postgres"]
    gates["postgresCharged80Percent"] = ("inconclusive" if pg["memoryPeak"] is None or pg["memoryMax"] is None
        else "passed" if pg["memoryPeak"] <= pg["memoryMax"] * .8 else "failed")
    def percentile(histogram, fraction):
        total, seen = sum(histogram.values()), 0
        for bucket, count in sorted(histogram.items()):
            seen += count
            if seen >= math.ceil(total*fraction):
                return bucket+10
        return None
    latency = {kind: {"requests": sum(histogram.values()), "p95UpperMs": percentile(histogram, .95),
                      "p99UpperMs": percentile(histogram, .99)} for kind, histogram in categories.items()}
    publication_p95 = percentile(publications,.95)
    gates["headSwapTransactionP95"] = ("inconclusive" if publication_p95 is None else
                                      "passed" if publication_p95 <= 1000 else "failed")
    publication_latency = {kind: {"count": sum(histogram.values()),"p95UpperMs": percentile(histogram,.95)}
                           for kind,histogram in publication_classes.items()}
    for kind,value in publication_latency.items():
        gates[kind+"HeadSwapP95"] = "passed" if value["p95UpperMs"]<=1000 else "failed"
    gates["lockWait2Seconds"] = "failed" if lock_wait_max is not None and lock_wait_max>2 else "inconclusive"
    for kind, value in latency.items():
        if kind in ("inventory-page", "report-page", "detail","http-inventory-page","http-detail"):
            gates[kind+"Latency"] = "passed" if value["p95UpperMs"] <= 2000 and value["p99UpperMs"] <= 5000 else "failed"
        elif kind in ("summary", "facet"):
            gates[kind+"Latency"] = "passed" if value["p95UpperMs"] <= 5000 else "failed"
    gates["thousandRequests"] = "passed" if sum(response_times.values())+max(0,http_requests-http_failures) >= 1000 else "inconclusive"
    gates["httpReaderFailures"] = "inconclusive" if not http_requests else "failed" if http_failures else "passed"
    if len(cycles) == 5 and all(row["complete"] is True for row in cycles):
        growth = all(cycles[-1][key]-cycles[0][key] <= 64*MIB for key in ("rss", "heapUsed"))
        monotonic = any(all(cycles[i+1][key]-cycles[i][key] > 16*MIB for i in range(4)) for key in ("rss", "heapUsed"))
        gates["settledFiveCycleGrowth"] = "passed" if growth and not monotonic else "failed"
    else:
        gates["settledFiveCycleGrowth"] = "inconclusive"
    amplification = {}
    baseline, full = mutation_probes.get(10000), mutation_probes.get(100000)
    for name, keys in [("mutationWriteRows10Percent", ("rows","insert","update","delete")),
                       ("mutationReadTuples10Percent", ("sequentialTuples","indexTuples","heapFetches","scans"))]:
        complete = baseline and full and baseline.get("keys")==full.get("keys")==20 and all(
            isinstance(probe.get("physical"),dict) and all(type(probe["physical"].get(key)) in (int,float)
                and math.isfinite(probe["physical"][key]) and probe["physical"][key]>=0 for key in keys)
            for probe in (baseline,full))
        if name == "mutationReadTuples10Percent":
            complete = complete and all(probe["physical"].get("readMethod") == "transaction-difference-v2"
                                        for probe in (baseline,full))
        if not complete:
            gates[name] = "inconclusive"
        else:
            values = {key: {"baseline": baseline["physical"][key],"full": full["physical"][key],
                           "ratio": full["physical"][key]/baseline["physical"][key] if baseline["physical"][key] else None}
                      for key in keys}
            gates[name] = "passed" if all(value["full"]<=1.1*value["baseline"] for value in values.values()) else "failed"
            amplification[name] = values
    wal_ratio = full["wal"]/baseline["wal"] if baseline and full and isinstance(baseline.get("wal"),(int,float)) \
        and baseline["wal"]>0 and isinstance(full.get("wal"),(int,float)) else None
    gates["mutationWal2x"] = "inconclusive" if wal_ratio is None else "passed" if wal_ratio<=2 else "failed"
    gates["twoCompleteChangedValueSweeps"] = "passed" if len(sweep_results)==2 and all(
        row.get("batches")==5000 and row.get("keys")==100000 and row.get("verifiedValues")==100000
        and row.get("changed")==100000 and row.get("checksum") for row in sweep_results) else "inconclusive"
    final = read_json(directory / "containers-final.json")
    complete_container_counters = final and all("RestartCount" in value and all(
        field in value.get("State", {}) for field in ("OOMKilled", "ExitCode")) for value in final.values())
    gates["containerOomAndRestart"] = ("inconclusive" if not complete_container_counters else "failed" if any(
        value["State"]["OOMKilled"] or value["RestartCount"] or value["State"]["ExitCode"] in (9, 137)
        for value in final.values()) else "passed")
    if functional and mode == "query":
        comparison = functional.get("comparison", [])
        gates["diagnosticListLatency"] = ("inconclusive" if len(comparison) != 2 else "passed" if
            all(row["latency"]["p95"] <= 2000 and row["latency"]["p99"] <= 5000 for row in comparison) else "failed")
    window_peaks = {}
    for window in windows:
        window["peakSensitiveHeapObservedMax"] = max(window["sampledHeapUsedMax"],window["stageCheckpointHeapUsedMax"],
                                                    window["gcPreHeapUsedMax"] or 0)
        window_peaks[window["count"]] = max(window_peaks.get(window["count"],0),window["peakSensitiveHeapObservedMax"])
    delta = window_peaks[100000]-window_peaks[10000] if all(count in window_peaks for count in (10000,100000)) else None
    gates["requestWorkingSet64MiB"] = ("inconclusive" if delta is None or len(windows)!=6 or not all(window["closed"] for window in windows)
        or not identity or any(window.get("pid")!=identity["pid"] for window in windows)
        or any(not {"sql.result","response.serialize"}.issubset(window.get("stages",[])) for window in windows)
        or incomplete or not coverage["probePassed"] or not summary or summary.get("dropped")!=0
        or not coverage["workloadGcRecords"] else "passed" if delta<=64*MIB else "failed")
    if functional:
        if functional.get("status") == "failed":
            gates["reportedWorkloadOutcome"] = "failed"
        status = functional.get("functionalStatus")
        if functional.get("error") or functional.get("identityProbeError"):
            gates["functionalProfiles"] = "failed"
        elif status in ("passed", "failed"):
            gates["functionalProfiles"] = status
        elif mode == "full" and functional.get("status") == "failed":
            gates["functionalProfiles"] = "failed"
    sampled = samples > 0 or any(worker["sampledHeapUsedMax"] is not None for worker in workers)
    staged = bool(stages) or any(worker["stageCheckpointHeapUsedMax"] is not None for worker in workers)
    return {"mode": mode, "identity": identity, "sampledHeapUsedMax": heap if sampled else None, "sampledRssMax": rss if sampled else None,
            "gcPreHeapUsedMax": pre, "stageCheckpointHeapUsedMax": checkpoints if staged else None,
            "peakSensitiveHeapObservedMax": observed, "kernelChargedMemoryPeak": peak,
            "samples": samples, "queryMaxMs": query_max, "poolWaitingMax": pool_max,
            "readerRejections": reader_rejections, "unsuccessfulTimingSamples": unsuccessful_timings,
            "response10msHistogram": response_times, "latency": latency, "cycles": cycles,
            "mutationProbes": mutation_probes, "amplification": amplification, "mutationWalRatio": wal_ratio,"sweeps": sweep_results,
            "publication": {"count": sum(publications.values()),"p95UpperMs": publication_p95,"maximumMs": publication_max,
                            "rejections": publication_rejections,"includesPoolAcquisition": True,"classes": publication_latency},
            "httpRequests": http_requests,"httpFailures": http_failures,
            "applicationConnections": {"sampledMaximum": connection_max,"samples": connection_samples,
                "missingSamples": connection_missing,"failedSamples": connection_failures,"reported": reported_connections,
                "bootstrapComplete": bootstrap_complete,
                "scope": "Five-second server samples plus the single shared app pool and explicit operator/worker slot reservations; not an instantaneous sampled upper bound."},
            "sampledLockWaitMaxSeconds": lock_wait_max,
            "requestWindows": windows,"requestWorkingSetDelta": delta,
            "coverage": coverage, "cgroups": groups, "gates": gates,
            "qualificationStatus": "failed" if "failed" in gates.values() else "inconclusive"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("--mode", choices=("query", "full", "probe"), default="full")
    args = parser.parse_args()
    result = summarize(args.directory, args.mode)
    result["interpreter"] = {"path": "scripts/capacity-results.py",
                             "sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    (args.directory / f"{args.mode}-observations.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({key: result[key] for key in ("mode", "qualificationStatus", "gates")}))
