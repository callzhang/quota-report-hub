import json
import sys
import unittest
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent.parent / "skills" / "quota-reporter" / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

from token_usage_parsers import (  # noqa: E402
    CodexParseContext,
    codex_counter_delta,
    parse_codex_line,
    parse_codex_lines,
)


def token_line(*, timestamp="2026-08-18T11:45:01.000Z", total=120, input_tokens=100, output_tokens=20):
    return json.dumps({
        "timestamp": timestamp,
        "type": "event_msg",
        "payload": {
            "type": "token_count",
            "info": {
                "total_token_usage": {
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "cached_input_tokens": 60,
                    "cache_write_input_tokens": 0,
                    "reasoning_output_tokens": 5,
                    "total_tokens": total,
                }
            },
        },
    })


class CodexTokenUsageParserTests(unittest.TestCase):
    def test_session_model_and_token_count_emit_structural_record(self):
        records = list(parse_codex_lines([
            json.dumps({"type": "session_meta", "payload": {"session_id": "session-1"}}),
            json.dumps({"type": "turn_context", "payload": {"model": "gpt-5.6-sol"}}),
            token_line(),
        ]))
        self.assertEqual(len(records), 1)
        record = records[0]
        self.assertEqual(record.provider, "codex")
        self.assertEqual(record.logical_record_key, "codex:session-1")
        self.assertEqual(record.model_id, "gpt-5.6-sol")
        self.assertEqual(record.counters, {
            "input_tokens": 100,
            "output_tokens": 20,
            "cache_read_tokens": 60,
            "cache_write_tokens": 0,
            "reasoning_tokens": 5,
            "total_tokens": 120,
        })
        self.assertEqual(len(record.fingerprint), 64)

    def test_session_meta_falls_back_to_payload_id(self):
        context = CodexParseContext()
        self.assertIsNone(parse_codex_line(
            json.dumps({"type": "session_meta", "payload": {"id": "fallback-session"}}), context
        ))
        self.assertEqual(context.logical_session_id, "fallback-session")

    def test_copied_parent_record_has_same_fingerprint_but_real_subagent_does_not(self):
        parent_lines = [
            json.dumps({"type": "session_meta", "payload": {"session_id": "parent"}}),
            json.dumps({"type": "turn_context", "payload": {"model": "gpt-5.6-sol"}}),
            token_line(),
        ]
        parent = list(parse_codex_lines(parent_lines))[0]
        copied = list(parse_codex_lines(parent_lines))[0]
        subagent = list(parse_codex_lines([
            json.dumps({"type": "session_meta", "payload": {"session_id": "subagent"}}),
            json.dumps({"type": "turn_context", "payload": {"model": "gpt-5.6-sol"}}),
            token_line(),
        ]))[0]
        self.assertEqual(parent.fingerprint, copied.fingerprint)
        self.assertNotEqual(parent.fingerprint, subagent.fingerprint)

    def test_metadata_is_ignored_and_malformed_or_irrelevant_events_increment_warning_count(self):
        context = CodexParseContext()
        self.assertIsNone(parse_codex_line(
            json.dumps({"type": "session_meta", "payload": {"session_id": "session"}}), context
        ))
        self.assertEqual(context.warning_count, 0)
        self.assertIsNone(parse_codex_line("not-json", context))
        self.assertIsNone(parse_codex_line(
            json.dumps({"type": "event_msg", "payload": {"type": "unknown-event", "private": "ignored"}}), context
        ))
        self.assertEqual(context.warning_count, 2)

    def test_missing_structural_context_or_invalid_counters_warns_without_content(self):
        context = CodexParseContext()
        self.assertIsNone(parse_codex_line(token_line(), context))
        self.assertEqual(context.warning_count, 1)
        context.logical_session_id = "session"
        context.model_id = "model"
        self.assertIsNone(parse_codex_line(token_line(total=-1), context))
        self.assertEqual(context.warning_count, 2)

    def test_counter_delta_is_positive_and_reset_starts_a_new_epoch(self):
        acknowledged = {
            "input_tokens": 80, "output_tokens": 10, "cache_read_tokens": 40,
            "cache_write_tokens": 0, "reasoning_tokens": 2, "total_tokens": 90,
        }
        current = {
            "input_tokens": 100, "output_tokens": 20, "cache_read_tokens": 60,
            "cache_write_tokens": 0, "reasoning_tokens": 5, "total_tokens": 120,
        }
        self.assertEqual(codex_counter_delta(current, acknowledged), {
            "input_tokens": 20, "output_tokens": 10, "cache_read_tokens": 20,
            "cache_write_tokens": 0, "reasoning_tokens": 3, "total_tokens": 30,
        })
        reset = {key: max(0, value // 2) for key, value in current.items()}
        self.assertEqual(codex_counter_delta(reset, current), reset)
        self.assertTrue(all(value >= 0 for value in codex_counter_delta(reset, current).values()))


if __name__ == "__main__":
    unittest.main()
