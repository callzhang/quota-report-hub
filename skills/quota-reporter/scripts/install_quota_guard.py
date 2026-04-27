#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import plistlib
import platform
import shlex
import shutil
import subprocess
import sys
import tempfile
from textwrap import dedent
from pathlib import Path

from quota_reporters import request_auth_pool_token


LABEL = "com.openai.quota-guard"
RUN_INTERVAL_SECONDS = 900
CONFIG_PATH = Path.home() / ".agents" / "auth" / "quota-reporter.json"
PLIST_PATH = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"
LOG_PATH = Path.home() / ".agents" / "auth" / "quota-guard.log"
ERROR_LOG_PATH = Path.home() / ".agents" / "auth" / "quota-guard.error.log"
CRON_MARKER = "# quota-guard-managed"
CLAUDE_SETTINGS_PATH = Path.home() / ".claude" / "settings.json"
WINDOWS_RUNNER_PATH = Path.home() / ".agents" / "auth" / "quota-guard-run.ps1"
WINDOWS_TASK_NAME = LABEL


def write_config(auth_pool_url: str, email: str, auth_pool_user_token: str) -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(
        json.dumps(
            {
                "auth_pool_url": auth_pool_url,
                "auth_pool_user_email": email,
                "auth_pool_user_token": auth_pool_user_token,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def configure_claude_statusline(python_path: str, skill_scripts_dir: Path) -> dict:
    statusline_script = skill_scripts_dir / "claude_statusline_probe.py"
    command = f"{shlex.quote(python_path)} {shlex.quote(str(statusline_script))}"

    CLAUDE_SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    settings = json.loads(CLAUDE_SETTINGS_PATH.read_text(encoding="utf-8")) if CLAUDE_SETTINGS_PATH.exists() else {}
    settings["statusLine"] = {
        "type": "command",
        "command": command,
        "refreshInterval": 60,
    }
    CLAUDE_SETTINGS_PATH.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
    return settings["statusLine"]


def write_plist(python_path: str, worker_script: Path) -> None:
    PLIST_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "Label": LABEL,
        "ProgramArguments": [python_path, str(worker_script)],
        "StartInterval": RUN_INTERVAL_SECONDS,
        "RunAtLoad": True,
        "StandardOutPath": str(LOG_PATH),
        "StandardErrorPath": str(ERROR_LOG_PATH),
        "EnvironmentVariables": {
            "PATH": os.environ.get("PATH", ""),
        },
    }
    with PLIST_PATH.open("wb") as handle:
        plistlib.dump(payload, handle)


def load_launch_agent() -> None:
    uid = str(os.getuid())
    service = f"gui/{uid}/{LABEL}"
    existing = subprocess.run(["launchctl", "print", service], capture_output=True, text=True)
    if existing.returncode == 0:
        subprocess.run(["launchctl", "bootout", f"gui/{uid}", str(PLIST_PATH)], check=True)
    subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", str(PLIST_PATH)], check=True)
    subprocess.run(["launchctl", "kickstart", "-k", service], check=True)


def cron_lines(python_path: str, worker_script: Path) -> list[str]:
    command = (
        f"{shlex.quote(python_path)} {shlex.quote(str(worker_script))} "
        f">> {shlex.quote(str(LOG_PATH))} 2>> {shlex.quote(str(ERROR_LOG_PATH))}"
    )
    return [
        f"@reboot {command} {CRON_MARKER}",
        f"*/15 * * * * {command} {CRON_MARKER}",
    ]


def install_linux_crontab(python_path: str, worker_script: Path) -> None:
    if shutil.which("crontab") is None:
        raise SystemExit("crontab command not found; install cron before running the quota guard installer")

    existing = subprocess.run(["crontab", "-l"], capture_output=True, text=True, check=False)
    if existing.returncode not in (0, 1):
        raise subprocess.CalledProcessError(existing.returncode, existing.args, output=existing.stdout, stderr=existing.stderr)

    preserved_lines = [line for line in existing.stdout.splitlines() if CRON_MARKER not in line]
    cron_payload = "\n".join(preserved_lines + cron_lines(python_path, worker_script)).rstrip() + "\n"
    subprocess.run(["crontab", "-"], input=cron_payload, text=True, check=True)


def ps_single_quote(value: str | Path) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def write_windows_runner(python_path: str, worker_script: Path) -> Path:
    WINDOWS_RUNNER_PATH.parent.mkdir(parents=True, exist_ok=True)
    WINDOWS_RUNNER_PATH.write_text(
        "\n".join(
            [
                "$ErrorActionPreference = 'Stop'",
                f"& {ps_single_quote(python_path)} {ps_single_quote(worker_script)} >> {ps_single_quote(LOG_PATH)} 2>> {ps_single_quote(ERROR_LOG_PATH)}",
                "",
            ]
        ),
        encoding="utf-8",
    )
    return WINDOWS_RUNNER_PATH


def windows_scheduler_script(runner_script: Path) -> str:
    return dedent(
        f"""
        param(
          [Parameter(Mandatory = $true)][string]$RunnerScript,
          [Parameter(Mandatory = $true)][string]$TaskName
        )

        $ErrorActionPreference = 'Stop'
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$RunnerScript`""
        $repeatTrigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
        $startupTrigger = New-ScheduledTaskTrigger -AtStartup
        $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType S4U -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew

        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($repeatTrigger, $startupTrigger) -Principal $principal -Settings $settings -Force | Out-Null
        """
    ).strip()


def install_windows_task_scheduler(python_path: str, worker_script: Path) -> dict:
    powershell_path = (
        shutil.which("powershell")
        or shutil.which("powershell.exe")
        or shutil.which("pwsh")
        or shutil.which("pwsh.exe")
    )
    if powershell_path is None:
        raise SystemExit("PowerShell command not found; install PowerShell before running the quota guard installer")

    runner_script = write_windows_runner(python_path, worker_script)
    installer_path: Path | None = None
    installer_script = tempfile.NamedTemporaryFile("w", suffix=".ps1", delete=False, encoding="utf-8")
    try:
        installer_script.write(windows_scheduler_script(runner_script))
        installer_script.flush()
        installer_path = Path(installer_script.name)
    finally:
        installer_script.close()

    try:
        subprocess.run(
            [
                powershell_path,
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(installer_path),
                "-RunnerScript",
                str(runner_script),
                "-TaskName",
                WINDOWS_TASK_NAME,
            ],
            check=True,
        )
    finally:
        if installer_path is not None:
            installer_path.unlink(missing_ok=True)

    return {
        "scheduler": "task_scheduler",
        "config_path": str(CONFIG_PATH),
        "runner_script_path": str(runner_script),
        "task_name": WINDOWS_TASK_NAME,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Install the local quota guard and store a personal auth-pool token.")
    parser.add_argument("--auth-pool-url", required=True)
    parser.add_argument("--email")
    parser.add_argument("--auth-pool-user-token")
    parser.add_argument("--python-path", default=sys.executable)
    parser.add_argument("--skip-token-request", action="store_true")
    return parser


def ensure_user_token(auth_pool_url: str, email: str | None, auth_pool_user_token: str | None, skip_token_request: bool) -> tuple[str, str]:
    resolved_email = email or input("Company email: ").strip()
    token = auth_pool_user_token
    if token:
        return resolved_email, token
    if not skip_token_request:
        request_auth_pool_token(auth_pool_url, resolved_email)
        print(f"Access token requested for {resolved_email}. Check your inbox, then paste the token below.")
    pasted = input("Personal auth-pool token: ").strip()
    if not pasted:
        raise SystemExit("no auth-pool token provided")
    return resolved_email, pasted


def main() -> None:
    args = build_parser().parse_args()
    worker_script = Path(__file__).with_name("quota_guard.py")
    skill_scripts_dir = Path(__file__).resolve().parent
    email, token = ensure_user_token(
        args.auth_pool_url,
        args.email,
        args.auth_pool_user_token,
        args.skip_token_request,
    )
    write_config(args.auth_pool_url, email, token)
    statusline = configure_claude_statusline(args.python_path, skill_scripts_dir)
    system = platform.system()

    if system == "Darwin":
        write_plist(args.python_path, worker_script)
        load_launch_agent()
        print(
            json.dumps(
                {
                    "scheduler": "launchd",
                    "label": LABEL,
                    "config_path": str(CONFIG_PATH),
                    "plist_path": str(PLIST_PATH),
                    "auth_pool_user_email": email,
                    "claude_statusline_settings_path": str(CLAUDE_SETTINGS_PATH),
                    "claude_statusline": statusline,
                    "start_interval_seconds": RUN_INTERVAL_SECONDS,
                },
                indent=2,
            )
        )
        return

    if system == "Linux":
        install_linux_crontab(args.python_path, worker_script)
        print(
            json.dumps(
                {
                    "scheduler": "cron",
                    "config_path": str(CONFIG_PATH),
                    "log_path": str(LOG_PATH),
                    "error_log_path": str(ERROR_LOG_PATH),
                    "auth_pool_user_email": email,
                    "claude_statusline_settings_path": str(CLAUDE_SETTINGS_PATH),
                    "claude_statusline": statusline,
                    "entries": cron_lines(args.python_path, worker_script),
                },
                indent=2,
            )
        )
        return

    if system == "Windows":
        windows_result = install_windows_task_scheduler(args.python_path, worker_script)
        print(
            json.dumps(
                {
                    **windows_result,
                    "auth_pool_user_email": email,
                    "claude_statusline_settings_path": str(CLAUDE_SETTINGS_PATH),
                    "claude_statusline": statusline,
                },
                indent=2,
            )
        )
        return

    raise SystemExit(f"unsupported platform: {system}")


if __name__ == "__main__":
    main()
