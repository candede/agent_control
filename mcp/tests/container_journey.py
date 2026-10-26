"""Real HTTP journey driver for the exact-owned, offline container fixture."""

import asyncio
import json
import sys
import time
from pathlib import Path

import httpx2
from conftest import OTHER, USER, connect

PUBLIC = "https://mcp.example.test"
RECEIPT = Path("/work/connection.json")


class LocalNetwork(httpx2.AsyncBaseTransport):
    def __init__(self):
        self.transport = httpx2.AsyncHTTPTransport()

    async def handle_async_request(self, request):
        target = "http://mcp:8000" + request.url.raw_path.decode()
        forwarded = httpx2.Request(
            request.method, target, headers=request.headers, stream=request.stream
        )
        return await self.transport.handle_async_request(forwarded)

    async def aclose(self):
        await self.transport.aclose()


async def rpc(browser, token, *, drain=False):
    headers = {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    response = await browser.post(
        "/mcp",
        headers=headers,
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": {"name": "Isolated container fixture", "version": "1"},
            },
        },
    )
    assert response.status_code == 200, response.text
    headers["Mcp-Session-Id"] = response.headers["mcp-session-id"]
    initialized = await browser.post(
        "/mcp",
        headers=headers,
        json={"jsonrpc": "2.0", "method": "notifications/initialized"},
    )
    assert initialized.status_code == 202, initialized.text
    catalog = await browser.post(
        "/mcp",
        headers=headers,
        json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
    )
    assert catalog.status_code == 200, catalog.text
    assert len(catalog.json()["result"]["tools"]) == 124
    if drain:
        await asyncio.to_thread(Path("/work/drain-started.json").write_text, '{"started":true}')
    response = await browser.post(
        "/mcp",
        headers=headers,
        json={
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "get_capability_check_progress" if drain else "list_capabilities",
                "arguments": {"request": {}},
            },
        },
    )
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    assert not result.get("isError"), result
    assert result["structuredContent"] == ({"progress": None} if drain else {"value": []}), result
    if not drain:
        await browser.delete("/mcp", headers=headers)


async def main(mode):
    started = time.monotonic()
    if mode == "capacity":
        await capacity()
        return
    async with httpx2.AsyncClient(
        base_url=PUBLIC, transport=LocalNetwork(), follow_redirects=False
    ) as browser:
        if mode in {"cold", "reconnect"}:
            client, data = await connect(browser)
            response = await browser.post("/token", data=data)
            assert response.status_code == 200, response.text
            connection = {"client": client, **response.json()}
            await asyncio.to_thread(RECEIPT.write_text, json.dumps(connection))
            await asyncio.to_thread(RECEIPT.chmod, 0o600)
        else:
            connection = json.loads(await asyncio.to_thread(RECEIPT.read_text))
        token = connection["access_token"]
        if mode == "revoked":
            response = await browser.get(
                "/diagnostics", headers={"Authorization": "Bearer " + token}
            )
            assert response.status_code == 401
        elif mode == "revoke":
            response = await browser.post(
                "/revoke", data={"client_id": connection["client"], "token": token}
            )
            assert response.status_code == 200, response.text
        else:
            assert (await browser.get("/health")).status_code == 200
            assert (await browser.get("/ready")).status_code == 200
            for headers in ({}, {"Authorization": "Bearer invalid"}):
                assert (await browser.get("/diagnostics", headers=headers)).status_code == 401
            wrong_host = await browser.get("/ready", headers={"Host": "wrong.example.test"})
            assert wrong_host.status_code in {400, 421}
            wrong_origin = await browser.post(
                "/mcp",
                headers={
                    "Origin": "https://wrong.example.test",
                    "Authorization": "Bearer " + token,
                },
                json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
            )
            assert wrong_origin.status_code in {400, 403, 421}
            diagnostics = await browser.get(
                "/diagnostics", headers={"Authorization": "Bearer " + token}
            )
            assert diagnostics.status_code == 200, diagnostics.text
            await rpc(browser, token, drain=mode == "drain")
    print(json.dumps({"mode": mode, "outcome": "passed", "seconds": time.monotonic() - started}))


async def capacity():
    started = time.monotonic()
    clients = []
    try:
        for index, oid in enumerate((USER, OTHER)):
            browser = httpx2.AsyncClient(
                base_url=PUBLIC, transport=LocalNetwork(), follow_redirects=False, timeout=60
            )
            clients.append(browser)
            _, data = await connect(
                browser,
                upstream_code="synthetic-entra-code"
                if index == 0
                else "synthetic-entra-code-other",
            )
            issued = await browser.post("/token", data=data)
            assert issued.status_code == 200, issued.text
            headers = {
                "Authorization": "Bearer " + issued.json()["access_token"],
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
            }
            response = await browser.post(
                "/mcp",
                headers=headers,
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-11-25",
                        "capabilities": {},
                        "clientInfo": {
                            "name": "Capacity A" if index == 0 else "Capacity B",
                            "version": "1",
                        },
                    },
                },
            )
            assert response.status_code == 200, response.text
            headers["Mcp-Session-Id"] = response.headers["mcp-session-id"]
            response = await browser.post(
                "/mcp",
                headers=headers,
                json={
                    "jsonrpc": "2.0",
                    "method": "notifications/initialized",
                },
            )
            assert response.status_code == 202
            browser.fixture_headers = headers
            browser.fixture_oid = oid

        async def call(index):
            browser = clients[index % 2]
            response = await browser.post(
                "/mcp",
                headers=browser.fixture_headers,
                json={
                    "jsonrpc": "2.0",
                    "id": index + 2,
                    "method": "tools/call",
                    "params": {
                        "name": "get_capability_check_progress",
                        "arguments": {"request": {"retry": "failed"}},
                        "_meta": {
                            "com.agentcontrol/origin": {"callingAgent": {"id": browser.fixture_oid}}
                        },
                    },
                },
            )
            assert response.status_code in {200, 503}, response.text
            if response.status_code == 503:
                return {"outcome": "backpressure", "bytes": len(response.content)}
            result = response.json()["result"]
            if result.get("isError"):
                error = json.loads(result["content"][0]["text"])
                assert error["status"] == 503, error
                return {"outcome": "backpressure", "bytes": len(response.content)}
            assert result["structuredContent"] == {
                "progress": {
                    "checks": [
                        {
                            "capabilityId": "graph.directory.read",
                            "state": "complete" if index % 2 == 0 else "checking",
                        }
                    ]
                }
            }, result
            return {"outcome": "passed", "bytes": len(response.content)}

        isolated = await asyncio.gather(*(call(index) for index in range(4)))
        assert all(row["outcome"] == "passed" for row in isolated)
        burst_started = time.monotonic()
        burst = await asyncio.wait_for(asyncio.gather(*(call(index) for index in range(64))), 60)
        burst_seconds = time.monotonic() - burst_started
        assert any(row["outcome"] == "backpressure" for row in burst)
        recovered = await asyncio.gather(*(call(index) for index in range(2)))
        assert all(row["outcome"] == "passed" for row in recovered)
        print(
            json.dumps(
                {
                    "mode": "capacity",
                    "outcome": "passed",
                    "principals": 2,
                    "isolatedCalls": 4,
                    "burstCalls": 64,
                    "burstPassed": sum(row["outcome"] == "passed" for row in burst),
                    "burstRejected": sum(row["outcome"] == "backpressure" for row in burst),
                    "burstBytes": sum(row["bytes"] for row in burst),
                    "burstSeconds": burst_seconds,
                    "recoveryCalls": 2,
                    "seconds": time.monotonic() - started,
                    "scope": (
                        "Synthetic HTTP/SDK load under actual container limits, "
                        "not provider or production capacity"
                    ),
                }
            )
        )
    finally:
        for browser in clients:
            await browser.aclose()


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1]))
