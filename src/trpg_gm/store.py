from __future__ import annotations

import json
import random
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .rules import evaluate_d100


class GameStore:
    """SQLite-backed campaign state, isolated by room id."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._migrate()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def _migrate(self) -> None:
        with self._connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS rooms (
                    id TEXT PRIMARY KEY,
                    system TEXT NOT NULL,
                    script_path TEXT,
                    seed INTEGER NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active'
                );
                CREATE TABLE IF NOT EXISTS characters (
                    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
                    id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    hp INTEGER NOT NULL,
                    mp INTEGER NOT NULL,
                    san INTEGER NOT NULL,
                    max_hp INTEGER,
                    max_mp INTEGER,
                    max_san INTEGER,
                    stats_json TEXT NOT NULL DEFAULT '{}',
                    notes TEXT NOT NULL DEFAULT '',
                    appearance TEXT NOT NULL DEFAULT '',
                    background TEXT NOT NULL DEFAULT '',
                    concept TEXT NOT NULL DEFAULT '',
                    PRIMARY KEY (room_id, id)
                );
                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
                    created_at TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS canon (
                    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
                    key TEXT NOT NULL,
                    value TEXT NOT NULL,
                    source TEXT NOT NULL,
                    PRIMARY KEY (room_id, key)
                );
                CREATE TABLE IF NOT EXISTS entities (
                    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
                    kind TEXT NOT NULL,
                    id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    state_json TEXT NOT NULL,
                    PRIMARY KEY (room_id, kind, id)
                );
                CREATE TABLE IF NOT EXISTS recaps (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
                    created_at TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    state_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS character_creation_rules (
                    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
                    rules_json TEXT NOT NULL,
                    basis TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS character_drafts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
                    character_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    appearance TEXT NOT NULL,
                    background TEXT NOT NULL,
                    concept TEXT NOT NULL,
                    skills_json TEXT NOT NULL,
                    decision TEXT NOT NULL,
                    basis TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'adjudicated'
                );
                """
            )
            character_columns = {
                row["name"] for row in db.execute("PRAGMA table_info(characters)").fetchall()
            }
            migrations = {
                "max_hp": "ALTER TABLE characters ADD COLUMN max_hp INTEGER",
                "max_mp": "ALTER TABLE characters ADD COLUMN max_mp INTEGER",
                "max_san": "ALTER TABLE characters ADD COLUMN max_san INTEGER",
                "appearance": "ALTER TABLE characters ADD COLUMN appearance TEXT NOT NULL DEFAULT ''",
                "background": "ALTER TABLE characters ADD COLUMN background TEXT NOT NULL DEFAULT ''",
                "concept": "ALTER TABLE characters ADD COLUMN concept TEXT NOT NULL DEFAULT ''",
            }
            for name, statement in migrations.items():
                if name not in character_columns:
                    db.execute(statement)
            db.execute("UPDATE characters SET max_hp = hp WHERE max_hp IS NULL")
            db.execute("UPDATE characters SET max_mp = mp WHERE max_mp IS NULL")
            db.execute("UPDATE characters SET max_san = san WHERE max_san IS NULL")

    def create_room(
        self,
        room_id: str,
        system: str,
        *,
        script_path: str | None = None,
        seed: int = 0,
    ) -> dict[str, Any]:
        with self._connect() as db:
            db.execute(
                "INSERT INTO rooms(id, system, script_path, seed) VALUES (?, ?, ?, ?)",
                (room_id, system, script_path, seed),
            )
        return self.get_room(room_id)

    def get_room(self, room_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM rooms WHERE id = ?", (room_id,)).fetchone()
        return dict(row) if row else None

    def add_character(
        self,
        room_id: str,
        character_id: str,
        name: str,
        *,
        hp: int,
        mp: int,
        san: int,
        stats: dict[str, int] | None = None,
        notes: str = "",
        appearance: str = "",
        background: str = "",
        concept: str = "",
    ) -> dict[str, Any]:
        with self._connect() as db:
            db.execute(
                """INSERT INTO characters
                (room_id, id, name, hp, mp, san, max_hp, max_mp, max_san,
                 stats_json, notes, appearance, background, concept)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    room_id, character_id, name, hp, mp, san, hp, mp, san,
                    json.dumps(stats or {}, ensure_ascii=False), notes,
                    appearance, background, concept,
                ),
            )
        return self.get_character(room_id, character_id)

    def get_character(self, room_id: str, character_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM characters WHERE room_id = ? AND id = ?",
                (room_id, character_id),
            ).fetchone()
        if not row:
            return None
        character = dict(row)
        character["stats"] = json.loads(character.pop("stats_json"))
        return character

    def adjust_resource(
        self, room_id: str, character_id: str, resource: str, delta: int, reason: str
    ) -> dict[str, Any]:
        if resource not in {"hp", "mp", "san"}:
            raise ValueError("resource must be hp, mp, or san")
        select_sql = {
            "hp": "SELECT hp, max_hp FROM characters WHERE room_id = ? AND id = ?",
            "mp": "SELECT mp, max_mp FROM characters WHERE room_id = ? AND id = ?",
            "san": "SELECT san, max_san FROM characters WHERE room_id = ? AND id = ?",
        }
        update_sql = {
            "hp": "UPDATE characters SET hp = hp + ? WHERE room_id = ? AND id = ?",
            "mp": "UPDATE characters SET mp = mp + ? WHERE room_id = ? AND id = ?",
            "san": "UPDATE characters SET san = san + ? WHERE room_id = ? AND id = ?",
        }
        maximum_column = {"hp": "max_hp", "mp": "max_mp", "san": "max_san"}[resource]
        with self._connect() as db:
            current = db.execute(
                select_sql[resource], (room_id, character_id)
            ).fetchone()
            if current is None:
                raise KeyError(f"unknown character: {room_id}/{character_id}")
            if current[resource] + delta > current[maximum_column]:
                raise ValueError(
                    f"{resource} adjustment exceeds maximum {current[maximum_column]}"
                )
            cursor = db.execute(
                update_sql[resource], (delta, room_id, character_id)
            )
            self._append_event(
                db,
                room_id,
                "resource_changed",
                {"character_id": character_id, "resource": resource, "delta": delta, "reason": reason},
            )
        return self.get_character(room_id, character_id)

    def _append_event(
        self, db: sqlite3.Connection, room_id: str, kind: str, payload: dict[str, Any]
    ) -> None:
        db.execute(
            "INSERT INTO events(room_id, created_at, kind, payload_json) VALUES (?, ?, ?, ?)",
            (room_id, datetime.now(timezone.utc).isoformat(), kind, json.dumps(payload, ensure_ascii=False)),
        )

    def save_recap(
        self, room_id: str, summary: str, state: dict[str, Any]
    ) -> dict[str, Any]:
        created_at = datetime.now(timezone.utc).isoformat()
        with self._connect() as db:
            cursor = db.execute(
                "INSERT INTO recaps(room_id, created_at, summary, state_json) VALUES (?, ?, ?, ?)",
                (room_id, created_at, summary, json.dumps(state, ensure_ascii=False)),
            )
            recap = {
                "id": cursor.lastrowid,
                "room_id": room_id,
                "created_at": created_at,
                "summary": summary,
                "state": state,
            }
            self._append_event(db, room_id, "recap_saved", recap)
        return recap

    def get_latest_recap(self, room_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                """SELECT id, room_id, created_at, summary, state_json
                FROM recaps WHERE room_id = ? ORDER BY id DESC LIMIT 1""",
                (room_id,),
            ).fetchone()
        if not row:
            return None
        recap = dict(row)
        recap["state"] = json.loads(recap.pop("state_json"))
        return recap

    @staticmethod
    def _validate_character_creation_rules(rules: dict[str, Any]) -> dict[str, Any]:
        required = {"skill_count", "allowed_skills", "skill_min", "skill_max", "resources"}
        missing = required - rules.keys()
        if missing:
            raise ValueError(f"character creation rules missing: {', '.join(sorted(missing))}")
        skill_count = rules["skill_count"]
        allowed = rules["allowed_skills"]
        recommended = rules.get("recommended_skills", [])
        if not isinstance(skill_count, int) or skill_count < 1:
            raise ValueError("skill_count must be a positive integer")
        if not isinstance(allowed, list) or not all(
            isinstance(skill, str) and skill.strip() for skill in allowed
        ):
            raise ValueError("allowed_skills must be a list of non-empty names")
        normalized_allowed = [skill.strip() for skill in allowed]
        if len(set(normalized_allowed)) != len(normalized_allowed):
            raise ValueError("allowed_skills must contain unique names after trimming")
        if len(normalized_allowed) < skill_count:
            raise ValueError("allowed_skills must contain at least skill_count names")
        if not isinstance(recommended, list) or not all(
            isinstance(skill, str) and skill.strip() for skill in recommended
        ):
            raise ValueError("recommended_skills must be a subset of allowed_skills")
        normalized_recommended = [skill.strip() for skill in recommended]
        if len(set(normalized_recommended)) != len(normalized_recommended) or not set(
            normalized_recommended
        ).issubset(set(normalized_allowed)):
            raise ValueError("recommended_skills must be a unique subset of allowed_skills")
        skill_min, skill_max = rules["skill_min"], rules["skill_max"]
        if not all(isinstance(value, int) for value in (skill_min, skill_max)):
            raise ValueError("skill_min and skill_max must be integers")
        if not 0 <= skill_min <= skill_max <= 100:
            raise ValueError("skill range must satisfy 0 <= skill_min <= skill_max <= 100")
        resources = rules["resources"]
        if not isinstance(resources, dict) or set(resources) != {"hp", "mp", "san"}:
            raise ValueError("resources must define exactly hp, mp, and san")
        normalized_resources: dict[str, dict[str, int]] = {}
        for resource, config in resources.items():
            if not isinstance(config, dict):
                raise ValueError(f"{resource} rules must be an object")
            values = [config.get("base"), config.get("die"), config.get("max_party_difference")]
            if not all(isinstance(value, int) for value in values):
                raise ValueError(f"{resource} base, die, and max_party_difference must be integers")
            base, die, spread = values
            if base < 0 or die < 1 or spread < 0:
                raise ValueError(f"{resource} requires base >= 0, die >= 1, and max_party_difference >= 0")
            normalized_resources[resource] = {
                "base": base,
                "die": die,
                "max_party_difference": spread,
            }
        return {
            "skill_count": skill_count,
            "allowed_skills": normalized_allowed,
            "recommended_skills": normalized_recommended,
            "skill_min": skill_min,
            "skill_max": skill_max,
            "resources": normalized_resources,
        }

    def configure_character_creation(
        self, room_id: str, rules: dict[str, Any], *, basis: str
    ) -> dict[str, Any]:
        if self.get_room(room_id) is None:
            raise KeyError(f"unknown room: {room_id}")
        if not basis.strip():
            raise ValueError("basis must identify the scenario, canon, or table ruling")
        normalized = self._validate_character_creation_rules(rules)
        existing = self.get_character_creation_rules(room_id)
        with self._connect() as db:
            character_count = db.execute(
                "SELECT COUNT(*) AS count FROM characters WHERE room_id = ?", (room_id,)
            ).fetchone()["count"]
            draft_count = db.execute(
                "SELECT COUNT(*) AS count FROM character_drafts WHERE room_id = ?", (room_id,)
            ).fetchone()["count"]
            if (character_count or draft_count) and existing and existing["rules"] != normalized:
                raise ValueError(
                    "character creation rules cannot change after a draft is adjudicated or a character is generated"
                )
            db.execute(
                """INSERT INTO character_creation_rules(room_id, rules_json, basis)
                VALUES (?, ?, ?)
                ON CONFLICT(room_id) DO UPDATE SET rules_json=excluded.rules_json, basis=excluded.basis""",
                (room_id, json.dumps(normalized, ensure_ascii=False), basis.strip()),
            )
            payload = {"rules": normalized, "basis": basis.strip()}
            self._append_event(db, room_id, "character_creation_configured", payload)
        return payload

    def get_character_creation_rules(self, room_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT rules_json, basis FROM character_creation_rules WHERE room_id = ?",
                (room_id,),
            ).fetchone()
        if not row:
            return None
        return {"rules": json.loads(row["rules_json"]), "basis": row["basis"]}

    def propose_character(
        self,
        room_id: str,
        character_id: str,
        name: str,
        *,
        appearance: str,
        background: str,
        concept: str,
        skills: list[str],
        decision: str,
        basis: str,
        reason: str,
    ) -> dict[str, Any]:
        configured = self.get_character_creation_rules(room_id)
        if configured is None:
            raise ValueError("character creation rules must be configured first")
        if decision not in {"accepted", "rejected"}:
            raise ValueError("decision must be accepted or rejected")
        text_fields = {
            "character_id": character_id,
            "name": name,
            "appearance": appearance,
            "background": background,
            "concept": concept,
            "basis": basis,
            "reason": reason,
        }
        empty = [key for key, value in text_fields.items() if not value.strip()]
        if empty:
            raise ValueError(f"character proposal fields must not be empty: {', '.join(empty)}")
        if not isinstance(skills, list) or len(skills) != len(set(skills)):
            raise ValueError("skills must be a list of unique names")
        rules = configured["rules"]
        if decision == "accepted":
            if self.get_character(room_id, character_id) is not None:
                raise ValueError(f"character already exists: {room_id}/{character_id}")
            if len(skills) != rules["skill_count"]:
                raise ValueError(f"accepted character requires exactly {rules['skill_count']} skills")
            unsupported = set(skills) - set(rules["allowed_skills"])
            if unsupported:
                raise ValueError(f"skills do not fit configured world rules: {', '.join(sorted(unsupported))}")
        result = {
            "character_id": character_id.strip(),
            "name": name.strip(),
            "appearance": appearance.strip(),
            "background": background.strip(),
            "concept": concept.strip(),
            "skills": skills,
            "decision": decision,
            "basis": basis.strip(),
            "reason": reason.strip(),
        }
        with self._connect() as db:
            cursor = db.execute(
                """INSERT INTO character_drafts
                (room_id, character_id, name, appearance, background, concept,
                 skills_json, decision, basis, reason)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    room_id, result["character_id"], result["name"], result["appearance"],
                    result["background"], result["concept"],
                    json.dumps(skills, ensure_ascii=False), decision, result["basis"], result["reason"],
                ),
            )
            result["draft_id"] = cursor.lastrowid
            self._append_event(db, room_id, "character_concept_adjudicated", result)
        return result

    @staticmethod
    def _map_skill_roll(roll: int, minimum: int, maximum: int) -> int:
        if not 1 <= roll <= 100:
            raise ValueError("skill rolls must be in 1..100")
        if minimum == maximum:
            return minimum
        return minimum + ((roll - 1) * (maximum - minimum) // 99)

    def roll_character_creation(
        self,
        room_id: str,
        character_id: str,
        *,
        rolls: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        configured = self.get_character_creation_rules(room_id)
        if configured is None:
            raise ValueError("character creation rules must be configured first")
        with self._connect() as db:
            draft = db.execute(
                """SELECT * FROM character_drafts
                WHERE room_id = ? AND character_id = ? ORDER BY id DESC LIMIT 1""",
                (room_id, character_id),
            ).fetchone()
        if draft is None or draft["decision"] != "accepted":
            raise ValueError("latest character proposal must be accepted before rolling")
        if draft["status"] == "generated" or self.get_character(room_id, character_id) is not None:
            raise ValueError(f"character already generated: {room_id}/{character_id}")

        rules = configured["rules"]
        skills = json.loads(draft["skills_json"])
        rng = random.SystemRandom()
        supplied = rolls or {}
        if not isinstance(supplied, dict):
            raise ValueError("rolls must be an object")
        supplied_skill_rolls = supplied.get("skills", {})
        if not isinstance(supplied_skill_rolls, dict):
            raise ValueError("explicit skill rolls must be an object")
        if "skills" in supplied and set(supplied_skill_rolls) != set(skills):
            raise ValueError("explicit skill rolls must match all approved skills exactly")
        if any(
            isinstance(roll, bool) or not isinstance(roll, int) or not 1 <= roll <= 100
            for roll in supplied_skill_rolls.values()
        ):
            raise ValueError("explicit skill roll values must be integers in 1..100")
        skill_rolls = {
            skill: supplied_skill_rolls.get(skill, rng.randint(1, 100)) for skill in skills
        }
        stats = {
            skill: self._map_skill_roll(
                roll, rules["skill_min"], rules["skill_max"]
            )
            for skill, roll in skill_rolls.items()
        }

        generated: dict[str, int] = {}
        resource_rolls: dict[str, int] = {}
        with self._connect() as db:
            party_rows = db.execute(
                "SELECT max_hp, max_mp, max_san FROM characters WHERE room_id = ?",
                (room_id,),
            ).fetchall()
            for resource, config in rules["resources"].items():
                roll = supplied.get(resource, rng.randint(1, config["die"]))
                if isinstance(roll, bool) or not isinstance(roll, int) or not 1 <= roll <= config["die"]:
                    raise ValueError(f"{resource} roll must be in 1..{config['die']}")
                resource_rolls[resource] = roll
                natural_low = config["base"] + 1
                natural_high = config["base"] + config["die"]
                value = config["base"] + roll
                existing = [row[f"max_{resource}"] for row in party_rows]
                if existing:
                    spread = config["max_party_difference"]
                    allowed_low = max(natural_low, max(existing) - spread)
                    allowed_high = min(natural_high, min(existing) + spread)
                    if allowed_low > allowed_high:
                        raise ValueError(f"existing party {resource} maxima exceed configured fairness spread")
                    value = max(allowed_low, min(value, allowed_high))
                generated[resource] = value

            db.execute(
                """INSERT INTO characters
                (room_id, id, name, hp, mp, san, max_hp, max_mp, max_san,
                 stats_json, notes, appearance, background, concept)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)""",
                (
                    room_id, character_id, draft["name"],
                    generated["hp"], generated["mp"], generated["san"],
                    generated["hp"], generated["mp"], generated["san"],
                    json.dumps(stats, ensure_ascii=False), draft["appearance"],
                    draft["background"], draft["concept"],
                ),
            )
            db.execute("UPDATE character_drafts SET status = 'generated' WHERE id = ?", (draft["id"],))
            self._append_event(
                db,
                room_id,
                "character_generated",
                {
                    "character_id": character_id,
                    "skill_rolls": skill_rolls,
                    "stats": stats,
                    "resource_rolls": resource_rolls,
                    "maxima": generated,
                },
            )
        character = self.get_character(room_id, character_id)
        character["generation"] = {
            "skill_rolls": skill_rolls,
            "resource_rolls": resource_rolls,
            "maxima": generated,
        }
        return character

    def adjudicate_action(
        self,
        room_id: str,
        character_id: str,
        action: str,
        *,
        decision: str,
        basis: str,
        reason: str,
    ) -> dict[str, Any]:
        if decision not in {"accepted", "rejected"}:
            raise ValueError("decision must be accepted or rejected")
        if not action.strip():
            raise ValueError("action must not be empty")
        if not basis.strip():
            raise ValueError("basis must explain the scenario, canon, rules, or established state")
        if not reason.strip():
            raise ValueError("reason must explain why the action is accepted or rejected")
        if self.get_character(room_id, character_id) is None:
            raise KeyError(f"unknown character: {room_id}/{character_id}")
        result = {
            "character_id": character_id,
            "action": action.strip(),
            "decision": decision,
            "basis": basis.strip(),
            "reason": reason.strip(),
        }
        with self._connect() as db:
            self._append_event(db, room_id, "action_adjudicated", result)
        return result

    def record_check(
        self, room_id: str, character_id: str, stat: str, *, roll: int
    ) -> dict[str, Any]:
        character = self.get_character(room_id, character_id)
        if character is None:
            raise KeyError(f"unknown character: {room_id}/{character_id}")
        if stat not in character["stats"]:
            raise KeyError(f"unknown stat for {character_id}: {stat}")
        target = character["stats"][stat]
        result = {
            "character_id": character_id,
            "stat": stat,
            "roll": roll,
            "target": target,
            "degree": evaluate_d100(roll, target),
        }
        with self._connect() as db:
            self._append_event(db, room_id, "check_resolved", result)
        return result

    def set_canon(self, room_id: str, key: str, value: str, *, source: str) -> None:
        with self._connect() as db:
            existing = db.execute(
                "SELECT value FROM canon WHERE room_id = ? AND key = ?", (room_id, key)
            ).fetchone()
            if existing and existing["value"] != value:
                raise ValueError(
                    f"canon conflict for {key}: {existing['value']!r} != {value!r}; record an explicit retcon instead"
                )
            db.execute(
                "INSERT OR IGNORE INTO canon(room_id, key, value, source) VALUES (?, ?, ?, ?)",
                (room_id, key, value, source),
            )

    def upsert_entity(
        self, room_id: str, kind: str, entity_id: str, name: str, state: dict[str, Any]
    ) -> None:
        with self._connect() as db:
            existing = db.execute(
                "SELECT state_json FROM entities WHERE room_id = ? AND kind = ? AND id = ?",
                (room_id, kind, entity_id),
            ).fetchone()
            merged_state = json.loads(existing["state_json"]) if existing else {}
            merged_state.update(state)
            db.execute(
                """INSERT INTO entities(room_id, kind, id, name, state_json) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(room_id, kind, id) DO UPDATE SET name=excluded.name, state_json=excluded.state_json""",
                (room_id, kind, entity_id, name, json.dumps(merged_state, ensure_ascii=False)),
            )
            self._append_event(
                db,
                room_id,
                "entity_upserted",
                {"kind": kind, "id": entity_id, "name": name, "state": merged_state},
            )

    def get_context(self, room_id: str, *, event_limit: int = 20) -> dict[str, Any]:
        room = self.get_room(room_id)
        if room is None:
            raise KeyError(f"unknown room: {room_id}")
        with self._connect() as db:
            character_rows = db.execute(
                "SELECT * FROM characters WHERE room_id = ? ORDER BY id", (room_id,)
            ).fetchall()
            canon_rows = db.execute(
                "SELECT key, value FROM canon WHERE room_id = ? ORDER BY key", (room_id,)
            ).fetchall()
            entity_rows = db.execute(
                "SELECT kind, id, name, state_json FROM entities WHERE room_id = ? ORDER BY kind, id",
                (room_id,),
            ).fetchall()
            draft_rows = db.execute(
                """SELECT id, character_id, name, appearance, background, concept,
                skills_json, decision, basis, reason, status
                FROM character_drafts WHERE room_id = ? ORDER BY id""",
                (room_id,),
            ).fetchall()
        characters = []
        for row in character_rows:
            character = dict(row)
            character["stats"] = json.loads(character.pop("stats_json"))
            characters.append(character)
        creation = self.get_character_creation_rules(room_id) or {
            "rules": None,
            "basis": None,
        }
        creation["drafts"] = [
            {
                **{key: row[key] for key in row.keys() if key != "skills_json"},
                "skills": json.loads(row["skills_json"]),
            }
            for row in draft_rows
        ]
        return {
            "room": room,
            "characters": characters,
            "character_creation": creation,
            "canon": {row["key"]: row["value"] for row in canon_rows},
            "entities": [
                {"kind": row["kind"], "id": row["id"], "name": row["name"], "state": json.loads(row["state_json"])}
                for row in entity_rows
            ],
            "recent_events": self.list_events(room_id)[-event_limit:],
        }

    def list_events(self, room_id: str) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT id, created_at, kind, payload_json FROM events WHERE room_id = ? ORDER BY id",
                (room_id,),
            ).fetchall()
        return [
            {"id": row["id"], "created_at": row["created_at"], "kind": row["kind"], "payload": json.loads(row["payload_json"])}
            for row in rows
        ]
