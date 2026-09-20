---
name: Safe file organizing and cleanup
description: Sort, deduplicate or clean folders (Downloads, Desktop, project dirs) with a dry run first and recoverable deletes
tags: [files, cleanup, organize, downloads]
version: 1
created: 2026-09-18T00:00:00.000Z
updated: 2026-09-18T00:00:00.000Z
uses: 0
successes: 0
origin: bundled
---

## When to use
"Organise my Downloads", "clean up old files", "find duplicates", "free disk space".

## Steps
1. Inventory without changing anything:
   `Get-ChildItem PATH -File | Group-Object Extension | Sort-Object Count -Descending | Select-Object Name,Count,@{n='MB';e={[math]::Round(($_.Group|Measure-Object Length -Sum).Sum/1MB,1)}}`
2. Propose a plan (target folders by type/date, what will move, what could be deleted with total size) and wait for the owner's go-ahead when anything would be deleted.
3. Moves: create folders then `Move-Item -LiteralPath SRC -Destination DST` per file; never overwrite — append ` (2)` when a name exists.
4. Duplicates: hash candidates with equal size only:
   `Get-ChildItem PATH -File -Recurse | Group-Object Length | Where-Object Count -gt 1 | ForEach-Object { $_.Group | Get-FileHash -Algorithm SHA256 } | Group-Object Hash | Where-Object Count -gt 1`
5. Deletes go to the Recycle Bin, not permanent removal:
   `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($path, 'OnlyErrorDialogs', 'SendToRecycleBin')`
6. Write a manifest of every move/delete to `PATH\_organize-log-<date>.csv` so it can be reversed.

## Verification
Re-run the inventory; report counts moved, space freed, and the manifest path.

## Pitfalls
- Use `-LiteralPath` for names containing `[` or `]`.
- Skip files currently open/locked; report them.
- Do not touch OneDrive placeholders (Attributes contains `Offline`/`RecallOnDataAccess`) — moving them triggers downloads.
