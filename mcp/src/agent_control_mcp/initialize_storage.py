"""One-shot empty-volume ownership initialization, not the service entrypoint."""

import os
import stat
import sys
from pathlib import Path

ROOT = Path("/var/lib/agent-control-mcp/oauth")


def main() -> None:
    uid, gid = (int(value) for value in sys.argv[1:])
    if uid <= 0 or gid < 0 or os.getuid() != 0:
        raise ValueError("Storage initialization requires exact non-root target ownership.")
    info = ROOT.lstat()
    if not stat.S_ISDIR(info.st_mode):
        raise ValueError("OAuth volume root must be a real directory.")
    if info.st_uid == 0:
        if any(ROOT.iterdir()):
            raise ValueError("Nonempty root-owned state requires explicit operator recovery.")
        ROOT.chmod(0o700)
        os.chown(ROOT, uid, gid)
    elif info.st_uid != uid or info.st_gid != gid or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("Existing OAuth volume ownership/mode differs; restore, never reset.")


if __name__ == "__main__":
    main()
