#!/usr/bin/env python3

from __future__ import annotations

import argparse
import os
import secrets
import subprocess
import tempfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
SUPPORTED_ENVIRONMENTS = ("production", "preview", "development")


def run(command: list[str], *, cwd: Path, input_text: str | None = None, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        command,
        cwd=str(cwd),
        input=input_text,
        text=True,
        capture_output=True,
        check=check,
    )


def parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key] = value.strip().strip('"').strip("'")
    return values


def current_vercel_env(environment: str, *, cwd: Path) -> dict[str, str]:
    with tempfile.TemporaryDirectory(prefix=f"vercel-env-{environment}-") as temp_dir:
        destination = Path(temp_dir) / ".env"
        command = [
            "vercel",
            "env",
            "pull",
            str(destination),
            "--environment",
            environment,
            "--yes",
        ]
        result = run(command, cwd=cwd, check=False)
        if result.returncode != 0:
            raise SystemExit(
                f"failed to pull Vercel env for {environment}:\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
            )
        return parse_env_file(destination)


def upsert_vercel_env(name: str, value: str, environment: str, *, cwd: Path) -> None:
    existing = current_vercel_env(environment, cwd=cwd)
    if name in existing:
        remove_result = run(
            ["vercel", "env", "rm", name, environment, "--yes"],
            cwd=cwd,
            check=False,
        )
        if remove_result.returncode != 0:
            raise SystemExit(
                f"failed to remove existing env {name} from {environment}:\nSTDOUT:\n{remove_result.stdout}\nSTDERR:\n{remove_result.stderr}"
            )

    add_result = run(
        ["vercel", "env", "add", name, environment],
        cwd=cwd,
        input_text=value,
        check=False,
    )
    if add_result.returncode != 0:
        raise SystemExit(
            f"failed to add env {name} to {environment}:\nSTDOUT:\n{add_result.stdout}\nSTDERR:\n{add_result.stderr}"
        )


def email_domain(address: str) -> str:
    if "@" not in address:
        raise SystemExit(f"invalid sending email: {address}")
    return address.rsplit("@", 1)[1].lower()


def ensure_auth_pool_key(*, cwd: Path, rotate: bool) -> tuple[str, bool]:
    production_env = current_vercel_env("production", cwd=cwd)
    existing = production_env.get("AUTH_POOL_ENCRYPTION_KEY")
    if existing and not rotate:
        return existing, False
    return secrets.token_hex(32), True


def deploy_production(*, cwd: Path) -> None:
    result = run(["vercel", "deploy", "--prod", "--yes"], cwd=cwd, check=False)
    if result.returncode != 0:
        raise SystemExit(
            f"failed to deploy production:\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )
    print(result.stdout.strip())


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Configure Vercel env for Quota Report Hub and deploy production."
    )
    parser.add_argument("--allowed-domain", required=True, help="Company email domain allowed to request personal tokens")
    parser.add_argument("--mailgun-api-key", required=True, help="Mailgun API key")
    parser.add_argument("--sending-email", required=True, help="Mailgun from address, for example hello@example.com")
    parser.add_argument(
        "--environments",
        default="production,preview,development",
        help="Comma-separated Vercel environments to update",
    )
    parser.add_argument("--cwd", type=Path, default=REPO_ROOT, help="Quota Report Hub repo root")
    parser.add_argument(
        "--rotate-auth-pool-key",
        action="store_true",
        help="Generate and replace AUTH_POOL_ENCRYPTION_KEY even if one already exists",
    )
    parser.add_argument(
        "--skip-deploy",
        action="store_true",
        help="Update Vercel env only and do not trigger vercel deploy --prod",
    )
    return parser


def main() -> None:
    args = build_parser().parse_args()
    environments = [item.strip() for item in args.environments.split(",") if item.strip()]
    invalid = [item for item in environments if item not in SUPPORTED_ENVIRONMENTS]
    if invalid:
        raise SystemExit(f"unsupported environments: {', '.join(invalid)}")

    sending_domain = email_domain(args.sending_email)
    auth_pool_key, rotated_key = ensure_auth_pool_key(cwd=args.cwd, rotate=args.rotate_auth_pool_key)
    shared_values = {
        "AUTH_ALLOWED_EMAIL_DOMAIN": args.allowed_domain.lower(),
        "MAILGUN_API_KEY": args.mailgun_api_key,
        "MAILGUN_DOMAIN": sending_domain,
        "MAILGUN_FROM": args.sending_email,
        "AUTH_POOL_ENCRYPTION_KEY": auth_pool_key,
    }

    for environment in environments:
        for name, value in shared_values.items():
            upsert_vercel_env(name, value, environment, cwd=args.cwd)

    if not args.skip_deploy:
        deploy_production(cwd=args.cwd)

    print(
        "\n".join(
            [
                "Configured Vercel environments:",
                *[f"- {environment}" for environment in environments],
                f"Allowed company domain: {args.allowed_domain.lower()}",
                f"Mailgun sending domain: {sending_domain}",
                f"Mailgun from: {args.sending_email}",
                f"Auth pool key rotated: {'yes' if rotated_key else 'no'}",
            ]
        )
    )


if __name__ == "__main__":
    main()
