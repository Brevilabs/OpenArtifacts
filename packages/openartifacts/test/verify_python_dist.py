#!/usr/bin/env python3
"""Verify Python release archives contain only the thin launcher and metadata."""

import argparse
import configparser
from email.parser import BytesParser
from email.policy import default
from pathlib import Path, PurePosixPath
import tarfile
from typing import Iterable, List, Optional, Sequence
import zipfile


def relative_sdist_names(path: Path) -> List[PurePosixPath]:
    with tarfile.open(path, "r:gz") as archive:
        files = [PurePosixPath(item.name) for item in archive.getmembers() if item.isfile()]
    roots = {item.parts[0] for item in files}
    if len(roots) != 1:
        raise ValueError(f"sdist must have one root directory, found {sorted(roots)}")
    return [PurePosixPath(*item.parts[1:]) for item in files]


def wheel_names(path: Path) -> List[PurePosixPath]:
    with zipfile.ZipFile(path) as archive:
        return [PurePosixPath(name) for name in archive.namelist() if not name.endswith("/")]


def wheel_console_script(path: Path) -> str:
    with zipfile.ZipFile(path) as archive:
        names = [
            name
            for name in archive.namelist()
            if name.endswith(".dist-info/entry_points.txt")
        ]
        if len(names) != 1:
            raise ValueError(f"wheel must contain one entry_points.txt, found {len(names)}")
        parser = configparser.ConfigParser()
        parser.read_string(archive.read(names[0]).decode("utf-8"))
    try:
        return parser["console_scripts"]["openartifacts"]
    except KeyError as error:
        raise ValueError("wheel has no openartifacts console script") from error


def wheel_metadata(path: Path):
    with zipfile.ZipFile(path) as archive:
        names = [name for name in archive.namelist() if name.endswith(".dist-info/METADATA")]
        if len(names) != 1:
            raise ValueError(f"wheel must contain one METADATA file, found {len(names)}")
        return BytesParser(policy=default).parsebytes(archive.read(names[0]))


def reject_non_python_payload(names: Iterable[PurePosixPath], archive: str) -> None:
    forbidden_parts = {"bin", "skill", "src", "test", "node_modules"}
    forbidden_suffixes = {".js", ".ts", ".sql"}
    for name in names:
        if forbidden_parts.intersection(name.parts):
            raise ValueError(f"{archive} contains non-Python payload: {name}")
        if name.name == "package.json" or name.suffix in forbidden_suffixes:
            raise ValueError(f"{archive} contains non-Python payload: {name}")


def verify(directory: Path) -> None:
    wheels = sorted(directory.glob("openartifacts-*.whl"))
    sdists = sorted(directory.glob("openartifacts-*.tar.gz"))
    if len(wheels) != 1 or len(sdists) != 1:
        raise ValueError(
            f"expected one wheel and one sdist, found {len(wheels)} wheel(s) and {len(sdists)} sdist(s)"
        )

    wheel = wheel_names(wheels[0])
    sdist = relative_sdist_names(sdists[0])
    reject_non_python_payload(wheel, wheels[0].name)
    reject_non_python_payload(sdist, sdists[0].name)

    wheel_strings = {str(name) for name in wheel}
    required_wheel = {
        "openartifacts_launcher/__init__.py",
        "openartifacts_launcher/cli.py",
    }
    if not required_wheel.issubset(wheel_strings):
        raise ValueError(f"wheel is missing {sorted(required_wheel - wheel_strings)}")
    console_script = wheel_console_script(wheels[0])
    if console_script != "openartifacts_launcher.cli:entrypoint":
        raise ValueError(f"wheel has unexpected openartifacts console script: {console_script}")
    metadata = wheel_metadata(wheels[0])
    if metadata.get_all("Requires-Dist"):
        raise ValueError("wheel declares runtime dependencies")
    if metadata["Requires-Python"] != ">=3.9":
        raise ValueError(f"wheel has unexpected Python requirement: {metadata['Requires-Python']}")

    sdist_strings = {str(name) for name in sdist}
    if "README.md" in sdist_strings:
        raise ValueError("sdist contains the npm package README instead of only the PyPI README")
    required_sdist = {
        "LICENSE",
        "pyproject.toml",
        "python/README.md",
        "python/openartifacts_launcher/__init__.py",
        "python/openartifacts_launcher/cli.py",
    }
    if not required_sdist.issubset(sdist_strings):
        raise ValueError(f"sdist is missing {sorted(required_sdist - sdist_strings)}")


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    arguments = parser.parse_args(argv)
    verify(arguments.directory)
    print("Python wheel and sdist contain only the launcher and package metadata")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
