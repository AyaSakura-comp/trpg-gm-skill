import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from trpg_gm.cli import ROOM_FILE_SUFFIX, main


class CliTests(unittest.TestCase):
    def test_commands_without_db_share_the_canonical_room_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            rooms_directory = Path(directory) / "central-rooms"
            with patch.dict(os.environ, {"TRPG_GM_ROOMS_DIR": str(rooms_directory)}):
                with redirect_stdout(StringIO()):
                    self.assertEqual(main(["room", "create", "demo", "--system", "coc7"]), 0)
                context_output = StringIO()
                with redirect_stdout(context_output):
                    self.assertEqual(main(["context", "demo"]), 0)
                catalog_output = StringIO()
                with redirect_stdout(catalog_output):
                    self.assertEqual(main(["rooms", "list"]), 0)

            self.assertEqual(json.loads(context_output.getvalue())["room"]["id"], "demo")
            catalog = json.loads(catalog_output.getvalue())
            self.assertEqual(catalog["root"], str(rooms_directory.resolve()))
            self.assertEqual([room["room_id"] for room in catalog["rooms"]], ["demo"])
            self.assertEqual(Path(catalog["rooms"][0]["db"]).parent, rooms_directory.resolve())

    def test_missing_canonical_directory_lists_as_empty(self):
        with tempfile.TemporaryDirectory() as directory:
            rooms_directory = Path(directory) / "not-created"
            with patch.dict(os.environ, {"TRPG_GM_ROOMS_DIR": str(rooms_directory)}):
                output = StringIO()
                with redirect_stdout(output):
                    self.assertEqual(main(["rooms", "list"]), 0)
            catalog = json.loads(output.getvalue())
            self.assertEqual(catalog["root"], str(rooms_directory.resolve()))
            self.assertEqual(catalog["rooms"], [])

    def test_canonical_room_id_cannot_escape_the_shared_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            rooms_directory = Path(directory) / "central-rooms"
            with patch.dict(os.environ, {"TRPG_GM_ROOMS_DIR": str(rooms_directory)}):
                with self.assertRaisesRegex(ValueError, "safe room id"):
                    main(["room", "create", "../escape"])

    def test_canonical_room_rejects_a_preexisting_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outside = root / "outside-room"
            rooms_directory = root / "canonical"
            rooms_directory.mkdir()
            with redirect_stdout(StringIO()):
                main(["--db", str(outside), "room", "create", "external"])
            (rooms_directory / f"external{ROOM_FILE_SUFFIX}").symlink_to(outside)

            with patch.dict(os.environ, {"TRPG_GM_ROOMS_DIR": str(rooms_directory)}):
                with self.assertRaisesRegex(ValueError, "symlink"):
                    main(["context", "external"])

    def test_rooms_list_discovers_active_trpg_databases_under_standard_room_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            alpha_db = root / "workspace-a" / ".trpg" / "rooms" / "alpha"
            beta_db = root / "workspace-b" / ".trpg" / "rooms" / "beta"
            junk = root / "workspace-b" / ".trpg" / "rooms" / "notes.txt"
            with redirect_stdout(StringIO()):
                main(["--db", str(alpha_db), "room", "create", "alpha", "--system", "coc7"])
                main(["--db", str(beta_db), "room", "create", "beta", "--system", "fate"])
                main([
                    "--db", str(alpha_db), "character", "add", "alpha", "alice", "艾莉絲",
                    "--hp", "10", "--mp", "8", "--san", "55",
                ])
            junk.write_text("not a TRPG room", encoding="utf-8")

            output = StringIO()
            with redirect_stdout(output):
                self.assertEqual(main(["rooms", "list", str(root)]), 0)

            catalog = json.loads(output.getvalue())
            self.assertEqual(catalog["root"], str(root.resolve()))
            self.assertTrue(catalog["active_only"])
            self.assertEqual([room["room_id"] for room in catalog["rooms"]], ["alpha", "beta"])
            self.assertEqual(catalog["rooms"][0]["character_count"], 1)
            self.assertEqual(catalog["rooms"][1]["system"], "fate")
            self.assertEqual(catalog["rooms"][0]["db"], str(alpha_db.resolve()))
            self.assertNotIn("script_path", catalog["rooms"][0])

    def test_rooms_relocate_moves_active_rooms_to_canonical_and_keeps_legacy_alias(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "workspace" / ".trpg" / "rooms" / "legacy"
            canonical = root / "canonical"
            with redirect_stdout(StringIO()):
                main(["--db", str(source), "room", "create", "legacy", "--system", "coc7"])
            output = StringIO()
            with patch.dict(os.environ, {"TRPG_GM_ROOMS_DIR": str(canonical)}):
                with redirect_stdout(output):
                    self.assertEqual(main(["rooms", "relocate", str(source.parent)]), 0)
                canonical_context = StringIO()
                with redirect_stdout(canonical_context):
                    self.assertEqual(main(["context", "legacy"]), 0)
                legacy_context = StringIO()
                with redirect_stdout(legacy_context):
                    self.assertEqual(main(["--db", str(source), "context", "legacy"]), 0)

            relocation = json.loads(output.getvalue())
            self.assertEqual([room["room_id"] for room in relocation["relocated"]], ["legacy"])
            self.assertEqual(json.loads(canonical_context.getvalue())["room"]["system"], "coc7")
            self.assertEqual(json.loads(legacy_context.getvalue())["room"]["id"], "legacy")

    def test_rooms_relocate_discovers_the_pre_v015_default_location(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "workspace" / ".trpg" / f"game{ROOM_FILE_SUFFIX}"
            canonical = root / "canonical"
            with redirect_stdout(StringIO()):
                main(["--db", str(source), "room", "create", "old-default"])
            with patch.dict(os.environ, {"TRPG_GM_ROOMS_DIR": str(canonical)}):
                output = StringIO()
                with redirect_stdout(output):
                    self.assertEqual(main(["rooms", "relocate", str(root)]), 0)
                context_output = StringIO()
                with redirect_stdout(context_output):
                    self.assertEqual(main(["context", "old-default"]), 0)
            self.assertEqual(json.loads(output.getvalue())["relocated"][0]["room_id"], "old-default")
            self.assertEqual(json.loads(context_output.getvalue())["room"]["id"], "old-default")

    def test_rooms_relocate_refuses_to_overwrite_a_canonical_room(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "workspace" / ".trpg" / "rooms" / "same"
            canonical = root / "canonical"
            with redirect_stdout(StringIO()):
                main(["--db", str(source), "room", "create", "same", "--system", "fate"])
            with patch.dict(os.environ, {"TRPG_GM_ROOMS_DIR": str(canonical)}):
                with redirect_stdout(StringIO()):
                    main(["room", "create", "same", "--system", "coc7"])
                with self.assertRaisesRegex(ValueError, "already exists"):
                    main(["rooms", "relocate", str(root)])
                context_output = StringIO()
                with redirect_stdout(context_output):
                    main(["context", "same"])
            self.assertEqual(json.loads(context_output.getvalue())["room"]["system"], "coc7")

    def test_rooms_relocate_never_leaves_the_legacy_path_missing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "workspace" / ".trpg" / "rooms" / "continuous"
            canonical = root / "canonical"
            with redirect_stdout(StringIO()):
                main(["--db", str(source), "room", "create", "continuous"])
            real_symlink_to = Path.symlink_to

            def require_legacy_path_while_preparing_alias(path, target, *args, **kwargs):
                self.assertTrue(source.exists())
                return real_symlink_to(path, target, *args, **kwargs)

            with patch.dict(os.environ, {"TRPG_GM_ROOMS_DIR": str(canonical)}):
                with patch.object(Path, "symlink_to", require_legacy_path_while_preparing_alias):
                    with redirect_stdout(StringIO()):
                        main(["rooms", "relocate", str(root)])
                output = StringIO()
                with redirect_stdout(output):
                    main(["--db", str(source), "context", "continuous"])
            self.assertEqual(json.loads(output.getvalue())["room"]["id"], "continuous")

    def test_rooms_relocate_never_overwrites_a_target_created_after_preflight(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "workspace" / ".trpg" / "rooms" / "race"
            canonical = root / "canonical"
            target = canonical / f"race{ROOM_FILE_SUFFIX}"
            with redirect_stdout(StringIO()):
                main(["--db", str(source), "room", "create", "race", "--system", "coc7"])
            real_link = os.link

            def create_competing_target_then_link(old, new):
                with redirect_stdout(StringIO()):
                    main(["--db", str(target), "room", "create", "race", "--system", "fate"])
                return real_link(old, new)

            with patch.dict(os.environ, {"TRPG_GM_ROOMS_DIR": str(canonical)}):
                with patch("trpg_gm.cli.os.link", side_effect=create_competing_target_then_link):
                    with self.assertRaises(FileExistsError):
                        main(["rooms", "relocate", str(root)])
                canonical_output = StringIO()
                legacy_output = StringIO()
                with redirect_stdout(canonical_output):
                    main(["context", "race"])
                with redirect_stdout(legacy_output):
                    main(["--db", str(source), "context", "race"])
            self.assertEqual(json.loads(canonical_output.getvalue())["room"]["system"], "fate")
            self.assertEqual(json.loads(legacy_output.getvalue())["room"]["system"], "coc7")

    def test_rooms_relocate_rejects_duplicate_room_ids_before_moving(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "one" / ".trpg" / "rooms" / "duplicate"
            second = root / "two" / ".trpg" / "rooms" / "duplicate"
            canonical = root / "canonical"
            with redirect_stdout(StringIO()):
                main(["--db", str(first), "room", "create", "duplicate", "--system", "coc7"])
                main(["--db", str(second), "room", "create", "duplicate", "--system", "fate"])
            with patch.dict(os.environ, {"TRPG_GM_ROOMS_DIR": str(canonical)}):
                with self.assertRaisesRegex(ValueError, "duplicate room id"):
                    main(["rooms", "relocate", str(root)])
            first_output = StringIO()
            second_output = StringIO()
            with redirect_stdout(first_output):
                main(["--db", str(first), "context", "duplicate"])
            with redirect_stdout(second_output):
                main(["--db", str(second), "context", "duplicate"])
            self.assertEqual(json.loads(first_output.getvalue())["room"]["system"], "coc7")
            self.assertEqual(json.loads(second_output.getvalue())["room"]["system"], "fate")

    def test_rooms_list_does_not_follow_a_room_directory_symlink_outside_root(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside:
            root = Path(directory)
            outside_db = Path(outside) / ".trpg" / "rooms" / "external"
            with redirect_stdout(StringIO()):
                main(["--db", str(outside_db), "room", "create", "external"])
            linked_parent = root / "workspace" / ".trpg"
            linked_parent.mkdir(parents=True)
            (linked_parent / "rooms").symlink_to(outside_db.parent, target_is_directory=True)

            output = StringIO()
            with redirect_stdout(output):
                self.assertEqual(main(["rooms", "list", str(root)]), 0)

            self.assertEqual(json.loads(output.getvalue())["rooms"], [])

    def test_rooms_list_rejects_a_missing_or_non_directory_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(ValueError, "room search root must be an existing directory"):
                main(["rooms", "list", str(root / "missing")])
            file_root = root / "file"
            file_root.write_text("x", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "room search root must be an existing directory"):
                main(["rooms", "list", str(file_root)])

    def test_explicit_equals_db_option_keeps_legacy_location(self):
        with tempfile.TemporaryDirectory() as directory:
            db = str(Path(directory) / "legacy")
            canonical = str(Path(directory) / "canonical")
            with patch.dict(os.environ, {"TRPG_GM_ROOMS_DIR": canonical}):
                with redirect_stdout(StringIO()):
                    self.assertEqual(main([f"--db={db}", "room", "create", "legacy"]), 0)
                output = StringIO()
                with redirect_stdout(output):
                    self.assertEqual(main(["--db", db, "context", "legacy"]), 0)
            self.assertEqual(json.loads(output.getvalue())["room"]["id"], "legacy")

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

    def test_guardrail_cli_persists_rules_and_forces_rejection(self):
        with tempfile.TemporaryDirectory() as directory:
            db = str(Path(directory) / "game.sqlite3")
            with redirect_stdout(StringIO()):
                main(["--db", db, "room", "create", "demo", "--system", "coc7"])
                main([
                    "--db", db, "character", "add", "demo", "alice", "艾莉絲",
                    "--hp", "10", "--mp", "8", "--san", "55",
                ])
                main([
                    "--db", db, "guardrail", "add", "demo", "no-magic",
                    "--scopes", '["character","action"]',
                    "--statement", "玩家角色不得施法或瞬間移動。",
                    "--terms", '["施法","瞬間移動"]',
                    "--source", "scenario.md#limits",
                ])
            output = StringIO()
            with redirect_stdout(output):
                main([
                    "--db", db, "action", "adjudicate", "demo", "alice", "施法打開門",
                    "--decision", "accepted", "--basis", "玩家要求", "--reason", "接受",
                ])
            ruling = json.loads(output.getvalue())
            self.assertEqual(ruling["decision"], "rejected")
            self.assertEqual(ruling["enforced_guardrails"], ["no-magic"])

            output = StringIO()
            with redirect_stdout(output):
                main(["--db", db, "guardrail", "list", "demo"])
            self.assertEqual(json.loads(output.getvalue())[0]["id"], "no-magic")

    def test_character_availability_cli_updates_participation(self):
        with tempfile.TemporaryDirectory() as directory:
            db = str(Path(directory) / "game.db")
            with redirect_stdout(StringIO()):
                main(["--db", db, "room", "create", "demo", "--system", "coc7"])
                main([
                    "--db", db, "character", "add", "demo", "alice", "艾莉絲",
                    "--hp", "10", "--mp", "8", "--san", "55",
                ])
            output = StringIO()
            with redirect_stdout(output):
                self.assertEqual(main([
                    "--db", db, "character", "availability", "demo", "alice",
                    "--can-act", "false", "--reason", "受到束縛",
                ]), 0)
            self.assertFalse(json.loads(output.getvalue())["can_act"])

            output = StringIO()
            with redirect_stdout(output):
                main(["--db", db, "context", "demo"])
            participant = json.loads(output.getvalue())["participation"]["characters"][0]
            self.assertFalse(participant["can_act"])
            self.assertEqual(participant["unavailable_reason"], "受到束縛")

    def test_story_progress_cli_tracks_stagnation_and_intervention(self):
        with tempfile.TemporaryDirectory() as directory:
            db = str(Path(directory) / "game.db")
            with redirect_stdout(StringIO()):
                main(["--db", db, "room", "create", "demo", "--system", "coc7"])
                main([
                    "--db", db, "character", "add", "demo", "alice", "艾莉絲",
                    "--hp", "10", "--mp", "8", "--san", "55",
                ])
                main([
                    "--db", db, "story", "objective", "demo",
                    "--chapter", "第一章", "--objective", "找到地下室入口",
                    "--reason", "劇本目前目標",
                ])
                for index in range(3):
                    main([
                        "--db", db, "action", "adjudicate", "demo", "alice",
                        f"搜索大廳 {index}", "--decision", "accepted",
                        "--basis", "場景允許", "--reason", "一般搜索",
                    ])
                    main([
                        "--db", db, "story", "progress", "demo",
                        "--status", "stalled", "--reason", "沒有新發現",
                    ])
            output = StringIO()
            with redirect_stdout(output):
                main([
                    "--db", db, "story", "intervene", "demo",
                    "--event", "地下室傳出撞擊聲，暗門隨即打開",
                    "--intended-progress", "引導玩家前往地下室",
                    "--reason", "三次玩家行動沒有推進劇情",
                ])

            progress = json.loads(output.getvalue())
            self.assertEqual(progress["stagnant_action_count"], 0)
            self.assertFalse(progress["intervention_required"])

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
