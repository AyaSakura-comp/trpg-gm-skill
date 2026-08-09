# Qwen every-action narrative hook E2E

Date: 2026-08-09

## Purpose

Verify the most failure-prone v0.13.0 path through production-like Pi and `local-llama/qwen3.6-35b-q4`: a rejected action receives a short novel-like player-facing passage instead of a terse ruling-and-handoff. Accepted and rejected enforcement are both covered by automated Extension tests; this document's passing Qwen trace covers the rejected path only.

## Fixture

- DB stem: `/tmp/trpg-every-action-narrative-v013` with the standard SQLite suffix
- Room: `narrative-v013`
- Character: `alice` / 艾莉絲, an ordinary person with no wall-passing or teleportation capability
- Passing prompt: `/tmp/trpg-every-action-narrative-v013d-prompt.txt`
- Passing trace: `/tmp/trpg-every-action-narrative-v013d.jsonl`
- Wall time: 23.82 seconds

## Passing sequence

1. The injected hook explicitly required a novel-like response for every accepted or rejected action and prohibited a ruling-summary-only handoff.
2. Qwen loaded the exact room context.
3. It persisted the exact declared action `我變成煙霧穿過石牆。` as `rejected`, grounded in the character notes, solid wall, and absence of supernatural capability.
4. No check or world-state mutation occurred.
5. Qwen called `trpg_turn_finalize` before player-facing prose with `playerActionStatus=rejected`, empty `stateChanges`, and all required confirmations.
6. The final response described the unchanged wall, dim light, corridor sound, cool air, and dust smell in a novel-like paragraph, then explained the rejection and returned an open-ended prompt.
7. The Extension appended the canonical rejected-action ruling and did not recursively reject its own appended literal action report.

## Mechanical output guard

After action finalization, `message_end` removes handoff questions and Markdown list lines, then requires at least one prose paragraph containing 60 meaningful characters and two sentence-ending marks. A terse response is replaced with a guard error, `turn.finalized` is invalidated, and the agent is asked to correct the response. For rejected actions, a normalized literal replay of the exact rejected action in the model's prose is also blocked; the Extension appends the exact audit wording itself after prose validation.

This is bounded validation, not a semantic literary classifier. Paraphrased low-quality prose, subtle player-agency violations, or a semantic claim that a rejected action occurred can still require protocol compliance, E2E review, or future semantic validation.

## Failure evidence retained

- `/tmp/trpg-every-action-narrative-v013.jsonl`: Qwen produced rich prose, but the first implementation recursively revalidated its own appended ruling and eventually replaced it with a guard error. A regression test and `playerFacingNarrativeValidated` state fixed this.
- `/tmp/trpg-every-action-narrative-v013b.jsonl`: timed out after context at 180 seconds without mutation.
- `/tmp/trpg-every-action-narrative-v013c.jsonl`: Qwen adjudicated but narrated before finalization; the existing finalization hook correctly blocked the response.

## Result

PASS for the production-like rejected-action path. Together with automated accepted/rejected output tests, v0.13 combines per-turn prompt injection, finalizer self-attestation, and bounded final-output validation so action responses cannot consist only of a terse status summary and spotlight handoff.
