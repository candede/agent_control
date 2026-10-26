"""Loopback-only test tunnel: Docker internal networks intentionally publish no NAT ports."""

import re
import socketserver
import subprocess
import sys
import threading

import pytest

NODE = """
const net = require('net');
const socket = net.connect(10000, '127.0.0.1');
process.stdin.pipe(socket);
socket.pipe(process.stdout);
process.stdin.on('end', () => socket.end());
socket.on('error', () => process.exit(1));
socket.on('close', () => process.exit(0));
"""


def main():
    container, scratch, *selectors = sys.argv[1:]
    if not re.fullmatch(r"[a-f0-9]{64}", container):
        raise ValueError("Exact owned container ID required.")
    processes = set()
    lock = threading.Lock()
    capacity = threading.BoundedSemaphore(16)

    class Tunnel(socketserver.BaseRequestHandler):
        def handle(self):
            if not capacity.acquire(blocking=False):
                return
            process = subprocess.Popen(
                ["docker", "exec", "-i", container, "node", "-e", NODE],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                bufsize=0,
            )
            with lock:
                processes.add(process)

            def send():
                try:
                    while data := self.request.recv(65536):
                        process.stdin.write(data)
                except OSError:
                    pass
                finally:
                    process.stdin.close()

            incoming = threading.Thread(target=send, daemon=True)
            incoming.start()
            try:
                while data := process.stdout.read(65536):
                    self.request.sendall(data)
            except OSError:
                pass
            finally:
                self.request.close()
                process.terminate()
                process.wait(timeout=5)
                with lock:
                    processes.discard(process)
                capacity.release()

    class Server(socketserver.ThreadingTCPServer):
        daemon_threads = True
        request_queue_size = 16

    with Server(("127.0.0.1", 0), Tunnel) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            endpoint = f"http://127.0.0.1:{server.server_address[1]}"
            return pytest.main(
                [
                    *selectors,
                    f"--azure-oauth-endpoint={endpoint}",
                    f"--basetemp={scratch}",
                ]
            )
        finally:
            server.shutdown()
            with lock:
                remaining = list(processes)
            for process in remaining:
                if process.poll() is None:
                    process.terminate()
            for process in remaining:
                process.wait(timeout=5)
            thread.join(timeout=5)


if __name__ == "__main__":
    sys.exit(main())
