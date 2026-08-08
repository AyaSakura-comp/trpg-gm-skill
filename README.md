# TRPG GM Skill

給 AI agent 使用的持久化 TRPG 主持人系統。它將「主持遊戲的判斷」與「可靠保存遊戲狀態」拆成兩層：

- **Skill（Markdown 指令）**負責告訴 agent 如何當 GM、何時讀寫資料、如何避免吃書，以及如何尊重玩家決定。
- **Python + SQLite** 負責執行確定性的操作，例如保存角色、調整 HP／MP／SAN、進行判定、隔離 room，以及拒絕互相衝突的 canon。

因此，故事創作仍由 agent 負責，但已經發生的事不再只存在聊天上下文裡。

## 系統組成

```text
玩家訊息
   │
   ▼
AI Agent
   │ 載入 SKILL.md：主持規範、每回合流程、資訊揭露規則
   │
   ├── 讀劇本檔案：世界觀、場景、NPC 與預寫內容
   │
   └── 呼叫 scripts/trpg-gm
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
   - 必要時執行判定。
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
   - 只有行動可行、結果不確定，而且失敗有意義時才擲骰。
   - 擲骰前告知能力、目標值與可見風險。
   - 不因想推劇情而修改骰子或讓唯一線索永久消失。

6. **支線與世界運作**
   - 決定 NPC 如何反應、支線如何發展、場景如何變化。
   - 將可重複使用的細節保存成 entity。
   - 每次回覆最後把決定權交還玩家，例如「你要怎麼做？」。

更完整的主持規範：`.agents/skills/trpg-gm/references/GM_PROTOCOL.md`。

## Python 負責什麼

Python 程式位於 `src/trpg_gm/`。它不創作故事，也不自行決定 NPC 行為；它是 agent 的狀態工具與規則執行器。

### `cli.py`

提供 agent 可呼叫的命令列介面：

- 建立 room
- 新增角色
- 調整 HP／MP／SAN
- 新增或更新 entity
- 寫入 canon
- 執行並保存 d100 判定
- 取得完整 room context
- 查詢事件紀錄

所有結果都輸出 JSON，方便 agent 重新讀取。

### `store.py`

負責 SQLite schema 與資料一致性：

- 以 `room_id` 隔離不同遊戲。
- 保存角色和世界狀態。
- 將資源變動、entity 更新與判定寫入事件紀錄。
- 遇到 canon 舊值與新值不同時直接拒絕，防止 agent 靜默吃書。
- 將 room、角色、canon、entities 與 recent events 組合成每回合 context。

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

### 2. 建立玩家角色

```bash
$GM --db "$DB" character add miskatonic alice 艾莉絲 \
  --hp 10 \
  --mp 8 \
  --san 55 \
  --stats '{"力量":45,"聆聽":60,"圖書館使用":70}' \
  --notes '記者'
```

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
  → 判斷是否需要擲骰
  → 執行判定
  → 寫入資源、NPC、線索或支線變化
  → 描述玩家角色能感知的結果
  → 詢問下一步行動
```

### 5. 需要判定時

由程式擲 d100 並保存結果：

```bash
$GM --db "$DB" check miskatonic alice 聆聽
```

若使用實體骰或玩家已經擲出結果：

```bash
$GM --db "$DB" check miskatonic alice 聆聽 --roll 20
```

Agent 必須接受記錄下來的結果，不可以因劇情需要重新擲骰。

### 6. 套用遊戲後果

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

Agent 根據已保存的結果產生遊戲內敘事，通常包含：

1. 場景與感官資訊
2. NPC 或環境反應
3. 判定與可見資源變化
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

下一次遊戲只要使用相同的 room-id 與 DB，就能從 `context` 繼續。

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
| 對話中斷後恢復 | 重新呼叫 context | 持久保存狀態 |

簡單說：**Skill 管主持決策與流程，Python 管可驗證的狀態與規則。**

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

Pi 在信任此 repo 後會從 `.agents/skills/` 自動發現 Skill。其他支援 Agent Skills 規格的 agent harness 也可以直接載入該目錄。

完整 CLI 命令請見 `.agents/skills/trpg-gm/references/CLI.md`。

## 測試

```bash
PYTHONPATH=src python3 -W error::ResourceWarning -m unittest discover -s tests -v
```

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
├── src/trpg_gm/
│   ├── cli.py
│   ├── rules.py
│   └── store.py
├── tests/
├── pyproject.toml
└── README.md
```

## License

MIT
