# 怎麼連線、多台電腦、分享給別人

## 你現在的設定（已經弄好了）

ChatGPT 連你電腦走的是 **OpenAI 的加密通道（Secure MCP Tunnel）**：

1. 你電腦上有一個小程式 `tunnel-client`，開機就自動在背景啟動。
2. 它主動連到 OpenAI，說「我是 tunnel_xxxxxxxx，有工作就丟給我」。
3. 你在 ChatGPT 講話 → OpenAI 把要做的事經由這條線送過來 → ChatBridge 在你電腦上做 → 結果送回去。

因為是**你的電腦主動往外連**，路由器不用開門，外面的人也找不到你的電腦。

相關檔案都在 `%USERPROFILE%\.chatbridge\tunnel-client\`：

| 檔案 | 用途 |
|---|---|
| `tunnel-client.exe` | OpenAI 的通道程式 |
| `profiles\chatbridge.yaml` | 設定：哪個 tunnel、要啟動什麼 |
| `start-tunnel.ps1` | 守門員：程式當掉會自動重開（最多等 60 秒） |
| `start-hidden.vbs` | 開機時用它在背景啟動（登錄檔 Run 裡的 `ChatBridgeOpenAITunnel`） |
| 工作排程器 `ChatBridgeTunnelWatchdog` | 看門狗：每 5 分鐘檢查一次，通道被關掉（例如登出、當機）就自動叫起來；同時只會有一份在跑 |
| `tunnel.log` | 連線紀錄（超過 20 MB 自動換新檔） |

### 出問題時

| 狀況 | 做法 |
|---|---|
| ChatGPT 說連不到電腦 | `chatbridge tunnel status` 看一下；不行就 `chatbridge tunnel restart` |
| 更新了程式、ChatGPT 沒看到新功能 | `chatbridge tunnel restart`，再到 ChatGPT 的 app 設定按「重新整理」 |
| 想看發生什麼事 | `chatbridge tunnel logs` |
| 想先斷開 | `chatbridge pause`（通道還在，但所有動作都被拒絕） |

### ChatGPT 那邊的開關

- **Settings → Security and login → Developer mode**：要打開。
- **Settings → Apps（Plugins）**：ChatBridge 在這裡。新增工具後按它 → 「重新整理」。
- 聊天時：輸入框 **+ → Developer mode**，勾選 ChatBridge。

---

## 多台電腦

**一台電腦 = 一個 tunnel = ChatGPT 裡一個 app。** 這是 OpenAI 的設計，每條通道只能接一台電腦。

在第二台電腦上：

1. 裝好 Node.js，把這個專案複製過去，執行 `npm install`、`npm run build`、`npm link`。
2. 到 platform.openai.com → **Tunnels** 再建一個 tunnel（例如叫 `office-pc`）。
3. 把 `%USERPROFILE%\.chatbridge\tunnel-client\` 整個資料夾複製過去，然後改兩個地方：
   - `profiles\chatbridge.yaml` 裡的 `tunnel_id` 換成新的
   - `mcp` 的 `command` 改成那台電腦上專案的路徑
4. 那台電腦也設定環境變數 `GPT_TUNNELS_CONTROL_API_KEY-1`（同一把 API key 就行）。
5. 執行 `wscript.exe start-hidden.vbs`，再用 `chatbridge tunnel status` 確認。
6. 幫它取名字：`chatbridge name "辦公室電腦"`。
7. ChatGPT → Apps → 新增一個 app，選新的 tunnel。

之後在對話裡勾選哪個 app，就是在控制哪台電腦。ChatGPT 看得到每台的名字，不會搞混。

> 能不能一個 app 切換很多台？可以做，但要多一個「轉接站」讓所有電腦連上去，等於又回到要架伺服器、要處理登入。對個人用途來說，一台一個 app 最簡單也最安全。

---

## 分享給別人用

**不要**把你的 tunnel 或 API key 給別人，那等於把你的電腦交給他。

讓別人用他自己的電腦，他需要：

1. 自己的 OpenAI Platform 帳號，建立自己的 tunnel 和 API key。
2. 複製這個專案，照上面「多台電腦」的步驟做。

也就是說，每個人都是「自己的 ChatGPT 控制自己的電腦」。

---

## Claude 網頁版

Claude 沒有 OpenAI 這種通道，需要一個 HTTPS 網址。做法是用 **Cloudflare Tunnel**（一樣是電腦主動往外連，不用開門），再加上 ChatBridge 自己的登入（密語＋手機驗證碼）：

```bash
winget install Cloudflare.cloudflared
chatbridge up                                     # 另開一個視窗
cloudflared tunnel --url http://127.0.0.1:8765     # 會印出 https://xxxx.trycloudflare.com
chatbridge set-public-url https://xxxx.trycloudflare.com
```

然後 Claude.ai → **Settings → Connectors → Add custom connector**，網址填 `https://xxxx.trycloudflare.com/mcp`，登入時輸入 `~/.chatbridge/OWNER-CREDENTIALS.txt` 裡的密語和驗證碼。

這種臨時網址每次重開都會變。要固定網址需要一個放在 Cloudflare 的網域，步驟見 [TECHNICAL.md](TECHNICAL.md#固定網址)。

---

## 本機 App（Claude Desktop、Codex CLI）

這兩個在同一台電腦上，不需要通道：

- Claude Desktop：在 `%APPDATA%\Claude\claude_desktop_config.json` 加入
  ```json
  { "mcpServers": { "chatbridge": { "command": "chatbridge", "args": ["stdio"] } } }
  ```
- Codex CLI：`codex mcp add chatbridge -- chatbridge stdio`
