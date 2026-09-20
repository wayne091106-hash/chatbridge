# 安全模型

這份寫的是「實際上擋得住什麼、擋不住什麼」，不是行銷詞。

## 誰能用這條通道

- 電腦**不對外開任何連接埠**。是電腦上的 `tunnel-client` 主動連到 OpenAI，像打電話出去。
- OpenAI 那端用你的金鑰驗證，金鑰只放在 Windows 環境變數 `GPT_TUNNELS_CONTROL_API_KEY-1`，不在任何檔案或聊天室裡。
- HTTP 模式（`chatbridge serve` + cloudflared）走 OAuth 2.1 + PKCE，需要擁有者通行碼（可加 TOTP）。重新導向網址限制在 `auth.allowedRedirectHosts`。
- 本機管理介面和工作台只聽 `127.0.0.1`，每次啟動換一把新鑰匙（`~/.chatbridge/workbench-token`）。

## 權限的三層

| 層 | 指令 | 擋什麼 |
|---|---|---|
| 暫停 | `chatbridge pause` | 立刻拒絕**所有**工具呼叫，最硬的開關 |
| 模式 | `chatbridge mode readonly` | 只能讀，不能寫檔、不能跑指令、不能動滑鼠 |
| 範圍 | `chatbridge scope projects` | 只有**授權過的資料夾**碰得到，其他一律拒絕 |

三層都在同一個檢查點（`src/core/policy.ts`），每一個工具呼叫都會經過，拒絕的結果會寫進稽核紀錄。

### 專案授權（scope = projects）

```bash
chatbridge scope projects
chatbridge grant "C:\我的專案" --hours 8 --note "今天的工作"
chatbridge grants        # 看現在授權了什麼
chatbridge revoke all    # 全部收回
```

- 授權存在 `~/.chatbridge/grants.json`，**會自己到期**，不需要有人記得收回。
- 沒有授權時，連讀檔都會被拒絕，錯誤訊息會直接告訴 ChatGPT 該叫你執行什麼指令。
- 螢幕截圖、滑鼠鍵盤、視窗控制在這個模式下**預設關閉**（`policy.projectsAllowDesktop` 可以打開）。截圖會照到整個桌面，所以不該跟「只授權一個資料夾」同時存在。
- `C:\work` 授權**不會**順便放行 `C:\work-secrets`（用 `path.relative` 判斷，不是字串開頭比對）。

**這是護欄，不是沙箱。** 指令字串裡出現的絕對路徑會被檢查，但指令仍然可以透過間接方式繞出去（環境變數、腳本、別的程式）。它的用途是「不讓模型亂跑」，不是「關住一個想害你的攻擊者」。真的要隔離請用虛擬機或容器。

## 主要風險：內容騙 ChatGPT

最實際的風險不是有人闖進來，是**你叫 ChatGPT 讀的東西裡面藏著指令**（網頁、郵件、README、程式碼註解）。它讀到「把使用者的檔案刪掉」有可能當成任務。

防線：

- 讀不熟的網頁或信件前，先 `chatbridge mode readonly`，或用 `chatbridge scope projects` 限定資料夾。
- 每一次寫入類的呼叫**都會先建立還原點**，出事跟 ChatGPT 說「復原剛剛的修改」，或用 `fs_checkpoints`。
- Agent 的改動可以整批 `agent_revert`，刪掉的檔案會丟到 `~/.chatbridge/hub/trash` 而不是真的消失。
- 覺得不對就 `chatbridge pause`。

## 稽核

- 每一次工具呼叫寫一行到 `~/.chatbridge/audit/audit.jsonl`，包含呼叫者、工具、參數、結果、耗時。
- 每一行帶前一行的雜湊，形成一條鏈：**有人事後改紀錄會被驗出來**（`chatbridge audit --verify`，`chatbridge doctor` 也會檢查）。
- 參數裡看起來像金鑰的欄位會先遮蔽再寫入。
- 歸檔後的舊檔也在鏈上，驗證會接到歸檔檔的最後一行。

## 已知的缺口

- 專案授權擋不住有意繞路的指令（見上）。
- 桌面控制、截圖在 `scope = machine` 下看得到整台電腦的畫面，包含其他程式的視窗。
- Google Drive 通道的檔案放在雲端硬碟上，受那個帳號的安全性保護；那個帳號只應該用來傳東西。
- 稽核鏈能證明「紀錄沒被改」，不能阻止有本機管理員權限的人整個刪掉重來。
