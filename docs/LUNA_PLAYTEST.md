# GPT-5.6 Luna multi-session playtest

Date: 2026-08-08  
Model: `openai-codex/gpt-5.6-luna`  
Harness: Pi print-mode sessions with project-local `trpg-gm` skill  
Campaign room: `luna-playtest`

## Method

Four independent Pi session files used one shared SQLite campaign DB. Each session received the room id and DB path but no prior chat transcript.

1. Session 1 created the room and three player characters in one turn, then improvised an opening scene.
2. Session 2 resumed from DB and processed one declared action from each player.
3. Session 3 resumed again, performed three more checks, advanced the scene and produced a player-safe recap.
4. A post-fix smoke session verified the corrected CLI-path guidance and merge-upsert behavior.

Characters:

| id | Character | Role | HP | MP | SAN | Skills |
|---|---|---|---:|---:|---:|---|
| `yuching` | 林雨晴 | 醫師 | 12 | 10 | 65 | 急救 75、觀察 55、心理學 50 |
| `bohan` | 陳柏翰 | 工程師 | 13 | 8 | 60 | 機械維修 70、聆聽 55、力量 60 |
| `siyu` | 吳思妤 | 民俗學者 | 9 | 14 | 70 | 圖書館使用 80、神秘學 70、說服 60 |

## Observed flow

### Session 1 — creation and opening

Luna persisted all three characters, one active scene, one NPC, one active quest and one canon premise. It then narrated a short opening at a storm-bound abandoned clinic without exposing the NPC's stored secret.

The DB, rather than conversation history, contained everything needed by the next session.

### Session 2 — three simultaneous player actions

The new session loaded `context` before adjudicating:

| Character | Check | Roll | Result | Consequence |
|---|---|---:|---|---|
| 林雨晴 | 觀察 55 | 25 | hard | discovered drag marks and dark-red spots |
| 陳柏翰 | 機械維修 70 | 79 | failure | electrical arc, HP 13 → 12 |
| 吳思妤 | 說服 60 | 96 | failure | NPC became guarded and withheld information |

The checks, HP loss, new clues, NPC state, scene state and quest state were all persisted. The final narration exposed only player-visible facts.

### Session 3 — continuity without chat memory

A third independent session correctly recovered the party location, previous clues, damaged power box, NPC attitude and active quest from SQLite.

| Character | Check | Roll | Result |
|---|---|---:|---|
| 林雨晴 | 急救 75 | 89 | failure |
| 陳柏翰 | 聆聽 55 | 53 | success |
| 吳思妤 | 神秘學 70 | 64 | success |

Luna correctly declined to deduct SAN because the scene had not yet presented a sufficiently horrifying stimulus. It persisted three new clues, advanced the scene into the interior corridor and gave a secret-free recap.

Final resource state after the three gameplay sessions:

```json
{
  "bohan": {"hp": 12, "mp": 8, "san": 60},
  "siyu": {"hp": 9, "mp": 14, "san": 70},
  "yuching": {"hp": 12, "mp": 10, "san": 65}
}
```

The campaign held eight world entities: five clues, one NPC, one quest and one scene.

## Bugs discovered

### 1. Ambiguous CLI working directory

The first three sessions initially tried `./scripts/trpg-gm` from the repository root. That path did not exist, so Luna searched for the skill executable, changed into the skill directory and recovered. Gameplay still completed, but each session incurred one avoidable failed tool call.

Fix: `SKILL.md` now explicitly instructs the agent to change into the directory containing the loaded `SKILL.md` before invoking `./scripts/trpg-gm`.

Post-fix result: the fourth independent session used the correct absolute skill directory on its first bash call and produced zero tool errors.

### 2. Full entity replacement could erase hidden state

During Session 2, Luna updated the NPC's attitude but omitted its `secret` field from the replacement JSON. The original implementation treated entity upsert as full replacement, so the hidden field was lost even though it was never revealed in narration.

Root cause: the storage API relied on an LLM to reproduce every existing key during each state update. This is unsafe for partial agent updates.

Fix: entity writes are now merge-upserts. Supplied keys change, while unspecified keys remain intact. A regression test verifies that changing `attitude` preserves `status` and `secret`.

Post-fix smoke result:

```json
{
  "status": "alive",
  "attitude": "cooperative",
  "secret": "他在失聯前曾收到女兒寄來的一張沒有文字的黑色照片"
}
```

The response did not reveal the secret.

## Play experience assessment

### Worked well

- Room state survived completely independent Pi sessions.
- Three characters could act in the same round without state crossover.
- Luna respected player agency and did not invent player decisions or dialogue.
- Rolls were transparent, accepted as final and saved as events.
- Failure advanced fiction through injury, delay or NPC resistance instead of ending the scenario.
- HP changes and clues matched the narrated consequences.
- Hidden DB information stayed out of player-facing narration.
- Luna made a sensible no-SAN-loss ruling rather than deducting SAN merely because the genre was horror.
- The final responses were concise and consistently returned control with a question.

### Still limited

- The one-shot test asked Luna to resolve a whole round at once, so visible stakes were not presented to players in a separate pre-roll interaction. A live table should ideally announce stakes, allow clarification, then roll.
- Built-in rules only cover CoC-style d100. Other systems need rule adapters.
- `seed` is stored on the room but random checks currently use `SystemRandom`; seeded replay is not implemented.
- Entity state has no schema per entity type, so quality still depends on the agent choosing consistent field names.
- There is no dedicated retcon workflow or field-deletion command.
- Long campaigns will eventually need structured session summaries or event pagination beyond a recent-event window.

## Verdict

After the merge-upsert and path-instruction fixes, the skill is functional for an MVP multi-session CoC-style game. Persistence, room binding, three-player state, checks, consequences, hidden information and continuity all worked in real Luna sessions. The largest remaining work is ruleset breadth and long-campaign ergonomics rather than basic playability.
