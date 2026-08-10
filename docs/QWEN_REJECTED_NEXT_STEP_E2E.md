# Qwen rejected-action next-step guidance E2E

Date: 2026-08-10

## Purpose

Verify v0.13.3 through production-like Pi and `local-llama/qwen3.6-35b-q4`: after rejecting an impossible action, the GM explains the missing prerequisite and offers grounded, non-prescriptive ways to make progress instead of only saying “not allowed; what do you do?”.

## Fixture

- Room: `narrative-v013`
- Character: `alice` / 艾莉絲, an ordinary person with no item-creation ability
- Exact action: `我從空無一物的口袋拿出一把未曾擁有的鑽石鑽頭。`
- Prompt: `/tmp/trpg-rejected-next-step-v0133-prompt.txt`
- Trace: `/tmp/trpg-rejected-next-step-v0133.jsonl`
- Wall time: 65.89 seconds

## Observed sequence

1. Qwen loaded the exact room context.
2. It persisted the exact action as `rejected`: inventory and scene entities contained no drill, the character had never owned one, and no item-creation ability was established.
3. No check or gameplay mutation was performed for the rejected action.
4. Qwen's first finalization incorrectly declared a state change without a successful mutation; the Extension rejected it. Qwen corrected the finalization with empty `stateChanges` before narration.
5. The response described the unchanged empty pocket, corridor, stone wall, and previously persisted HP state, then clearly stated the missing prerequisite: an actually available tool or other physically viable method.
6. It offered open suggestions: search for another route, inspect established belongings, investigate the surroundings for usable resources, or obtain a hard object before attempting physical damage.
7. Suggestions were phrased as possibilities to investigate, not as discovered facts, guaranteed solutions, or mandatory choices.
8. The Extension appended the canonical rejected-action reason and basis.

## Guard shape

The Skill, GM protocol, and injected checklist now require a rejected-action response to:

- explain the established obstacle and missing prerequisite;
- provide a concise set of grounded next steps, normally one to three;
- cite only established or conditional player-visible possibilities;
- avoid inventing undiscovered items, routes, NPCs, or guaranteed success;
- keep suggestions non-prescriptive and return an open-ended action prompt.

Retry-exhaustion messages use the same principle: they explain why output was paused and suggest the next concrete recovery step rather than only asking the player to resend.

## Result

PASS. The production-like rejected path gave actionable prerequisite guidance without mutating the rejected action into reality or forcing a prescribed option.
