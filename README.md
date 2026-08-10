# TRPG GM Skill

給 AI agent 使用的持久化 TRPG 主持人系統。它將「主持遊戲的判斷」與「可靠保存遊戲狀態」拆成三層：

- **Skill（Markdown 指令）**負責告訴 agent 如何當 GM、何時讀寫資料、如何避免吃書，以及如何尊重玩家決定。
- **Pi Extension（JavaScript hooks）**在每個 Pi 回合注入 checklist、追蹤 CLI 操作，並要求 agent 在輸出玩家敘事前呼叫 `trpg_turn_finalize`。
- **Python + SQLite** 負責執行確定性的操作，例如保存角色、調整 HP／MP／SAN、追蹤每名玩家的參與次數與角色可行動狀態、進行判定、隔離 room、拒絕互相衝突的 canon，以及用不可覆寫的劇本 guardrails 強制攔截已知違規角色概念與行動。

因此，故事創作仍由 agent 負責，但已經發生的事不再只存在聊天上下文裡。

## 安裝

### 系統需求

- Git
- Python 3.10+
- Bash（Linux、macOS 或 Windows WSL／Git Bash）
- Pi Extension 需要可載入 JavaScript extensions 的 Pi Agent；Pi 本身已包含所需 Node.js runtime
- Agent 必須能讀檔、執行 shell，並對 campaign DB 目錄有寫入權限

這個 Skill 的 Python CLI 位於同一個 Git repository，因此建議保留完整 clone，再讓各 agent 的 skills 目錄 symlink 到 clone 裡的 `.agents/skills/trpg-gm`。不要只複製 `SKILL.md`，否則 `scripts/`、`references/` 和 `src/trpg_gm/` 不會完整存在。

### 1. Clone 完整 repository

```bash
INSTALL_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}"
REPO="$INSTALL_ROOT/trpg-gm-skill"

mkdir -p "$INSTALL_ROOT"
git clone <GIT_REPOSITORY_URL> "$REPO"
chmod +x "$REPO/.agents/skills/trpg-gm/scripts/trpg-gm"

SKILL_SOURCE="$REPO/.agents/skills/trpg-gm"
```

如果 repository 已經存在，請不要再次 clone；改用下方的更新命令。

先直接驗證 Python CLI：

```bash
"$SKILL_SOURCE/scripts/trpg-gm" --help
```

Skill symlink 可以共用同一份 Git checkout；之後 `git pull` 即可讓所有 agent 同步更新。

### 2. 安裝到 Pi Agent（Skill + Extension）

這個 repository 現在是完整的 Pi package。`package.json` 會同時註冊：

```text
.agents/skills/trpg-gm/       # GM Skill
extensions/trpg-gm-guard.js   # Pi lifecycle hooks
```

Extension 具有與 Pi 相同的系統權限；安裝前請先檢查原始碼。只 symlink `SKILL.md` 不會安裝 Extension。

#### 從已 clone 的目錄全域安裝

```bash
pi install "$REPO"
pi list
```

Local path package 不會被複製；Pi 直接使用這份 checkout。首次安裝後，長期存活的 Pi process 需重新啟動，或在已開啟的 session 執行：

```text
/reload
/skill:trpg-gm
```

若 Piweb／Piscord 每則訊息都會 spawn 新 Pi process，下一則訊息便會讀取目前 checkout，不需另外 deploy 或重啟 gateway service。完整差異與驗證方式見 [`docs/PI_AGENT_DEPLOYMENT.md`](docs/PI_AGENT_DEPLOYMENT.md)。

#### 直接從 Git repository 全域安裝

Repository 發布後可省略手動 clone：

```bash
pi install https://github.com/<owner>/trpg-gm-skill
# SSH private repository：
# pi install git:git@github.com:<owner>/trpg-gm-skill
```

Pi 會 clone repository、執行 package install，並依 `package.json` 載入 Skill 與 Extension。

#### 只安裝到某個遊戲 workspace

```bash
GAME_DIR=/path/to/my-trpg-workspace
cd "$GAME_DIR"
pi install -l "$REPO"
```

這會寫入 `$GAME_DIR/.pi/settings.json`。從該 workspace 啟動 Pi 並接受 project trust 後才會載入 package。

#### 不安裝，單次測試

```bash
pi -e "$REPO" -p '/skill:trpg-gm 我想玩 TRPG'
```

#### 確認 Extension 正在運作

使用 `/skill:trpg-gm` 後，每個遊戲回合都會看到 `TRPG GM Guard` checklist；agent 也會取得 typed gameplay tools、raw fallback `trpg_gm_cli` 與 `trpg_turn_finalize`。Extension 會：

1. 在 `before_agent_start` 注入當回合檢查表。
2. 優先以 `trpg_gm_context`、`trpg_gm_action_adjudicate`、`trpg_gm_check`、`trpg_gm_entity_upsert`、`trpg_gm_character_adjust`、`trpg_gm_character_availability`、`trpg_gm_story_objective`、`trpg_gm_story_progress`、`trpg_gm_story_intervene`、`trpg_gm_canon_set`、`trpg_gm_recap_save` 的命名欄位執行 gameplay；只有未涵蓋的 setup/query 才使用 raw `trpg_gm_cli`。所有工具共用同一套 exact-room、裁定、check 與 mutation tracking，Pi 遊戲回合不解析任意 bash 字串。
3. 要求每項玩家遊戲內行動先保存接受／拒絕裁定、設定依據與原因；DB guardrail 命中時會把錯誤的 `accepted` 強制改成 `rejected`。被拒絕的行動不能擲骰或改變世界狀態，拒絕理由會自動附加到玩家回覆。
4. 角色生成後，要求 GM 先根據已保存的角色背景／概念設定具體開場 chapter/objective，呈現玩家可感知的故事背景並交還第一個行動選擇；完成前拒絕玩家 action 與 finalization。
5. 拒絕 gameplay 回合沒有先讀取 context、沒有交代行動裁定／檢定後果，或未確認秘密、玩家自主權及詳細敘事品質的 finalization；尚未取得 room／開團資訊時可使用受限的 `clarification` 回合。
6. 在 `message_end` 發現未 finalization、敘事過短或 rejected action 被寫成已完成時，隱藏不合格回覆，將 machine-readable error code 以 `display:false` follow-up 回傳 agent並立即觸發自我修正；最多重試三次，`agent_settled` 則保留為未完成回合的 fallback。

Extension 不會猜測或自動寫入故事內容；實際狀態仍只能由 Python CLI 寫入 SQLite。

### GM 負責詳細講述故事

GM 不能只回報資料庫狀態或用幾句摘要跳過場景。每個 gameplay 場景都應以小說式的具體段落呈現玩家可感知的世界：交代空間布局、出入口與物件位置，選擇有辨識度的視覺、聲音、氣味、溫度或觸感，描寫 NPC 的語氣、表情、動作，以及背景環境如何持續活動。事件發生時要寫出過程、可見後果與場景前後的變化，而不只說「成功」「失敗」或「出現敵人」。Rejected action 還要說明缺少的前置條件，並提供精簡、grounded、非強迫的可行下一步（通常一至三個）；只能引用已建立的障礙、工具、路徑或 NPC，不得捏造尚未發現的解法或保證成功。

細節必須服務氣氛、空間理解、壓力與玩家選擇，並以劇本、canon 和已保存狀態為準；命名、可重用或會影響後續的新增細節仍須先持久化。詳細敘事只擴充 GM 控制的世界與 NPC，不授權 GM 替任何玩家角色補寫思想、情緒、台詞、移動、決定或反應。`trpg_turn_finalize` 因此要求 `narrativeDetailChecked=true`，確認 gameplay 回覆已達到這項標準。

### 創角後優先引導故事開場

完成 `creation roll` 後，`context.story_progress.opening_guidance_required` 會變成 true，並以 `opening_character_ids` 指出尚未銜接故事的角色。GM 必須先讀取這些角色已保存的背景與概念，使用 `trpg_gm_story_objective` 保存具體開場章節、目標及背景依據；`openingCharacterIds` 必須精確包含所有待銜接角色，reason 必須逐一引用各角色已保存的背景或概念原文，再向玩家描述可感知的時代、地點、眼前事件與故事鉤子。

開場只建立世界局面，不替玩家角色決定動機、台詞、移動、情緒反應或是否接受任務；敘述後應直接詢問玩家第一步要做什麼。objective 尚未保存時，SQLite 核心會拒絕新 action，Pi finalizer 也會拒絕輸出，確保 GM 不會在創角完成後停在角色數值表或直接跳過故事背景。

### 多玩家公平參與

每次 `context` 都包含持久化的 `participation` 摘要：各角色累積行動、已接受行動、最後行動事件、目前是否能行動，以及 `next_spotlight_character_ids`。GM 在下一個自然決策點必須優先邀請累積參與較少且仍能行動的玩家，不能讓最積極的單一玩家長期壟斷劇情。多人仍可行動時，`trpg_turn_finalize` 會要求 `nextSpotlightCharacterId`，且只接受重新計算後優先名單中的角色。

HP 為 0 的角色會自動排除。其他確定的昏迷、束縛、石化或離場狀態，必須透過 `trpg_gm_character_availability` 保存原因；狀態解除後恢復 `canAct=true`。SQLite 核心會拒絕目前不能行動角色的不可能行動。這裡追蹤的是平等的「有意義參與機會」，不允許 GM 為湊數代替玩家宣告行動。

### 防止劇情原地打轉

`context.story_progress` 會保存目前章節、具體目標與連續未推進的玩家 action 數。每個 accepted action 裁定後，GM 必須保存 `advanced` 或 `stalled` 與理由；rejected action 不改變世界，因此不進入此時鐘。連續第三次 `stalled` 時，SQLite 核心會拒絕第四個 action，也禁止直接更換 objective 清零；Pi finalizer 同時要求先使用 `trpg_gm_story_intervene` 保存具體的世界事件與預期推進方向。

介入事件應提供新壓力、可見線索、NPC 主動行為或環境改變，使玩家能朝下一章／目標前進。需要強制轉場時，事件本身必須直接改變場景：讓 NPC 或危險來到目前地點、讓外部環境改變、開啟通路，或在玩家已宣告搭乘／移動後直接寫到抵達；不得要求玩家先選 GM 指定的特定選項、接受唯一任務或從假選單中挑唯一有效答案，才允許進下一幕。

事件發生並持久化後，GM 描述新的可見局面，再用開放式問題將行動權交還玩家。若玩家尚未宣告移動，GM 不得替角色走到下一個地點，而應把下一幕的壓力帶到角色目前所在處。SQLite 會拒絕中英文常見的「必須選擇／接受某選項才能繼續」介入文字，通過後保存 `transition_mode=direct_world_event` 與 `requires_prescribed_player_choice=false`；這是 bounded text validation，未列入模式的全新語意改寫仍須由 GM 規範及 review 防護。`trpg_turn_finalize` 會在有 `story_intervention` 的回合要求 `eventDrivenTransitionChecked=true`。介入不能代替玩家角色決策、保證成功、洩漏秘密或改寫 canon；成功介入後停滯計數歸零。

### 3. 安裝到 OpenAI Codex CLI／IDE

Codex 與 Pi 可以共用同一個使用者層級路徑：

```bash
mkdir -p "$HOME/.agents/skills"
ln -s "$SKILL_SOURCE" "$HOME/.agents/skills/trpg-gm"
```

Codex 官方支援 global `~/.agents/skills`、project `.agents/skills` 與 symlinked skill folders。重新啟動 Codex；在 CLI 或 IDE 中輸入 `$` 選取 `trpg-gm`，或明確寫：

```text
$trpg-gm 我想繼續舊團並看 recap
```

專案限定安裝方式與 Pi 相同：

```bash
mkdir -p /path/to/game/.agents/skills
ln -s "$SKILL_SOURCE" /path/to/game/.agents/skills/trpg-gm
```

### 4. 安裝到 Claude Code

Claude Code 的個人 Skill 路徑是 `~/.claude/skills/`，並正式支援 skill directory symlink：

```bash
mkdir -p "$HOME/.claude/skills"
ln -s "$SKILL_SOURCE" "$HOME/.claude/skills/trpg-gm"
```

重新啟動 Claude Code，或在支援 live skill detection 的版本中等待重新掃描。使用：

```text
/trpg-gm 我想開一個新團
```

專案限定安裝：

```bash
GAME_DIR=/path/to/my-trpg-workspace
mkdir -p "$GAME_DIR/.claude/skills"
ln -s "$SKILL_SOURCE" "$GAME_DIR/.claude/skills/trpg-gm"
```

Claude Code 只會自動掃描 `.claude/skills`，不會把本 repo 的 `.agents/skills` 當作 Claude project Skill，因此需要上述 symlink。

### 5. 安裝到 Hermes Agent

Hermes 的主要 Skill 目錄是 `$HERMES_HOME/skills/`，預設為 `~/.hermes/skills/`。

#### 方法 A：直接 symlink

```bash
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
mkdir -p "$HERMES_HOME/skills"
ln -s "$SKILL_SOURCE" "$HERMES_HOME/skills/trpg-gm"
```

重新啟動 Hermes，或開新 session，然後使用：

```text
/trpg-gm 我想玩 TRPG
```

確認安裝：

```bash
hermes skills list
```

#### 方法 B：讓 Hermes 共用 `~/.agents/skills`

如果 Pi 和 Codex 已經使用 `~/.agents/skills/trpg-gm`，可在 `~/.hermes/config.yaml` 加入：

```yaml
skills:
  external_dirs:
    - ~/.agents/skills
```

如此不需要第二個 symlink。重新啟動 Hermes 或 `/reset`，再用 `/trpg-gm` 載入。

> Hermes 的 external skill directory 若可寫，agent 也可能修改其中內容；需要唯讀部署時請使用檔案權限限制。

### 6. 共用安裝快速版

Pi 應安裝完整 package 才會取得 hooks；Codex 與 Hermes 可以共用 `~/.agents/skills`，Claude Code 另外建立 symlink：

```bash
# Pi：Skill + Extension
pi install "$REPO"

# 其他 agents：共用跨平台 Skill（沒有 Pi hooks）
mkdir -p "$HOME/.agents/skills" "$HOME/.claude/skills"
ln -s "$SKILL_SOURCE" "$HOME/.agents/skills/trpg-gm"
ln -s "$SKILL_SOURCE" "$HOME/.claude/skills/trpg-gm"

# Hermes config.yaml 再加入：
# skills:
#   external_dirs:
#     - ~/.agents/skills
```

最終結構：

```text
~/.local/share/trpg-gm-skill/          # 完整 Git clone + Python + Pi Extension
├── .agents/skills/trpg-gm/
└── extensions/trpg-gm-guard.js

Pi settings                             # 指向完整 local package
~/.agents/skills/trpg-gm               # Codex + Hermes，共用 symlink
~/.claude/skills/trpg-gm               # Claude Code symlink
~/.hermes/config.yaml                  # Hermes external_dirs 指向 ~/.agents/skills
```

### 更新 Extension 與 Skill

#### Local clone 安裝

Pi 直接讀取 checkout，所以更新同一個 clone 即可：

```bash
git -C "$REPO" pull --ff-only
cd "$REPO"
npm test
```

測試通過後，長期存活的 Pi session 執行：

```text
/reload
```

`/reload` 會重新載入 package 的 Skill 與 Extension；symlink 不需要重建。若 Piweb／Piscord gateway 對每則訊息啟動新 Pi process，下一則訊息已會直接載入更新後的 checkout，不必重新執行 `pi install`、重新掛載、複製檔案或重啟 gateway。只有 `pi list` 不再解析至預期路徑、checkout 已移動，或 gateway 本身不健康時才需修復掛載或服務。

詳細部署矩陣與 troubleshooting：[`docs/PI_AGENT_DEPLOYMENT.md`](docs/PI_AGENT_DEPLOYMENT.md)。

#### Git URL 安裝

未固定 ref 的 Git package：

```bash
pi update --extension https://github.com/<owner>/trpg-gm-skill
# 或更新全部已安裝 packages：
pi update --extensions
```

如果安裝來源包含固定 tag／commit，例如 `@v0.2.0`，一般 update 不會移動到新版本。請明確安裝新 ref：

```bash
pi install git:github.com/<owner>/trpg-gm-skill@v0.3.0
```

更新完成後重新啟動 Pi 或執行 `/reload`。可用 `pi list` 確認 package 來源，用 `pi config` 啟用／停用其中的 Skill 或 Extension。

### 移除

先用當初相同的 package source 從 Pi 移除，再處理其他 agents 的 symlink。**不要刪除 campaign DB**：遊戲資料應放在遊戲 workspace 的 `.trpg/rooms/`，而不是安裝 repository 裡。

```bash
# Local path 安裝：
pi remove "$REPO"
# Git URL 安裝則使用：pi remove https://github.com/<owner>/trpg-gm-skill

rm "$HOME/.agents/skills/trpg-gm"
rm "$HOME/.claude/skills/trpg-gm"
# 如果使用 Hermes direct symlink：
rm "${HERMES_HOME:-$HOME/.hermes}/skills/trpg-gm"

# 確認沒有需要保留的檔案後才執行：
rm -rf "$REPO"
```

安裝與 hooks 依據官方文件：[Pi Packages](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md)、[Pi Extensions](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)、[Pi Skills](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md)、[Codex Build skills](https://learn.chatgpt.com/docs/build-skills)、[Claude Code Skills](https://code.claude.com/docs/en/slash-commands)、[Hermes Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)。

## 系統組成

```text
玩家訊息
   │
   ▼
AI Agent
   │ 載入 SKILL.md：主持規範、每回合流程、資訊揭露規則
   │
Pi Extension（Pi 環境）
   │ 注入 checklist、追蹤成功工具操作、要求 turn finalization
   │
   ├── 讀劇本檔案：世界觀、場景、NPC 與預寫內容
   │
   └── Pi：呼叫 trpg_gm_cli；其他 agent：呼叫 scripts/trpg-gm
             │
             ▼
        Python CLI
             │ 驗證命令、執行判定、讀寫狀態
             ▼
        GameStore / SQLite
             ├── room 與劇本路徑
             ├── 玩家角色、HP／MP／SAN、能力
             ├── NPC、支線、場景、地點、線索
             ├── canon 固定事實
             ├── player-safe session recaps
             └── append-only 事件與判定紀錄
```

## Skill 負責什麼

Skill 位於 `.agents/skills/trpg-gm/SKILL.md`。它是給 agent 閱讀的主持手冊，不直接保存資料，也不負責計算 SQL。

Skill 負責：

1. **主持風格與權責**
   - Agent 控制世界、NPC、規則與後果。
   - 玩家只控制自己的角色。
   - Agent 不替玩家角色說話、思考或做關鍵決定。

2. **每回合操作順序**
   - 先確認目前的 room。
   - 在敘事前讀取 room context。
   - 檢查劇本、canon、角色與最近事件。
   - 使用 `action adjudicate` 保存玩家行動是否符合設定，以及具體依據與原因。
   - 只有接受的行動才可在必要時執行判定。
   - 先保存確定發生的狀態變化，再描述結果。

3. **劇本與即興處理**
   - 有 `script_path` 時，提醒並讀取對應劇本。
   - 路徑失效時停止猜測，請玩家提供正確路徑。
   - 沒有劇本時，告知玩家將採即興模式，再建立並保存 premise、NPC、場景與衝突。

4. **敘事一致性**
   - 使用 canon 與 event history 檢查新內容是否矛盾。
   - 區分「GM 知道的真相」與「角色已經知道的資訊」。
   - 不洩漏尚未發現的線索、NPC 祕密或劇本幕後內容。

5. **裁定原則**
   - 可以拒絕缺乏設定依據、超出角色能力、違反 canon／規則或在目前場景不可能的行動，但必須保存並向玩家說明具體原因。
   - 劇本沒有逐字列出的合理創意行動不能只因「沒寫」而拒絕。
   - 不得僅以現代法律、當代風俗習慣、現代道德或政治正確否決虛構行動；以劇本的時空背景判斷能否嘗試，再套用符合時代的風險與後果。例如 18xx 年角色可以嘗試搶銀行並騎馬逃跑，但不保證成功，也不免除警衛、目擊、追捕、通緝或名聲後果。
   - `guardrail add` 只應保存劇本／canon 明文禁止事項或玩家同意的 table boundary，不得由 GM 自行推測現代規範建立。
   - 只有行動已接受、結果不確定，而且失敗有意義時才擲骰。
   - 擲骰前告知能力、目標值與可見風險。
   - 不因想推劇情而修改骰子或讓唯一線索永久消失。

6. **支線與世界運作**
   - 決定 NPC 如何反應、支線如何發展、場景如何變化。
   - 將可重複使用的細節保存成 entity。
   - 每次回覆最後把決定權交還玩家，例如「你要怎麼做？」。

更完整的主持規範：`.agents/skills/trpg-gm/references/GM_PROTOCOL.md`。

## Pi Extension 負責什麼

Extension 位於 `extensions/trpg-gm-guard.js`，只在 Pi Agent 中運作；Agent Skills 標準本身沒有 lifecycle hooks，因此 Claude Code、Codex 與 Hermes 載入相同 Skill 時不會取得這一層保護。

Extension 使用 Pi lifecycle API：

- `input`：辨識明確的 `/skill:trpg-gm`、要求 agent 當 GM／主持冒險，以及 TRPG 開團／續團遊戲請求，啟用 session guard；只討論或修改 `trpg-gm` 程式碼與 README 不會啟用。
- `before_agent_start`：每回合注入 context、狀態保存、秘密資訊及玩家自主權 checklist。
- Typed gameplay tools：`trpg_gm_context`、`trpg_gm_action_adjudicate`、`trpg_gm_check`、`trpg_gm_entity_upsert`、`trpg_gm_character_adjust`、`trpg_gm_character_availability`、`trpg_gm_story_objective`、`trpg_gm_story_progress`、`trpg_gm_story_intervene`、`trpg_gm_canon_set`、`trpg_gm_recap_save` 使用命名欄位與 JSON object，避免模型漏掉 `adjudicate`、room、entity name、傳入非法 decision 或組出壞 JSON。
- Raw `trpg_gm_cli` fallback：只供 typed tools 尚未涵蓋的 setup/query；以 `pi.exec(executable, args[])` 安全傳遞結構化 tokens。所有工具都在成功後才記錄 exact room、context、玩家行動裁定、check 與 mutation；失敗不更新 guard 狀態。
- `message_end`：每個新的 user message 都重設 turn-local adjudication／finalization 狀態，避免 Piweb／RPC 未觸發 `input` hook 時沿用上一回合；不合格的 assistant 回覆會被替換成空內容，並以隱藏的 `TRPG_TURN_NOT_FINALIZED`、`TRPG_ACTION_NARRATIVE_TOO_TERSE` 或 `TRPG_REJECTED_ACTION_REPLAYED` follow-up 回傳 agent，立即觸發同回合自我修正，而不是把內部 Guard 訊息顯示給玩家；連續三次仍未修正時停止自動循環，並以不含內部代碼的玩家安全文字說明鎖住原因：尚未完成狀態確認與保存、缺少完整場景敘事，或仍可能把 rejected action 誤寫成已發生；同時提供對應的可執行建議，例如原樣重送以重新載入／保存、維持角色意圖重送以補齊敘事，或先調查障礙、尋找已存在的工具／其他路徑來建立前置條件。
- `agent_settled`：等 retry／compaction 全部完成後，若仍缺少 context 或 finalization，作為 fallback 排入一次 follow-up。
- Session custom entry：保存 guard 已啟用狀態，使 `/reload` 或 resume 後仍可恢復。

Extension 另提供 `trpg_turn_finalize` 工具。Agent 必須在所有狀態操作完成後、玩家可見回答之前呼叫；工具會拒絕以下情況：

- `gameplay` 回合沒有成功載入 room context；只有等待玩家提供 room／開團資訊時才能使用 `clarification` 例外。
- `playerActionStatus` 宣稱接受／拒絕，但沒有對應的持久化 `action adjudicate` 事件，或宣稱無玩家行動卻沒有 `noPlayerActionReason`。
- 被拒絕的玩家行動仍執行了判定或世界狀態 mutation。
- 宣稱保存了狀態，但實際未觀察到成功的 mutation。
- 執行判定後既未保存後果，也沒有合理的 `noStateChangeReason`，或判定之前沒有已接受的行動裁定。
- 沒有確認 player-facing 回覆已排除 GM secret。
- 沒有以 `narrativeDetailChecked=true` 確認 gameplay 回覆已準備小說式的空間、感官、世界活動與事件變化細節。
- 保存 `story_intervention` 後，沒有以 `eventDrivenTransitionChecked=true` 確認強制轉場由劇情事件直接發生，而非逼玩家選擇指定選項。
- 沒有確認玩家角色的額外決策仍交給玩家。

`trpg_turn_finalize` 的 `turnKind` 通常使用 `gameplay`。若 Skill 正在詢問「新團或舊團」、room-id、劇本或角色等缺少資訊，可使用 `clarification`，並在 `noStateChangeReason` 說明正在等待哪一項玩家輸入；已經擲骰或寫入狀態的回合不能藉此跳過驗證。

這是一個流程 guard，不是安全邊界或完整的故事內容審查器。`narrativeDetailChecked` 仍是模型在輸出前的強制自我確認；此外，v0.13 起 `message_end` 對每個已裁定 action 執行 bounded prose validation：移除交棒問句與 Markdown 清單後，至少要有一段 60 個 meaningful characters、兩個句末標點的敘事。Rejected action 的最終文字若逐字重播其正規化 action 原句也會被阻擋，以免把未發生的嘗試寫成既成事實。v0.13.1 起，這些錯誤不再以玩家可見的 Guard 文字取代答案，而是隱藏不合格回覆並以 machine-readable、`display:false` follow-up 促使 agent 自我修正。這些長度、句子及 literal-match 檢查不能直接量測真正文學性，也不能識別所有語意改寫、秘密洩漏或漏存線索；`message_end` 只能替換 finalized message，若某個前端直接呈現 token streaming，仍可能在驗證前短暫看到模型原始文字。秘密資訊、敘事品質與持久化完整性仍須由 Skill 規範、結構化 finalization、SQLite 事件紀錄、production-like E2E 及人工監督共同防護。

## Python 負責什麼

Python 程式位於 `src/trpg_gm/`。它不創作故事，也不自行決定 NPC 行為；它是 agent 的狀態工具與規則執行器。

### `cli.py`

提供 agent 可呼叫的命令列介面：

- 建立 room
- 設定劇本相容的捏角規則與技能數量
- 保存角色外觀、背景、概念及技能提案的接受／拒絕裁定
- 擲骰生成技能值與公平約束的 HP／MP／SAN 上限
- 調整 HP／MP／SAN，但不得超過生成上限
- 新增或更新 entity
- 寫入 canon
- 執行並保存 d100 判定
- 取得完整 room context
- 查詢事件紀錄
- 保存與讀取最新的玩家安全 recap

所有結果都輸出 JSON，方便 agent 重新讀取。

### `store.py`

負責 SQLite schema 與資料一致性：

- 以 `room_id` 隔離不同遊戲。
- 保存角色外觀、背景、概念、捏角規則、提案與世界狀態。
- 驗證技能數量及 allowed skills，拒絕強行接受不符合世界觀的技能。
- 保存技能與 HP／MP／SAN 上限的原始骰值，並以 `max_party_difference` 限制同團角色資源差距。
- 將角色生成、資源變動、entity 更新與判定寫入事件紀錄。
- 遇到 canon 舊值與新值不同時直接拒絕，防止 agent 靜默吃書。
- 將 room、角色、canon、entities 與 recent events 組合成每回合 context。
- 以 append-only snapshots 保存 player-safe recaps，供新 session 回顧舊團。

### `rules.py`

目前提供 CoC 類型的 d100 判定：

- critical
- extreme
- hard
- success
- failure
- fumble

Python 只計算並記錄結果；如何把成功或失敗轉化成遊戲情節，仍由 Skill 指導 agent 決定。

### SQLite 負責什麼

SQLite 是遊戲狀態的持久化來源。即使 agent 重啟、對話被截斷或換了一個 session，只要它重新載入同一個 room DB，就能取得必要狀態。

建議每個 room 使用獨立檔案：

```text
.trpg/rooms/<room-id>.sqlite3
```

資料庫不是玩家可見的完整敘事。裡面可能包含 NPC 祕密與未發現線索；agent 必須依照 Skill 的資訊分層規則決定哪些內容能說出口。

## 完整遊戲 Workflow

### 0. 選擇開新團或繼續舊團

如果玩家只說想玩 TRPG，卻沒有指定 room，GM 先問：

> 要開一個新團，還是繼續舊團並先看 recap？

- **新團**：進入建房、劇本與創角流程。
- **舊團**：請玩家選擇 room，不能由 agent 自行猜測。Agent 私下讀 `context` 恢復完整 GM 狀態，再用 `recap show` 取得玩家可見摘要。

```bash
GM=.agents/skills/trpg-gm/scripts/trpg-gm
$GM --db "$DB" context demo
$GM --db "$DB" recap show demo
```

`context` 可能含有 NPC secret 與未發現線索，只能供 GM 判斷；`recap` 專門保存可以直接告訴玩家的內容。若舊團尚無 recap，agent 應從 context 整理最小的玩家安全摘要、保存後再顯示。

### 1. 建立遊戲房間

Agent 先確認：

- room-id
- 使用的 TRPG 系統
- 劇本路徑，可留空
- 遊戲基調與玩家界線
- 玩家角色資料

接著建立 room：

```bash
GM=.agents/skills/trpg-gm/scripts/trpg-gm
DB=.trpg/rooms/miskatonic.sqlite3

$GM --db "$DB" room create miskatonic \
  --system coc7 \
  --script /absolute/path/scenario.md \
  --seed 42
```

`script_path` 只保存路徑，劇本內容仍由 agent 使用檔案工具讀取，不會複製進 SQLite。

### 2. 持久化捏角

GM 先依劇本／canon 設定本團技能數、可選技能、建議技能、能力值範圍與 HP／MP／SAN 公平限制：

```bash
$GM --db "$DB" creation configure miskatonic \
  --basis 'scenario.md#investigator-creation' \
  --rules '{"skill_count":3,"allowed_skills":["偵查","聆聽","圖書館使用","說服"],"recommended_skills":["偵查","圖書館使用"],"skill_min":20,"skill_max":80,"resources":{"hp":{"base":8,"die":6,"max_party_difference":2},"mp":{"base":6,"die":6,"max_party_difference":2},"san":{"base":45,"die":30,"max_party_difference":10}}}'
```

玩家填寫姓名、外觀、背景與概念，並可接受 GM 建議或自行從 allowed skills 選擇劇本要求的技能數。GM 用 `creation propose` 保存接受／拒絕、原因與設定依據；不符合世界觀時可以拒絕，但不能替玩家選擇。

```bash
$GM --db "$DB" creation propose miskatonic alice 艾莉絲 \
  --appearance '黑髮，穿舊式記者風衣' \
  --background '地方報社記者' \
  --concept '追查失蹤案的民間調查者' \
  --skills '["偵查","圖書館使用","說服"]' \
  --decision accepted \
  --basis '符合現代調查劇本與 allowed skills' \
  --reason '外觀、背景、概念與技能符合世界觀'

$GM --db "$DB" creation roll miskatonic alice
```

技能各擲 d100 並映射到設定範圍；HP／MP／SAN 上限也會擲骰。新角色的最終資源上限會被限制在與每位既有隊友的 `max_party_difference` 內，原始 roll 與調整後結果都會保存和回報。`character add` 僅供舊角色匯入。

玩家角色建立後，agent 不可以自行替角色採取行動。

### 3. 建立初始世界狀態

可變動資料使用 entity：

```bash
$GM --db "$DB" entity miskatonic quest find-lin '尋找林教授' \
  --state '{"status":"active","known":true,"leads":["old-library"]}'

$GM --db "$DB" entity miskatonic npc caretaker '老管理員' \
  --state '{"status":"alive","location":"old-library","attitude":"wary","secret":"has-key"}'
```

不應被任意改寫的事實使用 canon：

```bash
$GM --db "$DB" canon miskatonic 'npc:lin:status' '失蹤' \
  --source 'scenario.md#scene-2'
```

- **Entity**：會改變的狀態，例如 NPC 位置、支線進度、門是否打開。
- **Canon**：已確立的事實，例如某人的身分、事件真相、已確認的歷史。

### 4. 每次收到玩家行動

Agent 必須先載入狀態：

```bash
$GM --db "$DB" context miskatonic --events 30
```

然後依序處理：

```text
玩家宣告行動
  → 載入 context
  → 讀取相關劇本段落
  → 檢查角色是否能執行
  → action adjudicate 保存接受／拒絕、依據與原因
  → 若拒絕：不擲骰、不改狀態，向玩家說明原因
  → 若接受：判斷是否需要擲骰
  → 執行判定
  → 寫入資源、NPC、線索或支線變化
  → Pi：呼叫 trpg_turn_finalize 驗證本回合
  → 描述玩家角色能感知的結果
  → 詢問下一步行動
```

### 5. 先裁定玩家行動

```bash
$GM --db "$DB" action adjudicate miskatonic alice '展開翅膀飛過鎖門' \
  --decision rejected \
  --basis '角色卡、canon 與劇本均未建立飛行能力' \
  --reason '角色沒有翅膀或其他飛行手段'
```

接受與拒絕都會保存為 `action_adjudicated` 事件。拒絕必須說明原因與設定依據，而且不能接著擲骰或寫入該行動的世界後果。

### 6. 需要判定時

由程式擲 d100 並保存結果：

```bash
$GM --db "$DB" check miskatonic alice 聆聽
```

若使用實體骰或玩家已經擲出結果：

```bash
$GM --db "$DB" check miskatonic alice 聆聽 --roll 20
```

Agent 必須接受記錄下來的結果，不可以因劇情需要重新擲骰。

### 7. 套用遊戲後果

例如失去 SAN：

```bash
$GM --db "$DB" character adjust miskatonic alice san -5 \
  --reason '目擊神話生物'
```

例如 NPC 改變位置：

```bash
$GM --db "$DB" entity miskatonic npc caretaker '老管理員' \
  --state '{"status":"alive","location":"basement","attitude":"hostile","secret":"has-key"}'
```

`entity` 是 merge-upsert：有提供的 key 會更新，沒提供的欄位會保留。這可避免 agent 只更新 NPC 態度時，意外刪掉既有祕密或其他狀態；目前尚未提供刪除單一欄位的命令。

### 7. 回覆玩家

Agent 根據已保存的結果產生遊戲內敘事。每一次玩家行動都必須獲得至少一小段小說式回覆，無論裁定是 accepted、rejected、規則不允許或當下不可能；不得只輸出「某人做了什麼／不允許，下一位要怎麼做？」就交棒。Rejected 行動沒有實際發生，因此只能描寫玩家可見的既有障礙、未改變環境或 NPC／世界狀態，然後清楚說明拒絕理由，不得捏造行動成功或世界後果。

回覆通常包含：

1. 場景與感官資訊
2. NPC 或環境反應；若 rejected，則呈現既有障礙或可感知限制
3. 判定、裁定理由與可見資源變化
4. 目前壓力或已發現線索
5. 「你要怎麼做？」

資料庫裡的 GM 祕密不能直接全部輸出。

### 8. Session 結束

Agent 在自然停點前應：

- 更新目前 scene
- 更新所有 active quest
- 更新 NPC 位置與狀態
- 保存新發現的線索
- 保存 HP／MP／SAN 變化
- 將穩定且重要的新事實寫入 canon
- 產生不包含祕密的玩家摘要
- 使用 `recap save` 保存該摘要

```bash
$GM --db "$DB" recap save miskatonic \
  --summary '調查者已進入舊診療所。' \
  --state '{"location":"後門通道","known_goals":["尋找失聯者"],"known_clues":["拖曳痕跡"],"party_conditions":["陳柏翰手部輕傷"],"immediate_danger":"深處傳來金屬聲"}'
```

Recap 不可包含未發現線索、NPC secret、劇本真相、伏筆或 GM notes。下一次遊戲使用相同 room-id 與 DB 時，agent 以 `context` 恢復主持狀態，以 `recap show` 向玩家回顧舊團。

## Skill 與 Python 的責任邊界

| 問題 | Skill / Agent | Python / SQLite |
|---|---|---|
| 接下來發生什麼故事？ | 決定 | 不決定 |
| NPC 如何反應？ | 決定並保存 | 保存結果 |
| 玩家角色要做什麼？ | 等玩家宣告 | 不決定 |
| 是否需要判定？ | 根據情境判斷 | 不主動判斷 |
| 骰子結果與成功等級？ | 呼叫工具並接受結果 | 計算及記錄 |
| HP／MP／SAN 如何變化？ | 決定合理後果 | 原子化更新及記錄 |
| 哪些資訊能告訴玩家？ | 根據角色認知決定 | 不負責資訊揭露 |
| 防止不同 room 串資料 | 選對 room-id | 以 room-id／DB 隔離 |
| 防止 canon 被改寫 | 發現衝突後解釋或詢問 | 拒絕不同值覆寫 |
| 對話中斷後恢復 | 讀 context，向玩家顯示 recap | 持久保存完整狀態與安全摘要 |

簡單說：**Skill 管主持決策，Pi Extension 管每回合流程 guard，Python 管可驗證的狀態與規則。**

## 快速開始

```bash
git clone <this-repository>
cd trpg-gm-skill
chmod +x .agents/skills/trpg-gm/scripts/trpg-gm

GM=.agents/skills/trpg-gm/scripts/trpg-gm
DB=.trpg/rooms/demo.sqlite3

$GM --db "$DB" room create demo --system coc7 --script /absolute/path/scenario.md
$GM --db "$DB" character add demo alice 艾莉絲 \
  --hp 10 --mp 8 --san 55 --stats '{"聆聽":60,"圖書館使用":70}'
$GM --db "$DB" context demo
```

Pi 若只信任並開啟此 repo，會從 `.agents/skills/` 發現 Skill，但不會因此自動安裝 package Extension。要同時取得 hooks，請先執行 `pi install "$PWD"`；其他支援 Agent Skills 規格的 agent harness 則可直接載入該 Skill 目錄。

完整 CLI 命令請見 `.agents/skills/trpg-gm/references/CLI.md`。

## 測試

### 測試哲學：每一個改動都要跑

本專案把測試視為功能的一部分，不是完成後才補做的檢查。**任何改動——包含 Python、Pi Extension、Skill 指令、文件、CLI 範例、package metadata 與版本號——在 commit 或 push 前都必須執行完整的 `npm test`。** 不得以「只改一行」、「只改文件」或「本機看起來正常」為理由跳過。

開發與維護遵守以下原則：

1. **RED → GREEN → REFACTOR**：功能或 bugfix 先新增能重現需求／漏洞且確實失敗的 regression test，再做最小修正，最後在完整測試仍通過的前提下整理程式。
2. **每個缺陷都留下測試**：實玩、code review 或惡意玩家找到的每一條繞過方式，都必須轉成永久 regression test，不能只修當下案例。
3. **測持久狀態，不只測文字回覆**：agent 說「已拒絕」不代表安全；測試必須直接檢查 SQLite event、角色資源、canon、entity、guardrail 與 finalization 紀錄，確認沒有偷偷擲骰或改變世界。
4. **跨層防禦要分層驗證**：Python／SQLite 測不可繞過的核心規則；Node.js 測 Pi lifecycle、structured tools 與 finalization；真實 Pi Agent 測模型是否能正確使用整套 workflow。Prompt instruction 不能代替程式驗證。
5. **同時測 happy path 與 adversarial path**：除了正常創角與行動，也要測越權、假冒 GM、prompt injection、混淆禁止詞、秘密索取、先修改後裁定、options 變形及 legacy command bypass。
6. **跨 session 才算真正持久化**：連續性測試使用相同 room DB、不同 agent sessions，而且不得使用聊天 continuation；新 session 必須只靠 `context` 恢復。
7. **隔離測試資料**：E2E／模型測試使用 `mktemp` 建立 `/tmp` workspace 與獨立 SQLite，不得污染正式 campaign DB。
8. **失敗就不提交**：不得刪除、skip、放寬 assertion 或吞掉錯誤來換取綠燈。先找根因；修正後從 targeted test 回到完整 suite。
9. **回覆不是證據**：模型測試需保留 prompt、response、耗時和機器可讀 evaluation，並以 DB 查詢驗證資源未變、秘密未洩漏、拒絕已保存。
10. **安全與工作流程改動要跑真實 Agent**：凡是修改 guardrail、action adjudication、character creation、context loading、secret handling、tool schema 或 finalizer，除自動測試外，還必須使用 production-like Pi Agent 做隔離的端對端／惡意玩家測試，並將結果寫入 `docs/`。

每次改動的最低驗證門檻：

```bash
npm test
git diff --check
```

建議提交前紀錄當次測試數量與結果。若改動會影響玩家可見行為或安全邊界，還要執行下方的 Pi Agent 多 Session／對抗測試；單元測試不能取代模型實玩，模型實玩也不能取代單元測試。

### 完整自動測試

```bash
npm test
```

這會依序執行：

```bash
PYTHONPATH=src python3 -W error::ResourceWarning -m unittest discover -s tests -v
node --test tests/test_extension.mjs
```

Python 測試驗證 SQLite migration、room 隔離、角色資源、canon 衝突、immutable guardrails、強制拒絕、entity merge-upsert、事件紀錄與 d100 判定。Node.js 測試驗證 Pi package manifest、guard activation、結構化 `trpg_gm_cli` 執行與失敗處理、option-order-safe exact-room tracking、未 finalization 回覆攔截、finalization 拒絕條件及單次 follow-up 行為。

也可先確認 Pi 能載入 Extension module，而不啟動遊戲：

```bash
pi -e ./extensions/trpg-gm-guard.js --list-models
```

### Pi Agent 多 Session 實玩測試

單元測試只能證明 Python 層正確；還需要確認真正的 agent 會載入 Skill、遵守 GM workflow，並在沒有聊天記憶時從 SQLite 接續遊戲。建議使用以下方法進行端對端測試。

#### 測試目標

驗證：

- 未指定 room 的模糊開場會先詢問「新團或舊團 recap」，不會擅自建立遊戲。
- 三名玩家能在同一個 room 建立角色。
- 不同 Pi sessions 不共用聊天歷史，只共用 campaign DB。
- 新 session 會先執行 `context`，而不是自行猜測前情。
- 判定、HP／MP／SAN、NPC、線索、scene 和 quest 都會持久保存。
- Agent 不會透露 `secret`，也不會替玩家決定行動。
- 更新少數 entity 欄位時，不會刪掉未提供的隱藏狀態。

#### 1. 建立隔離的測試環境

```bash
cd trpg-gm-skill

RUN="$(mktemp -d /tmp/trpg-gm-luna-e2e-XXXXXX)"
DB="$RUN/campaign.sqlite3"
SESSION_DIR="$RUN/pi-sessions"
ROOM=luna-playtest
mkdir -p "$SESSION_DIR"
```

測試資料放在 `/tmp`，避免污染正式 campaign。所有 sessions 使用相同的 `$DB` 與 `$ROOM`，但每次 Pi invocation 都建立新的 session；**不要使用 `--continue`**。

以下範例使用 GPT-5.6 Luna。執行前需要在 Pi 完成 `openai-codex` 登入：

```bash
run_luna() {
  local session_name="$1"
  local prompt="$2"

  pi \
    --provider openai-codex \
    --model gpt-5.6-luna \
    --thinking medium \
    --session-dir "$SESSION_DIR" \
    --name "$session_name" \
    --approve \
    --no-extensions \
    --no-skills \
    --skill .agents/skills/trpg-gm/SKILL.md \
    -p "$prompt"
}
```

`--no-skills` 加上明確的 `--skill` 可以避免其他已安裝 Skill 干擾測試；`--approve` 讓非互動模式信任 project-local Skill。

#### 2. Session 1：創角與開場

```bash
run_luna session-1 "$(cat <<EOF
/skill:trpg-gm
你是 TRPG GM。不要修改專案程式碼。
room-id：$ROOM
DB：$DB
沒有劇本，直接採即興 CoC7 恐怖故事。
請在同一個 room 建立：
- yuching／林雨晴，醫師，HP 12、MP 10、SAN 65；急救75、觀察55、心理學50。
- bohan／陳柏翰，工程師，HP 13、MP 8、SAN 60；機械維修70、聆聽55、力量60。
- siyu／吳思妤，民俗學者，HP 9、MP 14、SAN 70；圖書館使用80、神秘學70、說服60。
使用 CLI 真正保存角色，並建立初始 scene、NPC、active quest 與至少一項 canon。
最後提供不洩密的開場，並問玩家要怎麼做。
EOF
)"
```

完成後直接檢查 DB，不要只相信 agent 的文字回覆：

```bash
.agents/skills/trpg-gm/scripts/trpg-gm \
  --db "$DB" context "$ROOM" --events 50
```

此時應有三名角色、至少一個 scene、NPC、active quest 與 canon。

#### 3. Session 2：無聊天記憶接續三名玩家

重新執行 `run_luna` 會建立另一個 Pi session：

```bash
run_luna session-2 "$(cat <<EOF
/skill:trpg-gm
這是新的 Pi session；你沒有上一個 session 的聊天記憶。
room-id：$ROOM
DB：$DB
先用 context 讀取狀態，再主持這一輪：
- 林雨晴檢查後門拖痕。
- 陳柏翰檢查故障配電箱。
- 吳思妤詢問 NPC 最後一次聯絡內容。
符合條件時用 CLI 擲骰並接受結果。保存線索、傷害、NPC、scene 與 quest 變化；不得洩漏 secret。
EOF
)"
```

檢查回覆與 DB 是否一致，例如 agent 若描述角色損失 1 HP，`context` 中也必須真的少 1 HP，且 recent events 應存在 `check_resolved` 和 `resource_changed`。

#### 4. Session 3：再次恢復與 Session recap

```bash
run_luna session-3 "$(cat <<EOF
/skill:trpg-gm
這是第三個獨立 Pi session。只能依靠持久狀態接續。
room-id：$ROOM
DB：$DB
先讀 context。三位玩家沿既有線索進入建築：
- 林雨晴判斷暗紅斑點是否為血。
- 陳柏翰注意室內聲音來源。
- 吳思妤判斷痕跡是否符合民俗儀式。
使用既有角色能力進行合理判定，保存所有結果。只有真正出現恐怖刺激時才能處理 SAN。
結尾提供不洩密的 session recap，再問下一步。
EOF
)"
```

這一輪主要驗證新 agent 能否正確恢復角色位置、先前失敗、已發現線索、NPC 態度和 active quest，而不是重新創造一套不相干的劇情。

#### 5. 驗證最終狀態

```bash
GM=.agents/skills/trpg-gm/scripts/trpg-gm
$GM --db "$DB" context "$ROOM" --events 100 > "$RUN/final-context.json"

python3 - "$RUN/final-context.json" <<'PY'
import json
import sys

context = json.load(open(sys.argv[1]))
assert len(context["characters"]) == 3
assert context["room"]["id"] == "luna-playtest"
assert any(e["kind"] == "quest" for e in context["entities"])
assert any(e["kind"] == "scene" for e in context["entities"])
assert any(e["kind"] == "check_resolved" for e in context["recent_events"])
print("multi-session state OK")
PY
```

也要人工檢查三份 response：

- 敘事中的骰子與 DB event 相同。
- 敘事中的資源變動與角色資料相同。
- 沒有輸出 DB 中尚未公開的 secret。
- 沒有替玩家角色發言或決定下一步。
- 每個 session 最後都有把控制權交還玩家。

#### 6. Entity hidden-state regression smoke test

先加入只有 GM 知道的欄位：

```bash
$GM --db "$DB" entity "$ROOM" npc keeper 管理員 \
  --state '{"status":"alive","attitude":"wary","secret":"has-key"}'

$GM --db "$DB" entity "$ROOM" npc keeper 管理員 \
  --state '{"attitude":"cooperative"}'
```

再次讀取 context，預期得到：

```json
{
  "status": "alive",
  "attitude": "cooperative",
  "secret": "has-key"
}
```

這可驗證 merge-upsert 不會因 agent 只更新態度就遺失 secret。玩家可見回覆仍不得透露 `has-key`。

#### 通過標準

只有以下條件全部成立才算通過：

- Python 單元測試全部成功且沒有 ResourceWarning。
- 至少三個獨立 Pi session files 被建立。
- 三個 sessions 使用同一個 room DB，且沒有使用聊天 session continuation。
- 三名角色與所有資源跨 session 一致。
- 每個 gameplay session 在敘事前呼叫 `context`。
- 判定與資源變化存在事件紀錄。
- Entity partial update 不會移除未提供欄位。
- Session 收尾保存 player-safe recap；舊團入口顯示 recap，而不是完整私密 context。
- 沒有 hidden-information leak、玩家代理行為或靜默 canon rewrite。

本專案實際 Luna playtest 的流程、結果、發現問題與修正紀錄見 [`docs/LUNA_PLAYTEST.md`](docs/LUNA_PLAYTEST.md)。Production Qwen MTP 證據包含：[`QWEN_MTP_GUARDRAIL_PLAYTEST.md`](docs/QWEN_MTP_GUARDRAIL_PLAYTEST.md) 的禁止條款／元敘事攻擊／秘密保護、[`QWEN_OPENING_GUIDANCE_E2E.md`](docs/QWEN_OPENING_GUIDANCE_E2E.md) 的背景導向開場、[`QWEN_NARRATIVE_DETAIL_E2E.md`](docs/QWEN_NARRATIVE_DETAIL_E2E.md) 的小說式敘事、[`QWEN_EVERY_ACTION_NARRATIVE_E2E.md`](docs/QWEN_EVERY_ACTION_NARRATIVE_E2E.md) 的每次 accepted／rejected 行動小說回覆 hook、[`QWEN_HIDDEN_GUARD_RETRY_E2E.md`](docs/QWEN_HIDDEN_GUARD_RETRY_E2E.md) 的隱藏 error code 與 agent 自我修正、[`QWEN_REJECTED_NEXT_STEP_E2E.md`](docs/QWEN_REJECTED_NEXT_STEP_E2E.md) 的 rejected action 前置條件與可行下一步建議、[`QWEN_EVENT_DRIVEN_TRANSITION_E2E.md`](docs/QWEN_EVENT_DRIVEN_TRANSITION_E2E.md) 的事件驅動強制轉場，以及 [`QWEN_ERA_GROUNDED_ADJUDICATION_E2E.md`](docs/QWEN_ERA_GROUNDED_ADJUDICATION_E2E.md) 的時代背景優先犯罪行動裁定。

## 目前邊界

- `room.system` 可以記錄任意系統，但內建判定器目前只實作 CoC 類 d100。
- 其他規則系統應新增 rules adapter；在此之前，agent 不應把 d100 冒充其他系統的正式規則。
- Entity 更新採 merge-upsert，尚未提供刪除單一欄位或自動 schema 驗證。
- Canon 刻意禁止靜默覆寫；正式 retcon 需要先告知玩家，未來可加入專用 retcon event。

## 專案結構

```text
trpg-gm-skill/
├── .agents/skills/trpg-gm/
│   ├── SKILL.md
│   ├── references/
│   │   ├── CLI.md
│   │   └── GM_PROTOCOL.md
│   └── scripts/trpg-gm
├── extensions/
│   └── trpg-gm-guard.js
├── src/trpg_gm/
│   ├── cli.py
│   ├── rules.py
│   └── store.py
├── tests/
│   ├── test_extension.mjs
│   └── test_*.py
├── docs/
│   ├── LUNA_PLAYTEST.md
│   ├── PI_AGENT_DEPLOYMENT.md
│   ├── QWEN_ERA_GROUNDED_ADJUDICATION_E2E.md
│   ├── QWEN_EVERY_ACTION_NARRATIVE_E2E.md
│   ├── QWEN_EVENT_DRIVEN_TRANSITION_E2E.md
│   ├── QWEN_HIDDEN_GUARD_RETRY_E2E.md
│   ├── QWEN_MTP_GUARDRAIL_PLAYTEST.md
│   ├── QWEN_NARRATIVE_DETAIL_E2E.md
│   ├── QWEN_OPENING_GUIDANCE_E2E.md
│   └── QWEN_REJECTED_NEXT_STEP_E2E.md
├── package.json
├── pyproject.toml
└── README.md
```

## License

MIT
