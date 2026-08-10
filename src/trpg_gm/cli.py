from __future__ import annotations

import argparse
import json
import os
import random
import sqlite3
import sys
import uuid
from pathlib import Path
from typing import Sequence

from .catalog import list_active_rooms, room_ids_in_file
from .store import GameStore


ROOMS_DIR_ENV = "TRPG_GM_ROOMS_DIR"
ROOM_FILE_SUFFIX = "." + "sqlite" + str(3)


def _canonical_rooms_directory() -> Path:
    configured = os.environ.get(ROOMS_DIR_ENV)
    directory = Path(configured).expanduser() if configured else Path.home() / ".trpg" / "rooms"
    return directory.resolve()


def _canonical_room_path(room_id: str) -> Path:
    if (
        not room_id
        or room_id in {".", ".."}
        or "/" in room_id
        or "\\" in room_id
        or "\x00" in room_id
    ):
        raise ValueError("room_id must be a safe room id without path separators")
    candidate = _canonical_rooms_directory() / f"{room_id}{ROOM_FILE_SUFFIX}"
    if candidate.is_symlink():
        raise ValueError("canonical room path must not be a symlink")
    return candidate


def _atomic_relocate_room(source: Path, target: Path) -> None:
    alias = source.with_name(f".{source.name}.relocate-{uuid.uuid4().hex}")
    alias.symlink_to(target)
    try:
        os.link(source, target)
        try:
            os.replace(alias, source)
        except OSError:
            target.unlink()
            raise
    finally:
        if alias.is_symlink():
            alias.unlink()


def _atomic_restore_room(source: Path, target: Path) -> None:
    restored = source.with_name(f".{source.name}.restore-{uuid.uuid4().hex}")
    os.link(target, restored)
    try:
        os.replace(restored, source)
        target.unlink()
    finally:
        if restored.exists():
            restored.unlink()


def _relocate_active_rooms(search_root: Path) -> dict:
    resolved_root = search_root.expanduser().resolve()
    include_root = resolved_root.name == "rooms" and resolved_root.parent.name == ".trpg"
    catalog = list_active_rooms(
        resolved_root,
        include_root=include_root,
        include_legacy_default=True,
    )
    sources: dict[Path, list[str]] = {}
    for room in catalog["rooms"]:
        sources.setdefault(Path(room["db"]), []).append(str(room["room_id"]))

    planned: list[tuple[str, Path, Path]] = []
    planned_ids: set[str] = set()
    for source, room_ids in sources.items():
        if len(room_ids) != 1:
            raise ValueError(f"cannot relocate a room file containing multiple active rooms: {source}")
        room_id = room_ids[0]
        all_room_ids = room_ids_in_file(source)
        if all_room_ids != [room_id]:
            raise ValueError(
                f"cannot relocate a room file containing multiple rooms: {source}"
            )
        if room_id in planned_ids:
            raise ValueError(f"duplicate room id found in legacy locations: {room_id}")
        planned_ids.add(room_id)
        target = _canonical_room_path(room_id)
        if source == target:
            continue
        if target.exists() or target.is_symlink():
            raise ValueError(f"canonical room already exists: {room_id}")
        sidecars = [Path(f"{source}{suffix}") for suffix in ("-wal", "-shm", "-journal")]
        if any(sidecar.exists() for sidecar in sidecars):
            raise ValueError(f"cannot relocate an open room with sidecar files: {room_id}")
        planned.append((room_id, source, target))

    locks: list[sqlite3.Connection] = []
    try:
        for room_id, source, _target in planned:
            connection = sqlite3.connect(source, timeout=0, isolation_level=None)
            journal_mode = str(connection.execute("PRAGMA journal_mode").fetchone()[0]).lower()
            if journal_mode == "wal":
                connection.close()
                raise ValueError(f"cannot relocate WAL-mode room: {room_id}")
            connection.execute("BEGIN EXCLUSIVE")
            locks.append(connection)
    except (sqlite3.Error, ValueError) as error:
        for connection in locks:
            connection.close()
        raise ValueError(f"all rooms must be quiescent before relocation: {error}") from error

    relocated: list[dict[str, str]] = []
    completed: list[tuple[Path, Path]] = []
    try:
        for room_id, source, target in planned:
            target.parent.mkdir(parents=True, exist_ok=True)
            _atomic_relocate_room(source, target)
            completed.append((source, target))
            relocated.append(
                {"room_id": room_id, "from": str(source), "to": str(target), "legacy_alias": str(source)}
            )
    except OSError:
        for source, target in reversed(completed):
            if target.exists():
                _atomic_restore_room(source, target)
        for connection in locks:
            connection.rollback()
            connection.close()
        raise
    else:
        for connection in locks:
            connection.commit()
            connection.close()

    return {
        "source_root": catalog["root"],
        "canonical_root": str(_canonical_rooms_directory()),
        "relocated": relocated,
    }


def _json(value: str) -> dict:
    parsed = json.loads(value)
    if not isinstance(parsed, dict):
        raise argparse.ArgumentTypeError("must be a JSON object")
    return parsed


def _boolean(value: str) -> bool:
    normalized = value.strip().lower()
    if normalized == "true":
        return True
    if normalized == "false":
        return False
    raise argparse.ArgumentTypeError("must be true or false")


def _json_list(value: str) -> list[str]:
    parsed = json.loads(value)
    if not isinstance(parsed, list) or not all(isinstance(item, str) for item in parsed):
        raise argparse.ArgumentTypeError("must be a JSON array of strings")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="trpg-gm", description="Persistent TRPG GM state CLI")
    parser.add_argument("--db", type=Path, default=Path(".trpg/game.sqlite3"))
    commands = parser.add_subparsers(dest="command", required=True)

    rooms = commands.add_parser("rooms")
    rooms_commands = rooms.add_subparsers(dest="action", required=True)
    rooms_list = rooms_commands.add_parser("list")
    rooms_list.add_argument("root", type=Path, nargs="?")
    rooms_relocate = rooms_commands.add_parser("relocate")
    rooms_relocate.add_argument("root", type=Path)

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
    availability = character_commands.add_parser("availability")
    availability.add_argument("room_id")
    availability.add_argument("character_id")
    availability.add_argument("--can-act", type=_boolean, required=True)
    availability.add_argument("--reason", required=True)

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

    creation = commands.add_parser("creation")
    creation_commands = creation.add_subparsers(dest="action", required=True)
    creation_configure = creation_commands.add_parser("configure")
    creation_configure.add_argument("room_id")
    creation_configure.add_argument("--rules", type=_json, required=True)
    creation_configure.add_argument("--basis", required=True)
    creation_show = creation_commands.add_parser("show")
    creation_show.add_argument("room_id")
    creation_propose = creation_commands.add_parser("propose")
    creation_propose.add_argument("room_id")
    creation_propose.add_argument("character_id")
    creation_propose.add_argument("name")
    creation_propose.add_argument("--appearance", required=True)
    creation_propose.add_argument("--background", required=True)
    creation_propose.add_argument("--concept", required=True)
    creation_propose.add_argument("--skills", type=_json_list, required=True)
    creation_propose.add_argument("--decision", choices=("accepted", "rejected"), required=True)
    creation_propose.add_argument("--basis", required=True)
    creation_propose.add_argument("--reason", required=True)
    creation_roll = creation_commands.add_parser("roll")
    creation_roll.add_argument("room_id")
    creation_roll.add_argument("character_id")
    creation_roll.add_argument("--rolls", type=_json)

    guardrail = commands.add_parser("guardrail")
    guardrail_commands = guardrail.add_subparsers(dest="action", required=True)
    guardrail_add = guardrail_commands.add_parser("add")
    guardrail_add.add_argument("room_id")
    guardrail_add.add_argument("guardrail_id")
    guardrail_add.add_argument("--scopes", type=_json_list, required=True)
    guardrail_add.add_argument("--statement", required=True)
    guardrail_add.add_argument("--terms", type=_json_list, required=True)
    guardrail_add.add_argument("--source", required=True)
    guardrail_list = guardrail_commands.add_parser("list")
    guardrail_list.add_argument("room_id")

    action = commands.add_parser("action")
    action_commands = action.add_subparsers(dest="action", required=True)
    adjudicate = action_commands.add_parser("adjudicate")
    adjudicate.add_argument("room_id")
    adjudicate.add_argument("character_id")
    adjudicate.add_argument("player_action")
    adjudicate.add_argument("--decision", choices=("accepted", "rejected"), required=True)
    adjudicate.add_argument("--basis", required=True)
    adjudicate.add_argument("--reason", required=True)

    story = commands.add_parser("story")
    story_commands = story.add_subparsers(dest="action", required=True)
    story_objective = story_commands.add_parser("objective")
    story_objective.add_argument("room_id")
    story_objective.add_argument("--chapter", required=True)
    story_objective.add_argument("--objective", required=True)
    story_objective.add_argument("--reason", required=True)
    story_objective.add_argument("--opening-character-ids", type=_json_list)
    story_progress = story_commands.add_parser("progress")
    story_progress.add_argument("room_id")
    story_progress.add_argument("--status", choices=("advanced", "stalled"), required=True)
    story_progress.add_argument("--reason", required=True)
    story_intervene = story_commands.add_parser("intervene")
    story_intervene.add_argument("room_id")
    story_intervene.add_argument("--event", required=True)
    story_intervene.add_argument("--intended-progress", required=True)
    story_intervene.add_argument("--reason", required=True)

    check = commands.add_parser("check")
    check.add_argument("room_id")
    check.add_argument("character_id")
    check.add_argument("stat")
    check.add_argument("--roll", type=int, help="Explicit d100 result; random if omitted")

    recap = commands.add_parser("recap")
    recap_commands = recap.add_subparsers(dest="action", required=True)
    recap_save = recap_commands.add_parser("save")
    recap_save.add_argument("room_id")
    recap_save.add_argument("--summary", required=True)
    recap_save.add_argument("--state", type=_json, required=True)
    recap_show = recap_commands.add_parser("show")
    recap_show.add_argument("room_id")

    context = commands.add_parser("context")
    context.add_argument("room_id")
    context.add_argument("--events", type=int, default=20)

    events = commands.add_parser("events")
    events.add_argument("room_id")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    argument_list = list(argv) if argv is not None else sys.argv[1:]
    args = build_parser().parse_args(argument_list)
    if args.command == "rooms" and args.action == "list":
        root = args.root or _canonical_rooms_directory()
        if args.root is None and not root.exists():
            result = {"root": str(root), "active_only": True, "rooms": []}
        else:
            result = list_active_rooms(root, include_root=args.root is None)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if args.command == "rooms" and args.action == "relocate":
        result = _relocate_active_rooms(args.root)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    explicit_path = any(
        token == "--db" or token.startswith("--db=") for token in argument_list
    )
    if not explicit_path:
        args.db = _canonical_room_path(args.room_id)
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
    elif args.command == "character" and args.action == "availability":
        result = store.set_character_availability(
            args.room_id,
            args.character_id,
            can_act=args.can_act,
            reason=args.reason,
        )
    elif args.command == "canon":
        store.set_canon(args.room_id, args.key, args.value, source=args.source)
        result = {"ok": True, "key": args.key, "value": args.value}
    elif args.command == "entity":
        store.upsert_entity(args.room_id, args.kind, args.entity_id, args.name, args.state)
        result = {"ok": True, "kind": args.kind, "id": args.entity_id}
    elif args.command == "creation" and args.action == "configure":
        result = store.configure_character_creation(
            args.room_id, args.rules, basis=args.basis
        )
    elif args.command == "creation" and args.action == "show":
        result = store.get_character_creation_rules(args.room_id)
    elif args.command == "creation" and args.action == "propose":
        result = store.propose_character(
            args.room_id,
            args.character_id,
            args.name,
            appearance=args.appearance,
            background=args.background,
            concept=args.concept,
            skills=args.skills,
            decision=args.decision,
            basis=args.basis,
            reason=args.reason,
        )
    elif args.command == "creation" and args.action == "roll":
        result = store.roll_character_creation(
            args.room_id, args.character_id, rolls=args.rolls
        )
    elif args.command == "guardrail" and args.action == "add":
        result = store.add_guardrail(
            args.room_id,
            args.guardrail_id,
            scopes=args.scopes,
            statement=args.statement,
            forbidden_terms=args.terms,
            source=args.source,
        )
    elif args.command == "guardrail" and args.action == "list":
        result = store.list_guardrails(args.room_id)
    elif args.command == "action" and args.action == "adjudicate":
        result = store.adjudicate_action(
            args.room_id,
            args.character_id,
            args.player_action,
            decision=args.decision,
            basis=args.basis,
            reason=args.reason,
        )
    elif args.command == "story" and args.action == "objective":
        result = store.set_story_objective(
            args.room_id,
            chapter=args.chapter,
            objective=args.objective,
            reason=args.reason,
            opening_character_ids=args.opening_character_ids,
        )
    elif args.command == "story" and args.action == "progress":
        result = store.record_story_progress(
            args.room_id, status=args.status, reason=args.reason
        )
    elif args.command == "story" and args.action == "intervene":
        result = store.intervene_story(
            args.room_id,
            event=args.event,
            intended_progress=args.intended_progress,
            reason=args.reason,
        )
    elif args.command == "check":
        roll = args.roll if args.roll is not None else random.SystemRandom().randint(1, 100)
        result = store.record_check(args.room_id, args.character_id, args.stat, roll=roll)
    elif args.command == "recap" and args.action == "save":
        result = store.save_recap(args.room_id, args.summary, args.state)
    elif args.command == "recap" and args.action == "show":
        result = store.get_latest_recap(args.room_id)
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
