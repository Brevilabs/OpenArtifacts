"""Delegate the Python console script to the matching npm CLI release."""

from importlib.metadata import version as distribution_version
import shutil
import subprocess
import sys
from typing import Optional, Sequence


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Run the matching npm CLI without interpreting its arguments or output."""
    npx = shutil.which("npx")
    if npx is None:
        print(
            "openartifacts requires Node.js 20+ with npm; install it from https://nodejs.org/.",
            file=sys.stderr,
        )
        return 127

    arguments = list(sys.argv[1:] if argv is None else argv)
    package = f"openartifacts@{distribution_version('openartifacts')}"
    try:
        completed = subprocess.run([npx, "--yes", package, *arguments])
    except KeyboardInterrupt:
        return 130
    return completed.returncode


def entrypoint() -> None:
    """Console-script entry point."""
    raise SystemExit(main())
