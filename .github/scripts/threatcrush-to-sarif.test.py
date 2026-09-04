#!/usr/bin/env python3
"""Behaviour tests for threatcrush-to-sarif.py.

FNXC:ThreatCrushParse 2026-08-24-02:14:
The converter is fail-closed. These cases pin the two review findings that
used to report a clean scan: a substring "footer" and an overwritten
incomplete finding block.
"""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    "threatcrush_to_sarif",
    Path(__file__).with_name("threatcrush-to-sarif.py"),
)
assert _SPEC and _SPEC.loader
_mod = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_mod)
parse = _mod.parse
Unrecognised = _mod.Unrecognised


CLEAN = """
Scanning . for security issues...
  ✓ No security issues found!
"""

FINDINGS = """
  Scan Results
  [HIGH] AWS Access Key
    File: .env:1
    Info: hardcoded credential
  1 issue(s) found across 12 files
"""


class ParseFooterTests(unittest.TestCase):
    def test_clean_scan_uses_documented_footer(self) -> None:
        self.assertEqual(parse(CLEAN), [])

    def test_findings_footer_with_across_files(self) -> None:
        findings = parse(FINDINGS)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["title"], "AWS Access Key")
        self.assertEqual(findings[0]["file"], ".env")

    def test_rejects_substring_footer_on_last_line(self) -> None:
        text = "error: failed to write cache: No security issues found in previous run\n"
        with self.assertRaises(Unrecognised):
            parse(text)

    def test_rejects_embedded_clean_phrase_when_last_line_is_not_footer(self) -> None:
        text = (
            "  [HIGH] AWS Access Key\n"
            "    File: .env:1\n"
            "    Info: hardcoded credential\n"
            "error: No security issues found in cache\n"
        )
        with self.assertRaises(Unrecognised):
            parse(text)

    def test_skips_fail_on_trailer_after_real_footer(self) -> None:
        text = CLEAN + "\n  ✗ findings at or above high — failing as requested by --fail-on\n"
        self.assertEqual(parse(text), [])


class ParseIncompleteBlockTests(unittest.TestCase):
    def test_rejects_incomplete_block_before_later_severity_overwrites_it(self) -> None:
        # Footer count would match the one complete finding if the incomplete
        # CRITICAL block were silently dropped.
        text = """
  CRITICAL  Incomplete Secret
  [HIGH] AWS Access Key
    File: .env:1
    Info: hardcoded credential
  1 issue(s) found across 12 files
"""
        with self.assertRaisesRegex(Unrecognised, "incomplete finding block"):
            parse(text)

    def test_rejects_trailing_incomplete_block(self) -> None:
        text = """
  [HIGH] AWS Access Key
    File: .env:1
  1 issue(s) found across 1 files
"""
        with self.assertRaisesRegex(Unrecognised, "incomplete finding block"):
            parse(text)


if __name__ == "__main__":
    unittest.main()
