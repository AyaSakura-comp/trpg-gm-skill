from __future__ import annotations

import json
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
                    stats_json TEXT NOT NULL DEFAULT '{}',
                    notes TEXT NOT NULL DEFAULT '',
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
                """
            )

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
    ) -> dict[str, Any]:
        with self._connect() as db:
            db.execute(
                """INSERT INTO characters
                (room_id, id, name, hp, mp, san, stats_json, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (room_id, character_id, name, hp, mp, san, json.dumps(stats or {}, ensure_ascii=False), notes),
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
        with self._connect() as db:
            cursor = db.execute(
                f"UPDATE characters SET {resource} = {resource} + ? WHERE room_id = ? AND id = ?",
                (delta, room_id, character_id),
            )
            if cursor.rowcount != 1:
                raise KeyError(f"unknown character: {room_id}/{character_id}")
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
        characters = []
        for row in character_rows:
            character = dict(row)
            character["stats"] = json.loads(character.pop("stats_json"))
            characters.append(character)
        return {
            "room": room,
            "characters": characters,
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
