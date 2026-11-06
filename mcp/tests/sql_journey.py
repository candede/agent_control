"""Real SDK tools -> exact loopback canonical API -> isolated SQL, never a provider."""

import asyncio
import json
import shutil
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import conftest
import httpx2
from conftest import Entra, tokens
from cryptography.fernet import Fernet
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.types import CallToolResult, Implementation
from public_contract import canonical_result, public_request

from agent_control_mcp.config import Settings
from agent_control_mcp.service import build_service


async def main(payload):
    target = urlsplit(payload["url"])
    assert target.scheme == "http" and target.hostname == "127.0.0.1" and target.port
    assert target.path == "/api" and not target.query and not target.fragment
    assert payload["client"] in {
        "33333333-3333-3333-3333-333333333333",
        "44444444-4444-4444-4444-444444444444",
    }
    conftest.CLIENT = payload["client"]
    root = Path(payload["state"])
    assert root.parent == Path("/evidence") and root.name.startswith("mcp-sql-")
    assert not await asyncio.to_thread(root.exists) and len(payload["calls"]) <= 32
    await asyncio.to_thread(root.mkdir, mode=0o700)
    network = httpx2.AsyncClient(trust_env=False, follow_redirects=False)
    original = httpx2.AsyncClient.__init__
    runtime = None
    authority_entries = 0
    try:
        values = {
            "MCP_TENANT_ID": "11111111-1111-1111-1111-111111111111",
            "MCP_CLIENT_ID": payload["client"],
            "MCP_API_CLIENT_ID": "22222222-2222-2222-2222-222222222222",
            "MCP_API_ORIGIN": "https://api.example.test",
            "MCP_PUBLIC_URL": "https://mcp.example.test/mcp",
            "MCP_ALLOWED_CLIENT_REDIRECT_URIS": '["https://client.example.test/callback"]',
            "MCP_OAUTH_STORAGE_PATH": str(root / "oauth"),
        }
        for name, content in (
            ("CLIENT_SECRET", "synthetic-confidential-client-secret"),
            ("JWT_SIGNING_KEY", Fernet.generate_key().decode()),
            ("OAUTH_ENCRYPTION_KEY", json.dumps([Fernet.generate_key().decode()])),
            ("METADATA_TOKEN", Fernet.generate_key().decode()),
        ):
            path = root / name
            path.write_text(content)
            path.chmod(0o600)
            values[f"MCP_{name}_FILE"] = str(path)
        settings = Settings.from_env(values)
        entra = Entra(settings)
        entra.oid = payload["oid"]

        async def route(request):
            nonlocal authority_entries
            if request.url.host == "login.microsoftonline.com":
                if request.url.path.endswith("/keys"):
                    return httpx2.Response(
                        200, json={"keys": [entra.key.as_dict(private=False), payload["jwk"]]}
                    )
                if request.url.path.endswith("/token") and parse_qs(request.content.decode()).get(
                    "requested_token_use"
                ) == ["on_behalf_of"]:
                    return httpx2.Response(
                        200,
                        json={
                            "access_token": payload["token"],
                            "token_type": "Bearer",
                            "expires_in": 3600,
                        },
                    )
                return await entra.route(request)
            assert request.url.host == "api.example.test"
            authority_entries += int(request.url.path == "/api/mcp/authenticated-entry")
            headers = {
                key: value for key, value in request.headers.items() if key.lower() != "host"
            }
            assert "cookie" not in headers
            return await network.request(
                request.method,
                f"http://127.0.0.1:{target.port}" + request.url.raw_path.decode(),
                headers=headers,
                content=await request.aread(),
            )

        def init(client, *args, **kwargs):
            kwargs.setdefault("transport", httpx2.MockTransport(route))
            original(client, *args, **kwargs)

        httpx2.AsyncClient.__init__ = init
        runtime = build_service(settings, transport=httpx2.MockTransport(route))
        app = runtime.app.app
        async with app.router.lifespan_context(app):
            async with httpx2.AsyncClient(
                base_url="https://mcp.example.test", transport=httpx2.ASGITransport(app=runtime.app)
            ) as browser:
                _, issued = await tokens(browser)
                browser.headers["Authorization"] = "Bearer " + issued["access_token"]
                async with streamable_http_client(
                    "https://mcp.example.test/mcp", http_client=browser
                ) as (read, write):
                    async with ClientSession(
                        read, write, client_info=Implementation(name="SQL SDK client", version="1")
                    ) as session:
                        initialized = await session.initialize()
                        listed = await session.list_tools()
                        schemas = [
                            tool.model_dump(mode="json", by_alias=True, exclude_none=True)
                            for tool in listed.tools
                        ]
                        profile = await network.get(
                            f"http://127.0.0.1:{target.port}/api/mcp/access-profile",
                            headers={"Authorization": "Bearer " + payload["token"]},
                        )
                        assert profile.status_code == 200
                        async with httpx2.AsyncClient(
                            base_url="https://mcp.example.test",
                            transport=httpx2.ASGITransport(app=runtime.app),
                        ) as private:
                            metadata = await private.post(
                                "/internal/mcp-metadata",
                                headers={
                                    "X-Agent-Control-Mcp-Metadata-Token": (
                                        settings.metadata_key.decode()
                                    )
                                },
                                json=profile.json(),
                            )
                        assert metadata.status_code == 200
                        assert metadata.json()["tools"] == schemas
                        assert metadata.json()["instructions"] == initialized.instructions
                        results, trace = [], []
                        for call in payload["calls"]:
                            name, request = public_request(call["name"], call["request"])
                            started = time.perf_counter()
                            result = await session.call_tool(
                                name,
                                {"request": request},
                                meta={
                                    "com.agentcontrol/origin": {
                                        "callingAgent": {"id": "synthetic-agent"}
                                    }
                                },
                            )
                            assert isinstance(result, CallToolResult) and not result.is_error, (
                                result
                            )
                            wire = result.model_dump(mode="json", by_alias=True, exclude_none=True)
                            document = canonical_result(call["name"], wire)["structuredContent"]
                            trace.append(
                                {
                                    "tool": name,
                                    "status": 200,
                                    "bytes": len(json.dumps(wire).encode()),
                                    "seconds": time.perf_counter() - started,
                                }
                            )
                            if "expected" in call:
                                for field in ("selection", "inventorySelection"):
                                    if field in document and "validatedAt" in document[field]:
                                        actual = datetime.fromisoformat(
                                            document[field]["validatedAt"]
                                        )
                                        prior = datetime.fromisoformat(
                                            call["expected"][field]["validatedAt"]
                                        )
                                        assert actual.tzinfo and prior <= actual <= datetime.now(
                                            UTC
                                        )
                                        call["expected"][field]["validatedAt"] = document[field][
                                            "validatedAt"
                                        ]
                                assert document == call["expected"], call["name"]
                            results.append(document)
                        assert sum(call["bytes"] for call in trace) <= 4 * 1024 * 1024
                        assert sum(call["seconds"] for call in trace) <= 180
                        assert all(call["seconds"] <= 60 for call in trace)
                        assert authority_entries == 2
                        print(
                            json.dumps(
                                {
                                    "results": results,
                                    "trace": trace,
                                    "authorityEntries": authority_entries,
                                    "tools": len(schemas),
                                    "metadataEquality": True,
                                },
                                ensure_ascii=False,
                            )
                        )
    finally:
        httpx2.AsyncClient.__init__ = original
        if runtime:
            await runtime.http.aclose()
        await network.aclose()
        await asyncio.to_thread(shutil.rmtree, root)


if __name__ == "__main__":
    asyncio.run(main(json.loads(sys.stdin.buffer.read(2 * 1024 * 1024))))
