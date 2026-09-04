"""Compatibility launcher for the canonical OpenArtifacts npm CLI."""

import shutil
import subprocess
import sys


def main() -> int:
    npx = shutil.which("npx")
    if npx is None:
        print(
            "OpenArtifacts is distributed through npm and requires Node.js 20+. "
            "Install Node.js from https://nodejs.org/.",
            file=sys.stderr,
        )
        return 127

    try:
        return subprocess.run(
            [npx, "--yes", "openartifacts@latest", *sys.argv[1:]]
        ).returncode
    except KeyboardInterrupt:
        return 130


def entrypoint() -> None:
    raise SystemExit(main())
