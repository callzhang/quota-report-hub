import os
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent.parent / "skills" / "quota-reporter" / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

from install_quota_guard import trim_guard_log  # noqa: E402


class GuardLogTrimTests(unittest.TestCase):
    def write_lines(self, path: Path, count: int) -> None:
        path.write_bytes(b"".join(f"cycle {index:06d} Errors: none\n".encode() for index in range(count)))

    def test_log_under_the_cap_is_left_alone(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "quota-guard.log"
            self.write_lines(path, 10)
            before = path.read_bytes()
            self.assertFalse(trim_guard_log(path, max_bytes=len(before)))
            self.assertEqual(path.read_bytes(), before)

    def test_missing_log_is_not_an_error(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            self.assertFalse(trim_guard_log(Path(temp_dir) / "absent.log", max_bytes=10))

    def test_oversized_log_keeps_newest_whole_lines_in_the_same_file(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "quota-guard.log"
            self.write_lines(path, 1000)
            # The scheduler's handle: opened in append mode before the guard trims.
            scheduler = open(path, "ab")
            inode = path.stat().st_ino

            self.assertTrue(trim_guard_log(path, max_bytes=4000))

            kept = path.read_bytes()
            self.assertLessEqual(len(kept), 2000)
            self.assertTrue(kept.startswith(b"cycle "))
            self.assertTrue(kept.endswith(b"cycle 000999 Errors: none\n"))
            self.assertEqual(path.stat().st_ino, inode)

            scheduler.write(b"next cycle\n")
            scheduler.close()
            after = path.read_bytes()
            self.assertEqual(after, kept + b"next cycle\n")
            if os.name != "nt":
                self.assertLessEqual(len(after), 4000)


if __name__ == "__main__":
    unittest.main()
