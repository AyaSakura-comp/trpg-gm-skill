import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ACTIVATION_PATTERN = /(?:\/skill:trpg-gm|開(?:一個)?新團|繼續舊團|(?:想|要|來|開始|繼續|玩|play|start|resume).{0,24}\bTRPG\b|(?:請(?:你)?|讓你)?(?:當|作為)\s*(?:TRPG\s*)?GM\b|主持.{0,20}(?:TRPG|CoC|克蘇魯|冒險|團))/iu;
const CLI_WRAPPER = fileURLToPath(new URL("../.agents/skills/trpg-gm/scripts/trpg-gm", import.meta.url));
const SKILL_MARKER = "# Persistent TRPG GM";
const DEGREE_LABELS = {
  critical: "大成功",
  extreme: "極難成功",
  hard: "困難成功",
  success: "成功",
  failure: "失敗",
  fumble: "大失敗",
};

function parseCheckReport(stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Successful check returned invalid JSON: ${error.message}`);
  }
  const required = ["character_id", "stat", "roll", "target", "degree"];
  const missing = required.filter((key) => value?.[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`Successful check omitted report fields: ${missing.join(", ")}.`);
  }
  return {
    characterId: String(value.character_id),
    stat: String(value.stat),
    roll: Number(value.roll),
    target: Number(value.target),
    degree: String(value.degree),
  };
}

function formatCheckReport(check) {
  const label = DEGREE_LABELS[check.degree] ?? check.degree;
  return `- ${check.characterId} 的${check.stat}：${label}（${check.degree}，roll ${check.roll}，目標 ${check.target}）`;
}

function hasNovelLikeActionPassage(text) {
  const withoutHandoff = String(text ?? "")
    .replace(/(?:你|下一位|[A-Za-z0-9_-]+)\s*(?:現在)?(?:要|想|會)?\s*怎麼做[？?]?/giu, "")
    .replace(/what (?:do|will|would) (?:you|[A-Za-z0-9_-]+) do\??/giu, "");
  return withoutHandoff.split(/\n\s*\n/u).some((paragraph) => {
    const prose = paragraph
      .split("\n")
      .filter((line) => !/^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|```)/u.test(line))
      .join(" ")
      .replace(/[*_`>#|]/gu, " ")
      .trim();
    const meaningfulCharacters = prose.replace(/[\s\p{P}\p{S}]/gu, "").length;
    const sentences = prose.match(/[。！？.!?]/gu)?.length ?? 0;
    return meaningfulCharacters >= 60 && sentences >= 2;
  });
}

function repeatsRejectedActionLiteral(text, action) {
  const normalize = (value) => String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
  const normalizedAction = normalize(action);
  return normalizedAction.length >= 4 && normalize(text).includes(normalizedAction);
}

function parseCharacterGeneration(stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Successful character generation returned invalid JSON: ${error.message}`);
  }
  if (!value?.id || !value?.name || !value?.stats || !value?.generation?.skill_rolls
      || !value?.generation?.resource_rolls || !value?.generation?.maxima) {
    throw new Error("Successful character generation omitted rolled abilities or resource maxima.");
  }
  return {
    characterId: String(value.id),
    name: String(value.name),
    stats: value.stats,
    skillRolls: value.generation.skill_rolls,
    resourceRolls: value.generation.resource_rolls,
    maxima: value.generation.maxima,
  };
}

function parseCharacterProposal(stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Successful character proposal returned invalid JSON: ${error.message}`);
  }
  const required = ["character_id", "name", "appearance", "background", "concept", "decision", "basis", "reason"];
  const missing = required.filter((key) => !String(value?.[key] ?? "").trim());
  if (missing.length > 0 || !Array.isArray(value?.skills)) {
    throw new Error(`Successful character proposal omitted fields: ${missing.join(", ") || "skills"}.`);
  }
  return {
    characterId: String(value.character_id),
    name: String(value.name),
    appearance: String(value.appearance),
    background: String(value.background),
    concept: String(value.concept),
    skills: value.skills.map(String),
    decision: String(value.decision),
    basis: String(value.basis),
    reason: String(value.reason),
  };
}

function parseActionAdjudication(stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Successful action adjudication returned invalid JSON: ${error.message}`);
  }
  const required = ["character_id", "action", "decision", "basis", "reason"];
  const missing = required.filter((key) => !String(value?.[key] ?? "").trim());
  if (missing.length > 0) {
    throw new Error(`Successful action adjudication omitted fields: ${missing.join(", ")}.`);
  }
  if (!["accepted", "rejected"].includes(value.decision)) {
    throw new Error(`Unknown action decision: ${value.decision}.`);
  }
  return {
    characterId: String(value.character_id),
    action: String(value.action),
    decision: String(value.decision),
    basis: String(value.basis),
    reason: String(value.reason),
  };
}

export function shouldActivateFromText(text) {
  return ACTIVATION_PATTERN.test(text ?? "");
}

function positionalTokens(tokens) {
  const positionals = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].startsWith("--")) {
      if (!tokens[index].includes("=")) index += 1;
    } else {
      positionals.push(tokens[index]);
    }
  }
  return positionals;
}

function optionValue(args, name) {
  const directIndex = args.indexOf(name);
  if (directIndex >= 0) return args[directIndex + 1];
  const inline = args.find((token) => token.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
}

function classifyCliArgs(args) {
  if (args.includes("--help") || args.includes("-h")) {
    return { contextRoom: null, operationRoom: null, action: false, check: false, mutation: false };
  }
  const [command, actionOrRoom, maybeRoom] = args;
  const commandRoom = positionalTokens(args.slice(1))[0] ?? actionOrRoom;
  const subcommandPositionals = positionalTokens(args.slice(2));
  const subcommandRoom = subcommandPositionals[0] ?? maybeRoom;
  if (command === "context") return { contextRoom: commandRoom, operationRoom: null, action: false, check: false, mutation: false };
  if (command === "creation") {
    return {
      contextRoom: null,
      operationRoom: subcommandRoom,
      action: false,
      characterProposal: actionOrRoom === "propose",
      characterGenerated: actionOrRoom === "roll",
      check: false,
      mutation: actionOrRoom !== "show",
    };
  }
  if (command === "guardrail") {
    return {
      contextRoom: null,
      operationRoom: subcommandRoom,
      action: false,
      check: false,
      mutation: actionOrRoom === "add",
      safeSetupMutation: actionOrRoom === "add",
    };
  }
  if (command === "action" && actionOrRoom === "adjudicate") {
    return {
      contextRoom: null,
      operationRoom: subcommandRoom,
      action: true,
      playerAction: subcommandPositionals[2],
      decision: optionValue(args, "--decision"),
      check: false,
      mutation: false,
    };
  }
  if (command === "story" && ["objective", "progress", "intervene"].includes(actionOrRoom)) {
    return {
      contextRoom: null,
      operationRoom: subcommandRoom,
      action: false,
      check: false,
      mutation: true,
      requiresContext: true,
      storyOperation: actionOrRoom,
      doesNotResolveAction: actionOrRoom === "progress",
    };
  }
  if (command === "check") {
    return {
      contextRoom: null,
      operationRoom: commandRoom,
      action: false,
      check: true,
      explicitRoll: optionValue(args, "--roll"),
      mutation: false,
    };
  }
  if (["canon", "entity"].includes(command)) {
    return {
      contextRoom: null, operationRoom: commandRoom, action: false, check: false,
      mutation: true, requiresAcceptedAction: true,
    };
  }
  if (command === "room" && actionOrRoom === "create") {
    return { contextRoom: null, operationRoom: subcommandRoom, action: false, check: false, mutation: true };
  }
  if (command === "character" && ["add", "adjust", "availability"].includes(actionOrRoom)) {
    return {
      contextRoom: null, operationRoom: subcommandRoom, action: false, check: false,
      mutation: true,
      availability: actionOrRoom === "availability",
      resourceAdjustment: actionOrRoom === "adjust",
      characterId: ["adjust", "availability"].includes(actionOrRoom)
        ? subcommandPositionals[1]
        : undefined,
      resource: actionOrRoom === "adjust" ? subcommandPositionals[2] : undefined,
      canAct: actionOrRoom === "availability"
        ? String(optionValue(args, "--can-act")).toLowerCase() === "true"
        : undefined,
      requiresContext: actionOrRoom === "availability",
      requiresAcceptedAction: actionOrRoom === "adjust",
    };
  }
  if (command === "recap" && actionOrRoom === "save") {
    return { contextRoom: null, operationRoom: subcommandRoom, action: false, check: false, mutation: true };
  }
  return { contextRoom: null, operationRoom: null, action: false, check: false, mutation: false };
}

function parseParticipation(stdout) {
  try {
    const value = JSON.parse(stdout);
    const characters = value?.participation?.characters;
    if (!Array.isArray(characters)) return null;
    return characters.map((character) => ({
      characterId: String(character.character_id),
      canAct: character.can_act === true,
      actionCount: Number(character.action_count) || 0,
      unavailableReason: character.unavailable_reason ?? null,
    }));
  } catch {
    return null;
  }
}

function parseStoryProgress(stdout) {
  try {
    const value = JSON.parse(stdout);
    const progress = value?.story_progress ?? value;
    if (
      !progress
      || typeof progress.chapter !== "string"
      || !progress.chapter.trim()
      || typeof progress.objective !== "string"
      || !progress.objective.trim()
      || typeof progress.opening_guidance_required !== "boolean"
      || !Array.isArray(progress.opening_character_ids)
      || progress.opening_character_ids.some((id) => !String(id).trim())
      || progress.opening_guidance_required !== (progress.opening_character_ids.length > 0)
      || !Number.isInteger(progress.stagnant_action_count)
      || progress.stagnant_action_count < 0
      || typeof progress.intervention_required !== "boolean"
      || progress.intervention_required !== (progress.stagnant_action_count >= 3)
    ) return null;
    return {
      chapter: progress.chapter,
      objective: progress.objective,
      openingGuidanceRequired: progress.opening_guidance_required,
      openingCharacterIds: progress.opening_character_ids.map(String),
      stagnantActionCount: progress.stagnant_action_count,
      interventionRequired: progress.intervention_required,
    };
  } catch {
    return null;
  }
}

function nextSpotlightCharacterIds(participation) {
  const eligible = (participation ?? []).filter((character) => character.canAct);
  const minimum = Math.min(...eligible.map((character) => character.actionCount));
  return eligible
    .filter((character) => character.actionCount === minimum)
    .map((character) => character.characterId);
}

function freshTurn() {
  return {
    playerInput: "",
    setupMode: false,
    contextLoaded: false,
    contextRoom: null,
    contextDb: null,
    operationRooms: new Set(),
    dbPaths: new Set(),
    participation: null,
    storyProgress: null,
    storyProgressRecorded: false,
    storyInterventionPersisted: false,
    openingGuidanceRequired: false,
    actionNeedsProgress: false,
    operationIndex: 0,
    latestActionIndex: null,
    checkOperationIndices: [],
    mutationOperationIndices: [],
    safeSetupMutationOperationIndices: new Set(),
    characterProposals: [],
    characterProposalReportsAppended: 0,
    characterGenerations: [],
    characterGenerationReportsAppended: 0,
    actionAdjudications: [],
    actionRulingAppended: false,
    checkResolved: false,
    checkReports: [],
    checkReportAppended: false,
    mutationPersisted: false,
    finalized: false,
    playerFacingNarrativeValidated: false,
    reminderSent: false,
  };
}

function checklist() {
  return [
    "[TRPG GM Guard — mandatory for this turn]",
    "1. Before player-facing narration, use typed trpg_gm_context to load the exact room and DB.",
    "2. Prefer typed trpg_gm_action_adjudicate, trpg_gm_check, trpg_gm_entity_upsert, trpg_gm_character_adjust, trpg_gm_character_availability, trpg_gm_canon_set, and trpg_gm_recap_save. Use raw trpg_gm_cli only for unsupported setup/query operations; never use bash or direct SQLite. Read scenario text with read, never file:// web scraping.",
    "3. Persist every confirmed consequence, discovered clue, NPC/quest/scene change, and HP/MP/SAN change before narrating it.",
    "4. Never expose secrets or narrate speech, movement, thoughts, or reactions for any player character, including non-acting party PCs.",
    "5. After all state commands finish, call trpg_turn_finalize in a separate tool round before the final player-facing answer.",
    "6. Use turnKind=clarification only when you must ask for a missing room/setup choice before gameplay; otherwise use gameplay.",
    "7. If a check caused no persistent change, explain why in noStateChangeReason; never use that field to avoid saving a discovered clue.",
    "8. Before resolving a declared player action, adjudicate it with trpg_gm_cli action adjudicate against the script, canon, rules, and established state. Reject unsupported or impossible actions with a concrete basis and reason; do not roll or mutate state for a rejected action.",
    "9. During character creation, configure scenario-grounded allowed/recommended skills and party fairness first; persist appearance, background, concept, chosen skills, and accepted/rejected ruling before rolling abilities and HP/MP/SAN maxima. After generation, prioritize an opening based on the character background: persist a concrete chapter/objective, introduce only the world situation, and invite the player to decide their first action.",
    "10. Read the immutable persistent guardrails returned by context before adjudication. A matching guardrail overrides an attempted acceptance to rejected; never paraphrase the action or submit a second ruling to bypass it. During setup, derive guardrail terms and paraphrase aliases from explicit scenario prohibitions with guardrail add.",
    "11. Every resolved check must be reported to the player. The guard appends a canonical 判定結果 block with character, stat, degree, roll, and target to the finalized answer.",
    "12. Typed tools already encode the correct call shape: action decision is accepted|rejected, entity state is an object, and context events is an integer. Copy PLAYER_ACTION exactly. Omit check roll for a random d100 unless the player supplied a physical roll. Do not save recap every turn; save it only at campaign creation or a natural session break. Raw fallback shapes are [\"action\",\"adjudicate\",ROOM,CHARACTER,PLAYER_ACTION,...] and [\"entity\",ROOM,KIND,ID,NAME,...].",
    "13. Use context.participation to give equal spotlight opportunities to all eligible players. Prefer next_spotlight_character_ids when inviting the next action. Only exclude a character whose persisted availability or HP says they cannot act; record other temporary inability with trpg_gm_character_availability.",
    "14. Read context.story_progress. After each accepted, countable player action, persist advanced or stalled with trpg_gm_story_progress. At three consecutive stalled actions, persist a concrete in-world event with trpg_gm_story_intervene before narrating or accepting another action; never replace the objective to evade this clock. A forced transition must happen directly through the world event, not by requiring the player to choose a prescribed option. After the scene changes, return an open-ended action prompt and confirm eventDrivenTransitionChecked=true.",
    "15. The GM is the storyteller: every accepted or rejected action, including one blocked by rules or impossibility, requires at least a short novel-like passage grounded in player-visible facts. For a rejected action, narrate the established obstacle, unchanged surroundings, or NPC/world response without making the rejected action occur or mutating the world, then state the reason and basis. Never respond only with a ruling summary such as ‘X did something / not allowed; what does Y do?’ and immediately hand off. Establish concrete objects, sensory atmosphere, and world activity without deciding a player character's thoughts, feelings, speech, movement, or reaction. Confirm this with narrativeDetailChecked=true.",
    "16. Adjudicate fictional actions by the setting's time and place（時空背景）. Never reject solely because modern law（現代法律）, contemporary customs, morality, or political correctness（政治正確）disapproves; if the action is possible under scenario, canon, capabilities, scene, and rules, accept the attempt and apply era-grounded risks and consequences（後果）. Create guardrails only from explicit scenario/canon prohibitions or player-agreed table boundaries, not inferred modern norms.",
  ].join("\n");
}

export default function trpgGmGuard(pi) {
  let active = false;
  let turn = freshTurn();

  function activate({ persist = true } = {}) {
    if (!active && persist) {
      pi.appendEntry("trpg-gm-guard", { active: true });
    }
    active = true;
  }

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    active = entries.some(
      (entry) => entry.type === "custom"
        && entry.customType === "trpg-gm-guard"
        && entry.data?.active === true,
    );
    turn = freshTurn();
  });

  pi.on("input", async (event) => {
    if (event.source === "extension") return;
    const shouldActivate = active || shouldActivateFromText(event.text);
    turn = freshTurn();
    turn.playerInput = String(event.text ?? "");
    turn.setupMode = /(?:開新團|建立新團|new campaign|campaign setup)/iu.test(turn.playerInput);
    if (shouldActivate) activate();
  });

  pi.on("before_agent_start", async (event) => {
    if (!active && (shouldActivateFromText(event.prompt) || event.prompt?.includes(SKILL_MARKER))) {
      activate();
      turn = freshTurn();
    }
    if (!active) return undefined;
    if (!turn.playerInput) turn.playerInput = String(event.prompt ?? "");
    return {
      message: {
        customType: "trpg-gm-guard",
        content: checklist(),
        display: true,
      },
    };
  });

  pi.on("tool_call", async (event) => {
    if (!active || event.toolName.startsWith("trpg_gm_") || event.toolName === "trpg_turn_finalize") {
      return undefined;
    }
    const serializedInput = JSON.stringify(event.input ?? {});
    const touchesKnownDb = [...turn.dbPaths].some((dbPath) => serializedInput.includes(dbPath));
    const bashCommand = event.toolName === "bash" ? String(event.input?.command ?? "") : "";
    const bashDatabaseAccess = /(?:^|[;&|]\s*)sqlite3?\s|\b(?:import|from)\s+sqlite3?\b|\bsqlite3?\.connect\s*\(|(?:^|[\s"'])[^\s"']+\.sqlite3?\b/iu
      .test(bashCommand);
    const nonBashDatabasePath = event.toolName !== "bash" && /\.sqlite3?\b/iu.test(serializedInput);
    if (touchesKnownDb || bashDatabaseAccess || nonBashDatabasePath) {
      return {
        block: true,
        reason: "Direct access to a TRPG room database is forbidden; use structured trpg_gm_cli commands.",
      };
    }
    const webFileAccess = /^(?:browser|firecrawl|web)/iu.test(event.toolName)
      && /file:\/\//iu.test(serializedInput);
    if (webFileAccess) {
      return {
        block: true,
        reason: "Do not use file:// with web tools; read scenario text with the read tool.",
      };
    }
    return undefined;
  });

  async function executeCli(params, signal) {
    const operation = classifyCliArgs(params.args);
    const dbKey = resolve(params.db);
    if (turn.contextDb && dbKey !== turn.contextDb) {
      throw new Error(`All turn operations must use the same database as context: ${turn.contextDb}.`);
    }
    if (
      !turn.contextLoaded
      && !turn.setupMode
      && (operation.action || operation.check || operation.requiresContext || operation.requiresAcceptedAction)
    ) {
      throw new Error("Load the exact room context first, before action adjudication, checks, or gameplay mutations.");
    }
    if (
      turn.contextLoaded
      && operation.operationRoom
      && operation.operationRoom !== turn.contextRoom
    ) {
      throw new Error(`All turn operations must use the same exact room as context: ${turn.contextRoom}.`);
    }
    if (operation.action && turn.openingGuidanceRequired) {
      throw new Error("Guide the story background and persist its opening objective before accepting a player action.");
    }
    if (operation.action && turn.actionAdjudications.length > 0) {
      throw new Error("Only one successful action adjudication is allowed per turn; do not rewrite or re-submit a rejected player action.");
    }
    if (operation.action && !["accepted", "rejected"].includes(operation.decision)) {
      throw new Error("Action --decision must be exactly accepted or rejected; check is a separate command after an accepted ruling.");
    }
    if (
      operation.action
      && (!operation.playerAction || !turn.playerInput.includes(operation.playerAction))
    ) {
      throw new Error("Copy the exact contiguous player wording into ACTION; do not summarize or paraphrase it.");
    }
    if (operation.check && operation.explicitRoll !== undefined) {
      const escapedRoll = String(operation.explicitRoll).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const declaredRoll = new RegExp(
        `(?:實體骰(?:結果)?(?:是|為)?|骰(?:值|點|結果)(?:是|為)?|roll(?:ed| result)?|d100)\\s*[:=：]?\\s*${escapedRoll}(?!\\d)`,
        "iu",
      ).test(turn.playerInput);
      if (!declaredRoll) {
        throw new Error("Omit --roll for random d100; an explicit roll requires an unambiguous player-declared roll value.");
      }
    }
    const latestAction = turn.actionAdjudications.at(-1);
    if (operation.check && latestAction?.decision !== "accepted") {
      throw new Error("A check requires an accepted player action persisted earlier in the same turn.");
    }
    if (
      operation.mutation
      && operation.requiresAcceptedAction
      && !turn.setupMode
      && latestAction?.decision !== "accepted"
    ) {
      throw new Error("This gameplay mutation requires an accepted player action persisted earlier in the same turn.");
    }
    const result = await pi.exec(CLI_WRAPPER, ["--db", params.db, ...params.args], { signal });
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || `trpg-gm exited with code ${result.code}`);
    }
    activate();
    turn.dbPaths.add(params.db);
    turn.dbPaths.add(dbKey);
    const operationIndex = ++turn.operationIndex;
    if (operation.contextRoom) {
      const storyProgress = parseStoryProgress(result.stdout);
      if (!storyProgress) {
        throw new Error("Successful context omitted valid persistent story_progress fields.");
      }
      turn.contextLoaded = true;
      turn.contextRoom = operation.contextRoom;
      turn.contextDb = dbKey;
      turn.participation = parseParticipation(result.stdout);
      turn.storyProgress = storyProgress;
      turn.openingGuidanceRequired = storyProgress.openingGuidanceRequired;
    }
    if (operation.operationRoom) turn.operationRooms.add(operation.operationRoom);
    if (operation.characterProposal) {
      turn.characterProposals.push(parseCharacterProposal(result.stdout));
    }
    if (operation.characterGenerated) {
      turn.characterGenerations.push(parseCharacterGeneration(result.stdout));
      turn.openingGuidanceRequired = true;
    }
    if (operation.availability) {
      const participant = turn.participation?.find(
        (character) => character.characterId === operation.characterId,
      );
      if (participant) {
        try {
          const availability = JSON.parse(result.stdout);
          participant.canAct = availability.effective_can_act ?? operation.canAct;
          participant.unavailableReason = availability.unavailable_reason ?? null;
        } catch {
          participant.canAct = operation.canAct;
        }
      }
    }
    if (operation.resourceAdjustment && operation.resource === "hp") {
      const participant = turn.participation?.find(
        (character) => character.characterId === operation.characterId,
      );
      if (participant) {
        try {
          const character = JSON.parse(result.stdout);
          if (character.hp <= 0) {
            participant.canAct = false;
            participant.unavailableReason = "HP depleted";
          } else if (participant.unavailableReason?.startsWith("HP")) {
            participant.canAct = true;
            participant.unavailableReason = null;
          }
        } catch {
          // A successful resource adjustment normally returns the updated character.
        }
      }
    }
    if (operation.storyOperation) {
      let storyProgress = parseStoryProgress(result.stdout);
      if (!storyProgress) {
        throw new Error("Successful story progress operation returned invalid or omitted progress fields.");
      }
      if (operation.storyOperation === "objective") {
        const verification = await pi.exec(
          CLI_WRAPPER,
          ["--db", params.db, "context", operation.operationRoom],
          { signal },
        );
        if (verification.code !== 0) {
          throw new Error(verification.stderr || verification.stdout || "Failed to verify persisted story objective.");
        }
        storyProgress = parseStoryProgress(verification.stdout);
        if (!storyProgress) {
          throw new Error("Story objective verification context omitted valid persistent story_progress fields.");
        }
      }
      turn.storyProgress = storyProgress;
      turn.openingGuidanceRequired = storyProgress.openingGuidanceRequired;
      if (operation.storyOperation === "progress") turn.storyProgressRecorded = true;
      if (operation.storyOperation === "intervene") turn.storyInterventionPersisted = true;
    }
    if (operation.action) {
      turn.storyProgressRecorded = false;
      const adjudication = parseActionAdjudication(result.stdout);
      turn.actionAdjudications.push(adjudication);
      try {
        const rawAdjudication = JSON.parse(result.stdout);
        const countsAsParticipation = !rawAdjudication.availability_enforced
          && !rawAdjudication.enforced_guardrails;
        turn.actionNeedsProgress = countsAsParticipation
          && adjudication.decision === "accepted"
          && turn.storyProgress !== null;
        const participant = turn.participation?.find(
          (character) => character.characterId === adjudication.characterId,
        );
        if (countsAsParticipation && participant) participant.actionCount += 1;
      } catch {
        // parseActionAdjudication already validated the required persisted fields.
      }
      turn.latestActionIndex = operationIndex;
      turn.actionRulingAppended = false;
    }
    if (operation.check) {
      turn.checkReports.push(parseCheckReport(result.stdout));
      turn.checkOperationIndices.push(operationIndex);
      turn.checkReportAppended = false;
      turn.checkResolved = true;
    }
    if (operation.mutation && !operation.doesNotResolveAction) {
      turn.mutationOperationIndices.push(operationIndex);
    }
    if (operation.safeSetupMutation) {
      turn.safeSetupMutationOperationIndices.add(operationIndex);
    }
    turn.mutationPersisted ||= operation.mutation && !operation.doesNotResolveAction;
    turn.finalized = false;
    turn.playerFacingNarrativeValidated = false;
    return {
      content: [{ type: "text", text: result.stdout || "{}" }],
      details: { db: params.db, args: params.args, operation },
    };
  }

  pi.registerTool({
    name: "trpg_gm_cli",
    label: "TRPG GM CLI",
    description: "Run the persistent TRPG CLI with structured arguments. Exact gameplay forms: [\"context\",ROOM,\"--events\",N], [\"action\",\"adjudicate\",ROOM,CHARACTER,PLAYER_ACTION,\"--decision\",\"accepted|rejected\",\"--basis\",BASIS,\"--reason\",REASON], [\"check\",ROOM,CHARACTER,STAT] optionally followed by [\"--roll\",N], [\"entity\",ROOM,KIND,ID,NAME,\"--state\",JSON], [\"canon\",ROOM,KEY,VALUE,\"--source\",SOURCE], [\"character\",\"adjust\",ROOM,CHARACTER,RESOURCE,DELTA,\"--reason\",REASON], [\"character\",\"availability\",ROOM,CHARACTER,\"--can-act\",\"true|false\",\"--reason\",REASON], [\"recap\",\"save\",ROOM,\"--summary\",SUMMARY,\"--state\",JSON], and [\"events\",ROOM]. Copy the exact contiguous player wording into PLAYER_ACTION. JSON values must be one string token. There is no show/state/list/upsert/resolve subcommand. Put all positionals before options. Never use bash or direct SQLite for room state. Context includes participation and story-progress clocks plus immutable guardrails; matching guardrail terms force rejection, which cannot be replaced by another ruling in the same turn. Use story objective/progress/intervene commands; three stalled actions require a persisted intervention before another action.",
    promptSnippet: "Read or mutate persistent TRPG room state with verifiable structured CLI arguments",
    promptGuidelines: [
      "Use trpg_gm_cli instead of bash for every TRPG state command when the TRPG GM Guard is active.",
      "For new characters use creation configure, creation propose, then creation roll; do not bypass world-fit adjudication with character add.",
      "Read context guardrails every turn. Add scenario-grounded prohibitions with guardrail add and never attempt to redefine or bypass an existing guardrail.",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["db", "args"],
      properties: {
        db: { type: "string", description: "Absolute or workspace-relative room SQLite path" },
        args: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
          description: "CLI argument tokens after --db; do not include shell quoting",
        },
      },
    },
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      return executeCli(params, signal);
    },
  });

  const dbRoomProperties = {
    db: { type: "string", description: "Room database path" },
    room: { type: "string", description: "Exact room id" },
  };
  const registerTypedTool = (definition) => pi.registerTool({
    ...definition,
    executionMode: "sequential",
  });

  registerTypedTool({
    name: "trpg_gm_context",
    label: "TRPG Context",
    description: "Load the exact room context, participation priorities, and immutable guardrails. Use this first every gameplay turn; give eligible next_spotlight_character_ids equal opportunities and do not guess raw CLI tokens.",
    parameters: {
      type: "object", additionalProperties: false, required: ["db", "room"],
      properties: { ...dbRoomProperties, events: { type: "integer", minimum: 1, default: 20 } },
    },
    async execute(_id, params, signal) {
      const args = ["context", params.room];
      if (params.events !== undefined) args.push("--events", String(params.events));
      return executeCli({ db: params.db, args }, signal);
    },
  });

  registerTypedTool({
    name: "trpg_gm_action_adjudicate",
    label: "TRPG Action Adjudicate",
    description: "Persist exactly one ruling for the player's exact action text before checks or consequences.",
    parameters: {
      type: "object", additionalProperties: false,
      required: ["db", "room", "character", "action", "decision", "basis", "reason"],
      properties: {
        ...dbRoomProperties,
        character: { type: "string" },
        action: { type: "string", description: "Exact contiguous wording copied from player input" },
        decision: { type: "string", enum: ["accepted", "rejected"] },
        basis: { type: "string" }, reason: { type: "string" },
      },
    },
    async execute(_id, params, signal) {
      return executeCli({ db: params.db, args: [
        "action", "adjudicate", params.room, params.character, params.action,
        "--decision", params.decision, "--basis", params.basis, "--reason", params.reason,
      ] }, signal);
    },
  });

  registerTypedTool({
    name: "trpg_gm_check",
    label: "TRPG Check",
    description: "Resolve and persist a check. Omit roll for random d100; only pass roll when the player explicitly supplied it.",
    parameters: {
      type: "object", additionalProperties: false,
      required: ["db", "room", "character", "stat"],
      properties: {
        ...dbRoomProperties, character: { type: "string" }, stat: { type: "string" },
        roll: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    async execute(_id, params, signal) {
      const args = ["check", params.room, params.character, params.stat];
      if (params.roll !== undefined) args.push("--roll", String(params.roll));
      return executeCli({ db: params.db, args }, signal);
    },
  });

  registerTypedTool({
    name: "trpg_gm_entity_upsert",
    label: "TRPG Entity Upsert",
    description: "Merge a confirmed NPC, clue, quest, scene, item, or other entity state using typed fields.",
    parameters: {
      type: "object", additionalProperties: false,
      required: ["db", "room", "kind", "id", "name", "state"],
      properties: {
        ...dbRoomProperties, kind: { type: "string" }, id: { type: "string" },
        name: { type: "string" }, state: { type: "object", additionalProperties: true },
      },
    },
    async execute(_id, params, signal) {
      return executeCli({ db: params.db, args: [
        "entity", params.room, params.kind, params.id, params.name,
        "--state", JSON.stringify(params.state),
      ] }, signal);
    },
  });

  registerTypedTool({
    name: "trpg_gm_character_adjust",
    label: "TRPG Character Resource Adjust",
    description: "Persist an HP, MP, or SAN delta with an in-world reason.",
    parameters: {
      type: "object", additionalProperties: false,
      required: ["db", "room", "character", "resource", "delta", "reason"],
      properties: {
        ...dbRoomProperties, character: { type: "string" },
        resource: { type: "string", enum: ["hp", "mp", "san"] },
        delta: { type: "integer" }, reason: { type: "string" },
      },
    },
    async execute(_id, params, signal) {
      return executeCli({ db: params.db, args: [
        "character", "adjust", params.room, params.character, params.resource,
        String(params.delta), "--reason", params.reason,
      ] }, signal);
    },
  });

  registerTypedTool({
    name: "trpg_gm_character_availability",
    label: "TRPG Character Availability",
    description: "Persist whether a character can currently act. Use false only for an established incapacitating state, and restore true when that state ends.",
    parameters: {
      type: "object", additionalProperties: false,
      required: ["db", "room", "character", "canAct", "reason"],
      properties: {
        ...dbRoomProperties, character: { type: "string" },
        canAct: { type: "boolean" }, reason: { type: "string" },
      },
    },
    async execute(_id, params, signal) {
      return executeCli({ db: params.db, args: [
        "character", "availability", params.room, params.character,
        "--can-act", String(params.canAct), "--reason", params.reason,
      ] }, signal);
    },
  });

  registerTypedTool({
    name: "trpg_gm_story_objective",
    label: "TRPG Story Objective",
    description: "Persist the current chapter and concrete objective. After character generation, pass every pending opening character ID and cite each saved background or concept in reason before inviting the first action.",
    parameters: {
      type: "object", additionalProperties: false,
      required: ["db", "room", "chapter", "objective", "reason"],
      properties: {
        ...dbRoomProperties, chapter: { type: "string" },
        objective: { type: "string" }, reason: { type: "string" },
        openingCharacterIds: { type: "array", items: { type: "string" }, uniqueItems: true },
      },
    },
    async execute(_id, params, signal) {
      const args = [
        "story", "objective", params.room, "--chapter", params.chapter,
        "--objective", params.objective, "--reason", params.reason,
      ];
      if (params.openingCharacterIds !== undefined) {
        args.push("--opening-character-ids", JSON.stringify(params.openingCharacterIds));
      }
      return executeCli({ db: params.db, args }, signal);
    },
  });

  registerTypedTool({
    name: "trpg_gm_story_progress",
    label: "TRPG Story Progress",
    description: "After each countable player action, persist whether it advanced the current objective or stalled.",
    parameters: {
      type: "object", additionalProperties: false,
      required: ["db", "room", "status", "reason"],
      properties: {
        ...dbRoomProperties,
        status: { type: "string", enum: ["advanced", "stalled"] },
        reason: { type: "string" },
      },
    },
    async execute(_id, params, signal) {
      return executeCli({ db: params.db, args: [
        "story", "progress", params.room, "--status", params.status,
        "--reason", params.reason,
      ] }, signal);
    },
  });

  registerTypedTool({
    name: "trpg_gm_story_intervene",
    label: "TRPG Story Intervention",
    description: "After three stalled player actions, persist a concrete in-world event that directly changes the situation or scene without requiring the player to choose a prescribed option.",
    parameters: {
      type: "object", additionalProperties: false,
      required: ["db", "room", "event", "intendedProgress", "reason"],
      properties: {
        ...dbRoomProperties, event: { type: "string" },
        intendedProgress: { type: "string" }, reason: { type: "string" },
      },
    },
    async execute(_id, params, signal) {
      return executeCli({ db: params.db, args: [
        "story", "intervene", params.room, "--event", params.event,
        "--intended-progress", params.intendedProgress, "--reason", params.reason,
      ] }, signal);
    },
  });

  registerTypedTool({
    name: "trpg_gm_canon_set",
    label: "TRPG Canon Set",
    description: "Persist an immutable established fact. Do not use canon for mutable scene state or failed attempts.",
    parameters: {
      type: "object", additionalProperties: false,
      required: ["db", "room", "key", "value", "source"],
      properties: { ...dbRoomProperties, key: { type: "string" }, value: { type: "string" }, source: { type: "string" } },
    },
    async execute(_id, params, signal) {
      return executeCli({ db: params.db, args: [
        "canon", params.room, params.key, params.value, "--source", params.source,
      ] }, signal);
    },
  });

  registerTypedTool({
    name: "trpg_gm_recap_save",
    label: "TRPG Recap Save",
    description: "Save a player-safe recap only at campaign creation or a natural session break, never every turn.",
    parameters: {
      type: "object", additionalProperties: false,
      required: ["db", "room", "summary", "state"],
      properties: { ...dbRoomProperties, summary: { type: "string" }, state: { type: "object", additionalProperties: true } },
    },
    async execute(_id, params, signal) {
      return executeCli({ db: params.db, args: [
        "recap", "save", params.room, "--summary", params.summary,
        "--state", JSON.stringify(params.state),
      ] }, signal);
    },
  });

  pi.registerTool({
    name: "trpg_turn_finalize",
    label: "TRPG Turn Finalize",
    description: "Validate that the current TRPG GM turn loaded room context, persisted consequences, protected secrets, preserved player agency, and prepared rich novel-like world narration. Call after all trpg_gm_cli state commands and before the player-facing answer.",
    promptSnippet: "Finalize and validate a TRPG GM turn after all state writes",
    promptGuidelines: [
      "Call trpg_turn_finalize after all trpg_gm_cli commands and before every final player-facing TRPG response.",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["turnKind", "roomId", "playerActionStatus", "stateChanges", "secretsChecked", "playerAgencyChecked", "narrativeDetailChecked"],
      properties: {
        turnKind: {
          type: "string",
          enum: ["gameplay", "clarification"],
          description: "Use clarification only while asking the player for missing room or setup information",
        },
        roomId: { type: "string", description: "Exact room id, or an empty string when clarification is required" },
        playerActionStatus: {
          type: "string",
          enum: ["accepted", "rejected", "not_applicable"],
          description: "Accepted/rejected must match a persisted action adjudication; use not_applicable only when the player declared no in-world action",
        },
        noPlayerActionReason: {
          type: "string",
          description: "Required with playerActionStatus=not_applicable; explain why this turn contains no declared player action",
        },
        stateChanges: {
          type: "array",
          items: { type: "string" },
          description: "Player-safe descriptions of changes already persisted; never include secrets",
        },
        noStateChangeReason: {
          type: "string",
          description: "Why a resolved check produced no persistent change; omit when state changed",
        },
        nextSpotlightCharacterId: {
          type: "string",
          description: "When multiple characters can act, choose one of context.participation.next_spotlight_character_ids for the next meaningful decision prompt",
        },
        secretsChecked: { type: "boolean" },
        playerAgencyChecked: { type: "boolean" },
        narrativeDetailChecked: {
          type: "boolean",
          description: "For every accepted or rejected action, confirm the response includes at least a short novel-like player-visible passage rather than only a ruling summary and handoff; rejected actions must remain unperformed and cause no invented world change. Also confirm grounded space, objects, sensory atmosphere, NPC/world activity, and no invented player-character reaction; use true for a clarification with no narration",
        },
        eventDrivenTransitionChecked: {
          type: "boolean",
          description: "Required after trpg_gm_story_intervene: confirm any forced transition occurs directly through the persisted world event, does not require a prescribed player option, and returns an open-ended action prompt",
        },
      },
    },
    async execute(_toolCallId, params) {
      activate();
      if (!params.secretsChecked) {
        throw new Error("Confirm that the player-facing response contains no GM secrets.");
      }
      if (!params.playerAgencyChecked) {
        throw new Error("Confirm that the response does not make additional player-character decisions.");
      }
      if (!params.narrativeDetailChecked) {
        throw new Error("Confirm that every accepted or rejected action receives a detailed, grounded novel-like passage, never only a ruling summary and handoff, while remaining player-agency safe.");
      }
      if (turn.storyInterventionPersisted && !params.eventDrivenTransitionChecked) {
        throw new Error("Confirm that the forced transition happens through the persisted world event without requiring the player to choose a prescribed option.");
      }
      if (params.turnKind === "clarification") {
        if (params.playerActionStatus !== "not_applicable") {
          throw new Error("Clarification turns cannot accept or reject an in-world player action.");
        }
        if (!params.noPlayerActionReason?.trim()) {
          throw new Error("Clarification finalization requires noPlayerActionReason.");
        }
        if (turn.actionAdjudications.length > 0 || turn.checkResolved || turn.mutationPersisted || params.stateChanges.length > 0) {
          throw new Error("A turn with checks or persisted changes must finalize as gameplay, not clarification.");
        }
        if (!params.noStateChangeReason?.trim()) {
          throw new Error("Clarification finalization requires noStateChangeReason describing the missing player input.");
        }
        turn.finalized = true;
        return {
          content: [{ type: "text", text: "TRPG clarification turn validated. Ask only for the missing setup or room information." }],
          details: { turnKind: "clarification", reason: params.noStateChangeReason },
        };
      }
      if (!turn.contextLoaded || turn.contextRoom !== params.roomId) {
        throw new Error(`TRPG turn is not ready: run trpg-gm context for the exact room ${params.roomId}; last loaded room was ${turn.contextRoom ?? "none"}.`);
      }
      if (turn.openingGuidanceRequired) {
        throw new Error(
          "After character generation, persist a concrete story objective based on the character's story background before finalizing or accepting play.",
        );
      }
      if (turn.actionNeedsProgress && !turn.storyProgressRecorded) {
        throw new Error(
          "After every countable player action, record whether story progress advanced or stalled.",
        );
      }
      if (turn.storyProgress?.interventionRequired && !turn.storyInterventionPersisted) {
        throw new Error(
          "Three player actions have stalled; introduce and persist an in-world event that advances the chapter or objective.",
        );
      }
      const eligibleCount = turn.participation?.filter((character) => character.canAct).length ?? 0;
      if (eligibleCount > 1) {
        const priorities = nextSpotlightCharacterIds(turn.participation);
        if (!params.nextSpotlightCharacterId?.trim()) {
          throw new Error(`nextSpotlightCharacterId is required when multiple characters can act; prioritize: ${priorities.join(", ")}.`);
        }
        if (!priorities.includes(params.nextSpotlightCharacterId)) {
          throw new Error(`Next spotlight must prioritize one of: ${priorities.join(", ")}.`);
        }
      }
      const wrongOperationRooms = [...turn.operationRooms].filter((room) => room !== params.roomId);
      if (wrongOperationRooms.length > 0) {
        throw new Error(`TRPG turn mixed room ${params.roomId} with operations for: ${wrongOperationRooms.join(", ")}.`);
      }
      const latestAction = turn.actionAdjudications.at(-1);
      if (params.playerActionStatus === "not_applicable") {
        if (latestAction) {
          throw new Error("A persisted player action adjudication exists, so playerActionStatus cannot be not_applicable.");
        }
        if (!params.noPlayerActionReason?.trim()) {
          throw new Error("playerActionStatus=not_applicable requires noPlayerActionReason.");
        }
        if (turn.checkResolved) {
          throw new Error("A resolved check requires an accepted, persisted player action adjudication.");
        }
      } else {
        if (!latestAction) {
          throw new Error("Player action is missing a persisted action adjudication; run action adjudicate before resolving it.");
        }
        if (latestAction.decision !== params.playerActionStatus) {
          throw new Error(`Finalized player action status ${params.playerActionStatus} does not match persisted adjudication ${latestAction.decision}.`);
        }
        const earlierResolution = [...turn.checkOperationIndices, ...turn.mutationOperationIndices]
          .some((index) => index < turn.latestActionIndex);
        if (latestAction.decision === "accepted" && earlierResolution) {
          throw new Error("Accept and persist the player action before any check or world-state mutation; a later adjudication cannot authorize earlier resolution.");
        }
        const rejectedActionResolution = turn.checkOperationIndices.length > 0
          || turn.mutationOperationIndices.some((index) =>
            index > turn.latestActionIndex
              || !turn.safeSetupMutationOperationIndices.has(index));
        if (latestAction.decision === "rejected" && rejectedActionResolution) {
          throw new Error("A rejected player action must not produce a check or persistent world-state mutation; only guardrail setup completed before adjudication is exempt.");
        }
      }
      if (params.stateChanges.length > 0 && !turn.mutationPersisted) {
        throw new Error("TRPG turn declares a state change but no successful state mutation was observed; save it before finalizing.");
      }
      if (turn.checkResolved && !turn.mutationPersisted && !params.noStateChangeReason?.trim()) {
        throw new Error("A check was resolved without a persisted state change; save its consequence or provide noStateChangeReason.");
      }
      turn.finalized = true;
      turn.playerFacingNarrativeValidated = false;
      return {
        content: [{ type: "text", text: `TRPG turn validated for room ${params.roomId}. You may now give the player-facing response.` }],
        details: {
          turnKind: "gameplay",
          roomId: params.roomId,
          contextLoaded: turn.contextLoaded,
          checkResolved: turn.checkResolved,
          mutationPersisted: turn.mutationPersisted,
          stateChanges: params.stateChanges,
          characterProposals: turn.characterProposals,
          characterGenerations: turn.characterGenerations,
          actionAdjudications: turn.actionAdjudications,
          checkReports: turn.checkReports,
        },
      };
    },
  });

  pi.on("message_end", async (event) => {
    if (!active || event.message.role !== "assistant") return undefined;
    if (turn.playerFacingNarrativeValidated) return undefined;
    const originalContent = Array.isArray(event.message.content)
      ? event.message.content
      : [{ type: "text", text: String(event.message.content ?? "") }];
    const hasToolCall = originalContent.some((part) =>
      ["toolCall", "tool_call"].includes(part.type));
    if (!turn.finalized) {
      if (hasToolCall) return undefined;
      return {
        message: {
          ...event.message,
          content: [{
            type: "text",
            text: "[TRPG GM Guard] Player-facing response blocked: this turn is not finalized. Load context, persist the action ruling and consequences, then call trpg_turn_finalize.",
          }],
        },
      };
    }
    const originalText = originalContent
      .filter((part) => part.type === "text")
      .map((part) => String(part.text ?? ""))
      .join("\n");
    if (turn.actionAdjudications.length > 0 && !hasNovelLikeActionPassage(originalText)) {
      turn.finalized = false;
      turn.reminderSent = false;
      return {
        message: {
          ...event.message,
          content: [{
            type: "text",
            text: "[TRPG GM Guard] Player-facing action response blocked: add at least a short grounded novel-like passage before the ruling and handoff. For a rejected action, describe only the established obstacle or unchanged player-visible scene; do not make the rejected action occur.",
          }],
        },
      };
    }
    const actionForNarration = turn.actionAdjudications.at(-1);
    if (actionForNarration?.decision === "rejected"
        && repeatsRejectedActionLiteral(originalText, actionForNarration.action)) {
      turn.finalized = false;
      turn.reminderSent = false;
      return {
        message: {
          ...event.message,
          content: [{
            type: "text",
            text: "[TRPG GM Guard] Player-facing response blocked: do not replay the rejected action as completed fiction. Narrate only the established obstacle or unchanged player-visible scene; the guard will append the exact rejected ruling separately.",
          }],
        },
      };
    }
    turn.playerFacingNarrativeValidated = true;
    const blocks = [];
    const pendingProposals = turn.characterProposals
      .slice(turn.characterProposalReportsAppended)
      .filter((proposal) => proposal.decision === "rejected");
    for (const proposal of pendingProposals) {
      blocks.push([
        "**角色提案裁定：不允許**",
        `- 角色：${proposal.name}（${proposal.characterId}）`,
        `- 概念：${proposal.concept}`,
        `- 技能：${proposal.skills.join("、")}`,
        `- 原因：${proposal.reason}`,
        `- 依據：${proposal.basis}`,
      ].join("\n"));
    }
    turn.characterProposalReportsAppended = turn.characterProposals.length;

    const pendingGenerations = turn.characterGenerations
      .slice(turn.characterGenerationReportsAppended);
    for (const generation of pendingGenerations) {
      const skillLines = Object.entries(generation.stats).map(([skill, value]) =>
        `- ${skill}：roll ${generation.skillRolls[skill]} → ${value}`);
      const resourceLines = ["hp", "mp", "san"].map((resource) =>
        `- ${resource.toUpperCase()} 上限：roll ${generation.resourceRolls[resource]} → ${generation.maxima[resource]}`);
      blocks.push([
        `**角色生成結果：${generation.name}（${generation.characterId}）**`,
        ...skillLines,
        ...resourceLines,
      ].join("\n"));
    }
    turn.characterGenerationReportsAppended = turn.characterGenerations.length;
    const latestAction = turn.actionAdjudications.at(-1);
    if (latestAction?.decision === "rejected" && !turn.actionRulingAppended) {
      blocks.push([
        "**行動裁定：不允許**",
        `- 行動：${latestAction.action}`,
        `- 原因：${latestAction.reason}`,
        `- 依據：${latestAction.basis}`,
      ].join("\n"));
      turn.actionRulingAppended = true;
    }
    if (turn.checkReports.length > 0 && !turn.checkReportAppended) {
      blocks.push(`**判定結果**\n${turn.checkReports.map(formatCheckReport).join("\n")}`);
      turn.checkReportAppended = true;
    }
    if (blocks.length === 0) return undefined;

    const content = Array.isArray(event.message.content)
      ? [...event.message.content]
      : [{ type: "text", text: String(event.message.content ?? "") }];
    content.push({ type: "text", text: `\n\n${blocks.join("\n\n")}` });
    return { message: { ...event.message, content } };
  });

  pi.on("agent_settled", async () => {
    if (!active || turn.finalized || turn.reminderSent) return;
    const missing = [];
    if (!turn.contextLoaded) missing.push("load the exact room with trpg-gm context, or use turnKind=clarification if required room/setup input is still missing");
    missing.push("call trpg_turn_finalize before ending the TRPG turn");
    turn.reminderSent = true;
    pi.sendMessage(
      {
        customType: "trpg-gm-guard",
        content: `TRPG GM turn is incomplete: ${missing.join("; ")}. Complete these steps now, persist any omitted state, then provide the corrected player-facing response.`,
        display: true,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  });
}
