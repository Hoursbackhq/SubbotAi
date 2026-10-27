#!/usr/bin/env python3
"""
Shared subscription store for SubBot scanners.

Both gmail-scanner.py and statement-scanner.py write into the same
per-user scanned-subscriptions.json. Previously each scanner overwrote
the file wholesale, which silently wiped out subscriptions found by
the other source and any manual user edits (status, health_score,
use_case, notes). merge_subscription() folds a freshly-scanned record
into the existing list instead, preserving user-editable fields and
appending to price_history when the cost changes.
"""

from __future__ import annotations

import json
import os
import time
import contextlib
from datetime import datetime
from pathlib import Path
from user_paths import user_path

USER_DATA_DIR = Path(os.environ.get("DATA_DIR") or Path.home() / ".hermes") / "user-data"

# Fields the user can edit via the dashboard (PATCH /update-sub) — a rescan
# must never clobber these, only the objective scan-derived fields below.
USER_EDITABLE_FIELDS = ["status", "health_score", "use_case", "notes", "category"]

LOCK_RETRY_INTERVAL_S = 0.05
LOCK_TIMEOUT_S = 3


@contextlib.contextmanager
def _file_lock(lock_path: Path):
    """Exclusive-create lockfile — guards against a Node request and a Python
    scan/import racing to write the same user's file at the same time. Never
    steal an old lock: stop writers before clearing an abandoned lock."""
    deadline = time.monotonic() + LOCK_TIMEOUT_S
    while True:
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            if time.monotonic() >= deadline:
                raise TimeoutError("Storage is busy. Please try again shortly.")
            time.sleep(LOCK_RETRY_INTERVAL_S)
    try:
        os.write(fd, f"{os.getpid()}\n".encode())
        yield
    finally:
        os.close(fd)
        lock_path.unlink()


def load(user_id: str) -> dict:
    file = user_path(USER_DATA_DIR, user_id) / "scanned-subscriptions.json"
    if not file.exists():
        return {"subscriptions": [], "cancellation_history": [], "monthly_budget": None}
    with open(file) as f:
        return json.load(f)


def save(user_id: str, db: dict):
    out_dir = user_path(USER_DATA_DIR, user_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / "scanned-subscriptions.json"
    # Write to a temp file then rename — rename is atomic on the same filesystem,
    # so a reader never sees a half-written file if this process dies mid-write.
    tmp_file = out_dir / f".scanned-subscriptions.json.{os.getpid()}.tmp"
    with open(tmp_file, "w") as f:
        json.dump(db, f, indent=2)
    os.replace(tmp_file, out_file)


def merge_subscription(existing_list: list[dict], new_record: dict) -> list[dict]:
    """Merge one freshly-scanned subscription record into existing_list, returning
    a new list. Matches by id (merchant slug)."""
    result = list(existing_list)
    idx = next((i for i, s in enumerate(result) if s.get("id") == new_record.get("id")), None)

    if idx is None:
        result.append(new_record)
        return result

    existing = result[idx]
    merged = dict(existing)

    # Objective, scan-derived fields always refresh from the new scan
    for field in ("monthly_cost", "monthly_cost_usd", "currency", "billing_cycle",
                  "next_renewal", "last_used", "is_trial", "trial_ends", "source"):
        if field in new_record:
            merged[field] = new_record[field]

    # User-editable fields are preserved from what's already stored
    for field in USER_EDITABLE_FIELDS:
        if field in existing:
            merged[field] = existing[field]

    # Track price changes across scans
    old_cost = existing.get("monthly_cost")
    new_cost = new_record.get("monthly_cost")
    if old_cost is not None and new_cost is not None and abs(old_cost - new_cost) > 0.01:
        history = list(existing.get("price_history", []))
        history.append({
            "date": existing.get("last_used") or datetime.now().strftime("%Y-%m-%d"),
            "amount": old_cost,
            "currency": existing.get("currency", "USD"),
        })
        merged["price_history"] = history
        merged["price_changed_at"] = datetime.now().strftime("%Y-%m-%d")
    else:
        merged["price_history"] = existing.get("price_history", [])

    result[idx] = merged
    return result


def merge_all(user_id: str, new_records: list[dict], scanned_from: list[str] | None = None,
              cancelled_records: list[dict] | None = None) -> dict:
    """Load the existing store, merge in new_records, save, and return the db.
    Locked end-to-end so two concurrent scans/imports for the same user can't
    lose an update to each other."""
    out_dir = user_path(USER_DATA_DIR, user_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    lock_path = out_dir / "scanned-subscriptions.json.lock"

    with _file_lock(lock_path):
        db = load(user_id)
        subs = db.get("subscriptions", [])
        for record in new_records:
            subs = merge_subscription(subs, record)
        db["subscriptions"] = subs

        if cancelled_records:
            history = db.get("cancellation_history", [])
            seen_ids = {c.get("id") for c in history}
            for c in cancelled_records:
                if c.get("id") not in seen_ids:
                    history.append(c)
            db["cancellation_history"] = history

        if scanned_from:
            existing_sources = set(db.get("scanned_from", []))
            db["scanned_from"] = list(existing_sources | set(scanned_from))

        db["last_audit"] = datetime.now().strftime("%Y-%m-%d")
        save(user_id, db)
        return db
