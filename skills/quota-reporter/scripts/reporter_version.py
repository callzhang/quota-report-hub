"""Reporter client version, reported to the hub on every usage batch.

The hub gates on this: a client too old to report usage has no measurable premium-model share,
so the share rule cannot reach it at all. Keep this in step with MIN_REPORTER_CLIENT_VERSION in
lib/premium-ratio.js — raising the floor there without shipping a client that satisfies it locks
everybody out.
"""

CLIENT_VERSION = "2.0.0"
