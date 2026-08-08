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

export function shouldActivateFromText(text) {
  return ACTIVATION_PATTERN.test(text ?? "");
}

function classifyCliArgs(args) {
  if (args.includes("--help") || args.includes("-h")) {
    return { contextRoom: null, operationRoom: null, check: false, mutation: false };
  }
  const [command, actionOrRoom, maybeRoom] = args;
  if (command === "context") return { contextRoom: actionOrRoom, operationRoom: null, check: false, mutation: false };
  if (command === "check") return { contextRoom: null, operationRoom: actionOrRoom, check: true, mutation: false };
  if (["canon", "entity"].includes(command)) {
    return { contextRoom: null, operationRoom: actionOrRoom, check: false, mutation: true };
  }
  if (command === "room" && actionOrRoom === "create") {
    return { contextRoom: null, operationRoom: maybeRoom, check: false, mutation: true };
  }
  if (command === "character" && ["add", "adjust"].includes(actionOrRoom)) {
    return { contextRoom: null, operationRoom: maybeRoom, check: false, mutation: true };
  }
  if (command === "recap" && actionOrRoom === "save") {
    return { contextRoom: null, operationRoom: maybeRoom, check: false, mutation: true };
  }
  return { contextRoom: null, operationRoom: null, check: false, mutation: false };
}

function freshTurn() {
  return {
    contextLoaded: false,
    contextRoom: null,
    operationRooms: new Set(),
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
    "8. Every resolved check must be reported to the player. The guard appends a canonical 判定結果 block with character, stat, degree, roll, and target to the finalized answer.",
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
    description: "Run the repository's persistent TRPG CLI with structured arguments. In Pi gameplay, use this instead of bash so the guard can verify each successful room operation. Pass CLI tokens after --db as args, for example [\"context\",\"room-a\"] or [\"entity\",\"room-a\",\"clue\",\"c1\",\"線索\",\"--state\",\"{\\\"status\\\":\\\"discovered\\\"}\"].",
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
      if (operation.contextRoom) {
        turn.contextLoaded = true;
        turn.contextRoom = operation.contextRoom;
      }
      if (operation.operationRoom) turn.operationRooms.add(operation.operationRoom);
      if (operation.check) {
        turn.checkReports.push(parseCheckReport(result.stdout));
        turn.checkResolved = true;
      }
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
      required: ["turnKind", "roomId", "stateChanges", "secretsChecked", "playerAgencyChecked"],
      properties: {
        turnKind: {
          type: "string",
          enum: ["gameplay", "clarification"],
          description: "Use clarification only while asking the player for missing room or setup information",
        },
        roomId: { type: "string", description: "Exact room id, or an empty string when clarification is required" },
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
        if (turn.checkResolved || turn.mutationPersisted || params.stateChanges.length > 0) {
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
          checkReports: turn.checkReports,
        },
      };
    },
  });

  pi.on("message_end", async (event) => {
    if (!active || !turn.finalized || turn.checkReportAppended) return undefined;
    if (event.message.role !== "assistant" || turn.checkReports.length === 0) return undefined;

    const block = `**判定結果**\n${turn.checkReports.map(formatCheckReport).join("\n")}`;
    const content = Array.isArray(event.message.content)
      ? [...event.message.content]
      : [{ type: "text", text: String(event.message.content ?? "") }];
    content.push({ type: "text", text: `\n\n${block}` });
    turn.checkReportAppended = true;
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
