# Qwen novel-like narration E2E

Date: 2026-08-09

## Purpose

Production-like verification that Pi with `local-llama/qwen3.6-35b-q4` uses the v0.10 finalizer contract and produces detailed, player-visible world narration without taking control of the player character.

## Setup

- Extension and Skill loaded directly from this checkout.
- DB: `/tmp/trpg-opening-e2e-v090.db`
- Room: `opening-e2e-v090`
- Machine-readable passing trace: `/tmp/trpg-narrative-e2e-v010b.jsonl`
- Exact player action: `我保持原位，等待報社裡接下來發生的動靜。`

## Persisted tool sequence

1. `trpg_gm_context`
2. `trpg_gm_action_adjudicate` with the exact player wording and `accepted`
3. `trpg_gm_entity_upsert` for scene `newsroom-current`, persisting office layout, lighting, telephone ringing, print-room machinery, and the changed tea-room doorway
4. `trpg_gm_story_progress` with an honest `stalled` assessment
5. `trpg_turn_finalize` with `secretsChecked=true`, `playerAgencyChecked=true`, and `narrativeDetailChecked=true`

## Player-visible result

The answer used multiple novel-like paragraphs to establish:

- office dimensions and routes between desks;
- flooring, lighting, windows, weather, and long shadows;
- toner, paper, and coffee smells;
- the telephone's five rings and abrupt silence;
- the print-room motor and paper-feed sounds unfolding over time;
- the tea-room doorway's visible change;
- the persisted anonymous letter remaining on the desk.

It described only GM-controlled environment activity. Beyond the player's exact declaration to remain and wait, it assigned Alice no thought, emotion, speech, movement, decision, or reaction. It ended by returning the next action to the player.

## Result

PASS. The production tool schema required the new confirmation, the model supplied it, important scene details were persisted before narration, and the resulting prose was substantially more detailed than a state-transition summary.

## Gotcha discovered

An earlier trace at `/tmp/trpg-narrative-e2e-v010.jsonl` showed why rich narration must remain explicitly bounded: while describing an investigation, Qwen added physical choreography such as leaning closer and manipulating the letter. Those details were compatible with the declared inspection but exceeded a stricter test prompt that prohibited additional movement. The production guidance therefore repeatedly states that novel-like detail expands the world and NPCs, not the GM's authority over player characters. `narrativeDetailChecked` is a required pre-output self-attestation, not a semantic prose classifier; final output still depends on the Skill rules and review/E2E coverage.
