from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any


_REQUIRED_SCHEMA = {
    "rooms": {"id", "system", "status"},
    "characters": {"room_id", "id", "name"},
    "events": {"room_id", "created_at", "kind", "payload_json"},
    "canon": {"room_id", "key", "value", "source"},
    "entities": {"room_id", "kind", "id", "name", "state_json"},
    "recaps": {"room_id", "created_at", "summary", "state_json"},
}


def _candidate_room_databases(
    root: Path, *, include_root: bool = False, include_legacy_default: bool = False
) -> list[Path]:
    candidates: set[Path] = set()
    directories = [root] if include_root else []
    directories.extend(
        directory
        for directory in root.rglob("rooms")
        if directory.is_dir() and directory.parent.name == ".trpg"
    )
    for rooms_directory in directories:
        try:
            resolved_directory = rooms_directory.resolve(strict=True)
            resolved_directory.relative_to(root)
            entries = list(resolved_directory.iterdir())
        except (OSError, ValueError):
            continue
        for candidate in entries:
            if candidate.name.endswith(("-journal", "-shm", "-wal")):
                continue
            try:
                resolved = candidate.resolve(strict=True)
                resolved.relative_to(root)
            except (OSError, ValueError):
                continue
            if resolved.is_file():
                candidates.add(resolved)
    if include_legacy_default:
        legacy_name = "game." + "sqlite" + str(3)
        for candidate in root.rglob(legacy_name):
            if candidate.parent.name != ".trpg":
                continue
            try:
                resolved = candidate.resolve(strict=True)
                resolved.relative_to(root)
            except (OSError, ValueError):
                continue
            if resolved.is_file():
                candidates.add(resolved)
    return sorted(candidates)


def _has_trpg_schema(connection: sqlite3.Connection) -> bool:
    tables = {
        str(row[0])
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        ).fetchall()
    }
    if not set(_REQUIRED_SCHEMA).issubset(tables):
        return False
    for table, required_columns in _REQUIRED_SCHEMA.items():
        columns = {
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM pragma_table_info(?)", (table,)
            ).fetchall()
        }
        if not required_columns.issubset(columns):
            return False
    return True


def room_ids_in_file(path: str | Path) -> list[str]:
    source = Path(path).resolve(strict=True)
    connection = sqlite3.connect(f"{source.as_uri()}?mode=ro", uri=True)
    try:
        connection.execute("PRAGMA query_only = ON")
        if not _has_trpg_schema(connection):
            raise ValueError(f"not a TRPG room file: {source}")
        return [str(row[0]) for row in connection.execute("SELECT id FROM rooms ORDER BY id")]
    finally:
        connection.close()


def _latest_timestamp(connection: sqlite3.Connection, room_id: str, tables: set[str]) -> str | None:
    timestamps: list[str] = []
    if "events" in tables:
        row = connection.execute(
            "SELECT MAX(created_at) FROM events WHERE room_id = ?", (room_id,)
        ).fetchone()
        if row and row[0]:
            timestamps.append(str(row[0]))
    if "recaps" in tables:
        row = connection.execute(
            "SELECT MAX(created_at) FROM recaps WHERE room_id = ?", (room_id,)
        ).fetchone()
        if row and row[0]:
            timestamps.append(str(row[0]))
    return max(timestamps, default=None)


def list_active_rooms(
    search_root: str | Path, *, include_root: bool = False,
    include_legacy_default: bool = False,
) -> dict[str, Any]:
    """Discover player-safe metadata for active TRPG rooms without migrations."""
    root = Path(search_root).expanduser()
    if not root.is_dir():
        raise ValueError("room search root must be an existing directory")
    root = root.resolve()
    rooms: list[dict[str, Any]] = []

    for database in _candidate_room_databases(
        root,
        include_root=include_root,
        include_legacy_default=include_legacy_default,
    ):
        try:
            connection = sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA query_only = ON")
            try:
                if not _has_trpg_schema(connection):
                    continue
                tables = set(_REQUIRED_SCHEMA)
                rows = connection.execute(
                    "SELECT id, system, status FROM rooms WHERE status = 'active' ORDER BY id"
                ).fetchall()
                for row in rows:
                    character_count = 0
                    if "characters" in tables:
                        count = connection.execute(
                            "SELECT COUNT(*) FROM characters WHERE room_id = ?", (row["id"],)
                        ).fetchone()
                        character_count = int(count[0]) if count else 0
                    rooms.append(
                        {
                            "room_id": str(row["id"]),
                            "system": str(row["system"]),
                            "status": str(row["status"]),
                            "character_count": character_count,
                            "last_activity_at": _latest_timestamp(connection, str(row["id"]), tables),
                            "db": str(database),
                        }
                    )
            finally:
                connection.close()
        except (OSError, sqlite3.Error):
            continue

    rooms.sort(key=lambda room: (room["room_id"], room["db"]))
    return {"root": str(root), "active_only": True, "rooms": rooms}
