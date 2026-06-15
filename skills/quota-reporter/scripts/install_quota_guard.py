#!/usr/bin/env python3

from __future__ import annotations

import argparse
import base64
import http.server
import json
import os
import plistlib
import platform
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.parse
import webbrowser
from textwrap import dedent
from pathlib import Path

from quota_reporters import (
    cli_auth_seed_state,
    fetch_auth_pool_status,
    request_auth_pool_token,
    seed_guidance_lines,
)


def emit_seed_guidance() -> dict:
    """Print per-source pool-seeding guidance to stderr. The key case (#5): a user who only uses the
    desktop app (Claude Desktop / Codex.app) and never logged in via the CLI has no credential the
    guard can upload, so their account is silently never pooled until they run `<cli> login` once."""
    states = {}
    print("\nPool seeding (only accounts you log into via the CLI are shared to the pool):", file=sys.stderr)
    for source in ("claude", "codex"):
        try:
            state = cli_auth_seed_state(source)
        except Exception as error:
            state = {"source": source, "state": "unknown", "error": str(error)}
        states[source] = state
        for line in seed_guidance_lines(state):
            print(line, file=sys.stderr)
    return states


LABEL = "com.openai.quota-guard"
RUN_INTERVAL_SECONDS = 900
DEFAULT_AUTH_POOL_URL = "https://quota-report-hub.vercel.app/"
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


def verify_launch_agent_registered() -> dict:
    uid = str(os.getuid())
    service = f"gui/{uid}/{LABEL}"
    result = subprocess.run(["launchctl", "print", service], capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or f"launchd service {service} is not registered").strip())
    return {"ok": True, "scheduler": "launchd", "label": LABEL}


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


def verify_linux_crontab_registered() -> dict:
    result = subprocess.run(["crontab", "-l"], capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "could not read crontab").strip())
    managed_lines = [line for line in result.stdout.splitlines() if CRON_MARKER in line]
    if len(managed_lines) < 2:
        raise RuntimeError("quota guard crontab entries were not registered")
    return {"ok": True, "scheduler": "cron", "entries": managed_lines}


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


def verify_windows_task_registered() -> dict:
    powershell_path = (
        shutil.which("powershell")
        or shutil.which("powershell.exe")
        or shutil.which("pwsh")
        or shutil.which("pwsh.exe")
    )
    if powershell_path is None:
        raise RuntimeError("PowerShell command not found; cannot verify Task Scheduler registration")
    result = subprocess.run(
        [
            powershell_path,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            f"Get-ScheduledTask -TaskName {ps_single_quote(WINDOWS_TASK_NAME)} | Select-Object -ExpandProperty TaskName",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0 or WINDOWS_TASK_NAME not in result.stdout:
        raise RuntimeError((result.stderr or result.stdout or f"Task {WINDOWS_TASK_NAME} is not registered").strip())
    return {"ok": True, "scheduler": "task_scheduler", "task_name": WINDOWS_TASK_NAME}


def pool_health_summary(auth_pool_url: str | None, auth_pool_user_token: str | None) -> dict:
    """#3: confirm the pool actually has healthy accounts (not just a clean guard exit). Returns
    per-source {ok, total} from the hub, or an error marker."""
    if not auth_pool_url or not auth_pool_user_token:
        return {"checked": False, "reason": "no_auth_pool"}
    try:
        status = fetch_auth_pool_status(auth_pool_url, auth_pool_user_token)
    except Exception as error:
        return {"checked": False, "error": str(error)}
    by_source: dict = {}
    for item in (status.get("items") or []):
        bucket = by_source.setdefault(item.get("source") or "?", {"ok": 0, "total": 0})
        bucket["total"] += 1
        if item.get("status") == "ok":
            bucket["ok"] += 1
    return {"checked": True, "by_source": by_source}


def run_install_verification(
    python_path: str,
    worker_script: Path,
    system: str,
    auth_pool_url: str | None = None,
    auth_pool_user_token: str | None = None,
) -> dict:
    if system == "Darwin":
        scheduler = verify_launch_agent_registered()
    elif system == "Linux":
        scheduler = verify_linux_crontab_registered()
    elif system == "Windows":
        scheduler = verify_windows_task_registered()
    else:
        raise RuntimeError(f"unsupported platform: {system}")

    # #4: do NOT skip self-update here — pull the latest guard on install so the freshly-installed
    # machine runs current code immediately (otherwise it waits for the first scheduled self-update).
    guard_result = subprocess.run(
        [python_path, str(worker_script), "--no-toast"],
        capture_output=True,
        text=True,
        check=False,
    )
    if guard_result.returncode != 0:
        raise RuntimeError(
            "quota_guard.py verification run failed. "
            f"stdout={guard_result.stdout.strip()!r} stderr={guard_result.stderr.strip()!r}. "
            f"See {LOG_PATH} and {ERROR_LOG_PATH} for scheduled-run logs."
        )
    return {
        "scheduler": scheduler,
        "guard_run": {
            "ok": True,
            "stdout": guard_result.stdout.strip()[-4000:],
            "stderr": guard_result.stderr.strip()[-4000:],
        },
        "pool_health": pool_health_summary(auth_pool_url, auth_pool_user_token),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Install the local quota guard, configure the Claude statusline hook, "
            "and store the user's personal auth-pool access token for future scheduled runs."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--auth-pool-url",
        default=DEFAULT_AUTH_POOL_URL,
        help="Hub base URL used for auth upload, fetch-best, status, and emailed token issuance.",
    )
    parser.add_argument(
        "--email",
        help="Company email address that should receive or own the personal auth-pool token. Prompts interactively if omitted.",
    )
    parser.add_argument(
        "--auth-pool-user-token",
        help="Existing personal auth-pool token to store locally instead of prompting for a pasted token.",
    )
    parser.add_argument(
        "--python-path",
        default=sys.executable,
        help="Python interpreter used by the scheduled guard job and Claude statusline hook.",
    )
    parser.add_argument(
        "--skip-token-request",
        action="store_true",
        help="Skip the email token issuance API call. Use this when the token was already requested and you only need to paste it.",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Skip the browser-based loopback login and use the email + terminal paste flow (for headless/remote installs).",
    )
    parser.add_argument(
        "--skip-install-verification",
        action="store_true",
        help="Skip the post-install scheduler registration check and one manual quota_guard.py run. Use only for debugging installer changes.",
    )
    return parser


def email_from_token(token: str | None) -> str | None:
    """Decode the email out of a hub-signed `qrp.<payload>.<hmac>` token (no verification)."""
    if not token or not token.startswith("qrp."):
        return None
    parts = token.split(".")
    if len(parts) != 3 or not parts[1]:
        return None
    try:
        padded = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
    except Exception:
        return None
    email = payload.get("e")
    return str(email).strip().lower() if email else None


def parse_login_callback(path: str, expected_state: str) -> dict:
    """Validate the browser's loopback redirect to /callback?token=&state=&email=."""
    parsed = urllib.parse.urlparse(path)
    if parsed.path != "/callback":
        return {"ok": False, "status": 404, "error": "not_found"}
    query = urllib.parse.parse_qs(parsed.query)
    token = (query.get("token") or [""])[0].strip()
    state = (query.get("state") or [""])[0]
    email = (query.get("email") or [""])[0].strip().lower()
    if not token:
        return {"ok": False, "status": 400, "error": "missing_token"}
    if expected_state and state != expected_state:
        return {"ok": False, "status": 400, "error": "state_mismatch"}
    return {"ok": True, "status": 200, "token": token, "email": email}


def browser_available(no_browser: bool) -> bool:
    if no_browser:
        return False
    if platform.system().lower() == "linux" and not (
        os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")
    ):
        return False
    try:
        webbrowser.get()
        return True
    except Exception:
        return False


def run_browser_login(auth_pool_url: str, timeout: float = 300.0) -> dict | None:
    """Open the hub login page and capture the token via a one-shot localhost callback."""
    state = secrets.token_urlsafe(24)
    captured: dict = {}
    done = threading.Event()

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):  # keep the installer output clean
            return

        def do_GET(self):
            outcome = parse_login_callback(self.path, state)
            self.send_response(outcome["status"])
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            if outcome["ok"]:
                captured["token"] = outcome["token"]
                captured["email"] = outcome.get("email") or ""
                self.wfile.write(
                    "<h2>Quota Report Hub</h2><p>登录成功，可以关闭此标签页，回到终端。</p>".encode("utf-8")
                )
                done.set()
            else:
                self.wfile.write(
                    f"<h2>Login failed</h2><p>{outcome['error']}. You can close this tab.</p>".encode("utf-8")
                )

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        callback = f"http://127.0.0.1:{port}/callback"
        login_url = (
            f"{auth_pool_url.rstrip('/')}/login.html"
            f"?callback={urllib.parse.quote(callback, safe='')}"
            f"&state={urllib.parse.quote(state, safe='')}"
        )
        try:
            opened = webbrowser.open(login_url)
        except Exception:
            opened = False
        print(
            "A browser window should have opened to finish login."
            if opened
            else "Open this URL in your browser to finish login:"
        )
        print(f"  {login_url}")
        if not done.wait(timeout):
            return None
    finally:
        server.shutdown()
        server.server_close()

    token = captured.get("token")
    if not token:
        return None
    return {"token": token, "email": captured.get("email") or email_from_token(token)}


def ensure_user_token(
    auth_pool_url: str,
    email: str | None,
    auth_pool_user_token: str | None,
    skip_token_request: bool,
    no_browser: bool = False,
) -> tuple[str, str]:
    if auth_pool_user_token:
        resolved_email = email or email_from_token(auth_pool_user_token) or input("Company email: ").strip()
        return resolved_email, auth_pool_user_token

    if browser_available(no_browser):
        print("Opening browser login… (close the tab when it says you can)")
        login = run_browser_login(auth_pool_url)
        if login and login.get("token"):
            resolved_email = (
                email or login.get("email") or email_from_token(login["token"]) or input("Company email: ").strip()
            )
            return resolved_email, login["token"]
        print("Browser login did not complete; falling back to email + terminal paste.")

    resolved_email = email or input("Company email: ").strip()
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
        args.no_browser,
    )
    write_config(args.auth_pool_url, email, token)
    emit_seed_guidance()  # #1/#5: tell the user which sources will be pooled / need a one-time CLI login
    statusline = configure_claude_statusline(args.python_path, skill_scripts_dir)
    system = platform.system()

    if system == "Darwin":
        write_plist(args.python_path, worker_script)
        load_launch_agent()
        verification = (
            {"skipped": True}
            if args.skip_install_verification
            else run_install_verification(args.python_path, worker_script, system, args.auth_pool_url, token)
        )
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
                    "verification": verification,
                },
                indent=2,
            )
        )
        return

    if system == "Linux":
        install_linux_crontab(args.python_path, worker_script)
        verification = (
            {"skipped": True}
            if args.skip_install_verification
            else run_install_verification(args.python_path, worker_script, system, args.auth_pool_url, token)
        )
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
                    "verification": verification,
                },
                indent=2,
            )
        )
        return

    if system == "Windows":
        windows_result = install_windows_task_scheduler(args.python_path, worker_script)
        verification = (
            {"skipped": True}
            if args.skip_install_verification
            else run_install_verification(args.python_path, worker_script, system, args.auth_pool_url, token)
        )
        print(
            json.dumps(
                {
                    **windows_result,
                    "auth_pool_user_email": email,
                    "claude_statusline_settings_path": str(CLAUDE_SETTINGS_PATH),
                    "claude_statusline": statusline,
                    "verification": verification,
                },
                indent=2,
            )
        )
        return

    raise SystemExit(f"unsupported platform: {system}")


if __name__ == "__main__":
    main()
