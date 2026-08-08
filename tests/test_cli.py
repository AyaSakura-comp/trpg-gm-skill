import json
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

from trpg_gm.cli import main


class CliTests(unittest.TestCase):
    def test_room_create_and_context_emit_json(self):
        with tempfile.TemporaryDirectory() as directory:
            db = str(Path(directory) / "game.sqlite3")
            with redirect_stdout(StringIO()):
                self.assertEqual(main(["--db", db, "room", "create", "demo", "--system", "coc7"]), 0)
            output = StringIO()
            with redirect_stdout(output):
                self.assertEqual(main(["--db", db, "context", "demo"]), 0)

            self.assertEqual(json.loads(output.getvalue())["room"]["id"], "demo")

    def test_skill_wrapper_works_when_skill_directory_is_symlinked(self):
        repository = Path(__file__).resolve().parents[1]
        source_skill = repository / ".agents" / "skills" / "trpg-gm"
        with tempfile.TemporaryDirectory() as directory:
            install_root = Path(directory) / ".agents" / "skills"
            install_root.mkdir(parents=True)
            installed_skill = install_root / "trpg-gm"
            installed_skill.symlink_to(source_skill, target_is_directory=True)
            db = Path(directory) / "game.sqlite3"

            result = subprocess.run(
                [
                    str(installed_skill / "scripts" / "trpg-gm"),
                    "--db", str(db), "room", "create", "demo", "--system", "coc7",
                ],
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["id"], "demo")

    def test_action_adjudicate_emits_persisted_ruling(self):
        with tempfile.TemporaryDirectory() as directory:
            db = str(Path(directory) / "game.sqlite3")
            with redirect_stdout(StringIO()):
                main(["--db", db, "room", "create", "demo", "--system", "coc7"])
                main([
                    "--db", db, "character", "add", "demo", "alice", "艾莉絲",
                    "--hp", "10", "--mp", "8", "--san", "55",
                ])
            output = StringIO()
            with redirect_stdout(output):
                self.assertEqual(main([
                    "--db", db, "action", "adjudicate", "demo", "alice", "飛過鎖門",
                    "--decision", "rejected",
                    "--basis", "角色卡與劇本未建立飛行能力",
                    "--reason", "角色沒有翅膀或其他飛行手段",
                ]), 0)

            ruling = json.loads(output.getvalue())
            self.assertEqual(ruling["decision"], "rejected")
            self.assertEqual(ruling["action"], "飛過鎖門")

    def test_recap_save_and_show_emit_latest_player_safe_recap(self):
        with tempfile.TemporaryDirectory() as directory:
            db = str(Path(directory) / "game.sqlite3")
            with redirect_stdout(StringIO()):
                main(["--db", db, "room", "create", "demo", "--system", "coc7"])
                main([
                    "--db", db, "recap", "save", "demo",
                    "--summary", "調查者進入地下室。",
                    "--state", '{"location":"地下室","known_clues":["黑色照片"]}',
                ])
            output = StringIO()
            with redirect_stdout(output):
                self.assertEqual(main(["--db", db, "recap", "show", "demo"]), 0)

            recap = json.loads(output.getvalue())
            self.assertEqual(recap["summary"], "調查者進入地下室。")
            self.assertEqual(recap["state"]["location"], "地下室")


if __name__ == "__main__":
    unittest.main()
