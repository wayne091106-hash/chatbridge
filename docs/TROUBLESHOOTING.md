# 遇到問題時

先跑這個，它會把整條路徑檢查一遍（設定、Node、Codex、執行層、通道、權限範圍、agent、Drive、稽核鏈）：

```bash
chatbridge doctor
```

---

## ChatGPT 說連不上這台電腦

1. `chatbridge tunnel status` — 通道是否在跑。
2. `chatbridge tunnel restart` — 重新連線。**如果 ChatGPT 正在工作中，它會拒絕重啟**（重啟會砍掉正在跑的 shell 階段），要硬來加 `--force`。
3. `chatbridge tunnel logs --tail 40` — 看它在抱怨什麼。

## ChatGPT 做到一半就停了

這幾乎都是 ChatGPT 那端的限制，不是電腦這端出錯（稽核紀錄會顯示最後一個呼叫正常結束）：

| 現象 | 原因 | 已有的對策 |
|---|---|---|
| 一個動作卡住後整串停掉 | 單次工具呼叫 **60 秒**硬上限 | 超過 50 秒會回一張「工單」，之後用 `op_status` 領結果 |
| 做幾十步之後不動了 | 每一回合的步數預算 | 說明書要求它**分段回報**，不要一口氣做完 |
| 對話變長之後工具突然消失 | 長對話會被丟掉工具定義 | 叫它重新呼叫 `chatbridge_guide`；真的不行就開新對話 |
| 開新對話後沒有新功能 | 外掛的工具清單是**建立當下**固定的 | **必須重建外掛**，重新連線沒有用 |
| 說「對話太長」 | 對話長度上限 | 大檔案走 Drive 通道，重資料只走卡片（不進對話） |

長工作建議：呼叫 45／70／95 次時系統會提醒它存交接筆記（`handoff_save`），下次開新對話讀回來繼續。

## 連接埠被佔用

```
error: port 8799 is not available (EADDRINUSE)
```

有別的東西在用那個埠（可能是你自己開的伺服器）。換一個：

```bash
chatbridge doctor          # 會告訴你埠是「free」還是「被別的東西佔用」
```

然後改 `~/.chatbridge/config.json` 的 `server.port`，或設環境變數 `CHATBRIDGE_PORT`。**不要直接把佔用的程式砍掉**，那可能是你正在用的東西。

## 工具呼叫被拒絕

錯誤訊息開頭是 `Denied by owner policy:`，後面會說原因：

- `bridge is in readonly policy mode` → `chatbridge mode full`
- `project scope is on but nothing is granted` → `chatbridge grant "<資料夾>"`
- `... is outside the granted project folders` → 授權那個資料夾，或 `chatbridge scope machine`
- `ChatBridge is paused by the owner` → `chatbridge resume`

## Agent 不能用

```bash
chatbridge agents          # 每個 agent 裝了沒、上次檢查通不通
```

常見狀況：

- **Kilo「Model not found」** → 那個模型的 gateway 沒有額度，換一個（預設 `google-vertex/gemini-3.8-flash`）。
- **Cline 追加指示沒反應** → Cline 的 resume 在 JSON 模式下不能用，會改成開新一輪並交接上一輪的報告，這是預期行為。
- **agent 少了環境變數（例如 API 金鑰）** → 啟動 agent 時要把 `process.env` 整個傳過去，缺了就會出現「明明終端機能跑，從這裡跑就不行」。

## 檔案傳不過去

- **ChatGPT → 電腦**：附加檔案後說「存到我電腦」。`.bin` 這類副檔名 ChatGPT 可能直接不收，改走 Drive。
- **電腦 → 對話**：小檔 `xfer_send`，大檔會出現上傳卡片（約 0.5 MB/s）。
- **最快**：Google Drive 資料夾（`收件`／`寄件`），速度是你家網路全速。`chatbridge drive status` 看設定對不對。

## 東西做到一半被中斷了

不管是當機、重開機，還是你自己不小心把視窗關掉：**在跑的工作會被記下來，不會就這樣消失。**

```bash
chatbridge recover
```

會列出每一件被切斷的工作：在哪個資料夾、原本要做什麼、做到哪一步、已經改了哪些檔案，以及**怎麼接下去**（agent 還留著對話 id 的話可以直接續，不然會告訴你先看 `agent_diff` 再重跑）。

在 ChatGPT 裡也一樣，直接問「上次那個做到一半的怎麼了」，它會呼叫 `work_recover`。

## 工作台打不開

```bash
chatbridge serve                    # 本機伺服器要先在跑
chatbridge workbench "C:\你的專案"
```

- 只有本機連得上。鑰匙存在 `~/.chatbridge/workbench-token`，**重開伺服器之後舊網址照樣能用**；要換一把就加 `--new-token`。
- 如果整個工作台像死掉一樣（按什麼都沒反應、或顯示 `admin token required`），代表鑰匙對不上——重新執行 `chatbridge workbench` 拿新網址。
- 工作台輸入框切到「送給 GPT」時，訊息會排進佇列，由 ChatGPT 對話裡的卡片每 25 秒取一次。**那邊要有一張 ChatBridge 的卡片開著**，不然沒人幫你說話。

## 卡片不動了

卡片會自己降頻（越久沒變化問得越慢，切到別的分頁就暫停，連續 40 次沒變化就停），這是為了不要把工具呼叫額度燒在輪詢上。點一下卡片或切回分頁就會恢復。
