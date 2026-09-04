import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE_ROOT / "python"))

from openartifacts_launcher import cli  # noqa: E402


def load_version_checker():
    path = PACKAGE_ROOT / "scripts" / "check_version_parity.py"
    spec = importlib.util.spec_from_file_location("check_version_parity", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class LauncherTest(unittest.TestCase):
    @patch.object(cli, "distribution_version", return_value="0.2.0")
    @patch.object(cli.subprocess, "run")
    @patch.object(cli.shutil, "which", return_value="C:\\Node\\npx.cmd")
    def test_forwards_exact_arguments_and_child_status(self, which, run, version):
        run.return_value.returncode = 23
        arguments = ["publish", "a file.md", "$(still-data)", "--flag=value"]

        status = cli.main(arguments)

        self.assertEqual(status, 23)
        which.assert_called_once_with("npx")
        version.assert_called_once_with("openartifacts")
        run.assert_called_once_with(
            ["C:\\Node\\npx.cmd", "--yes", "openartifacts@0.2.0", *arguments]
        )

    @patch.object(cli.shutil, "which", return_value=None)
    def test_missing_npx_returns_127_with_install_guidance(self, which):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            status = cli.main(["--help"])

        self.assertEqual(status, 127)
        self.assertIn("Node.js 20+ with npm", stderr.getvalue())
        which.assert_called_once_with("npx")

    @patch.object(cli, "distribution_version", return_value="0.2.0")
    @patch.object(cli.subprocess, "run", side_effect=KeyboardInterrupt)
    @patch.object(cli.shutil, "which", return_value="/usr/local/bin/npx")
    def test_keyboard_interrupt_returns_130(self, _which, _run, _version):
        self.assertEqual(cli.main([]), 130)

    @patch.object(cli, "distribution_version", return_value="9.8.7")
    def test_executes_resolved_npx_with_inherited_environment(self, _version):
        with tempfile.TemporaryDirectory() as raw_directory:
            directory = Path(raw_directory)
            captured = directory / "arguments.json"
            capture_script = directory / "capture.py"
            capture_script.write_text(
                "import json, os, pathlib, sys\n"
                "pathlib.Path(os.environ['OPENARTIFACTS_CAPTURE']).write_text(json.dumps(sys.argv[1:]))\n"
                "raise SystemExit(37)\n",
                encoding="utf-8",
            )
            if os.name == "nt":
                npx = directory / "npx.cmd"
                npx.write_text(
                    f'@echo off\r\n"{sys.executable}" "%~dp0capture.py" %*\r\nexit /b %errorlevel%\r\n',
                    encoding="utf-8",
                )
            else:
                npx = directory / "npx"
                npx.write_text(
                    f"#!{sys.executable}\n"
                    "import json, os, pathlib, sys\n"
                    "pathlib.Path(os.environ['OPENARTIFACTS_CAPTURE']).write_text(json.dumps(sys.argv[1:]))\n"
                    "raise SystemExit(37)\n",
                    encoding="utf-8",
                )
                npx.chmod(0o755)

            arguments = ["publish", "a file.md", "literal & value"]
            path = f"{directory}{os.pathsep}{os.environ.get('PATH', '')}"
            with patch.dict(
                os.environ,
                {"PATH": path, "OPENARTIFACTS_CAPTURE": str(captured)},
            ):
                status = cli.main(arguments)

            self.assertEqual(status, 37)
            self.assertEqual(
                json.loads(captured.read_text(encoding="utf-8")),
                ["--yes", "openartifacts@9.8.7", *arguments],
            )

    def test_npm_and_python_versions_match(self):
        checker = load_version_checker()
        npm_version, pypi_version, lock_version = checker.package_versions()
        self.assertEqual(checker.check_version(), npm_version)
        self.assertEqual(npm_version, pypi_version)
        self.assertEqual(npm_version, lock_version)

    def test_release_version_must_be_stable_semver(self):
        checker = load_version_checker()
        with patch.object(
            checker,
            "package_versions",
            return_value=("1.2.3-rc.1", "1.2.3-rc.1", "1.2.3-rc.1"),
        ):
            with self.assertRaisesRegex(ValueError, "stable X.Y.Z"):
                checker.check_version("1.2.3-rc.1")

    def test_package_lock_version_must_match(self):
        checker = load_version_checker()
        with patch.object(
            checker,
            "package_versions",
            return_value=("1.2.3", "1.2.3", "1.2.2"),
        ):
            with self.assertRaisesRegex(ValueError, "package-lock.json=1.2.2"):
                checker.check_version("1.2.3")

    def test_requested_version_rejects_path_characters(self):
        checker = load_version_checker()
        with self.assertRaisesRegex(ValueError, "stable X.Y.Z"):
            checker.check_version("0.2.0/../../other")


if __name__ == "__main__":
    unittest.main()
