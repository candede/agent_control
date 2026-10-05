import importlib.util
import io
import json
import fnmatch
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


results = module("capacity-results")
runner = module("large-tenant-capacity")


class File:
    def __init__(self, value, name=""):
        self.value = value
        self.name = name

    def exists(self):
        return self.value is not None

    def read_text(self):
        return self.value

    def open(self, **_):
        return io.StringIO(self.value)


class Directory:
    def __init__(self, values):
        self.values = values

    def __truediv__(self, name):
        return File(self.values.get(name), name)

    def glob(self, pattern):
        return [File(value, name) for name, value in self.values.items() if fnmatch.fnmatch(name, pattern)]


class CapacityContracts(unittest.TestCase):
    def test_whole_app_connection_budget_requires_binding_bootstrap_and_actual_counters(self):
        name = "agentcontrol_test_"+"a"*32
        functional = {"database": name,"functionalStatus": "passed","status": "inconclusive",
            "applicationConnections": {"maximumObserved": 4,"limit": 4,"sharedApplicationPool": True,
                                      "status": "passed","coverage": "named clients and reserved slots"},
            "appBootstrap": {"database": name,"user": "agentcontrol_app","poolMaximum": 4,
                             "sharedApplicationPool": True,"routes": [
                                 {"path": path,"status": 200} for path in (
                                     "/api/capabilities","/api/data-sync/state","/api/inventory/refresh-jobs")]}}
        memory = [{"event": "database-diagnostics","application_connections": 4},
                  {"event": "summary","dropped": 0}]
        def check(value, records):
            return results.summarize(Directory({"query-result.json": json.dumps(value),
                "query-memory.jsonl": "\n".join(map(json.dumps,records))}),"query")
        self.assertEqual(check(functional,memory)["gates"]["applicationConnectionBudget4"],"passed")
        for records in (memory[1:], [{"event": "database-diagnostics"}]+memory[1:],
                        [{"event": "database-diagnostics","application_connections": 0}]+memory[1:],
                        memory+[{"event": "database-diagnostics-failed"}],
                        memory[:-1]+[{"event": "summary","dropped": 1}]):
            self.assertEqual(check(functional,records)["gates"]["applicationConnectionBudget4"],"inconclusive")
        for field in ("applicationConnections","appBootstrap"):
            self.assertEqual(check({k:v for k,v in functional.items() if k != field},memory)["gates"]["applicationConnectionBudget4"],"inconclusive")
        for field in ("applicationConnections","appBootstrap"):
            changed = {**functional,field: {**functional[field],"sharedApplicationPool": False}}
            self.assertEqual(check(changed,memory)["gates"]["applicationConnectionBudget4"],"failed")
        changed = {**functional,"applicationConnections": {**functional["applicationConnections"],"maximumObserved": 5}}
        self.assertEqual(check(changed,memory)["gates"]["applicationConnectionBudget4"],"failed")
        self.assertEqual(check(functional,[{"event": "database-diagnostics","application_connections": 5}]+memory[1:])
                         ["gates"]["applicationConnectionBudget4"],"failed")
        changed = {**functional,"status": "failed"}
        result = check(changed,memory)
        self.assertEqual(result["gates"]["functionalProfiles"],"passed")
        self.assertEqual(result["gates"]["reportedWorkloadOutcome"],"failed")
        self.assertEqual(result["qualificationStatus"],"failed")

    def test_disk_counter_retries_a_failed_measurement_without_accepting_partial_output(self):
        events = []
        with patch.object(runner, "docker", side_effect=[
            SimpleNamespace(returncode=1, stdout="15 /var/lib/postgresql/data\n", stderr="du: transient removed file"),
            SimpleNamespace(returncode=0, stdout="17\t/var/lib/postgresql/data\n", stderr=""),
        ]) as execute, patch.object(runner.time, "sleep") as sleep:
            self.assertEqual(runner.owned_volume_bytes("owned-postgres", events.append), 17*1024)
        self.assertEqual(execute.call_count, 2)
        execute.assert_called_with("exec", "owned-postgres", "du", "-sk", "/var/lib/postgresql/data", check=False, timeout=5)
        sleep.assert_called_once_with(.2)
        self.assertFalse(events[0]["accepted"])
        self.assertIsNone(events[0]["bytes"])
        self.assertEqual(events[0]["stderr"], "du: transient removed file")
        self.assertTrue(events[1]["accepted"])

    def test_disk_counter_never_invents_zero_from_missing_malformed_or_foreign_output(self):
        events = []
        with patch.object(runner, "docker", side_effect=[
            SimpleNamespace(returncode=0, stdout="", stderr=""),
            SimpleNamespace(returncode=0, stdout="NaN /var/lib/postgresql/data\n", stderr=""),
            SimpleNamespace(returncode=0, stdout="0 /unowned/path\n", stderr=""),
        ]) as execute, patch.object(runner.time, "sleep") as sleep:
            self.assertIsNone(runner.owned_volume_bytes("owned-postgres", events.append))
        self.assertEqual(execute.call_count, 3)
        self.assertEqual(sleep.call_count, 2)
        self.assertEqual([event["bytes"] for event in events], [None, None, None])

    def test_disk_counter_distinguishes_measured_zero_from_a_control_plane_timeout(self):
        events = []
        with patch.object(runner, "docker", return_value=SimpleNamespace(
            returncode=0, stdout="0 /var/lib/postgresql/data\n", stderr="",
        )):
            self.assertEqual(runner.owned_volume_bytes("owned-postgres", events.append), 0)
        self.assertTrue(events[0]["accepted"])
        events = []
        with patch.object(runner, "docker", side_effect=runner.subprocess.TimeoutExpired("owned du", 5)) as execute, \
                patch.object(runner.time, "sleep") as sleep:
            self.assertIsNone(runner.owned_volume_bytes("owned-postgres", events.append))
        execute.assert_called_once()
        sleep.assert_not_called()
        self.assertIsNone(events[0]["exit"])
        self.assertIsNone(events[0]["bytes"])

    def test_diagnostic_latency_failure_does_not_falsify_functional_correctness(self):
        value = {"status": "failed", "functionalStatus": "passed",
                 "comparison": [{"count": count, "latency": {"p95": 6000, "p99": 6000}}
                                for count in (10000, 100000)]}
        result = results.summarize(Directory({"query-result.json": json.dumps(value)}), "query")
        self.assertEqual(result["gates"]["functionalProfiles"], "passed")
        self.assertEqual(result["gates"]["diagnosticListLatency"], "failed")
        self.assertEqual(result["qualificationStatus"], "failed")
        value["identityProbeError"] = {"message": "actual producer failure"}
        result = results.summarize(Directory({"query-result.json": json.dumps(value)}), "query")
        self.assertEqual(result["gates"]["functionalProfiles"], "failed")

    def test_node24_actual_gc_fields_and_missing_coverage_fail_closed(self):
        directory = Directory({"full-stdout.log": "[42:0x123:0] 20 ms: gc=mc start_object_size=90000000 end_object_size=8000000 allocated=100000\n"})
        value = results.summarize(directory, "full")
        self.assertEqual(value["gcPreHeapUsedMax"], 90000000)
        self.assertEqual(value["coverage"]["isolates"][0]["allocatedBytes"], 100000)
        self.assertEqual(value["gates"]["heapObserved615MiB"], "inconclusive")

    def test_missing_gc_size_and_zero_counters_are_not_invented(self):
        directory = Directory({"full-stdout.log": "[42:0x123:0] 20 ms: gc=mc start_memory_size=90000000 allocated=100000\n"})
        value = results.summarize(directory, "full")
        self.assertEqual(value["coverage"]["malformedOrIncomplete"], 1)
        self.assertIsNone(value["gcPreHeapUsedMax"] if not value["coverage"]["rawGcRecords"] else None)
        self.assertEqual(value["gates"]["test-postgresZeroOomAndMaxEvents"], "inconclusive")

    def test_another_isolate_and_missing_container_fields_cannot_fill_coverage(self):
        records = [{"event": "identity", "pid": 42, "isolate": 0},
                   *[{"event": "checkpoint", "stage": stage, "heapUsed": 100} for stage in results.STAGES],
                   {"event": "summary", "dropped": 0}]
        directory = Directory({"full-memory.jsonl": "\n".join(json.dumps(record) for record in records),
                               "full-stdout.log": "[42:0x123:1] 20 ms: gc=mc start_object_size=900 end_object_size=800 allocated=100\n",
                               "probe-result.json": '{"status":"passed"}',
                               "containers-final.json": '{"test-db":{"State":{}}}'})
        value = results.summarize(directory, "full")
        self.assertEqual(value["coverage"]["workloadGcRecords"], 0)
        self.assertEqual(value["gates"]["heapObserved615MiB"], "inconclusive")
        self.assertEqual(value["gates"]["containerOomAndRestart"], "inconclusive")

    def test_request_gc_windows_use_synchronous_markers_not_guessed_clock_alignment(self):
        comparison, raw = [], []
        for count, peak in ((10000,20*results.MIB),(100000,30*results.MIB)):
            windows = []
            for index in range(3):
                windows.append({"index": index,"startedAt": 123,"finishedAt": 456,
                                "sampledHeapUsedMax": 10*results.MIB,"stageCheckpointHeapUsedMax": 12*results.MIB,
                                "stages": ["sql.result","response.serialize"]})
                marker = {"pid": 42,"count": count,"index": index}
                raw.append("CAPACITY_REQUEST_WINDOW "+json.dumps({**marker,"state": "begin"}))
                raw.append(f"[42:0x123:0] 999999 ms: gc=mc start_object_size={peak} end_object_size=100 allocated=100")
                raw.append("[43:0x456:0] 1 ms: gc=mc start_object_size=900000000 end_object_size=100 allocated=100")
                raw.append("CAPACITY_REQUEST_WINDOW "+json.dumps({**marker,"state": "end"}))
            comparison.append({"count": count,"requestWindows": windows,"latency": {"p95": 1,"p99": 1}})
        memory = [{"event": "identity","pid": 42,"isolate": 0},{"event": "summary","dropped": 0}]
        result = results.summarize(Directory({"query-stdout.log": "\n".join(raw),"query-result.json": json.dumps({"comparison": comparison}),
            "query-memory.jsonl": "\n".join(map(json.dumps,memory)),"probe-result.json": '{"status":"passed"}'}),"query")
        self.assertEqual(result["requestWorkingSetDelta"],10*results.MIB)
        self.assertEqual(result["gates"]["requestWorkingSet64MiB"],"passed")

    def test_lease_worker_samples_cannot_be_replaced_by_parent_or_raw_gc_coverage(self):
        def worker(pid, terminal=True, pool=True, peak=100):
            rows = [{"event": "identity", "pid": pid, "isolate": 0, "node": "24.20.0", "v8": "13.6.233.17-node.53",
                     "heap": {"heap_size_limit": 905969664}, "execArgv": ["--max-old-space-size=768"]},
                    {"event": "sample", "pid": pid, "isolate": 0, "heapUsed": peak, "heapTotal": peak, "rss": peak,
                     "external": 0, "arrayBuffers": 0, "eventLoopMaxMs": 1, "pool": {"total": 1, "waiting": 0, "idle": 0,
                     "maximum": 4, "foreground": 0, "queue": 0} if pool else None},
                    {"event": "checkpoint", "pid": pid, "isolate": 0, "stage": "sql.result", "heapUsed": peak}]
            if terminal:
                rows.append({"event": "summary", "pid": pid, "isolate": 0, "dropped": 0})
            return "\n".join(map(json.dumps, rows))
        raw = [{"pid": pid, "isolate": "0x123:0", "records": 1, "incomplete": 0, "gcPreHeapUsedMax": 90}
               for pid in (43, 44)]
        gc = {str(row["pid"]): row for row in raw}
        directory = Directory({"lease-worker-43-memory.jsonl": worker(43),
                               "lease-worker-44-memory.jsonl": worker(44, terminal=False)})
        coverage = results.worker_memory(directory, gc)
        self.assertTrue(coverage[0]["covered"])
        self.assertFalse(coverage[1]["covered"])
        self.assertIsNone(coverage[1]["dropped"])
        directory.values["lease-worker-44-memory.jsonl"] = worker(44, pool=False)
        self.assertFalse(results.worker_memory(directory, gc)[1]["covered"])
        directory.values["lease-worker-44-memory.jsonl"] = worker(44)
        parent = [{"event": "identity", "pid": 42, "isolate": 0},
                  *[{"event": "checkpoint", "stage": stage, "heapUsed": 100} for stage in results.STAGES],
                  {"event": "summary", "dropped": 0}]
        directory.values["full-memory.jsonl"] = "\n".join(map(json.dumps, parent))
        directory.values["full-stdout.log"] = "\n".join(
            f"[{pid}:0x123:0] 20 ms: gc=mc start_object_size=90 end_object_size=80 allocated=100" for pid in (42, 43, 44))
        directory.values["probe-result.json"] = '{"status":"passed"}'
        self.assertEqual(results.summarize(directory, "full")["gates"]["heapObserved615MiB"], "passed")
        missing = [json.loads(line) for line in worker(44).splitlines()]
        del missing[1]["heapTotal"]
        directory.values["lease-worker-44-memory.jsonl"] = "\n".join(map(json.dumps, missing))
        invalid = results.worker_memory(directory, gc)[1]
        self.assertFalse(invalid["covered"])
        self.assertIsNone(invalid["sampledHeapUsedMax"])
        directory.values["lease-worker-44-memory.jsonl"] = worker(44, peak=700*results.MIB)
        value = results.summarize(directory, "full")
        self.assertEqual(value["peakSensitiveHeapObservedMax"], 700*results.MIB)
        self.assertEqual(value["stageCheckpointHeapUsedMax"], 700*results.MIB)
        self.assertEqual(value["gates"]["heapObserved615MiB"], "failed")

    def test_resource_model_is_disk_backed_fixed_and_isolated(self):
        saved = []
        with patch.object(runner, "save", side_effect=lambda _path, value: saved.append(value)):
            runner.fixture(Path("artifacts/phase06/config-contract"), "agent-control-ltdp-" + "a"*32, "synthetic:local","synthetic-browser:local")
        value = saved[0]
        app, pg, controller = [value["services"][name] for name in ("test-db", "test-postgres", "controller")]
        self.assertEqual((app["mem_limit"], app["cpus"]), (1536*results.MIB, 1.5))
        self.assertEqual((pg["mem_limit"], pg["cpus"]), (1024*results.MIB, .5))
        self.assertEqual((controller["mem_limit"], controller["cpus"]), (1024*results.MIB, 1))
        self.assertEqual(controller["image"],"synthetic-browser:local")
        self.assertEqual(controller["environment"]["PLAYWRIGHT_BROWSERS_PATH"],"/ms-playwright")
        self.assertEqual(app["environment"]["NODE_OPTIONS"], "--max-old-space-size=768")
        self.assertEqual(pg["volumes"], ["large-tenant-data:/var/lib/postgresql/data"])
        for setting in ["shared_buffers=32MB", "work_mem=4MB", "maintenance_work_mem=64MB", "max_parallel_workers_per_gather=0", "statement_timeout=15000"]:
            self.assertIn(setting, pg["command"])
        self.assertEqual(value["networks"], {"fixture": {"internal": True}})
        self.assertTrue(all("ports" not in service and "tmpfs" not in service for service in value["services"].values()))

    def test_cgroup_cache_and_backend_rss_remain_distinct(self):
        text = ("123\n1790820000.000000001\nmemory.peak\n900000000\nmemory.max\n1073741824\n"
                "memory.events\nmax 0\noom 0\noom_kill 0\nmemory.stat\nfile 800000000\n"
                "memory.swap.current\n0\n/proc/1/status:Name:\tpostgres\n/proc/1/status:VmRSS:\t8192 kB\n")
        value = results.cgroup_summary(Directory({"test-postgres-continuous-cgroup.log": text}), "test-postgres")
        self.assertEqual(value["memoryPeak"], 900000000)
        self.assertEqual(value["fileCacheMax"], 800000000)
        self.assertEqual(value["backendRssMax"], 8192*1024)

    def test_actual_postgres_settings_must_match_not_just_compose_text(self):
        text = ("shared_buffers|4096|8kB\nwork_mem|4096|kB\nmaintenance_work_mem|65536|kB\n"
                "max_parallel_workers_per_gather|0|\nstatement_timeout|15000|ms\n"
                "data_directory|/var/lib/postgresql/data/pgdata|\ntemp_tablespaces||\nPostgreSQL 17\n")
        self.assertEqual(runner.verify_effective_postgres(text)["shared_buffers"], ["4096", "8kB"])
        for wrong in (text.replace("shared_buffers|4096", "shared_buffers|16384"),
                      text.replace("work_mem|4096", "work_mem|8192"),
                      text.replace("statement_timeout|15000", "statement_timeout|30000"),
                      text.replace("temp_tablespaces||", "temp_tablespaces|outside|"),
                      text.replace("data_directory|/var/lib/postgresql/data/pgdata|", "")):
            with self.assertRaisesRegex(RuntimeError, "capacity_postgres_setting_drift"):
                runner.verify_effective_postgres(wrong)

    def test_missing_reads_and_incomplete_cycles_cannot_pass_amplification_or_growth(self):
        rows = [{"event": "fixed-mutation-probe","count": count,"keys": 20,"wal": wal,
                 "physical": {"rows": 100,"insert": 40,"update": 40,"delete": 20}}
                for count,wal in ((10000,100),(100000,201))]
        rows += [{"event": "cycle","cycle": i,"complete": False,"settled": {"rss": 1,"heapUsed": 1}} for i in range(1,6)]
        value = results.summarize(Directory({"full-memory.jsonl": "\n".join(map(json.dumps,rows))}),"full")
        self.assertEqual(value["gates"]["mutationWriteRows10Percent"],"passed")
        self.assertEqual(value["gates"]["mutationReadTuples10Percent"],"inconclusive")
        self.assertEqual(value["gates"]["mutationWal2x"],"failed")
        self.assertEqual(value["gates"]["settledFiveCycleGrowth"],"inconclusive")

    def test_failed_and_unknown_reader_timings_cannot_make_success_latency_pass(self):
        rows = [{"event": "reader","kind": "detail","milliseconds": 1,"succeeded": False}]*1000
        rows += [{"event": "reader","kind": "detail","milliseconds": 1},
                 {"event": "reader","kind": "detail","milliseconds": 6000,"succeeded": True}]
        value = results.summarize(Directory({"full-memory.jsonl": "\n".join(map(json.dumps,rows))}),"full")
        self.assertEqual(value["latency"]["detail"]["requests"],1)
        self.assertEqual(value["gates"]["detailLatency"],"failed")
        self.assertEqual(value["gates"]["thousandRequests"],"inconclusive")
        self.assertEqual(value["unsuccessfulTimingSamples"],{"failed": 1000,"unknown": 1})

    def test_amplification_allows_less_work_but_requires_real_nonnegative_counters(self):
        rows = [{"event": "fixed-mutation-probe","count": count,"keys": 20,"wal": count,
                 "physical": {"readMethod": "transaction-difference-v2",
                              **{key: work for key in ("rows","insert","update","delete","sequentialTuples","indexTuples","heapFetches","scans")}}}
                for count,work in ((10000,100),(100000,20))]
        value = results.summarize(Directory({"full-memory.jsonl": "\n".join(map(json.dumps,rows))}),"full")
        self.assertEqual(value["gates"]["mutationReadTuples10Percent"],"passed")
        rows[1]["physical"]["scans"] = -1
        value = results.summarize(Directory({"full-memory.jsonl": "\n".join(map(json.dumps,rows))}),"full")
        self.assertEqual(value["gates"]["mutationReadTuples10Percent"],"inconclusive")

    def test_unsubtracted_pending_scan_counters_cannot_pass_read_amplification(self):
        rows = [{"event": "fixed-mutation-probe","count": count,"keys": 20,"wal": count,
                 "physical": {key: 10 for key in ("rows","insert","update","delete","sequentialTuples","indexTuples","heapFetches","scans")}}
                for count in (10000,100000)]
        value = results.summarize(Directory({"full-memory.jsonl": "\n".join(map(json.dumps,rows))}),"full")
        self.assertEqual(value["gates"]["mutationReadTuples10Percent"],"inconclusive")
        self.assertEqual(value["gates"]["mutationWriteRows10Percent"],"passed")


if __name__ == "__main__":
    unittest.main()
