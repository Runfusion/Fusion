import io
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import collector
from collector import log

STAMP = re.compile(r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ ')


class CollectorLogTests(unittest.TestCase):
    def setUp(self):
        self.addCleanup(setattr, collector, '_log_file', None)

    def test_stdout_lines_carry_a_utc_timestamp(self):
        out = io.StringIO()
        with patch.dict(os.environ, {}, clear=True), patch.object(sys, 'stdout', out):
            log('Fusion delivery backing off:', 5, 'seconds')
        self.assertRegex(out.getvalue(), STAMP.pattern + r'Fusion delivery backing off: 5 seconds\n$')

    def test_journald_lines_are_left_to_journald_to_timestamp(self):
        out = io.StringIO()
        with patch.dict(os.environ, {'JOURNAL_STREAM': '8:1234'}), patch.object(sys, 'stdout', out):
            log('Fusion delivery backing off:', 5, 'seconds')
        self.assertEqual(out.getvalue(), 'Fusion delivery backing off: 5 seconds\n')

    def test_log_file_rotates_and_keeps_a_bounded_number_of_copies(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(collector, 'LOG_MAX_BYTES', 200):
            path = Path(tmp) / 'collector.log'
            collector._log_file = path
            for index in range(100):
                log('line', index)
            names = sorted(child.name for child in Path(tmp).iterdir())
            self.assertEqual(names, ['collector.log'] + [f'collector.log.{n}' for n in range(1, collector.LOG_BACKUPS + 1)])
            for child in Path(tmp).iterdir():
                self.assertLessEqual(child.stat().st_size, 200)
            lines = path.read_text().splitlines()
            self.assertTrue(all(STAMP.match(line) for line in lines))
            self.assertTrue(lines[-1].endswith('line 99'))
            self.assertTrue((Path(tmp) / 'collector.log.1').read_text().splitlines()[-1].endswith(f'line {99 - len(lines)}'))

    def test_unwritable_log_file_falls_back_to_stderr_without_raising(self):
        err = io.StringIO()
        with tempfile.TemporaryDirectory() as tmp, patch.object(sys, 'stderr', err):
            collector._log_file = Path(tmp) / 'missing-dir' / 'collector.log'
            log('Fusion delivery unavailable:', 'TimeoutError: timed out')
        self.assertRegex(err.getvalue(), STAMP.pattern + r'Fusion delivery unavailable: TimeoutError: timed out \(log file unavailable: ')


if __name__ == '__main__':
    unittest.main()
