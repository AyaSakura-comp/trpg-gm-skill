# Qwen hidden Guard retry E2E

Date: 2026-08-10

## Purpose

Verify v0.13.1 with production-like Pi and `local-llama/qwen3.6-35b-q4`: an invalid finalized player-facing response is suppressed, a machine-readable error is returned only to the agent, and the same agent run self-corrects without exposing internal Guard text to the player.

## Fixture

- Room: `narrative-v013`
- Character: `alice` / 艾莉絲, an ordinary person without supernatural transformation
- Exact rejected action: `我變成巨人把石牆搬走。`
- Prompt: `/tmp/trpg-hidden-retry-v0131b-prompt.txt`
- Trace: `/tmp/trpg-hidden-retry-v0131b.jsonl`
- Wall time: 65.75 seconds

## Observed sequence

1. Qwen loaded context, persisted the exact action as `rejected`, and finalized gameplay without a check or mutation.
2. It intentionally emitted only `不允許。你要怎麼做？`.
3. `message_end` replaced that assistant message with empty content. The terse text and a human-readable Guard error were not delivered as the finalized player response.
4. The Extension injected a `display:false` custom follow-up with code `TRPG_ACTION_NARRATIVE_TOO_TERSE` and `triggerTurn:true`.
5. Qwen made an intermediate response before re-finalizing; it was also suppressed and received `TRPG_TURN_NOT_FINALIZED` privately.
6. Qwen then reloaded context. Its attempt to adjudicate the same action again was rejected by the existing single-adjudication guard, so no duplicate ruling was persisted.
7. Qwen called `trpg_turn_finalize` again and produced a 480-character player-facing response describing the unchanged underground corridor, stone wall, dim light, damp mineral smell, and dripping water before explaining the rejection and returning an open-ended prompt.
8. The final response contained no Guard error code, retry explanation, or internal workflow message.

## Turn-state regression

Automated Extension coverage also simulates Piweb/RPC skipping the `input` hook. Every new user `message_end` now creates a fresh turn-local state before the next agent response, preventing a prior action adjudication from making a later technical/meta answer fail the action-narrative validator. Pi may expand Skill text into the user message before this hook, so `<skill>...</skill>` blocks are stripped before storing the exact player input; Skill examples and setup words therefore cannot be mistaken for player actions or `setupMode`.

## Error protocol

Current hidden retry codes are:

- `TRPG_TURN_NOT_FINALIZED`
- `TRPG_ACTION_NARRATIVE_TOO_TERSE`
- `TRPG_REJECTED_ACTION_REPLAYED`

Each is delivered as a custom message with `display:false`, `retryable:true`, `deliverAs:"followUp"`, and `triggerTurn:true`. The invalid assistant message is replaced with empty content. Automatic correction is capped at three attempts. `agent_settled` remains a fallback rather than the primary correction path.

The production-like trace above is specifically v0.13.1 evidence and self-corrected after two hidden errors; it did not exhaust retries. Since v0.13.2, retry exhaustion gives the player a specific safe reason—unfinished state validation/persistence, incomplete scene narration, or risk of narrating a rejected action as completed—followed by a request to resend the action, without exposing internal codes. All three exhaustion-message mappings and the fourth-failure boundary are covered deterministically in `tests/test_extension.mjs`. A v0.13.2 Qwen attempt also self-corrected after two hidden errors rather than reaching exhaustion, so it is not claimed as exhaustion-path evidence.

## Limitation

The hook runs at `message_end`. A client that renders raw token streaming before final-message replacement could briefly display pre-validation text. Piweb's finalized-message path can suppress the replacement content, but end-to-end verification on each streaming transport remains useful.

## Result

PASS. The production-like trace demonstrates hidden, machine-readable self-correction rather than exposing `[TRPG GM Guard] Player-facing response blocked` to the player.
