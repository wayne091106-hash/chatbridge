# 工具清單

ChatBridge 1.2.1 對 ChatGPT／Claude 公開 **65 個工具**。

> 這份檔案由 `npm run docs` 從伺服器本身產生，不要手動編輯。

## 說明與狀態

| 工具 | 做什麼 |
|---|---|
| `bridge_version` | Version of the ChatBridge server on this PC and the names of every tool it offers right now. |
| `op_status` | Collect the result of a tool call that was still running when it answered with a ticket id. |
| `computer_info` | OS, CPU, RAM, GPUs (nvidia-smi), disks, executor version and the current default working directory. |
| `bridge_status` | Pause state, policy, executor and recent audit entries. |
| `chatbridge_guide` | Call this first in a new conversation: explains which computer this is, the available capabilities and the recommended workflows. |
| `relay_poll` | Internal: messages the user typed in the local workbench, to be spoken into this conversation by the card. |

## Shell

| 工具 | 做什麼 |
|---|---|
| `shell_run` | Run a shell command on the PC. |
| `shell_read` | Get new output from a running or finished shell session, waiting up to wait_seconds for more. |
| `shell_write` | Write to the stdin of an interactive shell session (started with interactive=true or tty=true) and return the output produced afterwards. |
| `shell_kill` | Terminate a shell session and its child processes. |
| `shell_list` | List shell sessions with status and unread output size. |
| `shell_watch` | Show the user a live-updating terminal card for a running shell session (from shell_run). |
| `shell_peek` | Internal: latest output of a shell session for the live terminal card. |

## 檔案

| 工具 | 做什麼 |
|---|---|
| `set_working_directory` | Change the default directory used by shell_run and relative file paths. |
| `fs_read` | Read a text file with line numbers. |
| `fs_write` | Create or overwrite a file with the given content (parent directories are created). |
| `fs_edit` | Replace an exact string in a file. |
| `apply_patch` | Apply a multi-file patch in Codex format:
*** Begin Patch
*** Update File: path
@@ optional anchor
 context
-old
+new
*** Add File: path
+content
*** Delete File: path
*** End Patch
All hunks are validated before anything is written. |
| `fs_list` | Tree listing of a directory (dependency/build folders are skipped when recursing). |
| `fs_search` | Regex search in file contents (ripgrep). |
| `fs_manage` | mkdir, delete (recursive), copy or move a file/directory. |
| `fs_checkpoints` | List file-change checkpoints or undo one (restores every file changed in that checkpoint; default is the latest). |

## 桌面

| 工具 | 做什麼 |
|---|---|
| `screen_capture` | Capture the screen (all monitors by default). |
| `mouse` | Move/click/double_click/right_click/middle_click/scroll/drag. |
| `keyboard` | Type literal text, or send key combos with SendKeys syntax in `keys` (^=Ctrl, %=Alt, +=Shift, {ENTER}, {TAB}, {F5}, ^{ESC}). |
| `clipboard` | Get or set the clipboard text. |
| `windows_list` | Top-level windows with process id and title. |
| `window_focus` | Bring a window to the foreground by pid or title substring. |
| `view_screen` | Show the user a card with the PC screen. |

## 卡片與結果

| 工具 | 做什麼 |
|---|---|
| `view` | Show the user a card with an image, a text/code file (line numbers) or a folder tree from the PC. |
| `show_summary` | End a piece of work with a result card instead of typing the details out. |
| `summary_diff` | Internal: the diff of one file shown on a result card. |

## 檔案傳輸

| 工具 | 做什麼 |
|---|---|
| `xfer_receive` | Save a file from this conversation onto the PC. |
| `xfer_receive_chunk` | Fallback when a file cannot be passed as a file parameter: send it as base64 chunks (≤ 200 KB of base64 per call) with the same transfer_id. |
| `xfer_send` | Return a small PC file (max 20 MB) inside the tool result so you can use it in your Python sandbox. |
| `xfer_offer` | Show an upload card for a PC file. |
| `xfer_read_chunk` | Internal: used by the upload card to read a file in chunks. |
| `xfer_verify_url` | Internal: the upload card downloads the uploaded copy back to the PC and compares SHA-256 with the original. |
| `xfer_echo` | Tunnel size probe: returns kb kilobytes of marked text ([k000001]…). |
| `xfer_stage` | Internal: progress of the PC → object storage upload and, when ready, the short-lived download link for the upload card. |
| `drive_send` | Fastest way to hand PC files to the user: copies files or folders into the synced Drive folder (ChatBridge/寄件). |
| `drive_inbox` | List files the user put into the Drive folder ChatBridge/收件 (from their phone or another computer), newest first, with local PC paths you can open directly with the other tools. |

## Agent hub

| 工具 | 做什麼 |
|---|---|
| `agents_list` | Coding agents on this PC in the owner's order of preference (Kilo Code first, then Cline, then Codex, then Claude Code) with their default model, suggested models and last health check. |
| `agents_check` | Health-check agents by sending each a tiny prompt (read-only). |
| `agent_run` | Start a coding agent on this PC as a background worker for a whole task (e.g. |
| `agent_status` | Progress of an agent conversation (any job id of it): status of the latest run, activity, queued instructions and (when finished) the result. |
| `agent_message` | Steer an agent conversation (any job id of it) in plain language: add a requirement, correct its direction, answer its question. |
| `agent_pause` | Stop the agent's current step but keep the conversation, so it can continue later with agent_resume or agent_message. |
| `agent_resume` | Continue a paused (or finished) agent conversation, optionally with a new instruction. |
| `agent_cancel` | Stop an agent conversation for good (queued instructions are dropped). |
| `agent_result` | Full result of an agent conversation: final report, every changed file and the diffs (truncated when very large). |
| `agent_diff` | The diff of one file changed by an agent conversation. |
| `agent_revert` | Undo every file change of an agent conversation: modified files are restored from the commit the conversation started at, files it created are moved to ChatBridge's trash folder. |
| `agent_jobs` | List recent agent conversations with their status. |
| `agents_configure` | Change the default model an agent uses (e.g. |
| `workbench_open` | Serious coding mode: opens a fullscreen workbench for a project folder where the user works with the coding agents like in a coding app — conversation with the agent, live activity, changed files with diffs, undo, branch, commit/push, agent/model/access settings and past conversations. |
| `workbench_state` | Internal: git branch, uncommitted changes, agents and past conversations of a project folder. |
| `workbench_diff` | Internal: diff of one uncommitted file in a project against HEAD. |
| `workbench_git` | Git actions for a project folder: commit (all changes, with a message), push (current branch to origin), switch (to an existing branch) or create_branch. |

## 交接

| 工具 | 做什麼 |
|---|---|
| `handoff_save` | Save a handoff note so work can continue in a new conversation (long chats get slow). |
| `handoff_load` | Load the latest handoff note (or one by name) to continue earlier work. |

## 其他

| 工具 | 做什麼 |
|---|---|
| `view_screen_frame` | Internal: next frame for the live screen card. |
| `work_recover` | What was still in flight when ChatBridge last stopped (crash, reboot, or the window was closed), and how to pick it up. |
| `owner_challenge` | Get a personal question that only the owner of this PC can answer. |
| `owner_answer` | Send the user's reply to the question from owner_challenge, exactly as they wrote it. |

