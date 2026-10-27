#!/usr/bin/env python3
"""
Regression tests for sub_store.merge_subscription — the fix for the bug
where gmail-scanner.py silently overwrote scanned-subscriptions.json on
every scan, wiping user edits and price history.
"""

import sys
import os
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import sub_store


class TestMergeSubscription(unittest.TestCase):
    def test_new_subscription_is_appended(self):
        result = sub_store.merge_subscription([], {"id": "netflix", "monthly_cost": 9.99})
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["id"], "netflix")

    def test_user_edited_fields_survive_a_rescan(self):
        existing = [{
            "id": "netflix", "name": "Netflix", "monthly_cost": 9.99, "currency": "USD",
            "status": "active", "health_score": 42, "use_case": "personal",
            "notes": "my custom note", "category": "streaming",
        }]
        new_scan = {
            "id": "netflix", "name": "Netflix", "monthly_cost": 9.99, "currency": "USD",
            "status": "active", "health_score": 70, "use_case": "",
            "notes": "Auto-detected", "category": "other",
        }
        result = sub_store.merge_subscription(existing, new_scan)
        merged = result[0]
        self.assertEqual(merged["health_score"], 42)
        self.assertEqual(merged["use_case"], "personal")
        self.assertEqual(merged["notes"], "my custom note")
        self.assertEqual(merged["category"], "streaming")

    def test_price_change_appends_to_history(self):
        existing = [{
            "id": "netflix", "monthly_cost": 9.99, "currency": "USD",
            "last_used": "2026-06-06", "price_history": [],
        }]
        new_scan = {"id": "netflix", "monthly_cost": 12.99, "currency": "USD"}
        result = sub_store.merge_subscription(existing, new_scan)
        merged = result[0]
        self.assertEqual(merged["monthly_cost"], 12.99)
        self.assertEqual(len(merged["price_history"]), 1)
        self.assertEqual(merged["price_history"][0]["amount"], 9.99)
        self.assertIn("price_changed_at", merged)

    def test_unchanged_price_does_not_append_history(self):
        existing = [{"id": "netflix", "monthly_cost": 9.99, "currency": "USD", "price_history": []}]
        new_scan = {"id": "netflix", "monthly_cost": 9.99, "currency": "USD"}
        result = sub_store.merge_subscription(existing, new_scan)
        self.assertEqual(result[0]["price_history"], [])
        self.assertNotIn("price_changed_at", result[0])

    def test_other_source_subscriptions_are_preserved(self):
        existing = [{"id": "csv-imported-sub", "monthly_cost": 5.0, "source": "csv-import"}]
        new_scan = {"id": "netflix", "monthly_cost": 9.99, "source": "gmail-scan"}
        result = sub_store.merge_subscription(existing, new_scan)
        ids = {s["id"] for s in result}
        self.assertEqual(ids, {"csv-imported-sub", "netflix"})


class TestFileLock(unittest.TestCase):
    def test_user_paths_preserve_verified_legacy_and_separate_collisions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            alice, bob = "w3a:google:a+b@example.test", "w3a:google:a_b@example.test"
            legacy = root / "w3a:google:a_b_example.test"
            legacy.mkdir()
            (legacy / "web3auth-meta.json").write_text(sub_store.json.dumps({"userId": alice}))
            self.assertEqual(sub_store.user_path(root, alice), legacy)
            self.assertNotEqual(sub_store.user_path(root, bob), legacy)
            self.assertEqual(sub_store.user_path(root, "w3a:google:../../escape").parent, root)

    def test_timeout_preserves_old_lock_and_skips_write(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / "scanned-subscriptions.json.lock"
            lock.write_text("another writer")
            os.utime(lock, (0, 0))
            with patch.object(sub_store, "LOCK_TIMEOUT_S", 0):
                with self.assertRaises(TimeoutError):
                    with sub_store._file_lock(lock):
                        self.fail("entered another writer's lock")
            self.assertEqual(lock.read_text(), "another writer")

    def test_failed_write_releases_own_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / "scanned-subscriptions.json.lock"
            with self.assertRaisesRegex(ValueError, "failed write"):
                with sub_store._file_lock(lock):
                    raise ValueError("failed write")
            self.assertFalse(lock.exists())
            with sub_store._file_lock(lock):
                self.assertTrue(lock.exists())
            self.assertFalse(lock.exists())


if __name__ == "__main__":
    unittest.main()
