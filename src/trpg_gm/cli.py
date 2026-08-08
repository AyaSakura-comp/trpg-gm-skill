from __future__ import annotations

import argparse
import json
import random
from pathlib import Path
from typing import Sequence

from .store import GameStore


def _json(value: str) -> dict:
    parsed = json.loads(value)
    if not isinstance(parsed, dict):
        raise argparse.ArgumentTypeError("must be a JSON object")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="trpg-gm", description="Persistent TRPG GM state CLI")
    parser.add_argument("--db", type=Path, default=Path(".trpg/game.sqlite3"))
    commands = parser.add_subparsers(dest="command", required=True)

    room = commands.add_parser("room")
    room_commands = room.add_subparsers(dest="action", required=True)
    create = room_commands.add_parser("create")
    create.add_argument("room_id")
    create.add_argument("--system", default="coc7")
    create.add_argument("--script")
    create.add_argument("--seed", type=int, default=0)

    character = commands.add_parser("character")
    character_commands = character.add_subparsers(dest="action", required=True)
    add = character_commands.add_parser("add")
    add.add_argument("room_id")
    add.add_argument("character_id")
    add.add_argument("name")
    add.add_argument("--hp", type=int, required=True)
    add.add_argument("--mp", type=int, required=True)
    add.add_argument("--san", type=int, required=True)
    add.add_argument("--stats", type=_json, default={})
    add.add_argument("--notes", default="")
    adjust = character_commands.add_parser("adjust")
    adjust.add_argument("room_id")
    adjust.add_argument("character_id")
    adjust.add_argument("resource", choices=("hp", "mp", "san"))
    adjust.add_argument("delta", type=int)
    adjust.add_argument("--reason", required=True)

    canon = commands.add_parser("canon")
    canon.add_argument("room_id")
    canon.add_argument("key")
    canon.add_argument("value")
    canon.add_argument("--source", required=True)

    entity = commands.add_parser("entity")
    entity.add_argument("room_id")
    entity.add_argument("kind", help="npc, quest, location, clue, faction, scene, etc.")
    entity.add_argument("entity_id")
    entity.add_argument("name")
    entity.add_argument("--state", type=_json, required=True)

    check = commands.add_parser("check")
    check.add_argument("room_id")
    check.add_argument("character_id")
    check.add_argument("stat")
    check.add_argument("--roll", type=int, help="Explicit d100 result; random if omitted")

    context = commands.add_parser("context")
    context.add_argument("room_id")
    context.add_argument("--events", type=int, default=20)

    events = commands.add_parser("events")
    events.add_argument("room_id")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    store = GameStore(args.db)

    if args.command == "room":
        result = store.create_room(
            args.room_id, args.system, script_path=args.script, seed=args.seed
        )
    elif args.command == "character" and args.action == "add":
        result = store.add_character(
            args.room_id, args.character_id, args.name,
            hp=args.hp, mp=args.mp, san=args.san, stats=args.stats, notes=args.notes,
        )
    elif args.command == "character" and args.action == "adjust":
        result = store.adjust_resource(
            args.room_id, args.character_id, args.resource, args.delta, args.reason
        )
    elif args.command == "canon":
        store.set_canon(args.room_id, args.key, args.value, source=args.source)
        result = {"ok": True, "key": args.key, "value": args.value}
    elif args.command == "entity":
        store.upsert_entity(args.room_id, args.kind, args.entity_id, args.name, args.state)
        result = {"ok": True, "kind": args.kind, "id": args.entity_id}
    elif args.command == "check":
        roll = args.roll if args.roll is not None else random.SystemRandom().randint(1, 100)
        result = store.record_check(args.room_id, args.character_id, args.stat, roll=roll)
    elif args.command == "context":
        result = store.get_context(args.room_id, event_limit=args.events)
    elif args.command == "events":
        result = store.list_events(args.room_id)
    else:  # pragma: no cover - argparse prevents this
        raise AssertionError("unreachable command")

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
