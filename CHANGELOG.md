# 變更紀錄

## 1.2.0 — 2026-09-20

**專案授權**
- `chatbridge scope projects` 之後，只有授權過的資料夾碰得到，其他一律拒絕。
- `chatbridge grant <資料夾> --hours 8`，授權會自己到期；`chatbridge grants`、`chatbridge revoke <id|資料夾|all>`。
- 這個模式下螢幕、滑鼠、視窗控制預設關閉（截圖看得到整個桌面，和「只授權一個資料夾」互相矛盾）。
- 預設仍然是 `machine`（整台電腦），沒有改變原本的行為。
- 修正：設定裡的 `denyPathPatterns`／`denyCommandPatterns` **從來沒有真的生效過**（沒有任何工具把路徑交給檢查點）。現在路徑和指令會自動從工具參數抽出來，62 個工具全部涵蓋。

**工作台與對話的整合**
- 工作台輸入框可以切換「交給本機 agent」或「送給 GPT」；送給 GPT 的訊息經由檔案佇列，由對話裡的卡片每 25 秒取件後說出來。
- 工作台加入終端機、檔案樹、ChatGPT 即時動作面板。
- `show_summary` 結果卡片：GPT 只寫文字，**改動清單和行數由電腦算**。

**成熟度**
- 整個專案進了 git（在此之前 12000 行程式碼沒有任何版本控制）。
- `chatbridge doctor` 現在會檢查通道、權限範圍、agent、Drive 通道和稽核鏈。
- `docs/TOOLS.md` 由 `npm run docs` 從伺服器本身產生，有測試擋著不讓它過期。
- 新增 `docs/SECURITY.md`、`docs/TROUBLESHOOTING.md`，CI 在 Windows 上跑型別檢查、測試和文件檢查。
- 68 個測試。

**修正**
- `tunnel restart` 不會再在 ChatGPT 工作到一半時打斷它（三分鐘內有非輪詢的動作就拒絕，除非 `--force`）。
- 用 `CHATBRIDGE_HOME` 指向別的設定檔時，不會誤重啟正式的通道。
- Shell 包裝器在非 Windows 平台上不再硬叫 `powershell.exe`。

## 1.1.0 以前

見 git 紀錄（初始提交涵蓋通道、agent hub、卡片、檔案傳輸、Google Drive 通道）。
