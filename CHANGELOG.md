# 變更紀錄

## 1.3.0 — 2026-09-20

**瀏覽器控制（9 個新工具）**
- 直接走 Chrome 的除錯協定（DevTools Protocol），不是截圖點座標。網頁有 DOM，就該指名元素。
- `browser_snapshot` 回傳整頁文字 ＋ 每個可操作元素的代號；`browser_click` 用代號、看得到的文字或 CSS 選擇器點下去；`browser_type` 填欄位並送出；另有 `browser_open`／`navigate`／`scroll`／`tabs`／`eval`／`screenshot`。
- 用**獨立的瀏覽器設定檔**，不會繼承擁有者平常登入的所有網站（`browser.ownProfile` 可以改，但那等於把所有登入交出去）。
- 頁面忽略協定層的點擊或 Enter 時，會退而用網頁自己的方式（`el.click()`、送出表單），並在回覆裡說明換過方法——不會假裝成功。
- 沒有新增任何相依套件：CDP 走 Node 內建的 WebSocket。

**兩個 ChatGPT 帳號共用一台電腦**
- `chatbridge tunnel add <名稱> --tunnel-id tunnel_xxx`：各自的 profile、健康埠、log、看門狗，並用 `--name` 在稽核紀錄裡分辨是哪個帳號。
- `tunnel status|restart|logs` 支援 `--profile`。

**身分問答**
- `chatbridge quiz add` 設定只有本人答得出來的問題；`policy.askOwnerForTools`（例如 `["mouse","keyboard"]`）指定哪些工具動手前要先確認。
- 答案只存加鹽雜湊，不進檔案、不進稽核紀錄。沒設題目時完全不擋。

**視覺點擊修好三件事**
- 沒截圖就點會默默用 1:1 座標點錯地方 → 現在直接擋下來。
- `screen_capture` 可以只截一個視窗（`window`），預設上限從 1600 提到 1920。
- 滑鼠鍵盤動作會回報游標最後位置、有沒有被移開、前景視窗是誰。

## 1.2.1 — 2026-09-20

**工作台修好了（之前是死的）**
- 鑰匙檔以前每次伺服器啟動都重寫，**連一個啟動失敗的 `serve`（例如埠被佔用）也會在退出前把它蓋掉**，於是正在跑的伺服器發出去的每一個網址都失效，整個工作台看起來就像壞掉。現在鑰匙建立一次就沿用，`--new-token` 才換。
- 實測：在工作台輸入「嗨」→ Kilo 正常接到並開始工作。

**卡片的 UI**
- 卡片內容以前貼著邊，被對話框的圓角切掉，左上／右上的按鈕因此按不到。現在留了安全邊距（全螢幕時自動取消）。
- 檢視卡片按了全螢幕**回不去**：沒有任何按鈕可以縮回對話。現在有返回鍵，也可以按 Esc。

**中斷的工作查得到**
- 當機、重開機、或不小心關掉視窗時，在跑的工作會標成 `interrupted` 並**寫回磁碟**（以前只在記憶體裡改成 failed，重開又變回 running）。
- 新工具 `work_recover` 和指令 `chatbridge recover`：列出被切斷的工作、做到哪一步、改過哪些檔案，以及怎麼接下去。

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
