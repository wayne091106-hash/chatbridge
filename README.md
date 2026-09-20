# ChatBridge：讓 ChatGPT 直接用你的電腦

[![CI](https://github.com/wayne091106-hash/chatbridge/actions/workflows/ci.yml/badge.svg)](https://github.com/wayne091106-hash/chatbridge/actions/workflows/ci.yml)
&nbsp;Windows&nbsp;·&nbsp;Node 24+&nbsp;·&nbsp;Apache-2.0

在 ChatGPT 網頁版（一般聊天就行，不用 Codex 或 Agent 模式）說一句話，它就能在你這台 Windows 電腦上：

- 開檔案、改檔案、跑指令、看螢幕、動滑鼠鍵盤
- 把大型寫程式工作交給電腦裡的 **Kilo Code、OpenCode、Cline、Codex、Claude Code**，然後在聊天室裡用**即時進度卡**看它們做事
- 在聊天室和電腦之間**傳檔案**（兩個方向都行）
- 用**卡片**顯示圖片、資料夾、程式差異、正在跑的終端機畫面、螢幕截圖

你的電腦**不會對外開任何門**。是電腦主動連到 OpenAI（像打電話出去），不是別人連進來。

```
 ChatGPT 網頁 ──(OpenAI 的加密通道)── 你電腦上的 tunnel 程式 ── ChatBridge ── 你的電腦
                                        （主動往外連）          （這個專案）
```

---

## 安裝

需要 Windows、Node 24 以上，以及一個 OpenAI 帳號（ChatGPT 要開發者模式）。

```powershell
git clone https://github.com/wayne091106-hash/chatbridge.git
cd chatbridge
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

腳本會安裝、建置、跑測試、把 `chatbridge` 指令接起來，最後跑一次健檢。第一次安裝會建立設定檔和擁有者通行碼。

**新安裝預設是「只碰授權過的資料夾」**，要先開一個給它：

```powershell
chatbridge grant "C:\你的專案" --hours 8
chatbridge scope machine      # 或者直接開放整台電腦（截圖、滑鼠、所有資料夾）
```

怎麼把 ChatGPT 接上來：[docs/CONNECT.md](docs/CONNECT.md)。

## 平常會用到的指令

| 想做的事 | 指令 |
|---|---|
| 看 ChatGPT 現在連不連得到電腦 | `chatbridge tunnel status` |
| 重新連線（改完設定、或 ChatGPT 說連不上時） | `chatbridge tunnel restart` |
| 看連線紀錄 | `chatbridge tunnel logs` |
| 只讓 ChatGPT「看」、不能改東西 | `chatbridge mode readonly` |
| 恢復完整權限 | `chatbridge mode full` |
| 只讓它碰某個專案資料夾 | `chatbridge scope projects` ＋ `chatbridge grant "C:\專案" --hours 8` |
| 恢復整台電腦 | `chatbridge scope machine` |
| 全部檢查一遍（連不連得到、agent、Drive、紀錄） | `chatbridge doctor` |
| 幫這台電腦取名字（有好幾台時很好認） | `chatbridge name "辦公室電腦"` |
| 看哪些寫程式 agent 能用 | `chatbridge agents` |
| 緊急停止：立刻拒絕 ChatGPT 所有動作 | `chatbridge pause` ／ 恢復：`chatbridge resume` |
| 看 ChatGPT 做過什麼（每一步都有紀錄） | `chatbridge audit --tail 30` |

開機會自動連線，不用手動啟動。

## 在 ChatGPT 裡怎麼用

直接用平常的話講就好，例如：

- 「看一下我桌面上有什麼」
- 「把 D:\報告 裡的 PDF 列出來，最大的那個傳給我」
- 「用 OpenCode 幫我在 ~/projects/blog 加一個深色模式，做完給我看改了什麼」
- 「截一張我的螢幕」
- 「幫我跑 npm run build，跑的時候讓我看畫面」

ChatGPT 第一次用時會先讀一份使用說明（`chatbridge_guide`），它會自己知道該用哪個工具。

### 交工作給寫程式 agent（agent_run）

ChatGPT 自己當「大腦」負責規劃和檢查，實際寫程式可以交給電腦裡的 agent：

沒指定的話，照這個順序挑能用的 agent：

| 順序 | Agent | 預設模型 | 備註 |
|---|---|---|---|
| 1 | **Kilo Code** | Gemini 3.8 Flash（走 Vertex，記在 GCP 帳單） | 真正的連續對話：可暫停、繼續、追加指示 |
| 2 | **Cline** | DeepSeek V4.1 Flash（免費） | 追加指示會開新一輪並交接上一輪的報告 |
| 3 | **Codex** | gpt-5.6-sol | 用 ChatGPT 的 Codex 額度，可連續對話 |
| 4 | **Claude Code** | 預設 | 可連續對話 |
| — | OpenCode、Gemini CLI | — | 保留但不主動使用（Gemini 目前不能用） |

模型都能在卡片或工作台裡切換，也可以設成預設。

### 電腦上的工作台（大視窗）
```bash
chatbridge serve        # 背景執行一次就好
chatbridge workbench "C:\你的專案"
```
會在瀏覽器開一個**完整大小**的工作台，跟對話裡的卡片是同一套介面、同一套工具，但不受 ChatGPT 的框限制：

- 左邊對話與活動、右邊變更／分支／送交推送／agent 與模型設定
- **終端機**：直接在專案裡下指令，輸出即時更新
- **檔案樹**：看專案結構，點檔案看差異
- **右下角即時面板**：ChatGPT 每在這台電腦做一個動作都會跳出來
- **輸入框可以切換送給誰**：
  - 「交給本機 agent」→ 直接叫 Kilo／Cline／Codex 做事，不佔任何額度
  - 「送給 GPT」→ 文字會送進你開著的 ChatGPT 對話（那邊要有 Computer Bridge 的卡片在，卡片會幫你說出來）

建議用 Chrome 的分割視窗：左邊 ChatGPT、右邊工作台。只有本機能開，每次啟動換一把新鑰匙。

### 兩種寫程式模式
- **聊天模式**：說「用 Kilo 幫我…」，對話裡會出現一張卡片：即時顯示 agent 在做什麼，完成後列出改了哪些檔案（+/− 行數，點一下看差異），可以直接在卡片裡追加指示、暫停、繼續、復原。
- **工作台模式**：說「開工作台」或按卡片右上角的放大鍵，會打開一個全螢幕、像 Codex 的畫面：左邊是對話和活動，右邊是變更、分支、送交或推送、agent／模型／權限設定，以及過去的對話。

交出去之後聊天室會出現一張**進度卡**：即時顯示 agent 在做什麼（跑什麼指令、改哪個檔），做完列出改了哪些檔案，點一下就看差異。卡片上有「停止」、「全螢幕」、「子母畫面」和「請 GPT 檢查結果」按鈕。

### 傳檔案

**最快：Google Drive 資料夾**（`chatbridge drive set "<資料夾>"`，建議用 Google Drive 桌面版的**鏡像模式**，這樣它是硬碟上的真實資料夾，git 和 agent 才能正常讀寫）
- 用 `chatbridge drive account <email>` 指定是哪個 Google 帳號，ChatGPT 讀 Drive 前會先確認連的是這一個，不會翻到別人的雲端硬碟。
- **電腦 → 你**：說「把 xxx 丟到 Drive」。檔案會放進 `ChatBridge/寄件`，用手機的 Drive App 就能拿，速度是你家網路全速。
- **你 → 電腦**：用手機把檔案丟進 `ChatBridge/收件`，跟 ChatGPT 說「我丟到 Drive 了」，它就會直接在電腦上處理。
- `寄件` 裡超過 7 天的舊檔會自動清掉。這個帳號只放傳輸用的東西，私人檔案不要放。

**透過對話（比較慢，受 OpenAI 限制）**
- **你 → 電腦**：在 ChatGPT 附加檔案，說「存到我電腦」，約 1–6 MB/s。
- **電腦 → 對話**：小檔用 `xfer_send`；大一點的會出現上傳卡片，約 0.5 MB/s。`.bin` 這類檔案 ChatGPT 可能不收。

### 交接筆記

長的工作可以說「把目前進度存成交接筆記」（`handoff_save`），下次開新對話說「讀交接筆記」就能接著做。筆記放在 `~/ChatBridge/handoffs`。

---

## 安全：你需要知道的

- **只有你的 ChatGPT 帳號**能用這條通道（OpenAI 那邊用你的金鑰驗證）。
- 權限有三層，全部在同一個檢查點上：`chatbridge pause`（全部拒絕）→ `chatbridge mode readonly`（只能看）→ `chatbridge scope projects`（只碰授權過的資料夾，授權可以設幾小時後自動失效）。預設是整台電腦全開，這是你選的。
- 主要風險是「**網頁內容騙 ChatGPT**」：例如你叫它讀一個網頁，網頁裡偷藏「刪掉使用者的檔案」。你選了完整權限＋自動批准，所以：
  - 叫它讀不熟的網頁、信件時，可以先切 `chatbridge mode readonly`
  - 改檔案前會自動存還原點，改壞了跟 ChatGPT 說「復原剛剛的修改」
  - 覺得怪怪的就 `chatbridge pause`
- 金鑰只放在 Windows 環境變數 `GPT_TUNNELS_CONTROL_API_KEY-1`，不在任何檔案或聊天室裡。

## 更多

- 怎麼連線、多台電腦、分享給別人：[docs/CONNECT.md](docs/CONNECT.md)
- 技術細節：[docs/TECHNICAL.md](docs/TECHNICAL.md)
- 工具清單（65 個，自動產生）：[docs/TOOLS.md](docs/TOOLS.md)
- 安全模型、擋得住什麼擋不住什麼：[docs/SECURITY.md](docs/SECURITY.md)
- 出問題時：[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)

## 開發

```bash
npm install
npm run build
npm test          # 74 個測試
npm run docs      # 新增工具後重新產生 docs/TOOLS.md
npm link          # 讓 chatbridge 指令在任何地方都能用
```
