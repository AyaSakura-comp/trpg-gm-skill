# TRPG GM Skill

給 AI agent 使用的持久化 TRPG 主持人 skill。它把每個遊戲 room 的角色、HP/MP/SAN、能力、NPC、支線、場景、線索、canon 與判定紀錄放進 SQLite，避免只靠對話上下文而「失憶」或吃書。

## 特色

- Agent Skills 標準：`.agents/skills/trpg-gm/SKILL.md`
- room 隔離：相同角色 id 在不同房間不會串資料
- 劇本路徑：room 會保存 `script_path`；無劇本可明確切換成即興模式
- 角色資源：HP / MP / SAN 與自訂能力值
- 世界狀態：泛型 entities 可保存 NPC、quest、scene、location、clue、clock 等
- 防吃書：canon 不允許靜默覆寫；事件採 append-only 紀錄
- CoC 風格 d100 判定：critical / extreme / hard / success / failure / fumble
- 零第三方 runtime dependency：Python 3.10+ 與標準庫 SQLite 即可

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

Pi 在信任此 repo 後會從 `.agents/skills/` 自動發現 skill；其他支援 Agent Skills 的 harness 也可直接載入該目錄。

## 測試

```bash
PYTHONPATH=src python3 -W error::ResourceWarning -m unittest discover -s tests -v
```

## 架構

```text
Agent / GM protocol
        |
        v
scripts/trpg-gm -> Python CLI -> GameStore -> room SQLite file
                                  |-- rooms + script path
                                  |-- characters + resources/stats
                                  |-- entities (NPC/quests/scenes/clues/...)
                                  |-- immutable canon facts
                                  `-- append-only events/checks
```

詳細行為規範在：

- `.agents/skills/trpg-gm/SKILL.md`
- `.agents/skills/trpg-gm/references/GM_PROTOCOL.md`
- `.agents/skills/trpg-gm/references/CLI.md`

## 目前邊界

`room.system` 可記錄任意系統，但內建判定器目前只實作 CoC 類 d100。其他規則可在後續加入 rules adapter；在那之前，agent 不應把 d100 冒充其他系統的正式規則。這個版本以可靠狀態保存與主持協議為核心。

## License

MIT
