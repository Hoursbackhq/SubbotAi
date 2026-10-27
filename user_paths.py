"""Account paths shared with user-path.js; legacy paths require matching metadata."""
import hashlib
import json
import re
from pathlib import Path


def user_path(root: Path, user_id: str) -> Path:
    if not isinstance(user_id, str) or not user_id or user_id in (".", ".."):
        raise ValueError("Invalid account ID")
    # JavaScript's legacy replacement treated UTF-16 code units separately.
    legacy_name = re.sub(r"[^a-zA-Z0-9:_.\-]", "_", user_id)
    legacy = root / legacy_name
    try:
        if json.loads((legacy / "web3auth-meta.json").read_text()).get("userId") == user_id:
            return legacy
    except (OSError, ValueError, AttributeError):
        pass
    return root / ("u_" + hashlib.sha256(user_id.encode()).hexdigest())
