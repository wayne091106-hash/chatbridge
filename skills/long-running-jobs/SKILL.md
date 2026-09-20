---
name: Long-running jobs on this PC
description: Start builds, trainings, downloads or servers that run for minutes to days, keep logs, and monitor them safely
tags: [background, training, gpu, logs, monitoring]
version: 1
created: 2026-09-18T00:00:00.000Z
updated: 2026-09-18T00:00:00.000Z
uses: 0
successes: 0
origin: bundled
---

## When to use
Anything that takes more than a couple of minutes: model training, large builds, dataset processing, dev servers.

## Two patterns
**A. Attached (minutes to ~1 hour, you keep watching):**
1. `shell_run` with the command and `yield_seconds` 30–60. Note the session id.
2. Poll with `shell_read` (`wait_seconds` 60–300). Summarise progress instead of pasting logs.
3. `shell_kill` if it hangs; check the last output first.

**B. Detached (survives the agent/bridge restarting):**
1. Create a run folder: `$run = "$env:USERPROFILE\runs\$(Get-Date -Format yyyyMMdd-HHmmss)-NAME"; New-Item -ItemType Directory $run`.
2. Launch with logs and a PID file:
   `$p = Start-Process -FilePath python -ArgumentList 'train.py','--epochs','50' -WorkingDirectory C:\path\to\project -RedirectStandardOutput "$run\out.log" -RedirectStandardError "$run\err.log" -WindowStyle Hidden -PassThru; $p.Id | Set-Content "$run\pid"`
3. Check status: `Get-Process -Id (Get-Content "$run\pid") -ErrorAction SilentlyContinue` and `Get-Content "$run\out.log" -Tail 40`.
4. For unattended monitoring schedule a job, e.g. `every 30m`: "check run folder X, report only if finished or failed (notify_user)".

## GPU work
- Before starting: `nvidia-smi` to confirm free VRAM; avoid starting a second training on a busy GPU.
- For work that should wait for an idle GPU use `schedule_task` with `gpu_idle_below` (e.g. 10).
- Watch memory: `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv -l 5` inside an attached session, then kill it.

## Verification
Report: exit code or process state, last meaningful log lines, output artefacts (paths, sizes), and elapsed time.

## Pitfalls
- Python buffers stdout when redirected: add `-u` or `PYTHONUNBUFFERED=1` so logs appear live.
- Start-Process needs separate `-ArgumentList` items; quote paths with spaces.
- Never leave attached sessions running forever; kill or detach them.
