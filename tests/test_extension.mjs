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
      return this.execResult;
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
    ]);
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
  for (const phrase of ["guardrail add", "forbidden_terms", "不可覆寫", "context"]) {
    assert.match(skill + cliReference, new RegExp(phrase));
  }
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
    playerAgencyChecked: true,
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
    playerAgencyChecked: true,
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
    secretsChecked: true, playerAgencyChecked: true,
  });
  assert.match(result.content[0].text, /validated/);
});

test("action tracking accepts argparse options before positionals", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 繼續遊戲", source: "interactive" },
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

  const result = await pi.tools.get("trpg_turn_finalize").execute("option-order", {
    turnKind: "gameplay",
    roomId: "room-a",
    playerActionStatus: "accepted",
    stateChanges: [],
    secretsChecked: true,
    playerAgencyChecked: true,
  });
  assert.match(result.content[0].text, /validated/);
});

test("action tracking handles inline argparse option assignments", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 繼續遊戲", source: "interactive" },
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

  const result = await pi.tools.get("trpg_turn_finalize").execute("inline-options", {
    turnKind: "gameplay", roomId: "room-a", playerActionStatus: "accepted",
    stateChanges: [], secretsChecked: true, playerAgencyChecked: true,
  });
  assert.match(result.content[0].text, /validated/);
});

test("setup mutations before a rejected action do not count as its consequences", async () => {
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
  await runAction(pi, { decision: "rejected", action: "施法開門" });

  const result = await pi.tools.get("trpg_turn_finalize").execute("setup-then-reject", {
    turnKind: "gameplay", roomId: "room-a", playerActionStatus: "rejected",
    stateChanges: ["已保存劇本禁止條款"], secretsChecked: true, playerAgencyChecked: true,
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
    { text: "/skill:trpg-gm 繼續遊戲", source: "interactive" },
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
      playerAgencyChecked: true,
    }),
    /context/,
  );

  await runCli(pi, ["context", "room-a"]);
  await runAction(pi);
  await runCli(pi, ["check", "room-a", "pc", "觀察"]);

  await assert.rejects(
    () => finalizer.execute("call-2", {
      turnKind: "gameplay",
      roomId: "room-a",
      playerActionStatus: "accepted",
      stateChanges: [],
      secretsChecked: true,
      playerAgencyChecked: true,
    }),
    /state change|noStateChangeReason/i,
  );
});

test("successful finalization prevents follow-up reminders", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "我要繼續 TRPG", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"]);
  await runAction(pi);
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
    playerAgencyChecked: true,
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
    { text: "/skill:trpg-gm 繼續遊戲", source: "interactive" },
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
    playerAgencyChecked: true,
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
    playerAgencyChecked: true,
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
    playerAgencyChecked: true,
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
  await pi.tools.get("trpg_turn_finalize").execute("creation-roll", {
    turnKind: "gameplay",
    roomId: "room-a",
    playerActionStatus: "not_applicable",
    noPlayerActionReason: "此回合正在捏角，沒有遊戲內角色行動",
    stateChanges: ["生成角色技能與 HP/MP/SAN 上限"],
    secretsChecked: true,
    playerAgencyChecked: true,
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

test("player actions require persisted adjudication and rejected actions report reasons", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 繼續遊戲", source: "interactive" },
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
      playerAgencyChecked: true,
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
    playerAgencyChecked: true,
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

test("an accepted action cannot retroactively authorize an earlier check", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 繼續遊戲", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"]);
  await runCli(pi, ["check", "room-a", "pc", "觀察"]);
  await runAction(pi);

  await assert.rejects(
    () => pi.tools.get("trpg_turn_finalize").execute("late-action", {
      turnKind: "gameplay",
      roomId: "room-a",
      playerActionStatus: "accepted",
      stateChanges: [],
      noStateChangeReason: "判定沒有建立持久狀態",
      secretsChecked: true,
      playerAgencyChecked: true,
    }),
    /before|earlier|先.*行動|順序/i,
  );
});

test("mutations before a rejected action cannot be disguised as setup", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 繼續遊戲", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"]);
  await runCli(pi, ["character", "adjust", "room-a", "pc", "hp", "99", "--reason", "違規行動效果"]);
  await runAction(pi, { decision: "rejected", action: "要求生命值增加" });

  await assert.rejects(
    pi.tools.get("trpg_turn_finalize").execute("pre-rejection-mutation", {
      turnKind: "gameplay", roomId: "room-a", playerActionStatus: "rejected",
      stateChanges: ["生命值增加"], secretsChecked: true, playerAgencyChecked: true,
    }),
    /rejected player action/i,
  );
});

test("rejected player actions cannot produce checks or world-state mutations", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 繼續遊戲", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"]);
  await runAction(pi, {
    action: "徒手穿過實心牆",
    decision: "rejected",
    basis: "目前場景的牆是完整實體，角色沒有超自然穿牆能力",
    reason: "這個行動在目前設定下不可能",
  });
  await runCli(pi, ["entity", "room-a", "scene", "wall", "牆後", "--state", "{}"]);

  await assert.rejects(
    () => pi.tools.get("trpg_turn_finalize").execute("rejected-mutation", {
      turnKind: "gameplay",
      roomId: "room-a",
      playerActionStatus: "rejected",
      stateChanges: ["角色穿過牆壁"],
      secretsChecked: true,
      playerAgencyChecked: true,
    }),
    /rejected|拒絕|must not/i,
  );
});

test("final player-facing answer reports every resolved check canonically", async () => {
  const pi = createFakePi();
  trpgGuard(pi);
  const ctx = context();
  await pi.handlers.get("input")(
    { text: "/skill:trpg-gm 繼續遊戲", source: "interactive" },
    ctx,
  );
  await runCli(pi, ["context", "room-a"]);
  await runAction(pi);

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
    playerAgencyChecked: true,
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
      playerAgencyChecked: true,
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
      playerAgencyChecked: true,
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
    playerAgencyChecked: true,
  });

  assert.match(result.content[0].text, /clarification/i);
  await pi.handlers.get("agent_settled")({}, ctx);
  assert.equal(pi.messages.length, 0);
});
