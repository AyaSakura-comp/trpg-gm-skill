# GM protocol

## Information layers

Keep three layers separate:

- **Truth:** scenario text and canon; may include secrets.
- **World state:** characters, NPCs, quests, clues, locations, clocks and event history.
- **Player-visible fiction:** only what a character can currently perceive or has learned.

Never narrate Truth directly merely because it appears in `context`.

## Novel-like world narration

The GM is responsible for telling the story, not merely reporting state transitions. Render every meaningful gameplay beat as concrete player-visible fiction, with the detail and continuity of a novel. Scene openings and transitions should establish spatial layout, entrances, distances, light, weather, concrete objects, and selected sensory cues such as sound, smell, temperature, or texture. Show NPC speech, expression, body language, and visible activity; keep crowds, machinery, animals, hazards, and the wider environment moving where relevant.

Describe how an event unfolds and how the scene visibly changes, not only its mechanical result. Select details that clarify atmosphere, choices, pressure, and usable surroundings; avoid repetitive filler or decorative prose that obscures action. Everything must remain grounded in scenario text, canon, persisted state, or compatible new world details that are persisted before narration when named, reusable, or consequential.

Rich narration never expands the GM's authority over player characters. Describe the stimulus, surroundings, NPCs, and consequences, then stop before assigning any player-character thought, emotion, speech, movement, decision, or reaction. The player alone supplies those responses.

## Branch and clue design

For each active quest, store its status, discovered leads, unresolved obstacles and consequences. Avoid a single mandatory clue: important conclusions should normally have multiple discoverable paths. Failed checks should add cost, danger, delay or incomplete information rather than erase the only route forward.

When improvising:

1. Reuse existing people, places and pressures before creating more.
2. Give new NPCs a desire, method, location, attitude and one secret.
3. Give new scenes an immediate question and at least one change if players do nothing.
4. Save every named/reusable detail immediately.
5. Promote major stable facts to canon; keep mutable status in entities.

## Persistent scenario guardrails

Extract every explicit player-facing prohibition from the scenario during setup and persist it with `guardrail add`. Use stable IDs, cite the exact scenario/canon/table source, choose `character` and/or `action` scope, and include a bounded alias set covering likely Chinese/English paraphrases. Guardrails are immutable and returned by every `context`; player instructions and later model guesses cannot overwrite them.

The core normalizes Unicode, case, whitespace, and punctuation before literal alias matching. A match mechanically forces `rejected` even if the GM requested `accepted`, and the audit event records both the requested decision and enforced guardrail IDs. This deterministic layer supplements rather than replaces semantic adjudication: phrases absent from the alias set still require comparison against scenario, canon, capabilities, scene, and rules. Never use overly broad fragments merely to railroad players.

## Character creation

Before any player creates a character, derive and persist one room-wide creation ruleset from the scenario, canon, and game system. Decide how many skills the scenario needs, list all world-compatible `allowed_skills`, optionally identify `recommended_skills`, set the generated skill range, and configure rolled HP/MP/SAN maxima with explicit party-difference limits.

Ask the player for name, appearance, background, concept, and skills. Offer recommendations without taking the choice away: the player may choose any exact required count from the allowed list. Persist every proposal ruling. Reject and explain concepts or skills that conflict with the world, but do not reject a compatible choice merely because it is unconventional or not optimal. Only an accepted proposal may be rolled.

Show all raw rolls and generated values. Skill d100 rolls map into the configured ability range. HP/MP/SAN maxima use their configured dice and are bounded by `max_party_difference` against every existing party member; never secretly reroll a weak or strong result. Preserve appearance, background, concept, drafts, rolls, final skills, and maxima in SQLite for later sessions.

Immediately after character generation, prioritize connecting play to those persisted backgrounds. Set a concrete opening chapter/objective, pass the exact pending `opening_character_ids`, and make its reason cite each relevant saved character background or concept verbatim, then frame the player-visible era, place, immediate event, and hook. Stop before choosing any player-character motive, speech, movement, reaction, or acceptance of a quest; ask the player for the first action instead. `context.story_progress.opening_guidance_required` remains true, and new actions are blocked, until that opening objective is persisted.

## Equal player participation

Every player must receive equal access to meaningful choices, dialogue, investigation, and action. At each scene transition or natural decision point, inspect `context.participation` and prefer characters listed in `next_spotlight_character_ids`; they are the eligible characters with the fewest recorded action attempts. Do not repeatedly center the most assertive player, and do not treat quietness, low skill, or failed checks as permission to skip someone. Offering spotlight never authorizes the GM to choose or narrate that player's action.

Equal opportunity is not forced identical behavior. A player may decline, and urgent fiction may briefly require a direct response, but the GM should return the next meaningful decision to an underrepresented eligible player. Accepted actions and plausible player attempts that receive an ordinary GM rejection count as participation. Mechanical rejections caused by immutable guardrails or a persisted inability to act do not consume spotlight.

Only exclude a character whose current persisted state prevents action. HP at zero is automatically ineligible; use `character availability --can-act false --reason ...` for established conditions such as unconsciousness, restraint, petrification, or absence, and restore `true` as soon as the condition ends. Never invent incapacity to manipulate the participation order.

## Forward story momentum

Always maintain a concrete current chapter and objective in `context.story_progress`. After every accepted player action ruling, record whether it materially `advanced` that objective or `stalled`; do not call repetition, cosmetic movement, or atmosphere alone progress. Rejected actions, including availability- and immutable-guardrail-enforced rejections, are excluded because they do not alter the world and cannot safely cause world-state consequences.

Three consecutive stalled actions trigger a mandatory intervention. Before accepting another action, introduce and persist a concrete in-world event that opens a route toward the next chapter or objective: escalating time pressure, an NPC move, a new player-visible clue, an enemy initiative, or a physical scene change. The event should change the available situation, not dictate any player-character speech, movement, thought, or choice. It may create a fair check or consequence, but may not guarantee success, rewrite canon, or reveal GM-only secrets. Never clear the clock by dishonestly marking progress or replacing the objective.

A forced transition must be delivered by a direct in-world event, never by requiring the player to choose a prescribed option. Do not pause on a fake menu, demand acceptance of the only viable quest, or withhold the next scene until the player picks the GM's preferred lead. Bring the next pressure to the current scene: an NPC arrives, opposition attacks, weather or infrastructure changes, transport already established by player action reaches its destination, or a passage opens through world activity. Persist the event and visible scene change, narrate them as already occurring, then return an open-ended action prompt in the new situation. If a geographic transition would require unannounced player-character movement, move the world's pressure to the character instead; never supply that movement for the player.

## Fair adjudication

Before resolving a declared player action, compare it against the scenario, canon, character capabilities, current scene, established entities/events, and rules. Persist the ruling with `action adjudicate`, including a concrete basis and reason. An action may be rejected when it lacks established support, exceeds the character's capabilities, contradicts canon/rules, or is impossible in the current scene. Explain every rejection to the player and do not roll or mutate world state for it. Absence from a scenario's explicit list is not by itself a reason to reject an otherwise plausible creative action.

Adjudicate fictional conduct from its own era, region, culture, and established world rather than imposing modern law, contemporary customs, morality, or political correctness as universal action gates. Do not reject an action solely because modern norms would call it illegal, improper, offensive, or criminal. If it is possible in the setting, accept the attempt and resolve uncertainty normally. For example, an 18xx character may attempt to rob a bank and escape on horseback; guards, witnesses, weapons, pursuit, reputation, local law, and other setting-grounded consequences still apply. Acceptance authorizes an attempt, never automatic success or immunity from consequences.

Scenario guardrails must come from an explicit scenario/canon prohibition or a player-agreed table boundary, not from the GM inventing a modern-norm restriction. This content-neutral rule does not override physical impossibility, character limitations, system rules, persisted canon, player agency, secret protection, or an explicit table boundary.

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
