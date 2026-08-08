# CLI reference

All output is JSON. Run from this skill directory:

```bash
GM=./scripts/trpg-gm
DB=/path/to/workspace/.trpg/rooms/my-room.sqlite3
```

## Room and context

```bash
$GM --db "$DB" room create my-room --system coc7 --script /abs/path/scenario.md --seed 42
$GM --db "$DB" context my-room --events 30
$GM --db "$DB" events my-room
```

Use an absolute scenario path when possible. A room cannot be silently recreated under the same id.

## Player-safe recaps

Save a recap at campaign creation and every natural session break:

```bash
$GM --db "$DB" recap save my-room \
  --summary '調查者已進入舊診療所，正在追查失聯者。' \
  --state '{"location":"後門通道","known_goals":["尋找張小姐"],"known_clues":["拖曳痕跡"],"party_conditions":["陳柏翰手部輕傷"],"immediate_danger":"診療區傳來金屬拖擦聲"}'

$GM --db "$DB" recap show my-room
```

`recap save` appends a new snapshot; `recap show` returns the latest one or JSON `null` if none exists. Recaps are player-facing by design. Never place undiscovered clues, NPC secrets, scenario truth, foreshadowing, or GM notes in `summary` or `state`. Read full `context` separately for GM continuity.

## Characters

```bash
$GM --db "$DB" character add my-room alice '艾莉絲' \
  --hp 10 --mp 8 --san 55 \
  --stats '{"力量":45,"聆聽":60,"圖書館使用":70}' --notes '記者'

$GM --db "$DB" character adjust my-room alice san -5 --reason '目擊神話生物'
$GM --db "$DB" character adjust my-room alice mp -2 --reason '施放守護術'
```

Resource names are exactly `hp`, `mp`, and `san`. Delta may be positive or negative. Always provide an in-world reason.

## Checks

```bash
# Roll a real random d100 and record it:
$GM --db "$DB" check my-room alice 聆聽

# Record a physical/player-provided roll:
$GM --db "$DB" check my-room alice 聆聽 --roll 20
```

Built-in resolution is CoC-style d100: critical, extreme, hard, success, failure, fumble. `--system` records campaign identity but this MVP only implements d100 resolution. For another system, store the externally resolved roll as an entity/event convention; do not pretend d100 is that game's official rule.

## Canon

```bash
$GM --db "$DB" canon my-room 'npc:lin:status' '失蹤' --source 'scenario.md#scene-2'
```

Repeating the same value is idempotent. A different value raises a canon conflict to prevent continuity errors. Never edit SQLite manually to bypass this.

## World entities

The entity type is open-ended: `npc`, `quest`, `scene`, `location`, `clue`, `faction`, `clock`, `item`, etc.

```bash
$GM --db "$DB" entity my-room quest find-lin '尋找林教授' \
  --state '{"status":"active","known":true,"leads":["old-library"]}'

$GM --db "$DB" entity my-room npc caretaker '老管理員' \
  --state '{"status":"alive","location":"old-library","attitude":"wary","secret":"has-key"}'
```

`entity` is a merge-upsert: supplied keys replace matching keys while unspecified fields are preserved. This prevents accidental loss of secrets or other state when an agent updates only one field. There is currently no CLI operation for deleting a state key. Secret values belong in DB context but must not be exposed until discovered.
