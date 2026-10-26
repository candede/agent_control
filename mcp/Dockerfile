FROM python:3.14.6-slim-bookworm@sha256:4c92ffcde4dd6f1ff72a24518f49fd4990b27134987dfa31a733badde66df9f8 AS dependencies
ENV PIP_INDEX_URL=https://packagefeedproxy.microsoft.io/pypi/simple \
    PIP_EXTRA_INDEX_URL= \
    UV_INDEX_URL=https://packagefeedproxy.microsoft.io/pypi/simple \
    UV_PYTHON_DOWNLOADS=never \
    UV_NO_CACHE=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /opt/mcp
RUN python -m pip install --no-cache-dir --index-url https://packagefeedproxy.microsoft.io/pypi/simple uv==0.12.17
COPY mcp/pyproject.toml mcp/uv.lock ./
COPY mcp/src src
RUN uv sync --frozen --no-dev --no-editable --index-url https://packagefeedproxy.microsoft.io/pypi/simple

FROM python:3.14.6-slim-bookworm@sha256:4c92ffcde4dd6f1ff72a24518f49fd4990b27134987dfa31a733badde66df9f8 AS runtime
ENV PATH=/opt/mcp/.venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    FASTMCP_ENABLE_RICH_LOGGING=false \
    HOME=/var/lib/agent-control-mcp \
    PIP_INDEX_URL=https://packagefeedproxy.microsoft.io/pypi/simple \
    PIP_EXTRA_INDEX_URL=
WORKDIR /opt/mcp
COPY --from=dependencies /opt/mcp/.venv .venv
RUN mkdir -p /var/lib/agent-control-mcp/oauth && chown -R 10001:10001 /var/lib/agent-control-mcp && chmod 700 /var/lib/agent-control-mcp/oauth
USER 10001:10001
EXPOSE 8000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=5s --timeout=5s --start-period=15s --retries=6 CMD ["python", "-m", "agent_control_mcp.healthcheck"]
ENTRYPOINT ["agent-control-mcp"]

FROM dependencies AS test
RUN uv sync --frozen --no-editable --index-url https://packagefeedproxy.microsoft.io/pypi/simple
COPY mcp/tests tests
COPY docs/mcp-integration.md /opt/docs/mcp-integration.md
ENV PATH=/opt/mcp/.venv/bin:$PATH HOME=/var/lib/agent-control-mcp TMPDIR=/work
USER 10001:10001
ENTRYPOINT ["python", "-m", "pytest"]
CMD ["--basetemp=/work/tests", "-p", "no:cacheprovider", "tests/test_config_storage.py", "tests/test_oauth.py", "tests/test_api_origin.py"]

FROM test AS fixture
ENTRYPOINT ["python", "tests/container_service.py"]
