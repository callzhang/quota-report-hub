# Archived Scripts

These scripts are preserved for historical reference only.

They implemented the earlier reporter-first design where each machine:

- probed local quota
- posted quota reports to the hub
- reused a generic installer named `install_hourly_reporter.py`

The active design has moved to:

- `scripts/quota_guard.py`
- `scripts/install_quota_guard.py`

The new design is auth-pool-first:

- local machines upload auth snapshots
- the local worker checks Codex and Claude quota every 15 minutes
- when quota is low, it fetches a better Codex auth from the cloud auth pool
- the dedicated install script handles company email token setup
