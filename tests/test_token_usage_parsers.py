import json
import sys
import unittest
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent.parent / "skills" / "quota-reporter" / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

from token_usage_parsers import (  # noqa: E402
    ClaudeParseContext,
    CodexParseContext,
    claude_counter_delta,
    codex_counter_delta,
    parse_claude_line,
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


class ClaudeTokenUsageParserTests(unittest.TestCase):
    def assistant_line(self, *, message_id="msg-1", usage=None, content=None):
        message = {
            "id": message_id,
            "model": "claude-opus-4-8",
            "usage": usage or {
                "input_tokens": 2,
                "output_tokens": 100,
                "cache_read_input_tokens": 900,
                "cache_creation_input_tokens": 50,
            },
        }
        if content is not None:
            message["content"] = content
        return json.dumps({
            "type": "assistant",
            "timestamp": "2026-08-18T11:50:00.000Z",
            "message": message,
        })

    def test_assistant_usage_maps_cache_creation_and_derived_total(self):
        record = parse_claude_line(self.assistant_line())
        self.assertIsNotNone(record)
        self.assertEqual(record.provider, "claude")
        self.assertEqual(record.logical_record_key, "claude:msg-1")
        self.assertEqual(record.model_id, "claude-opus-4-8")
        self.assertEqual(record.counters, {
            "input_tokens": 2,
            "output_tokens": 100,
            "cache_read_tokens": 900,
            "cache_write_tokens": 50,
            "reasoning_tokens": 0,
            "total_tokens": 1052,
        })

    def test_repeated_message_uses_structural_fingerprint_and_final_value_delta(self):
        first = parse_claude_line(self.assistant_line(content="private first"))
        copied = parse_claude_line(self.assistant_line(content="private changed"))
        self.assertEqual(first.fingerprint, copied.fingerprint)
        self.assertEqual(claude_counter_delta(copied.counters, first.counters), {
            field: 0 for field in first.counters
        })

        increased = parse_claude_line(self.assistant_line(usage={
            "input_tokens": 2,
            "output_tokens": 120,
            "cache_read_input_tokens": 910,
            "cache_creation_input_tokens": 50,
        }))
        self.assertEqual(claude_counter_delta(increased.counters, first.counters), {
            "input_tokens": 0,
            "output_tokens": 20,
            "cache_read_tokens": 10,
            "cache_write_tokens": 0,
            "reasoning_tokens": 0,
            "total_tokens": 30,
        })

    def test_lower_correction_never_emits_negative_tokens(self):
        current = {
            "input_tokens": 2, "output_tokens": 90, "cache_read_tokens": 800,
            "cache_write_tokens": 40, "reasoning_tokens": 0, "total_tokens": 932,
        }
        acknowledged = {
            "input_tokens": 2, "output_tokens": 100, "cache_read_tokens": 900,
            "cache_write_tokens": 50, "reasoning_tokens": 0, "total_tokens": 1052,
        }
        self.assertEqual(claude_counter_delta(current, acknowledged), {
            field: 0 for field in current
        })

    def test_user_tool_and_missing_assistant_structure_emit_no_content(self):
        context = ClaudeParseContext()
        self.assertIsNone(parse_claude_line(json.dumps({
            "type": "user", "message": {"content": "private user content"}
        }), context))
        self.assertEqual(context.warning_count, 0)
        self.assertIsNone(parse_claude_line(json.dumps({
            "type": "assistant", "timestamp": "2026-08-18T11:50:00.000Z",
            "message": {"content": "private assistant content"},
        }), context))
        self.assertEqual(context.warning_count, 1)

        good = parse_claude_line(self.assistant_line(content="never hashed"), context)
        same = parse_claude_line(self.assistant_line(content="different private content"), context)
        self.assertEqual(good.fingerprint, same.fingerprint)


if __name__ == "__main__":
    unittest.main()


class CodexCompactionDeltaTest(unittest.TestCase):
    """Context compaction is not a session reset."""

    def test_a_cache_drop_mid_session_does_not_re_emit_the_whole_cumulative(self):
        # codex compacts: cached_input_tokens collapses while the monotonic counters keep climbing.
        # Reading that as a reset charged the user for their entire session history again, which is
        # how 1.6% of buckets came to hold 86% of all recorded volume.
        acknowledged = {
            "input_tokens": 10_000_000, "output_tokens": 100_000,
            "cache_read_tokens": 9_500_000, "cache_write_tokens": 0,
            "reasoning_tokens": 50_000, "total_tokens": 10_100_000,
        }
        current = {
            "input_tokens": 10_400_000, "output_tokens": 110_000,
            "cache_read_tokens": 200_000,        # compacted away
            "cache_write_tokens": 0,
            "reasoning_tokens": 55_000, "total_tokens": 10_510_000,
        }
        delta = codex_counter_delta(current, acknowledged)
        self.assertEqual(delta["input_tokens"], 400_000)
        self.assertEqual(delta["output_tokens"], 10_000)
        self.assertEqual(delta["cache_read_tokens"], 0, "a cache drop is not negative usage")
        self.assertEqual(delta["total_tokens"], 410_000)
        self.assertLess(delta["total_tokens"], current["total_tokens"] / 20)

    def test_a_real_restart_still_re_emits_the_cumulative(self):
        acknowledged = {
            "input_tokens": 10_000_000, "output_tokens": 100_000,
            "cache_read_tokens": 9_500_000, "cache_write_tokens": 0,
            "reasoning_tokens": 50_000, "total_tokens": 10_100_000,
        }
        current = {
            "input_tokens": 5_000, "output_tokens": 400,
            "cache_read_tokens": 0, "cache_write_tokens": 0,
            "reasoning_tokens": 100, "total_tokens": 5_400,
        }
        self.assertEqual(codex_counter_delta(current, acknowledged), current)

    def test_the_delta_keeps_the_invariants_the_hub_validates(self):
        # A batch breaking these is rejected wholesale, so a clamped field must not desync the rest.
        acknowledged = {
            "input_tokens": 1_000, "output_tokens": 100, "cache_read_tokens": 900,
            "cache_write_tokens": 500, "reasoning_tokens": 90, "total_tokens": 1_100,
        }
        current = {
            "input_tokens": 1_200, "output_tokens": 150, "cache_read_tokens": 100,
            "cache_write_tokens": 400, "reasoning_tokens": 20, "total_tokens": 1_350,
        }
        delta = codex_counter_delta(current, acknowledged)
        self.assertLessEqual(delta["cache_read_tokens"], delta["input_tokens"])
        self.assertLessEqual(delta["cache_write_tokens"], delta["input_tokens"])
        self.assertLessEqual(delta["reasoning_tokens"], delta["output_tokens"])
        self.assertEqual(delta["total_tokens"], delta["input_tokens"] + delta["output_tokens"])
