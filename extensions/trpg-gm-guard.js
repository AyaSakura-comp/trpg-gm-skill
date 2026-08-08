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

function classifyCliArgs(args) {
  if (args.includes("--help") || args.includes("-h")) {
    return { contextRoom: null, operationRoom: null, action: false, check: false, mutation: false };
  }
  const [command, actionOrRoom, maybeRoom] = args;
  if (command === "context") return { contextRoom: actionOrRoom, operationRoom: null, action: false, check: false, mutation: false };
  if (command === "action" && actionOrRoom === "adjudicate") {
    return { contextRoom: null, operationRoom: maybeRoom, action: true, check: false, mutation: false };
  }
  if (command === "check") return { contextRoom: null, operationRoom: actionOrRoom, action: false, check: true, mutation: false };
  if (["canon", "entity"].includes(command)) {
    return { contextRoom: null, operationRoom: actionOrRoom, action: false, check: false, mutation: true };
  }
  if (command === "room" && actionOrRoom === "create") {
    return { contextRoom: null, operationRoom: maybeRoom, action: false, check: false, mutation: true };
  }
  if (command === "character" && ["add", "adjust"].includes(actionOrRoom)) {
    return { contextRoom: null, operationRoom: maybeRoom, action: false, check: false, mutation: true };
  }
  if (command === "recap" && actionOrRoom === "save") {
    return { contextRoom: null, operationRoom: maybeRoom, action: false, check: false, mutation: true };
  }
  return { contextRoom: null, operationRoom: null, action: false, check: false, mutation: false };
}

function freshTurn() {
  return {
    contextLoaded: false,
    contextRoom: null,
    operationRooms: new Set(),
    operationIndex: 0,
    latestActionIndex: null,
    checkOperationIndices: [],
    mutationOperationIndices: [],
    actionAdjudications: [],
    actionRulingAppended: false,
    checkResolved: false,
    checkReports: [],
    checkReportAppended: false,
    mutationPersisted: false,
    finalized: false,
    reminderSent: false,
  };
}

function checklist() {
  return [
    "[TRPG GM Guard — mandatory for this turn]",
    "1. Before player-facing narration, use trpg_gm_cli to load context for the exact room and DB.",
    "2. In Pi, use structured trpg_gm_cli calls instead of bash for every TRPG state operation.",
    "3. Persist every confirmed consequence, discovered clue, NPC/quest/scene change, and HP/MP/SAN change before narrating it.",
    "4. Never expose secrets or make additional decisions for the player character.",
    "5. After all state commands finish, call trpg_turn_finalize in a separate tool round before the final player-facing answer.",
    "6. Use turnKind=clarification only when you must ask for a missing room/setup choice before gameplay; otherwise use gameplay.",
    "7. If a check caused no persistent change, explain why in noStateChangeReason; never use that field to avoid saving a discovered clue.",
    "8. Before resolving a declared player action, adjudicate it with trpg_gm_cli action adjudicate against the script, canon, rules, and established state. Reject unsupported or impossible actions with a concrete basis and reason; do not roll or mutate state for a rejected action.",
    "9. Every resolved check must be reported to the player. The guard appends a canonical 判定結果 block with character, stat, degree, roll, and target to the finalized answer.",
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
    if (active || shouldActivateFromText(event.text)) {
      activate();
      turn = freshTurn();
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (!active && (shouldActivateFromText(event.prompt) || event.prompt?.includes(SKILL_MARKER))) {
      activate();
      turn = freshTurn();
    }
    if (!active) return undefined;
    return {
      message: {
        customType: "trpg-gm-guard",
        content: checklist(),
        display: true,
      },
    };
  });

  pi.registerTool({
    name: "trpg_gm_cli",
    label: "TRPG GM CLI",
    description: "Run the repository's persistent TRPG CLI with structured arguments. In Pi gameplay, use this instead of bash so the guard can verify each successful room operation. Before resolving a player's in-world action, call action adjudicate with accepted/rejected, basis, and reason. Pass CLI tokens after --db as args, for example [\"context\",\"room-a\"] or [\"action\",\"adjudicate\",\"room-a\",\"pc\",\"調查門縫\",\"--decision\",\"accepted\",\"--basis\",\"目前場景允許接近門口\",\"--reason\",\"角色具備一般調查能力\"].",
    promptSnippet: "Read or mutate persistent TRPG room state with verifiable structured CLI arguments",
    promptGuidelines: [
      "Use trpg_gm_cli instead of bash for every TRPG state command when the TRPG GM Guard is active.",
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
      const result = await pi.exec(CLI_WRAPPER, ["--db", params.db, ...params.args], { signal });
      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || `trpg-gm exited with code ${result.code}`);
      }
      activate();
      const operation = classifyCliArgs(params.args);
      const operationIndex = ++turn.operationIndex;
      if (operation.contextRoom) {
        turn.contextLoaded = true;
        turn.contextRoom = operation.contextRoom;
      }
      if (operation.operationRoom) turn.operationRooms.add(operation.operationRoom);
      if (operation.action) {
        turn.actionAdjudications.push(parseActionAdjudication(result.stdout));
        turn.latestActionIndex = operationIndex;
        turn.actionRulingAppended = false;
      }
      if (operation.check) {
        turn.checkReports.push(parseCheckReport(result.stdout));
        turn.checkOperationIndices.push(operationIndex);
        turn.checkReportAppended = false;
        turn.checkResolved = true;
      }
      if (operation.mutation) turn.mutationOperationIndices.push(operationIndex);
      turn.mutationPersisted ||= operation.mutation;
      turn.finalized = false;
      return {
        content: [{ type: "text", text: result.stdout || "{}" }],
        details: { db: params.db, args: params.args, operation },
      };
    },
  });

  pi.registerTool({
    name: "trpg_turn_finalize",
    label: "TRPG Turn Finalize",
    description: "Validate that the current TRPG GM turn loaded room context, persisted consequences, protected secrets, and preserved player agency. Call after all trpg_gm_cli state commands and before the player-facing answer.",
    promptSnippet: "Finalize and validate a TRPG GM turn after all state writes",
    promptGuidelines: [
      "Call trpg_turn_finalize after all trpg_gm_cli commands and before every final player-facing TRPG response.",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["turnKind", "roomId", "playerActionStatus", "stateChanges", "secretsChecked", "playerAgencyChecked"],
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
        secretsChecked: { type: "boolean" },
        playerAgencyChecked: { type: "boolean" },
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
        if (latestAction.decision === "rejected" && (turn.checkResolved || turn.mutationPersisted)) {
          throw new Error("A rejected player action must not produce a check or persistent world-state mutation.");
        }
      }
      if (params.stateChanges.length > 0 && !turn.mutationPersisted) {
        throw new Error("TRPG turn declares a state change but no successful state mutation was observed; save it before finalizing.");
      }
      if (turn.checkResolved && !turn.mutationPersisted && !params.noStateChangeReason?.trim()) {
        throw new Error("A check was resolved without a persisted state change; save its consequence or provide noStateChangeReason.");
      }
      turn.finalized = true;
      return {
        content: [{ type: "text", text: `TRPG turn validated for room ${params.roomId}. You may now give the player-facing response.` }],
        details: {
          turnKind: "gameplay",
          roomId: params.roomId,
          contextLoaded: turn.contextLoaded,
          checkResolved: turn.checkResolved,
          mutationPersisted: turn.mutationPersisted,
          stateChanges: params.stateChanges,
          actionAdjudications: turn.actionAdjudications,
          checkReports: turn.checkReports,
        },
      };
    },
  });

  pi.on("message_end", async (event) => {
    if (!active || !turn.finalized || event.message.role !== "assistant") return undefined;
    const blocks = [];
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
