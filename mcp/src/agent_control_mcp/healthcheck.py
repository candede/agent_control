import os
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, Request, build_opener


def main() -> None:
    host = urlsplit(os.environ["MCP_PUBLIC_URL"]).netloc
    request = Request("http://127.0.0.1:8000/ready", headers={"Host": host})
    with build_opener(ProxyHandler({})).open(request, timeout=4) as response:
        if response.status != 200:
            raise SystemExit(1)


if __name__ == "__main__":
    main()
