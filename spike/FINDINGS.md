# Phase 0 — codex exec-server 協定驗證（codex-cli 0.154.0，Windows 11）

啟動：`codex exec-server --listen ws://127.0.0.1:47100`（WebSocket，一個 frame 一則 JSON-RPC）
測試腳本：`exec-server-probe.mjs`、`pty-probe.mjs`

## 已驗證可用
| 方法 | 重點 |
|---|---|
| `initialize` → `initialized` | 回傳 shell=powershell、platformOs=windows、executorVersion |
| `process/start` | `processId, argv, cwd(file: URI), env, tty, pipeStdin, arg0`；回傳 `sandboxType: "none"` |
| `process/read` | `afterSeq, maxBytes, waitMs`；chunk 為 base64；有 `exited/exitCode/closed` |
| `process/write` | **必填 `writeId`**（官方 README 未寫）；`chunk` 為 base64 |
| `process/terminate` | OK |
| 通知 | `process/output`、`process/exited`、`process/closed` 會主動推送 |
| `fs/writeFile` | **欄位是 `path` + `dataBase64`** |
| `fs/readFile` | 回傳 `dataBase64` |
| `fs/readDirectory` | `entries[{fileName,isDirectory,isFile}]` |
| `fs/getMetadata` | `isFile, size, createdAtMs, modifiedAtMs` |

## 注意事項
- `env` 只會帶你傳入的變數，Windows 至少要給 `SystemRoot`、`PATH`。
- 互動式：pipe 模式與 PTY（`tty:true`）都可用；PTY 輸出含 ANSI/OSC 控制碼，回傳給模型前要清掉。
- 協定是實驗性質，官方 README 已落後於實作 → 固定 Codex 版本，升級後重跑這兩支腳本。
- exec-server 本身沒有認證，只能綁 127.0.0.1。
