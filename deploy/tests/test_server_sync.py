"""Exercise the release script in a temporary Linux tree, without root or network.

Git, tar, rsync and file operations are real. Only npm, the configuration probe,
service management, health checks and chown are replaced with local fixtures.
Run: python3 -m unittest discover -s deploy/tests -v
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "server-sync.sh"


class ServerSyncTest(unittest.TestCase):
    def setUp(self):
        for command in ("bash", "git", "rsync", "tar", "python3"):
            if shutil.which(command) is None:
                self.fail(f"Missing release test tool: {command}; run these tests on Linux")
        temporary = tempfile.TemporaryDirectory(prefix="myoffer-release-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.app = self.root / "app"
        self.source = self.root / "source"
        self.backups = self.root / "backups"
        self.service = self.root / "etc/backend.service"
        self.nginx = self.root / "etc/nginx.conf"
        self.log = self.root / "commands.log"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.old_env = "ENV=production\nSESSION_SECRET=fixture-only-session-secret-value\n"

        for tree, version in ((self.app, "old"), (self.source, "new")):
            self.write(tree / ".gitignore", ".env\nbackend/.venv/\nbackend/ai-runtime/node_modules/\nout/\n")
            self.write(tree / "code.txt", version)
            self.write(tree / "backend/ai-runtime/package-lock.json", version)
            self.write(tree / "deploy/myoffer-backend.service", f"{version}-service")
            self.write(tree / "deploy/nginx-myoffer-static.conf", f"{version}-nginx")
        self.old_revision = self.commit(self.app)
        self.write(self.app / "backend/.venv/bin/python", "#!/usr/bin/env bash\nexit 0\n", executable=True)
        self.write(self.app / ".env", self.old_env)
        self.write(self.app / "out/index.html", "old-static")
        self.write(self.service, "old-service")
        self.write(self.nginx, "old-nginx")
        self.modules = self.app / "backend/ai-runtime/node_modules"
        self.write(self.modules / "@earendil-works/pi-ai/version", "old")
        self.write(self.modules / "old-only", "must return on rollback")
        # Preserve symlinks as well as files in the dependency archive.
        (self.modules / "version-link").symlink_to("@earendil-works/pi-ai/version")

        self.write(self.root / "static/index.html", "new-static")
        self.archive = self.root / "static.tar.gz"
        with tarfile.open(self.archive, "w:gz") as archive:
            archive.add(self.root / "static/index.html", arcname="index.html")

        self.mock("npm", '''
printf 'npm\n' >> "$TEST_LOG"
[[ "$TEST_FAILURE" != install ]] || exit 9
mkdir -p node_modules/@earendil-works/pi-ai
cp package-lock.json node_modules/@earendil-works/pi-ai/version
printf new > node_modules/new-only
''')
        self.mock("systemctl", '''
printf 'systemctl %s\n' "$*" >> "$TEST_LOG"
if [[ "$*" == 'start myoffer-backend' && "$TEST_FAILURE" == start && ! -f "$TEST_FAILED" ]]; then
  touch "$TEST_FAILED"
  exit 1
fi
''')
        self.mock("rsync", '''
source_path="${@: -2:1}"
target_path="${@: -1}"
if [[ "$TEST_FAILURE" == same-mtime && "$source_path" == */source/ ]]; then
  # Force the rsync quick-check collision for both source and Git revision.
  touch -r "$source_path/code.txt" "$target_path/code.txt"
  touch -r "$source_path/.git/refs/heads/master" "$target_path/.git/refs/heads/master"
fi
if [[ "$TEST_FAILURE" == dependency-copy && "$source_path" == */source/backend/ai-runtime/node_modules/ ]]; then
  # Copy enough to replace old files, then emulate an interrupted transfer.
  "$TEST_REAL_RSYNC" -a --delete --exclude=new-only "$source_path" "$target_path"
  exit 23
fi
exec "$TEST_REAL_RSYNC" "$@"
''')
        for command in ("nginx", "curl", "chown"):
            self.mock(command, f'printf \'{command} %s\\n\' "$*" >> "$TEST_LOG"\n')

        # Rewrite only the fixed production paths in the copy under test.
        script = SCRIPT.read_text(encoding="utf-8")
        for original, replacement in (
            ("/srv/myoffer", self.app),
            ("/srv/backups/myoffer", self.backups),
            ("/srv/.myoffer-sync.XXXXXX", self.root / "stage.XXXXXX"),
            ("/etc/systemd/system/myoffer-backend.service", self.service),
            ("/etc/nginx/sites-available/myoffer", self.nginx),
        ):
            if original not in script:
                self.fail(f"Release fixture needs updating for path: {original}")
            script = script.replace(original, str(replacement))
        self.script = self.root / "server-sync.sh"
        self.write(self.script, script)
        self.env = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "MYOFFER_REPOSITORY": str(self.source),
            "TEST_LOG": str(self.log),
            "TEST_FAILED": str(self.root / "failed-once"),
            "TEST_REAL_RSYNC": shutil.which("rsync"),
        }

    @staticmethod
    def write(path, content, *, executable=False):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        if executable:
            path.chmod(0o755)

    def mock(self, name, body):
        self.write(self.bin / name, "#!/usr/bin/env bash\nset -euo pipefail\n" + body, executable=True)

    @staticmethod
    def git(tree, *args):
        return subprocess.check_output(["git", "-C", str(tree), *args], text=True).strip()

    def commit(self, tree):
        self.git(tree, "init", "-q", "-b", "master")
        self.git(tree, "add", ".")
        self.git(tree, "-c", "user.name=Release Test", "-c", "user.email=test@example.invalid",
                 "commit", "-qm", "Fixture release")
        return self.git(tree, "rev-parse", "HEAD")

    def release(self, failure=""):
        revision = self.commit(self.source)
        result = subprocess.run(
            ["bash", "-x", str(self.script), revision, str(self.archive)],
            env={**self.env, "TEST_FAILURE": failure}, text=True, capture_output=True, timeout=30,
            check=False,
        )
        self.output = result.stdout + result.stderr
        self.commands = self.log.read_text() if self.log.exists() else ""
        return result, revision

    def assert_old_release(self):
        for path, content in (
            (self.app / "code.txt", "old"),
            (self.app / "backend/ai-runtime/package-lock.json", "old"),
            (self.app / "out/index.html", "old-static"),
            (self.app / ".env", self.old_env),
            (self.service, "old-service"),
            (self.nginx, "old-nginx"),
        ):
            self.assertEqual(path.read_text(), content, f"{path}\n{self.output}")
        self.assertEqual(self.git(self.app, "rev-parse", "HEAD"), self.old_revision)
        self.assertEqual(self.git(self.app, "status", "--porcelain"), "")

    def assert_old_dependencies(self):
        self.assertEqual((self.modules / "@earendil-works/pi-ai/version").read_text(), "old")
        self.assertTrue((self.modules / "old-only").exists())
        self.assertTrue((self.modules / "version-link").is_symlink())
        self.assertEqual((self.modules / "version-link").read_text(), "old")
        self.assertFalse((self.modules / "new-only").exists())

    def test_success_updates_code_static_and_dependencies(self):
        result, revision = self.release()
        self.assertEqual(result.returncode, 0, self.output)
        self.assertEqual((self.app / "code.txt").read_text(), "new")
        self.assertEqual((self.app / "out/index.html").read_text(), "new-static")
        self.assertEqual((self.modules / "@earendil-works/pi-ai/version").read_text(), "new")
        self.assertFalse((self.modules / "old-only").exists())
        self.assertTrue((self.modules / "new-only").exists())
        self.assertEqual(self.git(self.app, "rev-parse", "HEAD"), revision)
        self.assertEqual(self.git(self.app, "status", "--porcelain"), "")
        self.assertIn("SESSION_SECRET=fixture-only-session-secret-value", (self.app / ".env").read_text())
        self.assertEqual(len(list(self.backups.glob("*/ai-node_modules.tar.gz"))), 1)

    def test_start_failure_restores_complete_release_without_reinstalling(self):
        result, _ = self.release("start")
        self.assertNotEqual(result.returncode, 0, self.output)
        self.assertIn("release failed; restoring", self.output)
        self.assert_old_release()
        self.assert_old_dependencies()
        self.assertEqual(self.commands.count("npm\n"), 1)

    def test_same_size_and_mtime_still_updates_content_and_git_revision(self):
        result, revision = self.release("same-mtime")
        self.assertEqual(result.returncode, 0, self.output)
        self.assertEqual((self.app / "code.txt").read_text(), "new")
        self.assertEqual(self.git(self.app, "rev-parse", "HEAD"), revision)

    def test_partial_dependency_copy_failure_restores_old_modules(self):
        result, _ = self.release("dependency-copy")
        self.assertNotEqual(result.returncode, 0, self.output)
        self.assertIn("release failed; restoring", self.output)
        self.assert_old_release()
        self.assert_old_dependencies()

    def test_first_install_failure_removes_new_modules(self):
        shutil.rmtree(self.modules)
        result, _ = self.release("start")
        self.assertNotEqual(result.returncode, 0, self.output)
        self.assert_old_release()
        self.assertFalse(self.modules.exists())

    def test_missing_package_with_same_lock_restores_other_modules(self):
        self.write(self.source / "backend/ai-runtime/package-lock.json", "old")
        shutil.rmtree(self.modules / "@earendil-works/pi-ai")
        result, _ = self.release("start")
        self.assertNotEqual(result.returncode, 0, self.output)
        self.assert_old_release()
        self.assertFalse((self.modules / "@earendil-works/pi-ai").exists())
        self.assertTrue((self.modules / "old-only").exists())
        self.assertFalse((self.modules / "new-only").exists())

    def test_unchanged_dependencies_are_preserved_without_install(self):
        self.write(self.source / "backend/ai-runtime/package-lock.json", "old")
        result, _ = self.release()
        self.assertEqual(result.returncode, 0, self.output)
        self.assertNotIn("npm\n", self.commands)
        self.assert_old_dependencies()
        self.assertEqual(list(self.backups.glob("*/ai-node_modules.tar.gz")), [])

    def test_install_failure_leaves_running_release_untouched(self):
        result, _ = self.release("install")
        self.assertNotEqual(result.returncode, 0, self.output)
        self.assertNotIn("systemctl", self.commands)
        self.assert_old_release()
        self.assert_old_dependencies()


if __name__ == "__main__":
    unittest.main()
