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

    def test_character_creation_workflow_configures_proposes_and_rolls(self):
        with tempfile.TemporaryDirectory() as directory:
            db = str(Path(directory) / "game.sqlite3")
            rules = {
                "skill_count": 2,
                "allowed_skills": ["偵查", "聆聽"],
                "recommended_skills": ["偵查"],
                "skill_min": 20,
                "skill_max": 80,
                "resources": {
                    "hp": {"base": 8, "die": 6, "max_party_difference": 2},
                    "mp": {"base": 6, "die": 6, "max_party_difference": 2},
                    "san": {"base": 45, "die": 30, "max_party_difference": 10},
                },
            }
            with redirect_stdout(StringIO()):
                main(["--db", db, "room", "create", "demo", "--system", "coc7"])
                main([
                    "--db", db, "creation", "configure", "demo",
                    "--rules", json.dumps(rules, ensure_ascii=False),
                    "--basis", "scenario.md#characters",
                ])
                main([
                    "--db", db, "creation", "propose", "demo", "alice", "艾莉絲",
                    "--appearance", "黑髮記者",
                    "--background", "地方報社",
                    "--concept", "調查失蹤案",
                    "--skills", '["偵查","聆聽"]',
                    "--decision", "accepted",
                    "--basis", "符合現代調查劇本",
                    "--reason", "外觀背景與技能均符合世界觀",
                ])
            output = StringIO()
            with redirect_stdout(output):
                self.assertEqual(main([
                    "--db", db, "creation", "roll", "demo", "alice",
                    "--rolls", '{"skills":{"偵查":100,"聆聽":1},"hp":1,"mp":1,"san":1}',
                ]), 0)

            character = json.loads(output.getvalue())
            self.assertEqual(character["stats"], {"偵查": 80, "聆聽": 20})
            self.assertEqual(character["max_hp"], 9)
            self.assertEqual(character["appearance"], "黑髮記者")

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
