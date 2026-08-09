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

Use an absolute scenario path when possible. A room cannot be silently recreated under the same id. `context` always returns the room's persistent `guardrails`.

## Immutable scenario guardrails

Persist explicit scenario prohibitions before character creation or play:

```bash
$GM --db "$DB" guardrail add my-room no-supernatural-pcs \
  --scopes '["character","action"]' \
  --statement '玩家角色是普通人，不得施法、飛行或瞬間移動。' \
  --terms '["施法","魔法","飛行","瞬間移動","傳送","teleport"]' \
  --source 'scenario.md#player-limits'

$GM --db "$DB" guardrail list my-room
```

`scopes` may contain `character`, `action`, or both. `forbidden_terms` are passed through Unicode NFKC/case folding with whitespace and punctuation removed, so trivial obfuscation such as `瞬 間 移 動` still matches. Include common aliases and translations, but avoid vague fragments that would reject legitimate actions. A guardrail ID is immutable: an identical add is idempotent, while different content raises `guardrail conflict` and cannot be overwritten.

`creation propose` and `action adjudicate` enforce these rules inside SQLite-backed core logic. On a match, a requested `accepted` decision is saved as `rejected`, with `requested_decision`, `enforced_guardrails`, policy-derived `basis`, and a matched-term `reason`. Rejected actions remain unable to produce checks or mutations through the Pi finalizer.

## Player-safe recaps

Save a recap at campaign creation and every natural session break:

```bash
$GM --db "$DB" recap save my-room \
  --summary '調查者已進入舊診療所，正在追查失聯者。' \
  --state '{"location":"後門通道","known_goals":["尋找張小姐"],"known_clues":["拖曳痕跡"],"party_conditions":["陳柏翰手部輕傷"],"immediate_danger":"診療區傳來金屬拖擦聲"}'

$GM --db "$DB" recap show my-room
```

`recap save` appends a new snapshot; `recap show` returns the latest one or JSON `null` if none exists. Recaps are player-facing by design. Never place undiscovered clues, NPC secrets, scenario truth, foreshadowing, or GM notes in `summary` or `state`. Read full `context` separately for GM continuity.

## World-aware character creation

Configure one persistent ruleset per room after reading the scenario/canon. The number of required skills is scenario-dependent:

```bash
$GM --db "$DB" creation configure my-room \
  --basis 'scenario.md#investigator-creation' \
  --rules '{
    "skill_count":3,
    "allowed_skills":["偵查","聆聽","圖書館使用","說服"],
    "recommended_skills":["偵查","圖書館使用"],
    "skill_min":20,
    "skill_max":80,
    "resources":{
      "hp":{"base":8,"die":6,"max_party_difference":2},
      "mp":{"base":6,"die":6,"max_party_difference":2},
      "san":{"base":45,"die":30,"max_party_difference":10}
    }
  }'

$GM --db "$DB" creation show my-room
```

`allowed_skills` is the world-compatible choice pool. `recommended_skills` lets the GM offer useful suggestions, but the player may decide any exact `skill_count` unique skills from the allowed pool. A different count or unsupported skill cannot be accepted.

Record appearance, background, concept, chosen skills, and an explicit world-fit ruling:

```bash
$GM --db "$DB" creation propose my-room alice '艾莉絲' \
  --appearance '黑髮，穿舊式記者風衣' \
  --background '地方報社記者' \
  --concept '追查失蹤案的民間調查者' \
  --skills '["偵查","圖書館使用","說服"]' \
  --decision accepted \
  --basis '劇本允許現代民間調查者，所選技能都在 allowed_skills' \
  --reason '外觀、背景、概念與技能符合世界觀'
```

Rejected proposals are also persisted as `character_concept_adjudicated` events. Explain the reason and basis to the player; then ask them to revise the proposal. Only the latest accepted proposal can be rolled. `creation roll` rechecks the persisted draft against the current immutable character guardrails, so a prohibition added after an earlier acceptance still blocks generation and requires a revised proposal.

```bash
# Secure random rolls:
$GM --db "$DB" creation roll my-room alice

# Explicit rolls for physical dice, replay, or tests:
$GM --db "$DB" creation roll my-room alice \
  --rolls '{"skills":{"偵查":82,"圖書館使用":41,"說服":65},"hp":4,"mp":2,"san":17}'
```

Each skill rolls d100 and maps linearly into `skill_min..skill_max`. Resource maxima use `base + d(die)`. To keep party members comparable, the final HP/MP/SAN maximum is clamped so its pairwise difference from every existing room character is at most that resource's `max_party_difference`; the original roll and adjusted maximum are both reported and persisted in `character_generated`. Current HP/MP/SAN start at those maxima and cannot later be adjusted above them.

## Characters

`character add` is retained for importing legacy/pre-generated characters. Normal new characters must use `creation configure` → `creation propose` → `creation roll`. Legacy imports are still checked against every `character`-scoped guardrail using the name, notes, appearance, background, concept, and stat names; they cannot bypass scenario prohibitions.

```bash
$GM --db "$DB" character add my-room alice '艾莉絲' \
  --hp 10 --mp 8 --san 55 \
  --stats '{"力量":45,"聆聽":60,"圖書館使用":70}' --notes '記者'

$GM --db "$DB" character adjust my-room alice san -5 --reason '目擊神話生物'
$GM --db "$DB" character adjust my-room alice mp -2 --reason '施放守護術'
```

Resource names are exactly `hp`, `mp`, and `san`. Delta may be positive or negative. Always provide an in-world reason.

### Availability and equal spotlight

Persist temporary inability to act instead of relying on chat memory:

```bash
$GM --db "$DB" character availability my-room alice \
  --can-act false --reason '昏迷，尚未接受急救'

$GM --db "$DB" character availability my-room alice \
  --can-act true --reason '急救後恢復意識'
```

`--can-act` is exactly `true` or `false`, and every change requires an auditable reason. HP at 0 also makes a character automatically ineligible. `context.participation` reports action counts, eligibility, and `next_spotlight_character_ids`: the currently eligible characters with the fewest adjudicated actions. GM must prefer those characters at the next natural decision point so every player receives equal meaningful opportunities. A persisted unavailable character is temporarily excluded; an attempted action while unavailable is mechanically forced to `rejected` until availability is restored.

## Story objective, progress, and forced intervention

Set a concrete chapter objective, then assess every countable player action:

```bash
$GM --db "$DB" story objective my-room \
  --chapter '第一章' --objective '找到地下室入口' --reason 'scenario.md#chapter-1'

# 創角剛完成時，ID 必須精確匹配 context.story_progress.opening_character_ids；
# reason 必須逐一包含各角色已保存的背景或概念原文：
$GM --db "$DB" story objective my-room \
  --chapter '第一章：失蹤案' --objective '從匿名信追查失蹤記者' \
  --reason '依 alice 的地方報社記者背景與 bob 的大學檔案室研究員背景開場' \
  --opening-character-ids '["alice","bob"]'
$GM --db "$DB" story progress my-room \
  --status stalled --reason '重複搜索沒有產生新線索或開啟新路徑'
$GM --db "$DB" story progress my-room \
  --status advanced --reason '暗門已被發現，目前目標已實質推進'
```

`context.story_progress` reports the current chapter/objective, `opening_guidance_required`, `opening_character_ids`, `stagnant_action_count`, and `intervention_required`. A successful `creation roll` adds that character to `opening_character_ids`; before any player action, set `story objective` after the final generated character, pass the exact complete ID list through `--opening-character-ids`, and cite each saved background or concept verbatim in `--reason`. This clears `opening_guidance_required`. The GM must describe only player-visible world context and invite the first action, never decide a player character's motive, speech, movement, or reaction.

After opening guidance, `advanced` resets the counter; `stalled` increments it. Only accepted actions enter this clock; rejected actions and availability-/guardrail-enforced rejections are excluded. After the third consecutive stalled action, no fourth action or objective replacement is allowed until the GM persists a concrete in-world intervention:

```bash
$GM --db "$DB" story intervene my-room \
  --event '停電後，地下室入口傳來撞擊聲並自行打開' \
  --intended-progress '把下一個決策點帶到地下室入口' \
  --reason '連續三次玩家行動未推進目前目標'
```

The intervention resets stagnation, but it must not choose a player-character action, silently rewrite canon, leak secrets, or guarantee success. It creates a new pressure, clue, opening, NPC move, or environmental change that gives players a meaningful route toward the next chapter or objective. For a forced transition, `--event` must describe the world change that directly occurs; it must not demand that the player select a prescribed option before the next scene is allowed. Bring the NPC, danger, opening, or environmental change to the current scene unless player-declared movement or transit already establishes arrival. After persisting the event, narrate the changed situation and return an open-ended action prompt. The core checks both `--event` and `--intended-progress`, rejecting common Chinese/English constructions that explicitly require choosing or accepting an option before the story may continue. A passing event is audited with `transition_mode=direct_world_event` and `requires_prescribed_player_choice=false`; this is bounded text validation rather than a complete semantic classifier, so novel paraphrases remain subject to GM protocol and review. Pi finalization additionally requires `eventDrivenTransitionChecked=true` for that intervention turn.

## Player action adjudication

Every declared in-world player action must be adjudicated before a check or world-state mutation:

```bash
# Accept a plausible action supported by the current scene:
$GM --db "$DB" action adjudicate my-room alice '調查門縫' \
  --decision accepted \
  --basis 'scene:clinic-door permits close inspection; character can reach the door' \
  --reason '這是目前位置與一般角色能力允許的調查行動'

# Reject an impossible or setting-breaking action:
$GM --db "$DB" action adjudicate my-room alice '展開翅膀飛過鎖門' \
  --decision rejected \
  --basis '角色卡、canon 與劇本均未建立翅膀或飛行能力' \
  --reason '艾莉絲是普通人，目前也沒有任何可用的飛行手段'
```

The command validates the room character, requires non-empty `basis` and `reason`, and persists an `action_adjudicated` event. Every adjudicated attempt contributes to persistent participation accounting regardless of acceptance, because a rejected but possible attempt still represents a player's opportunity to engage. An attempt mechanically rejected because the character is currently unable to act does not count. `decision` is exactly `accepted` or `rejected`. A rejected action must be explained to the player and must not trigger a check or world-state mutation. Do not reject a plausible creative action merely because the script does not enumerate it word-for-word; reject actions that lack established support, exceed character capabilities, contradict canon/rules, or are impossible in the current scene.

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

`entity` is a merge-upsert: supplied keys replace matching keys while unspecified fields are preserved. This prevents accidental loss of secrets or other state when an agent updates only one field. If both the stored state and update contain an integer `turn`, the new value cannot be lower; stale updates fail with `entity state turn cannot move backwards` instead of rewinding chronology. There is currently no CLI operation for deleting a state key. Secret values belong in DB context but must not be exposed until discovered.
