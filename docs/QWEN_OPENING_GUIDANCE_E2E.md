# Qwen character-opening guidance E2E

Date: 2026-08-09

## Purpose

Production-like verification that a Pi GM using `local-llama/qwen3.6-35b-q4` transitions from completed character creation into a background-grounded story opening without taking control of the player character.

## Setup

- Pi loaded this checkout's `extensions/trpg-gm-guard.js` and `.agents/skills/trpg-gm` directly.
- Isolated DB: `/tmp/trpg-opening-e2e-v090.db`
- Room: `opening-e2e-v090`
- Character: `alice` / 艾莉絲
- Saved background: `地方報社記者`
- Saved concept: `追查失蹤案的記者`
- Machine-readable Pi trace: `/tmp/trpg-opening-e2e-v090.jsonl`

## Observed sequence

1. Qwen created the room and loaded exact-room context through structured TRPG tools.
2. It completed `creation configure → creation propose → creation roll`.
3. A second context returned `opening_guidance_required=true` with `opening_character_ids=["alice"]`.
4. Qwen called `trpg_gm_story_objective` with:
   - chapter: `第一章：匿名信`
   - objective: `從報社收到的匿名信追查失蹤案`
   - `openingCharacterIds: ["alice"]`
   - a reason containing the exact saved background `地方報社記者`
5. The extension reloaded exact-room context internally and allowed `trpg_turn_finalize` only after the opening gate cleared.
6. The final answer described the visible period, newsroom, anonymous letter, message, stain, weather, and immediate hook; it made no speech, movement, thought, emotional reaction, motive, or quest-acceptance decision for 艾莉絲.
7. The answer ended with `你要怎麼做？`, returning the first action to the player.

## Result

PASS. The production-like Qwen/Pi path persisted a background-grounded opening objective, cleared the opening gate through verified context, finalized successfully, and preserved player agency.

Qwen initially guessed several invalid raw character-creation argument shapes; the CLI rejected them without corrupting state, and Qwen recovered to the documented shape. This reinforces the existing recommendation to add typed creation tools in a future release.
