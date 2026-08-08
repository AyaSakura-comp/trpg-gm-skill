import tempfile
import unittest
from pathlib import Path

from trpg_gm.store import GameStore


class GameStoreTests(unittest.TestCase):
    def test_create_room_persists_system_script_and_seed(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Path(directory) / "campaign.sqlite3"
            store = GameStore(db)

            room = store.create_room(
                "miskatonic", "coc7", script_path="scenarios/haunted.md", seed=42
            )

            self.assertEqual(
                room,
                {
                    "id": "miskatonic",
                    "system": "coc7",
                    "script_path": "scenarios/haunted.md",
                    "seed": 42,
                    "status": "active",
                },
            )
            self.assertEqual(GameStore(db).get_room("miskatonic"), room)

    def test_character_resources_are_room_scoped_and_changes_are_logged(self):
        with tempfile.TemporaryDirectory() as directory:
            store = GameStore(Path(directory) / "campaign.sqlite3")
            store.create_room("room-a", "coc7")
            store.create_room("room-b", "coc7")
            store.add_character(
                "room-a", "alice", "艾莉絲", hp=10, mp=8, san=55,
                stats={"力量": 45, "聆聽": 60}, notes="記者",
            )
            store.add_character(
                "room-b", "alice", "另一位艾莉絲", hp=20, mp=3, san=70
            )

            updated = store.adjust_resource("room-a", "alice", "san", -5, "目擊怪物")

            self.assertEqual(updated["san"], 50)
            self.assertEqual(store.get_character("room-b", "alice")["san"], 70)
            events = store.list_events("room-a")
            self.assertEqual(events[-1]["kind"], "resource_changed")
            self.assertEqual(events[-1]["payload"]["reason"], "目擊怪物")

    def test_canon_rejects_silent_rewrites_and_context_collects_room_state(self):
        with tempfile.TemporaryDirectory() as directory:
            store = GameStore(Path(directory) / "campaign.sqlite3")
            store.create_room("room-a", "coc7", seed=7)
            store.add_character("room-a", "alice", "艾莉絲", hp=10, mp=8, san=55)
            store.set_canon("room-a", "npc:lin:status", "失蹤", source="session-1")
            store.upsert_entity("room-a", "quest", "find-lin", "尋找林教授", {"status": "active"})

            with self.assertRaisesRegex(ValueError, "canon conflict"):
                store.set_canon("room-a", "npc:lin:status", "死亡", source="session-2")

            context = store.get_context("room-a")
            self.assertEqual(context["characters"][0]["name"], "艾莉絲")
            self.assertEqual(context["canon"]["npc:lin:status"], "失蹤")
            self.assertEqual(context["entities"][0]["state"]["status"], "active")

    def test_entity_update_preserves_unspecified_state_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            store = GameStore(Path(directory) / "campaign.sqlite3")
            store.create_room("room-a", "coc7")
            store.upsert_entity(
                "room-a", "npc", "keeper", "管理員",
                {"status": "alive", "attitude": "wary", "secret": "has-key"},
            )

            store.upsert_entity(
                "room-a", "npc", "keeper", "管理員", {"attitude": "guarded"}
            )

            entity = store.get_context("room-a")["entities"][0]
            self.assertEqual(
                entity["state"],
                {"status": "alive", "attitude": "guarded", "secret": "has-key"},
            )

    def test_record_check_uses_character_stat_and_logs_result(self):
        with tempfile.TemporaryDirectory() as directory:
            store = GameStore(Path(directory) / "campaign.sqlite3")
            store.create_room("room-a", "coc7")
            store.add_character(
                "room-a", "alice", "艾莉絲", hp=10, mp=8, san=55, stats={"聆聽": 60}
            )

            result = store.record_check("room-a", "alice", "聆聽", roll=20)

            self.assertEqual(result["degree"], "hard")
            self.assertEqual(result["target"], 60)
            self.assertEqual(store.list_events("room-a")[-1]["kind"], "check_resolved")


if __name__ == "__main__":
    unittest.main()
