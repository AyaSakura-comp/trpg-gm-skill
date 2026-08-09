# Qwen event-driven forced-transition E2E

Date: 2026-08-09

## Purpose

Verify v0.11.0 with production-like Pi and `local-llama/qwen3.6-35b-q4`: after three stalled actions, a forced transition must happen directly through a persisted world event instead of requiring the player to select the GM's prescribed option.

## Fixture

- DB: `/tmp/trpg-event-transition-e2e-v011.db`
- Room: `event-transition-v011`
- Seed: `1101`
- Objective: `查明碼頭失蹤貨船的去向`
- Character: `alice` / 艾莉絲
- Starting story clock: three accepted actions recorded as `stalled`; `intervention_required=true`
- Exact prompt: `/tmp/trpg-event-transition-e2e-v011-prompt.txt`
- Machine-readable Pi trace: `/tmp/trpg-event-transition-e2e-v011.jsonl`
- Wall time: 73.85 seconds

## Persisted sequence

1. `trpg_gm_context` loaded the exact DB and room and observed `stagnant_action_count=3`.
2. Qwen autonomously chose `trpg_gm_story_intervene` rather than asking Alice to follow an NPC, accept a mission, travel, or choose from a menu.
3. The persisted event brought the next scene to the current warehouse: a soaked fisherman burst through the side door with testimony and an oilcloth-wrapped object while an unlit speedboat approached.
4. The SQLite event records:

```json
{
  "transition_mode": "direct_world_event",
  "requires_prescribed_player_choice": false
}
```

5. Finalization passed with `playerActionStatus=not_applicable`, a concrete `noPlayerActionReason`, and all confirmations including `eventDrivenTransitionChecked=true`.

## Player-visible result

The narration depicted the warehouse door being struck open, sea wind and smell entering, the fisherman's visible condition and speech, the wrapped object, and the approaching engine. The scene changed immediately without waiting for Alice to choose a required lead. It did not assign Alice speech, movement, thought, emotion, decision, or reaction, offered no option list, and ended with the open prompt `你要怎麼做？`.

## Result

PASS. The forced transition was event-driven, persisted before narration, directly brought new pressure to the player's current scene, and preserved open-ended player agency. Separate regression tests also prove that common Chinese/English prescribed-option language in either `event` or `intended_progress` is rejected before audit metadata is written.

## Retry observed

Qwen's first finalizer call included `eventDrivenTransitionChecked=true` but omitted `noPlayerActionReason`; the existing guard rejected it. Qwen retried with the missing reason and finalization passed. No unfinalized player-facing response escaped between attempts.
