---
name: Windows system health check
description: Diagnose a slow or misbehaving Windows PC — CPU/RAM hogs, disk space, GPU state, recent errors, startup items
tags: [windows, diagnostics, performance, gpu]
version: 1
created: 2026-09-18T00:00:00.000Z
updated: 2026-09-18T00:00:00.000Z
uses: 0
successes: 0
origin: bundled
---

## When to use
The owner says the PC is slow, hot, out of space, crashing, or asks for a health report.

## Steps
1. Baseline: `system_info` (CPU, RAM, GPUs, disks).
2. Top processes by CPU and memory:
   `Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Name,Id,CPU,@{n='MB';e={[math]::Round($_.WorkingSet64/1MB)}} | Format-Table -AutoSize`
   `Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 15 Name,Id,@{n='MB';e={[math]::Round($_.WorkingSet64/1MB)}} | Format-Table -AutoSize`
3. GPU detail (NVIDIA): `nvidia-smi` and `nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv`.
4. Disk hotspots (fast, top-level only):
   `Get-ChildItem $env:USERPROFILE -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{Dir=$_.Name; GB=[math]::Round((Get-ChildItem $_.FullName -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum/1GB,2)} } | Sort-Object GB -Descending | Select-Object -First 12`
   Run it with a large yield_seconds; poll with shell_read.
5. Recent critical errors (last 24h):
   `Get-WinEvent -FilterHashtable @{LogName='System','Application'; Level=1,2; StartTime=(Get-Date).AddDays(-1)} -MaxEvents 40 | Select-Object TimeCreated,ProviderName,Id,Message | Format-List`
6. Startup items: `Get-CimInstance Win32_StartupCommand | Select-Object Name,Command,Location`.
7. Uptime / pending reboot: `(Get-CimInstance Win32_OperatingSystem).LastBootUpTime`.

## Report
Lead with the top 3 findings and concrete, reversible actions. Do not kill processes, uninstall software or delete files unless the owner asks.

## Pitfalls
- Recursive size scans of the whole drive take minutes; scope them.
- `Get-WinEvent` needs `-ErrorAction SilentlyContinue` when a log has no matching events.
- Localised Windows (zh-TW) prints translated messages; that is expected.
