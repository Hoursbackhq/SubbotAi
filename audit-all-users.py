#!/usr/bin/env python3
"""Weekly audits for registered accounts, including hashed storage directories."""
import json
import os
import subprocess
import sys
from pathlib import Path

from user_paths import user_path


def main():
    root = Path(os.environ.get("DATA_DIR") or Path.home() / ".hermes") / "user-data"
    for meta in root.glob("*/web3auth-meta.json"):
        try:
            uid = json.loads(meta.read_text())["userId"]
            if not isinstance(uid, str) or uid == "local" or user_path(root, uid) != meta.parent:
                continue
            subprocess.run([sys.executable, str(Path(__file__).with_name("llm-analyze.py")), "--user-id", uid], timeout=120, check=False)
        except (OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
            print(f"Audit skipped: {type(error).__name__}", file=sys.stderr)


if __name__ == "__main__":
    main()
