import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import trpgGuard, { shouldActivateFromText } from "../extensions/trpg-gm-guard.js";

function createFakePi() {
  const handlers = new Map();
  const tools = new Map();
  const messages = [];
  const entries = [];
  const execCalls = [];
  return {
    handlers,
    tools,
    messages,
    entries,
    execCalls,
    execResult: { code: 0, stdout: '{"ok":true}', stderr: "", killed: false },
    async exec(command, args) {
      execCalls.push({ command, args });
      const result = this.execResult;
      if (args.includes("context") && !this.preserveMalformedContext && result.code === 0) {
        try {
          const value = JSON.parse(result.stdout);
          if (!value.story_progress) {
            value.story_progress = {
              chapter: "目前章節",
              objective: "推進目前場景目標",
              opening_guidance_required: false,
              opening_character_ids: [],
              stagnant_action_count: 0,
              intervention_required: false,
            };
            return { ...result, stdout: JSON.stringify(value) };
          }
        } catch {
          // Tests that need malformed context set preserveMalformedContext.
        }
      }
      return result;
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    sendMessage(message, options) {
      messages.push({ message, options });
    },
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data });
    },
  };
}

const context = (entries = []) => ({
  sessionManager: { getEntries: () => entries },
  ui: { notify() {} },
});

const runCli = async (pi, args, db = "/tmp/game.sqlite3") => {
  const original = pi.execResult;
  if (args[0] === "check" && original.stdout === '{"ok":true}') {
    pi.execResult = {
      ...original,
      stdout: JSON.stringify({
        character_id: args[2],
        stat: args[3],
        roll: 20,
        target: 60,
        degree: "hard",
      }),
    };
  }
  try {
    return await pi.tools.get("trpg_gm_cli").execute("cli-call", { db, args });
  } finally {
    pi.execResult = original;
  }
};

const runAction = async (pi, {
  roomId = "room-a",
  characterId = "pc",
  action = "調查門縫",
  decision = "accepted",
  basis = "目前場景允許角色接近並調查這扇門",
  reason = "角色具備執行此行動所需的一般能力",
  db,
} = {}) => {
  const original = pi.execResult;
  pi.execResult = {
    code: 0,
    stdout: JSON.stringify({
      character_id: characterId,
      action,
      decision,
      basis,
      reason,
    }),
    stderr: "",
    killed: false,
  };
  try {
    return await runCli(pi, [
      "action", "adjudicate", roomId, characterId, action,
      "--decision", decision, "--basis", basis, "--reason", reason,
    ], db);
  } finally {
    pi.execResult = original;
  }
};

const runProgress = async (pi, db = null, status = "advanced") => {
  const original = pi.execResult;
  const progressDb = db ?? pi.execCalls.find((call) => call.args.includes("context"))?.args[1] ?? "/tmp/game.db";
  pi.execResult = { code: 0, stdout: JSON.stringify({
    chapter: "目前章節", objective: "推進目前場景目標",
    opening_guidance_required: false, opening_character_ids: [],
    stagnant_action_count: status === "stalled" ? 1 : 0,
    intervention_required: false,
  }), stderr: "", killed: false };
  try {
    return await pi.tools.get("trpg_gm_story_progress").execute("progress", {
      db: progressDb, room: "room-a", status, reason: "測試中記錄本次 action 的劇情推進",
    });
  } finally {
    pi.execResult = original;
  }
};

test("package manifest exposes both the Pi skill and extension", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  assert.deepEqual(manifest.pi.skills, ["./.agents/skills/trpg-gm"]);
  assert.deepEqual(manifest.pi.extensions, ["./extensions/trpg-gm-guard.js"]);
});

test("skill protocol requires player-facing reports for every check", async () => {
  const skill = await readFile(new URL("../.agents/skills/trpg-gm/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /每次判定結果/);
  assert.match(skill, /roll/);
  assert.match(skill, /目標值/);
  assert.match(skill, /成功等級/);
  assert.match(skill, /其他玩家角色.*說話|不得替.*其他.*玩家角色.*說話/s);
});

test("skill protocol requires novel-like detailed world narration", async () => {
  const skill = await readFile(new URL("../.agents/skills/trpg-gm/SKILL.md", import.meta.url), "utf8");
  const protocol = await readFile(new URL("../.agents/skills/trpg-gm/references/GM_PROTOCOL.md", import.meta.url), "utf8");
  const guidance = skill + protocol;
  assert.match(guidance, /小說/);
  assert.match(guidance, /感官|視覺.*聲音.*氣味/s);
  assert.match(guidance, /空間|位置/);
  assert.match(guidance, /場景.*變化|事物.*發生/s);
  assert.match(guidance, /不得.*玩家角色.*反應|不可.*玩家角色.*反應/s);
});

test("finalizer requires an explicit detailed-narration confirmation", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const finalizer = pi.tools.get("trpg_turn_finalize");
  assert.ok(finalizer.parameters.required.includes("narrativeDetailChecked"));
  assert.equal(finalizer.parameters.properties.narrativeDetailChecked.type, "boolean");
  const baseParams = {
    turnKind: "gameplay",
    roomId: "room-a",
    playerActionStatus: "not_applicable",
    noPlayerActionReason: "場景建立，尚無玩家行動",
    stateChanges: [],
    secretsChecked: true,
    playerAgencyChecked: true,
  };
  await assert.rejects(
    () => finalizer.execute("missing-detail-check", baseParams),
    /detailed|detail|詳細|小說/i,
  );
  await assert.rejects(
    () => finalizer.execute("detail-check", {
      ...baseParams,
      narrativeDetailChecked: false,
    }),
    /detailed|detail|詳細|小說/i,
  );
});

test("skill protocol requires persisted action adjudication outside the prompt", async () => {
  const skill = await readFile(new URL("../.agents/skills/trpg-gm/SKILL.md", import.meta.url), "utf8");
  const cliReference = await readFile(new URL("../.agents/skills/trpg-gm/references/CLI.md", import.meta.url), "utf8");
  assert.match(skill, /action adjudicate/);
  assert.match(skill, /拒絕.*原因/);
  assert.match(cliReference, /action adjudicate/);
  assert.match(cliReference, /action_adjudicated/);
});

test("skill protocol documents persistent world-aware character creation", async () => {
  const skill = await readFile(new URL("../.agents/skills/trpg-gm/SKILL.md", import.meta.url), "utf8");
  const cliReference = await readFile(new URL("../.agents/skills/trpg-gm/references/CLI.md", import.meta.url), "utf8");
  for (const phrase of ["creation configure", "creation propose", "creation roll", "外觀", "recommended_skills", "max_party_difference"]) {
    assert.match(skill + cliReference, new RegExp(phrase));
  }
  assert.match(skill, /玩家.*決定.*技能|技能.*玩家.*決定/);
  assert.match(skill, /不符合.*世界觀.*拒絕|拒絕.*不符合.*世界觀/);
});

test("skill protocol requires immutable persistent guardrails before adversarial play", async () => {
  const skill = await readFile(new URL("../.agents/skills/trpg-gm/SKILL.md", import.meta.url), "utf8");
  const cliReference = await readFile(new URL("../.agents/skills/trpg-gm/references/CLI.md", import.meta.url), "utf8");
  for (const phrase of ["guardrail add", "forbidden_terms", "不可覆寫", "context", "同一回合只能保存一次行動裁定"]) {
    assert.match(skill + cliReference, new RegExp(phrase));
  }
});

test("skill gives Pi exact structured tool calls and action decision enum", async () => {
  const skill = await readFile(new URL("../.agents/skills/trpg-gm/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /Pi 結構化工具速查/);
  assert.match(skill, /decision.*只能.*accepted.*rejected/s);
  assert.match(skill, /JSON.*args.*單一字串/s);
  assert.match(skill, /不存在.*show.*state.*list.*upsert.*resolve/s);
  assert.match(skill, /不要每回合.*recap|recap.*不是每回合/s);
  for (const tool of ["trpg_gm_context", "trpg_gm_action_adjudicate", "trpg_gm_check", "trpg_gm_entity_upsert"]) {
    assert.match(skill, new RegExp(tool));
  }
});

test("skill requires persistent equal spotlight for every eligible player", async () => {
  const skill = await readFile(new URL("../.agents/skills/trpg-gm/SKILL.md", import.meta.url), "utf8");
  for (const phrase of ["context.participation", "next_spotlight_character_ids", "平等", "無法行動"] ) {
    assert.match(skill, new RegExp(phrase));
  }
});

test("finalizer requires progress assessment and forced intervention after three stalled actions", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "我再次搜索大廳", source: "interactive" }, ctx,
  );
  pi.execResult = { code: 0, stdout: JSON.stringify({
    participation: { characters: [{ character_id: "alice", can_act: true, action_count: 2 }] },
    story_progress: {
      chapter: "第一章", objective: "找到地下室入口",
      opening_guidance_required: false, opening_character_ids: [],
      stagnant_action_count: 2, intervention_required: false,
    },
  }), stderr: "", killed: false };
  await pi.tools.get("trpg_gm_context").execute("context", {
    db: "/tmp/game.db", room: "room-a",
  });
  await runAction(pi, {
    characterId: "alice", action: "我再次搜索大廳", db: "/tmp/game.db",
  });

  await assert.rejects(
    pi.tools.get("trpg_turn_finalize").execute("finalize", {
      turnKind: "gameplay", roomId: "room-a", playerActionStatus: "accepted",
      stateChanges: [], secretsChecked: true, playerAgencyChecked: true, narrativeDetailChecked: true,
    }),
    /record whether.*advanced or stalled/i,
  );

  pi.execResult = { code: 0, stdout: JSON.stringify({
    chapter: "第一章", objective: "找到地下室入口",
    opening_guidance_required: false, opening_character_ids: [],
    stagnant_action_count: 3, intervention_required: true,
  }), stderr: "", killed: false };
  await pi.tools.get("trpg_gm_story_progress").execute("progress", {
    db: "/tmp/game.db", room: "room-a", status: "stalled",
    reason: "仍然沒有新線索",
  });
  await assert.rejects(
    pi.tools.get("trpg_turn_finalize").execute("finalize", {
      turnKind: "gameplay", roomId: "room-a", playerActionStatus: "accepted",
      stateChanges: [], secretsChecked: true, playerAgencyChecked: true, narrativeDetailChecked: true,
    }),
    /introduce.*event/i,
  );

  pi.execResult = { code: 0, stdout: JSON.stringify({
    chapter: "第一章", objective: "找到地下室入口",
    opening_guidance_required: false, opening_character_ids: [],
    stagnant_action_count: 0, intervention_required: false,
  }), stderr: "", killed: false };
  await pi.tools.get("trpg_gm_story_intervene").execute("intervene", {
    db: "/tmp/game.db", room: "room-a",
    event: "地下室傳出撞擊聲，暗門打開",
    intendedProgress: "引導玩家前往地下室",
    reason: "三次玩家行動未推進劇情",
  });
  await pi.tools.get("trpg_turn_finalize").execute("finalize", {
    turnKind: "gameplay", roomId: "room-a", playerActionStatus: "accepted",
    stateChanges: ["地下室暗門已由突發事件打開"],
    secretsChecked: true, playerAgencyChecked: true, narrativeDetailChecked: true,
  });
});

test("progress recorded before the current action cannot assess that new action", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "我檢查剛出現的暗門", source: "interactive" }, ctx,
  );
  pi.execResult = { code: 0, stdout: JSON.stringify({
    participation: { characters: [{ character_id: "alice", can_act: true, action_count: 1 }] },
    story_progress: {
      chapter: "第一章", objective: "找到入口",
      opening_guidance_required: false, opening_character_ids: [],
      stagnant_action_count: 0, intervention_required: false,
    },
  }), stderr: "", killed: false };
  await pi.tools.get("trpg_gm_context").execute("context", {
    db: "/tmp/game.db", room: "room-a",
  });
  await pi.tools.get("trpg_gm_story_progress").execute("old-progress", {
    db: "/tmp/game.db", room: "room-a", status: "advanced", reason: "上一個 action 已推進",
  });
  await runAction(pi, {
    characterId: "alice", action: "我檢查剛出現的暗門", db: "/tmp/game.db",
  });

  await assert.rejects(
    pi.tools.get("trpg_turn_finalize").execute("finalize", {
      turnKind: "gameplay", roomId: "room-a", playerActionStatus: "accepted",
      stateChanges: [], secretsChecked: true, playerAgencyChecked: true, narrativeDetailChecked: true,
    }),
    /record whether.*advanced or stalled/i,
  );
});

test("context rejects missing persistent story progress", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "繼續 TRPG", source: "interactive" }, ctx,
  );
  pi.preserveMalformedContext = true;
  pi.execResult = { code: 0, stdout: JSON.stringify({
    participation: { characters: [] },
  }), stderr: "", killed: false };

  await assert.rejects(
    pi.tools.get("trpg_gm_context").execute("context", {
      db: "/tmp/game.db", room: "room-a",
    }),
    /context.*story_progress|story progress.*context/i,
  );
});

test("story progress tools reject malformed successful CLI output", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "更新劇情進度", source: "interactive" }, ctx,
  );
  pi.execResult = { code: 0, stdout: JSON.stringify({
    participation: { characters: [] },
    story_progress: {
      chapter: "第一章", objective: "找到入口",
      opening_guidance_required: false, opening_character_ids: [],
      stagnant_action_count: 0, intervention_required: false,
    },
  }), stderr: "", killed: false };
  await pi.tools.get("trpg_gm_context").execute("context", {
    db: "/tmp/game.db", room: "room-a",
  });
  for (const stdout of [
    '{"ok":true}',
    '{"objective":"找到入口"}',
    '{"chapter":"第一章","objective":"找到入口","stagnant_action_count":-1,"intervention_required":false}',
    '{"chapter":"第一章","objective":"找到入口","stagnant_action_count":1.5,"intervention_required":false}',
    '{"chapter":"第一章","objective":"找到入口","stagnant_action_count":3}',
    '{"chapter":"第一章","objective":"找到入口","stagnant_action_count":3,"intervention_required":false}',
    '{"chapter":"第一章","objective":"找到入口","stagnant_action_count":2,"intervention_required":true}',
  ]) {
    pi.execResult = { code: 0, stdout, stderr: "", killed: false };
    await assert.rejects(
      pi.tools.get("trpg_gm_story_progress").execute("progress", {
        db: "/tmp/game.db", room: "room-a", status: "advanced", reason: "找到入口",
      }),
      /story progress.*invalid|omitted/i,
    );
  }
});

test("structured CLI tool description teaches action enum and exact player text", () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const description = pi.tools.get("trpg_gm_cli").description;
  assert.match(description, /accepted.*rejected/s);
  assert.match(description, /exact.*player.*wording/i);
  assert.match(description, /entity.*ROOM.*KIND.*ID.*NAME/s);
});

test("dedicated gameplay tools expose typed parameters instead of raw CLI tokens", () => {
  const pi = createFakePi();
  trpgGuard(pi);
  for (const name of [
    "trpg_gm_context", "trpg_gm_action_adjudicate", "trpg_gm_check",
    "trpg_gm_entity_upsert", "trpg_gm_character_adjust", "trpg_gm_canon_set",
    "trpg_gm_recap_save", "trpg_gm_character_availability",
    "trpg_gm_story_objective", "trpg_gm_story_progress", "trpg_gm_story_intervene",
  ]) {
    assert.ok(pi.tools.has(name), `${name} must be registered`);
  }
  assert.deepEqual(
    pi.tools.get("trpg_gm_action_adjudicate").parameters.properties.decision.enum,
    ["accepted", "rejected"],
  );
  assert.equal(
    pi.tools.get("trpg_gm_entity_upsert").parameters.properties.state.type,
    "object",
  );
  assert.equal(
    pi.tools.get("trpg_gm_character_availability").parameters.properties.canAct.type,
    "boolean",
  );
});

test("character availability typed tool persists inability to act", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "我衝過去但被落石壓住", source: "interactive" },
    ctx,
  );
  await pi.tools.get("trpg_gm_context").execute("context", {
    db: "/tmp/game.db", room: "room-a",
  });
  await runAction(pi, { action: "我衝過去但被落石壓住", db: "/tmp/game.db" });
  pi.execResult = { code: 0, stdout: '{"character_id":"pc","can_act":false,"reason":"被落石壓住"}', stderr: "", killed: false };

  await pi.tools.get("trpg_gm_character_availability").execute("availability", {
    db: "/tmp/game.db", room: "room-a", character: "pc",
    canAct: false, reason: "被落石壓住",
  });

  assert.deepEqual(pi.execCalls.at(-1).args.slice(2), [
    "character", "availability", "room-a", "pc",
    "--can-act", "false", "--reason", "被落石壓住",
  ]);
});

test("character availability can be restored after context without another action", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "角色在自然恢復階段甦醒", source: "interactive" },
    ctx,
  );
  await pi.tools.get("trpg_gm_context").execute("context", {
    db: "/tmp/game.db", room: "room-a",
  });
  pi.execResult = { code: 0, stdout: '{"character_id":"pc","can_act":true,"reason":"甦醒"}', stderr: "", killed: false };

  await pi.tools.get("trpg_gm_character_availability").execute("availability", {
    db: "/tmp/game.db", room: "room-a", character: "pc",
    canAct: true, reason: "甦醒",
  });

  assert.equal(pi.execCalls.length, 2);
});

test("availability changes refresh finalizer spotlight eligibility", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "鮑伯在場景轉換時陷入昏迷", source: "interactive" },
    ctx,
  );
  pi.execResult = { code: 0, stdout: JSON.stringify({
    participation: {
      characters: [
        { character_id: "alice", can_act: true, action_count: 2 },
        { character_id: "bob", can_act: true, action_count: 0 },
      ],
    },
  }), stderr: "", killed: false };
  await pi.tools.get("trpg_gm_context").execute("context", {
    db: "/tmp/game.db", room: "room-a",
  });
  pi.execResult = { code: 0, stdout: '{"character_id":"bob","can_act":false,"reason":"昏迷"}', stderr: "", killed: false };
  await pi.tools.get("trpg_gm_character_availability").execute("availability", {
    db: "/tmp/game.db", room: "room-a", character: "bob",
    canAct: false, reason: "昏迷",
  });

  await pi.tools.get("trpg_turn_finalize").execute("finalize", {
    turnKind: "gameplay", roomId: "room-a", playerActionStatus: "not_applicable",
    noPlayerActionReason: "場景狀態更新，沒有玩家角色行動",
    stateChanges: ["鮑伯目前昏迷，無法行動"],
    secretsChecked: true, playerAgencyChecked: true, narrativeDetailChecked: true,
  });
});

test("HP depletion refreshes finalizer spotlight eligibility", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "我擋在鮑伯前方承受衝擊", source: "interactive" },
    ctx,
  );
  pi.execResult = { code: 0, stdout: JSON.stringify({
    participation: { characters: [
      { character_id: "alice", can_act: true, action_count: 1, unavailable_reason: null },
      { character_id: "bob", can_act: true, action_count: 0, unavailable_reason: null },
    ] },
  }), stderr: "", killed: false };
  await pi.tools.get("trpg_gm_context").execute("context", {
    db: "/tmp/game.db", room: "room-a",
  });
  await runAction(pi, { characterId: "alice", action: "我擋在鮑伯前方承受衝擊", db: "/tmp/game.db" });
  await runProgress(pi);
  pi.execResult = { code: 0, stdout: '{"id":"bob","hp":0}', stderr: "", killed: false };
  await pi.tools.get("trpg_gm_character_adjust").execute("adjust", {
    db: "/tmp/game.db", room: "room-a", character: "bob",
    resource: "hp", delta: -10, reason: "受到衝擊",
  });

  await pi.tools.get("trpg_turn_finalize").execute("finalize", {
    turnKind: "gameplay", roomId: "room-a", playerActionStatus: "accepted",
    stateChanges: ["鮑伯 HP 降至 0"], secretsChecked: true, playerAgencyChecked: true, narrativeDetailChecked: true,
  });
});

test("dedicated gameplay tools build exact CLI calls and share turn tracking", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "我仔細檢查門縫", source: "interactive" },
    ctx,
  );
  await pi.tools.get("trpg_gm_context").execute("context", {
    db: "/tmp/game.sqlite3", room: "room-a", events: 30,
  });

  pi.execResult = {
    code: 0,
    stdout: JSON.stringify({
      character_id: "pc", action: "我仔細檢查門縫", decision: "accepted",
      basis: "scene:door", reason: "角色可以接近門縫",
    }),
    stderr: "", killed: false,
  };
  await pi.tools.get("trpg_gm_action_adjudicate").execute("action", {
    db: "/tmp/game.sqlite3", room: "room-a", character: "pc",
    action: "我仔細檢查門縫", decision: "accepted",
    basis: "scene:door", reason: "角色可以接近門縫",
  });
  await runProgress(pi, pi.execCalls[0].args[1]);

  pi.execResult = { code: 0, stdout: JSON.stringify({
    character_id: "pc", stat: "偵查", roll: 31, target: 60, degree: "success",
  }), stderr: "", killed: false };
  await pi.tools.get("trpg_gm_check").execute("check", {
    db: "/tmp/game.sqlite3", room: "room-a", character: "pc", stat: "偵查",
  });
  pi.execResult = { code: 0, stdout: '{"ok":true}', stderr: "", killed: false };
  await pi.tools.get("trpg_gm_entity_upsert").execute("entity", {
    db: "/tmp/game.sqlite3", room: "room-a", kind: "clue", id: "fiber",
    name: "門縫纖維", state: { discovered: true, turn: 3 },
  });

  assert.deepEqual(pi.execCalls.map((call) => call.args.slice(2)), [
    ["context", "room-a", "--events", "30"],
    ["action", "adjudicate", "room-a", "pc", "我仔細檢查門縫", "--decision", "accepted", "--basis", "scene:door", "--reason", "角色可以接近門縫"],
    ["story", "progress", "room-a", "--status", "advanced", "--reason", "測試中記錄本次 action 的劇情推進"],
    ["check", "room-a", "pc", "偵查"],
    ["entity", "room-a", "clue", "fiber", "門縫纖維", "--state", '{"discovered":true,"turn":3}'],
  ]);
  const result = await pi.tools.get("trpg_turn_finalize").execute("finalize", {
    turnKind: "gameplay", roomId: "room-a", playerActionStatus: "accepted",
    stateChanges: ["保存門縫纖維"], secretsChecked: true, playerAgencyChecked: true, narrativeDetailChecked: true,
  });
  assert.match(result.content[0].text, /validated/);
});

test("activation recognizes gameplay but ignores development prompts", () => {
  assert.equal(shouldActivateFromText("/skill:trpg-gm 我想繼續舊團"), true);
  assert.equal(shouldActivateFromText("請當 GM 主持一場克蘇魯冒險"), true);
  assert.equal(shouldActivateFromText("請修正一般 Python 測試"), false);
  assert.equal(shouldActivateFromText("請更新 trpg-gm README 與 extension"), false);
});

test("active guard injects a checklist and follows up once when finalization is missing", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();

  await pi.handlers.get("session_start")({}, ctx);
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 繼續遊戲", source: "interactive" },
    ctx,
  );
  const injection = await pi.handlers.get("before_agent_start")(
    { prompt: "繼續遊戲" },
    ctx,
  );

  assert.match(injection.message.content, /trpg_turn_finalize/);
  assert.match(injection.message.content, /context/);
  assert.match(injection.message.content, /guardrail/);
  assert.match(injection.message.content, /\["action","adjudicate",ROOM,CHARACTER,PLAYER_ACTION/);
  assert.match(injection.message.content, /\["entity",ROOM,KIND,ID,NAME/);

  await pi.handlers.get("agent_settled")({}, ctx);
  await pi.handlers.get("agent_settled")({}, ctx);
  assert.equal(pi.messages.length, 1);
  assert.equal(pi.messages[0].options.deliverAs, "followUp");
  assert.equal(pi.messages[0].options.triggerTurn, true);
  assert.match(pi.messages[0].message.content, /clarification/);
});

test("guardrail additions are tracked as persistent room mutations", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 開新團", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"]);
  await runCli(pi, [
    "guardrail", "add", "room-a", "no-magic",
    "--scopes", '["action"]', "--statement", "禁止施法",
    "--terms", '["施法"]', "--source", "scenario.md#limits",
  ]);

  const result = await pi.tools.get("trpg_turn_finalize").execute("guardrail-final", {
    turnKind: "gameplay",
    roomId: "room-a",
    playerActionStatus: "not_applicable",
    noPlayerActionReason: "本回合只設定劇本禁止條款",
    stateChanges: ["已保存劇本禁止條款"],
    secretsChecked: true,
    playerAgencyChecked: true, narrativeDetailChecked: true,
  });
  assert.match(result.content[0].text, /validated/);
});

test("structured Pi CLI tool tracks successful context without shell parsing", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 繼續遊戲", source: "interactive" },
    ctx,
  );

  const cli = pi.tools.get("trpg_gm_cli");
  assert.ok(cli, "extension must register a structured CLI tool");
  assert.match(cli.description, /context.*ROOM/);
  assert.match(cli.description, /positionals before options/);
  await cli.execute("cli-1", {
    db: "/tmp/game.sqlite3",
    args: ["context", "room-a"],
  });
  assert.deepEqual(pi.execCalls[0].args.slice(-4), ["--db", "/tmp/game.sqlite3", "context", "room-a"]);

  const result = await pi.tools.get("trpg_turn_finalize").execute("final-1", {
    turnKind: "gameplay",
    roomId: "room-a",
    playerActionStatus: "not_applicable",
    noPlayerActionReason: "此測試只驗證 room context",
    stateChanges: [],
    secretsChecked: true,
    playerAgencyChecked: true, narrativeDetailChecked: true,
  });
  assert.match(result.content[0].text, /validated/i);
});

test("context tracking accepts options before the room positional", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 繼續遊戲", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "--events", "30", "room-a"]);

  const result = await pi.tools.get("trpg_turn_finalize").execute("context-options", {
    turnKind: "gameplay", roomId: "room-a", playerActionStatus: "not_applicable",
    noPlayerActionReason: "本回合只查看狀態", stateChanges: [],
    secretsChecked: true, playerAgencyChecked: true, narrativeDetailChecked: true,
  });
  assert.match(result.content[0].text, /validated/);
});

test("action tracking accepts argparse options before positionals", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 繼續遊戲，我要調查門縫", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"]);
  pi.execResult = {
    code: 0,
    stdout: JSON.stringify({
      character_id: "pc", action: "調查門縫", decision: "accepted",
      basis: "場景允許", reason: "一般調查能力",
    }),
    stderr: "", killed: false,
  };
  await runCli(pi, [
    "action", "adjudicate", "--decision", "accepted",
    "--basis", "場景允許", "--reason", "一般調查能力",
    "room-a", "pc", "調查門縫",
  ]);
  await runProgress(pi);

  const result = await pi.tools.get("trpg_turn_finalize").execute("option-order", {
    turnKind: "gameplay",
    roomId: "room-a",
    playerActionStatus: "accepted",
    stateChanges: [],
    secretsChecked: true,
    playerAgencyChecked: true, narrativeDetailChecked: true,
  });
  assert.match(result.content[0].text, /validated/);
});

test("action tracking handles inline argparse option assignments", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 繼續遊戲，我要調查門縫", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"]);
  pi.execResult = {
    code: 0,
    stdout: JSON.stringify({
      character_id: "pc", action: "調查門縫", decision: "accepted",
      basis: "場景允許", reason: "一般調查能力",
    }),
    stderr: "", killed: false,
  };
  await runCli(pi, [
    "action", "adjudicate", "--decision=accepted",
    "--basis=場景允許", "--reason=一般調查能力",
    "room-a", "pc", "調查門縫",
  ]);
  await runProgress(pi);

  const result = await pi.tools.get("trpg_turn_finalize").execute("inline-options", {
    turnKind: "gameplay", roomId: "room-a", playerActionStatus: "accepted",
    stateChanges: [], secretsChecked: true, playerAgencyChecked: true, narrativeDetailChecked: true,
  });
  assert.match(result.content[0].text, /validated/);
});

test("setup mutations before a rejected action do not count as its consequences", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 開新團；玩家宣告：施法開門", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"]);
  await runCli(pi, [
    "guardrail", "add", "room-a", "no-magic",
    "--scopes", '["action"]', "--statement", "禁止施法",
    "--terms", '["施法"]', "--source", "scenario.md#limits",
  ]);
  await runAction(pi, { decision: "rejected", action: "施法開門" });

  const result = await pi.tools.get("trpg_turn_finalize").execute("setup-then-reject", {
    turnKind: "gameplay", roomId: "room-a", playerActionStatus: "rejected",
    stateChanges: ["已保存劇本禁止條款"], secretsChecked: true, playerAgencyChecked: true, narrativeDetailChecked: true,
  });
  assert.match(result.content[0].text, /validated/);
});

test("unfinalized text-only player responses are blocked", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 繼續遊戲", source: "interactive" },
    ctx,
  );

  const transformed = await pi.handlers.get("message_end")({
    message: { role: "assistant", content: [{ type: "text", text: "門已經打開了。" }] },
  });

  const text = transformed.message.content.map((part) => part.text ?? "").join("");
  assert.match(text, /blocked|尚未完成|未完成/iu);
  assert.doesNotMatch(text, /門已經打開了/);
});

test("finalizer rejects a turn without context or persisted state accounting", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 繼續遊戲，我要調查門縫", source: "interactive" },
    ctx,
  );
  const finalizer = pi.tools.get("trpg_turn_finalize");

  await assert.rejects(
    () => finalizer.execute("call-1", {
      turnKind: "gameplay",
      roomId: "room-a",
      playerActionStatus: "not_applicable",
      noPlayerActionReason: "尚未進入可執行玩家行動的 room",
      stateChanges: [],
      secretsChecked: true,
      playerAgencyChecked: true, narrativeDetailChecked: true,
    }),
    /context/,
  );

  await runCli(pi, ["context", "room-a"]);
  await runAction(pi);
  await runProgress(pi);
  await runCli(pi, ["check", "room-a", "pc", "觀察"]);

  await assert.rejects(
    () => finalizer.execute("call-2", {
      turnKind: "gameplay",
      roomId: "room-a",
      playerActionStatus: "accepted",
      stateChanges: [],
      secretsChecked: true,
      playerAgencyChecked: true, narrativeDetailChecked: true,
    }),
    /state change|noStateChangeReason/i,
  );
});

test("finalizer requires the least-participating eligible player as next spotlight", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "我檢查門縫", source: "interactive" },
    ctx,
  );
  pi.execResult = { code: 0, stdout: JSON.stringify({
    participation: {
      characters: [
        { character_id: "alice", can_act: true, action_count: 2 },
        { character_id: "bob", can_act: true, action_count: 0 },
      ],
      eligible_character_ids: ["alice", "bob"],
      next_spotlight_character_ids: ["bob"],
    },
  }), stderr: "", killed: false };
  await pi.tools.get("trpg_gm_context").execute("context", {
    db: "/tmp/game.db", room: "room-a",
  });
  await runAction(pi, { characterId: "alice", action: "我檢查門縫", db: "/tmp/game.db" });
  await runProgress(pi);
  const finalize = pi.tools.get("trpg_turn_finalize");
  const base = {
    turnKind: "gameplay", roomId: "room-a", playerActionStatus: "accepted",
    stateChanges: [], noStateChangeReason: "行動不需擲骰且沒有改變既有狀態",
    secretsChecked: true, playerAgencyChecked: true, narrativeDetailChecked: true,
  };

  await assert.rejects(() => finalize.execute("finalize", base), /nextSpotlightCharacterId/);
  await assert.rejects(
    () => finalize.execute("finalize", { ...base, nextSpotlightCharacterId: "alice" }),
    /must prioritize.*bob/i,
  );
  await finalize.execute("finalize", { ...base, nextSpotlightCharacterId: "bob" });
});

test("successful finalization prevents follow-up reminders", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "我要繼續 TRPG，並調查門縫", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"]);
  await runAction(pi);
  await runProgress(pi);
  for (const args of [
    ["check", "room-a", "pc", "觀察"],
    ["entity", "room-a", "clue", "c1", "線索", "--state", "{}"],
  ]) {
    await runCli(pi, args);
  }

  const finalizer = pi.tools.get("trpg_turn_finalize");
  const result = await finalizer.execute("call-3", {
    turnKind: "gameplay",
    roomId: "room-a",
    playerActionStatus: "accepted",
    stateChanges: ["保存已發現線索 c1"],
    secretsChecked: true,
    playerAgencyChecked: true, narrativeDetailChecked: true,
  });
  assert.match(result.content[0].text, /validated/i);

  await pi.handlers.get("agent_settled")({}, ctx);
  assert.equal(pi.messages.length, 0);

  await runCli(pi, ["entity", "room-a", "clue", "c2", "另一線索", "--state", "{}"]);
  await pi.handlers.get("agent_settled")({}, ctx);
  assert.equal(pi.messages.length, 1, "a later state command must invalidate finalization");
});

test("structured CLI preserves shell operators inside argument values", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 開新團並建立初始線索", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"]);
  const state = '{"note":"A | B; C & D"}';
  await runCli(pi, ["entity", "room-a", "clue", "c1", "A; B", "--state", state]);

  assert.equal(pi.execCalls[1].args.at(-1), state);
  const result = await pi.tools.get("trpg_turn_finalize").execute("operators", {
    turnKind: "gameplay",
    roomId: "room-a",
    playerActionStatus: "not_applicable",
    noPlayerActionReason: "GM 保存既有場景資料，沒有玩家宣告行動",
    stateChanges: ["保存包含標點的線索"],
    secretsChecked: true,
    playerAgencyChecked: true, narrativeDetailChecked: true,
  });
  assert.match(result.content[0].text, /validated/i);
});

test("development prompts do not activate persistent gameplay reminders", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("session_start")({}, ctx);
  await pi.handlers.get("input")(
    { text: "請更新 trpg-gm README 與 extension", source: "interactive" },
    ctx,
  );
  const injection = await pi.handlers.get("before_agent_start")(
    { prompt: "請更新 trpg-gm README 與 extension" },
    ctx,
  );
  assert.equal(injection, undefined);
  await pi.handlers.get("agent_settled")({}, ctx);
  assert.equal(pi.messages.length, 0);
});

test("successful CLI help output does not poison room tracking", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 繼續遊戲", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"]);
  await runCli(pi, ["check", "--help"]);

  const result = await pi.tools.get("trpg_turn_finalize").execute("help", {
    turnKind: "gameplay",
    roomId: "room-a",
    playerActionStatus: "not_applicable",
    noPlayerActionReason: "CLI help 不代表玩家行動",
    stateChanges: [],
    secretsChecked: true,
    playerAgencyChecked: true, narrativeDetailChecked: true,
  });
  assert.match(result.content[0].text, /validated/i);
});

test("character creation proposals are tracked and rejected concepts report reasons", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 開新團", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"]);
  pi.execResult = {
    code: 0,
    stdout: JSON.stringify({
      character_id: "pc",
      name: "艾莉絲",
      appearance: "背後長著龍翼",
      background: "異世界龍騎士",
      concept: "能飛行與噴火的龍裔",
      skills: ["飛行"],
      decision: "rejected",
      basis: "本團是現代寫實世界",
      reason: "龍翼與飛行技能不符合世界觀",
      draft_id: 1,
    }),
    stderr: "",
    killed: false,
  };
  await runCli(pi, [
    "creation", "propose", "room-a", "pc", "艾莉絲",
    "--appearance", "背後長著龍翼", "--background", "異世界龍騎士",
    "--concept", "能飛行與噴火的龍裔", "--skills", '["飛行"]',
    "--decision", "rejected", "--basis", "本團是現代寫實世界",
    "--reason", "龍翼與飛行技能不符合世界觀",
  ]);
  pi.execResult = {
    code: 0,
    stdout: JSON.stringify({
      character_id: "pc",
      name: "艾莉絲",
      appearance: "黑髮記者",
      background: "地方報社",
      concept: "追查失蹤案的記者",
      skills: ["偵查"],
      decision: "accepted",
      basis: "符合現代寫實劇本",
      reason: "修訂後的角色符合世界觀",
      draft_id: 2,
    }),
    stderr: "",
    killed: false,
  };
  await runCli(pi, [
    "creation", "propose", "room-a", "pc", "艾莉絲",
    "--appearance", "黑髮記者", "--background", "地方報社",
    "--concept", "追查失蹤案的記者", "--skills", '["偵查"]',
    "--decision", "accepted", "--basis", "符合現代寫實劇本",
    "--reason", "修訂後的角色符合世界觀",
  ]);

  await pi.tools.get("trpg_turn_finalize").execute("creation-rejected", {
    turnKind: "gameplay",
    roomId: "room-a",
    playerActionStatus: "not_applicable",
    noPlayerActionReason: "此回合正在進行開團捏角，沒有遊戲內角色行動",
    stateChanges: ["保存被拒絕的角色提案"],
    secretsChecked: true,
    playerAgencyChecked: true, narrativeDetailChecked: true,
  });
  const amended = await pi.handlers.get("message_end")({
    message: { role: "assistant", content: [{ type: "text", text: "請調整角色設定。" }] },
  }, ctx);
  const text = amended.message.content.map((part) => part.text ?? "").join("");
  assert.match(text, /角色提案裁定/);
  assert.match(text, /不允許/);
  assert.match(text, /龍翼與飛行技能不符合世界觀/);
  assert.match(text, /本團是現代寫實世界/);
});

test("character generation reports rolled skill values and resource maxima", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 開新團", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"]);
  pi.execResult = {
    code: 0,
    stdout: JSON.stringify({
      id: "pc",
      name: "艾莉絲",
      stats: { "偵查": 80, "聆聽": 20 },
      max_hp: 9,
      max_mp: 7,
      max_san: 46,
      generation: {
        skill_rolls: { "偵查": 100, "聆聽": 1 },
        resource_rolls: { hp: 1, mp: 1, san: 1 },
        maxima: { hp: 9, mp: 7, san: 46 },
      },
    }),
    stderr: "",
    killed: false,
  };
  await runCli(pi, ["creation", "roll", "room-a", "pc"]);
  pi.execResult = {
    code: 0,
    stdout: JSON.stringify({
      id: "pc2",
      name: "鮑伯",
      stats: { "圖書館使用": 50 },
      max_hp: 10,
      max_mp: 8,
      max_san: 50,
      generation: {
        skill_rolls: { "圖書館使用": 50 },
        resource_rolls: { hp: 2, mp: 2, san: 5 },
        maxima: { hp: 10, mp: 8, san: 50 },
      },
    }),
    stderr: "",
    killed: false,
  };
  await runCli(pi, ["creation", "roll", "room-a", "pc2"]);
  pi.execResult = { code: 0, stdout: JSON.stringify({
    chapter: "第一章", objective: "調查大學檔案室的失蹤紀錄",
    opening_guidance_required: false, opening_character_ids: [],
    stagnant_action_count: 0, intervention_required: false,
  }), stderr: "", killed: false };
  await pi.tools.get("trpg_gm_story_objective").execute("opening", {
    db: pi.execCalls[0].args[1], room: "room-a", chapter: "第一章",
    objective: "調查大學檔案室的失蹤紀錄", reason: "結合記者與大學助教背景引導開場",
  });
  await pi.tools.get("trpg_turn_finalize").execute("creation-roll", {
    turnKind: "gameplay",
    roomId: "room-a",
    playerActionStatus: "not_applicable",
    noPlayerActionReason: "此回合正在捏角，沒有遊戲內角色行動",
    stateChanges: ["生成角色技能與 HP/MP/SAN 上限"],
    secretsChecked: true,
    playerAgencyChecked: true, narrativeDetailChecked: true,
  });
  const amended = await pi.handlers.get("message_end")({
    message: { role: "assistant", content: [{ type: "text", text: "角色建立完成。" }] },
  }, ctx);
  const text = amended.message.content.map((part) => part.text ?? "").join("");
  assert.match(text, /角色生成結果/);
  assert.match(text, /艾莉絲/);
  assert.match(text, /鮑伯/);
  assert.match(text, /偵查.*roll 100.*80/);
  assert.match(text, /聆聽.*roll 1.*20/);
  assert.match(text, /HP.*roll 1.*9/);
  assert.match(text, /SAN.*roll 1.*46/);
});

test("character generation requires story-background guidance before finalization", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 開新團", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"]);
  pi.execResult = {
    code: 0,
    stdout: JSON.stringify({
      id: "pc", name: "艾莉絲", stats: { "偵查": 50 },
      generation: {
        skill_rolls: { "偵查": 50 }, resource_rolls: { hp: 1, mp: 1, san: 1 },
        maxima: { hp: 9, mp: 7, san: 46 },
      },
    }),
    stderr: "", killed: false,
  };
  await runCli(pi, ["creation", "roll", "room-a", "pc"]);
  const finalizer = pi.tools.get("trpg_turn_finalize");
  const params = {
    turnKind: "gameplay", roomId: "room-a", playerActionStatus: "not_applicable",
    noPlayerActionReason: "創角完成，尚未進入角色行動",
    stateChanges: ["生成角色並準備故事開場"],
    secretsChecked: true, playerAgencyChecked: true, narrativeDetailChecked: true,
  };

  await assert.rejects(() => finalizer.execute("before-opening", params), /story background|故事背景/i);

  pi.execResult = {
    code: 0,
    stdout: JSON.stringify({
      chapter: "第一章", objective: "從匿名信追查失蹤案",
      opening_guidance_required: false, opening_character_ids: [],
      stagnant_action_count: 0, intervention_required: false,
    }),
    stderr: "", killed: false,
  };
  await pi.tools.get("trpg_gm_story_objective").execute("opening", {
    db: pi.execCalls[0].args[1], room: "room-a", chapter: "第一章",
    objective: "從匿名信追查失蹤案", reason: "依地方報社記者背景引導開場",
    openingCharacterIds: ["pc"],
  });
  assert.deepEqual(pi.execCalls.at(-1).args.slice(2), ["context", "room-a"]);
  const result = await finalizer.execute("after-opening", params);
  assert.match(result.content[0].text, /validated/i);
});

test("action adjudication must preserve the player's exact wording", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "林雨晴宣告：我仔細檢查門廳書桌抽屜與桌面。", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"]);

  await assert.rejects(
    runAction(pi, { action: "調查書桌尋找線索" }),
    /copy the exact contiguous player wording/i,
  );
  assert.equal(pi.execCalls.length, 1);

  await runAction(pi, { action: "我仔細檢查門廳書桌抽屜與桌面。" });
  assert.equal(pi.execCalls.length, 2);
});

test("invalid action decisions fail before invoking the CLI", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "我調查門縫", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"]);

  await assert.rejects(
    runCli(pi, [
      "action", "adjudicate", "room-a", "pc", "我調查門縫",
      "--decision", "investigation_check", "--basis", "scene", "--reason", "合理",
    ]),
    /decision must be exactly accepted or rejected/i,
  );
  assert.equal(pi.execCalls.length, 1);
});

test("explicit check rolls require a player-provided roll", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "我要調查門縫", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"]);

  await assert.rejects(
    runCli(pi, ["check", "room-a", "pc", "觀察", "--roll", "50"]),
    /omit --roll.*random d100/i,
  );
  assert.equal(pi.execCalls.length, 1);

  await pi.handlers.get("input")(
    { text: "我有 20 枚硬幣，要調查門縫", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"]);
  await assert.rejects(
    runCli(pi, ["check", "room-a", "pc", "觀察", "--roll", "20"]),
    /player.*roll|玩家.*骰|omit --roll/i,
  );
  assert.equal(pi.execCalls.length, 2);

  await pi.handlers.get("input")(
    { text: "我調查門縫；我的實體骰結果是 20", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"]);
  await runAction(pi, { action: "我調查門縫" });
  await runCli(pi, ["check", "room-a", "pc", "觀察", "--roll", "20"]);
  assert.equal(pi.execCalls.length, 5);
});

test("a rejected adjudication cannot be rewritten and accepted in the same turn", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 繼續遊戲；詢問周管理員", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"]);
  await runAction(pi, { decision: "rejected", action: "詢問周管理員" });

  await assert.rejects(
    runAction(pi, { decision: "accepted", action: "詢問負責看守莊園的男性" }),
    /only one successful action adjudication/i,
  );
});

test("direct SQLite access through bash is blocked after loading a room DB", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 繼續遊戲", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"]);

  for (const event of [
    {
      toolName: "bash",
      input: { command: "python3 -c 'import sqlite3; sqlite3.connect(\"/tmp/game.sqlite3\")'" },
    },
    { toolName: "bash", input: { command: "cp /tmp/other.sqlite3 /tmp/backup" } },
    { toolName: "read", input: { path: "/tmp/game.sqlite3" } },
    { toolName: "browser", input: { command: "open file:///tmp/scenario.md" } },
  ]) {
    const result = await pi.handlers.get("tool_call")(event);
    assert.equal(result.block, true);
    assert.match(result.reason, /trpg_gm_cli|read tool/);
  }

  const harmless = await pi.handlers.get("tool_call")({
    toolName: "read", input: { path: "/tmp/scenario.md" },
  });
  assert.equal(harmless, undefined);
  const harmlessDocsCommand = await pi.handlers.get("tool_call")({
    toolName: "bash", input: { command: "echo 'SQLite documentation test'" },
  });
  assert.equal(harmlessDocsCommand, undefined);
});

test("player actions require persisted adjudication and rejected actions report reasons", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 繼續遊戲；宣稱自己有翅膀並飛過鎖門", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"]);

  const finalizer = pi.tools.get("trpg_turn_finalize");
  await assert.rejects(
    () => finalizer.execute("missing-action-ruling", {
      turnKind: "gameplay",
      roomId: "room-a",
      playerActionStatus: "accepted",
      stateChanges: [],
      secretsChecked: true,
      playerAgencyChecked: true, narrativeDetailChecked: true,
    }),
    /action|adjudicat|裁定/i,
  );

  pi.execResult = {
    code: 0,
    stdout: JSON.stringify({
      character_id: "pc",
      action: "宣稱自己有翅膀並飛過鎖門",
      decision: "rejected",
      basis: "角色卡與劇本均未建立飛行能力",
      reason: "角色沒有翅膀或其他飛行手段",
    }),
    stderr: "",
    killed: false,
  };
  await runCli(pi, [
    "action", "adjudicate", "room-a", "pc", "宣稱自己有翅膀並飛過鎖門",
    "--decision", "rejected",
    "--basis", "角色卡與劇本均未建立飛行能力",
    "--reason", "角色沒有翅膀或其他飛行手段",
  ]);

  await finalizer.execute("rejected-action", {
    turnKind: "gameplay",
    roomId: "room-a",
    playerActionStatus: "rejected",
    stateChanges: [],
    secretsChecked: true,
    playerAgencyChecked: true, narrativeDetailChecked: true,
  });
  const amended = await pi.handlers.get("message_end")({
    message: {
      role: "assistant",
      content: [{ type: "text", text: "這個行動無法執行。" }],
    },
  }, ctx);
  const text = amended.message.content.map((part) => part.text ?? "").join("");
  assert.match(text, /行動裁定/);
  assert.match(text, /不允許/);
  assert.match(text, /宣稱自己有翅膀並飛過鎖門/);
  assert.match(text, /角色沒有翅膀或其他飛行手段/);
  assert.match(text, /角色卡與劇本均未建立飛行能力/);
});

test("a check cannot execute before an accepted action", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 繼續遊戲，我要調查門縫", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"]);

  await assert.rejects(
    runCli(pi, ["check", "room-a", "pc", "觀察"]),
    /accepted.*action|action.*accepted/i,
  );
  assert.equal(pi.execCalls.length, 1, "rejected check must not reach persistent CLI");
});

test("gameplay mutations cannot execute before an accepted action", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 繼續遊戲；要求生命值增加", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"]);

  await assert.rejects(
    runCli(pi, ["character", "adjust", "room-a", "pc", "hp", "99", "--reason", "違規行動效果"]),
    /accepted.*action|action.*accepted/i,
  );
  assert.equal(pi.execCalls.length, 1, "rejected mutation must not reach persistent CLI");
});

test("rejected player actions cannot produce checks or world-state mutations", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 繼續遊戲；徒手穿過實心牆", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"]);
  await runAction(pi, {
    action: "徒手穿過實心牆",
    decision: "rejected",
    basis: "目前場景的牆是完整實體，角色沒有超自然穿牆能力",
    reason: "這個行動在目前設定下不可能",
  });
  await assert.rejects(
    runCli(pi, ["entity", "room-a", "scene", "wall", "牆後", "--state", "{}"]),
    /accepted.*action|rejected.*action|action.*accepted/i,
  );
  assert.equal(pi.execCalls.length, 2, "mutation after rejection must not reach persistent CLI");
});

test("final player-facing answer reports every resolved check canonically", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 繼續遊戲，我要調查門縫", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"]);
  await runAction(pi);
  await runProgress(pi);

  pi.execResult = {
    code: 0,
    stdout: JSON.stringify({
      character_id: "pc",
      stat: "察覺",
      roll: 27,
      target: 60,
      degree: "hard",
    }),
    stderr: "",
    killed: false,
  };
  await runCli(pi, ["check", "room-a", "pc", "察覺"]);

  await pi.tools.get("trpg_turn_finalize").execute("check-report", {
    turnKind: "gameplay",
    roomId: "room-a",
    playerActionStatus: "accepted",
    stateChanges: [],
    noStateChangeReason: "判定只決定玩家當下察覺程度，沒有建立持久狀態",
    secretsChecked: true,
    playerAgencyChecked: true, narrativeDetailChecked: true,
  });

  const amended = await pi.handlers.get("message_end")({
    message: {
      role: "assistant",
      content: [{ type: "text", text: "你在門縫裡看見一小段纖維。" }],
    },
  }, ctx);

  assert.ok(amended, "guard must amend a final answer that omits its check result");
  const text = amended.message.content.map((part) => part.text ?? "").join("");
  assert.match(text, /判定結果/);
  assert.match(text, /pc/);
  assert.match(text, /察覺/);
  assert.match(text, /困難成功/);
  assert.match(text, /hard/);
  assert.match(text, /roll 27/);
  assert.match(text, /目標 60/);
});

test("player action resolution cannot execute before context", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 我調查門縫", source: "interactive" },
    ctx,
  );

  await assert.rejects(
    runAction(pi, { action: "我調查門縫" }),
    /load.*context|context.*first/i,
  );
  assert.equal(pi.execCalls.length, 0);
});

test("all turn operations must use the same database as context", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 我調查門縫", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"], "/tmp/a.sqlite3");

  await assert.rejects(
    runAction(pi, { action: "我調查門縫" }),
    /same database|context database/i,
  );
  assert.equal(pi.execCalls.length, 1);
});

test("turn operations for a different room fail before persistence", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 我調查門縫", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"]);
  await runAction(pi, { action: "我調查門縫" });

  await assert.rejects(
    runCli(pi, ["entity", "room-b", "clue", "fiber", "纖維", "--state", "{}"]),
    /exact room|same room|room-a/i,
  );
  assert.equal(pi.execCalls.length, 2);
});

test("failed structured CLI calls do not satisfy context tracking", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 繼續遊戲", source: "interactive" },
    ctx,
  );
  pi.execResult = { code: 1, stdout: "", stderr: "unknown room", killed: false };
  await assert.rejects(() => runCli(pi, ["context", "room-a"]), /unknown room/);

  await assert.rejects(
    () => pi.tools.get("trpg_turn_finalize").execute("failed-cli", {
      turnKind: "gameplay",
      roomId: "room-a",
      playerActionStatus: "not_applicable",
      noPlayerActionReason: "context 載入失敗，尚未處理玩家行動",
      stateChanges: [],
      secretsChecked: true,
      playerAgencyChecked: true, narrativeDetailChecked: true,
    }),
    /context/,
  );
});

test("gameplay finalization rejects a different room than the loaded context", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 繼續遊戲", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"]);

  await assert.rejects(
    () => pi.tools.get("trpg_turn_finalize").execute("wrong-room", {
      turnKind: "gameplay",
      roomId: "room-b",
      playerActionStatus: "not_applicable",
      noPlayerActionReason: "此測試只驗證 room 一致性",
      stateChanges: [],
      secretsChecked: true,
      playerAgencyChecked: true, narrativeDetailChecked: true,
    }),
    /room-a|room-b|exact room/i,
  );
});

test("clarification finalization can ask for a room without loading context", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 我想玩 TRPG", source: "interactive" },
    ctx,
  );

  const result = await pi.tools.get("trpg_turn_finalize").execute("call-4", {
    turnKind: "clarification",
    roomId: "",
    playerActionStatus: "not_applicable",
    noPlayerActionReason: "仍在等待玩家選擇新團或舊團",
    stateChanges: [],
    noStateChangeReason: "等待玩家選擇新團或舊團與 room id",
    secretsChecked: true,
    playerAgencyChecked: true, narrativeDetailChecked: true,
  });

  assert.match(result.content[0].text, /clarification/i);
  await pi.handlers.get("agent_settled")({}, ctx);
  assert.equal(pi.messages.length, 0);
});
