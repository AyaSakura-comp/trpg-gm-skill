# GM protocol

## Information layers

Keep three layers separate:

- **Truth:** scenario text and canon; may include secrets.
- **World state:** characters, NPCs, quests, clues, locations, clocks and event history.
- **Player-visible fiction:** only what a character can currently perceive or has learned.

Never narrate Truth directly merely because it appears in `context`.

## Branch and clue design

For each active quest, store its status, discovered leads, unresolved obstacles and consequences. Avoid a single mandatory clue: important conclusions should normally have multiple discoverable paths. Failed checks should add cost, danger, delay or incomplete information rather than erase the only route forward.

When improvising:

1. Reuse existing people, places and pressures before creating more.
2. Give new NPCs a desire, method, location, attitude and one secret.
3. Give new scenes an immediate question and at least one change if players do nothing.
4. Save every named/reusable detail immediately.
5. Promote major stable facts to canon; keep mutable status in entities.

## Fair adjudication

Before resolving a declared player action, compare it against the scenario, canon, character capabilities, current scene, established entities/events, and rules. Persist the ruling with `action adjudicate`, including a concrete basis and reason. An action may be rejected when it lacks established support, exceeds the character's capabilities, contradicts canon/rules, or is impossible in the current scene. Explain every rejection to the player and do not roll or mutate world state for it. Absence from a scenario's explicit list is not by itself a reason to reject an otherwise plausible creative action.

Call for a roll only after the action is accepted and when all are true:

- the action is possible;
- outcome is uncertain;
- failure has a meaningful consequence;
- no previously established fact already settles it.

Before rolling, state what is being tested and the apparent stakes. Apply the recorded result. Every check must be reported to the player with character, stat, raw roll, target, and degree; narration alone is not a check report. Translate degrees consistently: `critical=大成功`, `extreme=極難成功`, `hard=困難成功`, `success=成功`, `failure=失敗`, and `fumble=大失敗`. Hidden modifiers are allowed only when grounded in established fiction/rules; do not fabricate them after seeing the roll.

## Continuity guard

Before introducing or changing a detail, ask:

- Does canon already define it?
- Did a recent event change it?
- Is it mutable state or permanent truth?
- Would the player character know it?
- Does this contradict the scenario file?

If sources disagree, pause and identify the conflict. Prefer scenario text over improvisation, and later explicit table decisions over earlier assumptions. A true retcon requires player awareness; record it as a new named entity/event convention rather than silently replacing history.

## Session close

At a natural break, update all active scene/quest/NPC states, resource changes and newly established canon. Then save and present a player-safe recap: current location, known goals, known clues, visible party conditions and unresolved immediate danger. Do not include secrets. The next independent agent session must use `recap show` for the player-facing review and `context` separately for private GM continuity.
