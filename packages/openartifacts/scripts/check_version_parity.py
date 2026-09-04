#!/usr/bin/env python3
"""Check that the npm and PyPI release versions agree."""

import argparse
import json
from pathlib import Path
import re


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
STABLE_SEMVER = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")


def package_versions(package_root=PACKAGE_ROOT):
    npm_version = json.loads(
        (package_root / "package.json").read_text(encoding="utf-8")
    )["version"]
    lock_version = json.loads(
        (package_root.parents[1] / "package-lock.json").read_text(encoding="utf-8")
    )["packages"]["packages/openartifacts"]["version"]
    pyproject = (package_root / "pyproject.toml").read_text(encoding="utf-8")
    pypi_versions = re.findall(r'(?m)^version\s*=\s*"([^"]+)"\s*$', pyproject)
    if len(pypi_versions) != 1:
        raise ValueError("pyproject.toml must contain exactly one string version")
    return npm_version, pypi_versions[0], lock_version


def check_version(expected=None):
    if expected is not None and STABLE_SEMVER.fullmatch(expected) is None:
        raise ValueError(
            f"requested version {expected} is not a stable X.Y.Z version"
        )
    npm_version, pypi_version, lock_version = package_versions()
    if len({npm_version, pypi_version, lock_version}) != 1:
        raise ValueError(
            "version mismatch: "
            f"package.json={npm_version}, pyproject.toml={pypi_version}, "
            f"package-lock.json={lock_version}"
        )
    if expected is not None and npm_version != expected:
        raise ValueError(
            f"requested version {expected} does not match package version {npm_version}"
        )
    if STABLE_SEMVER.fullmatch(npm_version) is None:
        raise ValueError(
            f"package version {npm_version} is not a stable X.Y.Z version"
        )
    return npm_version


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--expect", help="also require this exact release version")
    arguments = parser.parse_args(argv)
    try:
        version = check_version(arguments.expect)
    except ValueError as error:
        parser.error(str(error))
    print(version)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
