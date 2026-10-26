import uvicorn


def main() -> None:
    uvicorn.run(
        "agent_control_mcp.service:create_app",
        factory=True,
        host="0.0.0.0",
        port=8000,
        proxy_headers=False,
        access_log=False,
        limit_concurrency=32,
        backlog=64,
        timeout_keep_alive=5,
        timeout_graceful_shutdown=65,
    )


if __name__ == "__main__":
    main()
