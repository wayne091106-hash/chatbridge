# 技術細節

## 架構

```
 ChatGPT ──MCP── OpenAI Secure MCP Tunnel ── tunnel-client.exe ──stdio── chatbridge stdio
 Claude  ──MCP over HTTPS + OAuth 2.1── cloudflared ── chatbridge serve (127.0.0.1:8765)
                                                             │
                              ┌──────────────────────────────┼─────────────────────────┐
                              ▼                              ▼                         ▼
                 codex exec-server（執行層，無模型）   Agent hub（agent CLI）     桌面（截圖／滑鼠／鍵盤）
                 備援：內建 Node 執行器                Kilo／OpenCode／Cline／
                                                      Codex／Claude Code／Gemini
```

- **執行層**：`codex exec-server` 透過 JSON-RPC over WebSocket 負責執行程序和讀寫檔案。找不到 Codex 時改用內建的 Node 執行器（兩者跑同一套 contract 測試）。
- **政策**：三層都在 `src/core/policy.ts` 這一個檢查點上，每次呼叫工具都會過：`chatbridge pause`（全部拒絕）、`policy.mode`（`full`／`readonly`）、`policy.scope`（`machine`／`projects`，專案授權見 [SECURITY.md](SECURITY.md)）。路徑和指令是從工具參數裡**自動抽出來**的（`subjectFromArgs`），所以新增工具不需要記得宣告。
- **稽核**：`~/.chatbridge/audit/*.jsonl`，一條雜湊鏈，多個程序同時寫入也安全（寫入前會先 `syncFromTail`）。`chatbridge audit --verify` 可以驗證。
- **還原點**：每次寫入類的工具呼叫都會先建立還原點，`fs_checkpoints` 可以列出和復原。

## 工具

完整清單看 [TOOLS.md](TOOLS.md)（由 `npm run docs` 從伺服器本身產生，有測試擋著不讓它過期）。

大致分成：說明與狀態、Shell、檔案、桌面（截圖／滑鼠／鍵盤／視窗）、卡片與結果、檔案傳輸（對話與 Google Drive 兩條路）、Agent hub、交接筆記。

## 卡片（ChatGPT Apps SDK／MCP Apps）

- `ui://chatbridge/agent-panel.html`：agent 進度。每 1.5 秒用 `agent_status(since=n)` 只拿新事件。完成後列出變更檔案，點一下呼叫 `agent_diff`。
- `ui://chatbridge/viewer.html`：圖片、文字、資料夾、diff、終端機、螢幕。有 `refreshTool` 的卡片會自動更新（終端機、螢幕）。
- `ui://chatbridge/xfer-upload.html`：從電腦分塊讀檔（`xfer_read_chunk`）→ `window.openai.uploadFile` → 下載回來比對 SHA-256。
- 共用的橋接程式同時支援 `window.openai` 和 MCP Apps 的 postMessage，所以 Claude 那邊也能顯示。
- 本機預覽：`node spike/widget-harness.mjs`，然後開 `http://127.0.0.1:18990/card?tool=view&args={"path":"C:/"}`。

## Agent hub

- 設定和紀錄在 `~/.chatbridge/hub/`：`jobs/`、`logs/`、`config.json`（各 agent 預設模型）、`health.json`。
- 無頭模式的指令：
  - Codex：`codex exec --json`
  - Claude Code：`claude -p --output-format stream-json --verbose`
  - Gemini：`gemini -p -o stream-json`
  - Kilo、OpenCode：`run --format json --dir <cwd> [--auto] -m <model>`
  - Cline：`cline --json -c <cwd> --act -y`
- npm 的 `.cmd` 會被解析成 `node <script>`，避開 cmd.exe 的引號問題。超過 6000 字的任務改用檔案傳。
- 變更偵測：開工前記下 `git rev-parse HEAD`，完工後和它比對（agent 自己 commit 也抓得到）。開工前就已經改過的檔案不算 agent 的。另外會合併 agent 自己回報的路徑。不是 git 專案時改看檔案修改時間。
- 最多同時跑 3 個，預設 60 分鐘逾時。bridge 重開時，還在跑的工作會標成失敗。

## 固定網址

給 Claude 用的 Cloudflare 固定網址（需要一個放在 Cloudflare 的網域）：

```powershell
cloudflared tunnel login
cloudflared tunnel create chatbridge
cloudflared tunnel route dns chatbridge mcp.example.com
```

`%USERPROFILE%\.cloudflared\config.yml`：

```yaml
tunnel: chatbridge
credentials-file: C:\Users\<你>\.cloudflared\<tunnel-id>.json
ingress:
  - hostname: mcp.example.com
    service: http://127.0.0.1:8765
  - service: http_status:404
```

```powershell
cloudflared service install
chatbridge set-public-url https://mcp.example.com
chatbridge autostart enable
```

OAuth：支援動態註冊（DCR）＋ PKCE，擁有者密語＋TOTP。`chatbridge clients list|revoke`、`chatbridge passphrase reset`。

## Kestrel（舊的自主 agent，預設關閉）

已經改用 agent hub。要重新打開：在 `~/.chatbridge/config.json` 設定 `"features": { "agent": true }`，程式碼在 `src/agent/`，指令是 `kestrel`。

## 測試

`npm test`：75 個測試，包含兩個執行器的 contract、OAuth／HTTP／stdio、agent hub（用假的 agent 在真的 git repo 裡跑）、檔案傳輸，以及所有卡片的 script 語法檢查、專案授權的邊界（`C:\work` 不會放行 `C:\work-secrets`）、文件是否過期。

- `npm run typecheck` — 只跑型別
- `npm run docs` — 重新產生 `docs/TOOLS.md`（新增工具後要跑）
- CI（`.github/workflows/ci.yml`）在 Windows 上跑型別、測試，並檢查 `docs/TOOLS.md` 有沒有忘記重生。
