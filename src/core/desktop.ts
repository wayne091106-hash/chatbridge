import os from "node:os";
import path from "node:path";
import type { Executor } from "./executor.js";
import type { ShellManager } from "./shell.js";
import { formatBytes, randomId } from "./util.js";

const USER32 = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class KUser32 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@ -ErrorAction SilentlyContinue
[void][KUser32]::SetProcessDPIAware()
`;

function encodePs(script: string): string {
  return Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;\n" + script, "utf16le").toString("base64");
}

/** Remove PowerShell CLIXML progress/error records emitted on redirected stderr. */
export function stripClixml(text: string): string {
  return text
    .replace(/#< CLIXML\s*/g, "")
    .replace(/<Objs[\s\S]*?<\/Objs>/g, "")
    .trim();
}

/** Escape literal text for System.Windows.Forms.SendKeys. */
export function escapeSendKeys(text: string): string {
  return text.replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`).replace(/\r?\n/g, "{ENTER}").replace(/\t/g, "{TAB}");
}

/**
 * Windows desktop control (screenshots, mouse, keyboard, windows) implemented with PowerShell +
 * user32 so it runs through the same executor as everything else. Coordinates default to the
 * space of the most recent screenshot, which is what a vision model sees.
 */
export class DesktopService {
  private lastScale = 1;
  private lastOrigin = { x: 0, y: 0 };

  constructor(
    private readonly executor: Executor,
    private readonly shells: ShellManager,
  ) {}

  private async ps(script: string, timeoutSeconds = 60): Promise<string> {
    if (process.platform !== "win32") throw new Error("desktop control is implemented for Windows only");
    const r = await this.shells.exec("[desktop script]", {
      argv: ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePs(script)],
      timeoutSeconds,
    });
    if (r.timedOut) throw new Error("desktop script timed out");
    const output = stripClixml(r.output);
    if (r.exitCode !== 0) throw new Error(`desktop script failed (exit ${r.exitCode}): ${output.slice(0, 1500)}`);
    // Scripts print their result last; anything before it is incidental host output.
    const lines = output.split("\n").filter((l) => l.trim());
    return (lines.at(-1) ?? "").trim();
  }

  async systemInfo() {
    const cpus = os.cpus();
    const info: Record<string, unknown> = {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()} (${os.arch()})`,
      uptimeHours: +(os.uptime() / 3600).toFixed(1),
      cpu: { model: cpus[0]?.model.trim(), cores: cpus.length, loadAvg: os.loadavg() },
      memory: { total: formatBytes(os.totalmem()), free: formatBytes(os.freemem()) },
      user: os.userInfo().username,
      homeDir: os.homedir(),
      executor: await this.executor.info(),
    };
    const gpu = await this.shells.exec("nvidia-smi", {
      argv: ["nvidia-smi", "--query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu,driver_version", "--format=csv,noheader"],
      timeoutSeconds: 15,
    }).catch(() => null);
    if (gpu && gpu.exitCode === 0) {
      info.gpus = gpu.output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [name, memTotal, memUsed, util, temp, driver] = l.split(",").map((s) => s.trim());
          return { name, memTotal, memUsed, util, temp: `${temp} C`, driver };
        });
    }
    if (process.platform === "win32") {
      const disks = await this.ps(
        `Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { [pscustomobject]@{ drive=$_.DeviceID; sizeGB=[math]::Round($_.Size/1GB,1); freeGB=[math]::Round($_.FreeSpace/1GB,1) } } | ConvertTo-Json -Compress`,
        30,
      ).catch(() => "");
      if (disks) {
        try {
          info.disks = JSON.parse(disks);
        } catch {
          /* ignore */
        }
      }
    }
    return info;
  }

  async screenshot(opts: { maxWidth?: number; display?: "all" | "primary" } = {}) {
    const maxWidth = Math.min(Math.max(opts.maxWidth ?? 1600, 320), 3840);
    const file = path.join(os.tmpdir(), `chatbridge-shot-${randomId("", 4)}.png`);
    const script = `${USER32}
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = ${opts.display === "primary" ? "[System.Windows.Forms.Screen]::PrimaryScreen.Bounds" : "[System.Windows.Forms.SystemInformation]::VirtualScreen"}
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$cursor = [System.Windows.Forms.Cursor]::Position
$scale = [math]::Min(1.0, ${maxWidth} / $b.Width)
$w = [int]($b.Width * $scale); $h = [int]($b.Height * $scale)
$out = New-Object System.Drawing.Bitmap $w, $h
$g2 = [System.Drawing.Graphics]::FromImage($out)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($bmp, 0, 0, $w, $h)
$out.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $g2.Dispose(); $bmp.Dispose(); $out.Dispose()
[pscustomobject]@{ x=$b.X; y=$b.Y; width=$b.Width; height=$b.Height; scale=$scale; outWidth=$w; outHeight=$h; cursorX=$cursor.X; cursorY=$cursor.Y } | ConvertTo-Json -Compress`;
    const meta = JSON.parse(await this.ps(script));
    const png = await this.executor.readFile(file);
    await this.executor.remove(file).catch(() => {});
    this.lastScale = meta.scale;
    this.lastOrigin = { x: meta.x, y: meta.y };
    return { png, meta };
  }

  private toScreen(x: number, y: number, space: "screenshot" | "screen") {
    if (space === "screen") return { x: Math.round(x), y: Math.round(y) };
    return { x: Math.round(x / this.lastScale + this.lastOrigin.x), y: Math.round(y / this.lastScale + this.lastOrigin.y) };
  }

  async mouse(o: { action: "move" | "click" | "double_click" | "right_click" | "middle_click" | "scroll" | "drag"; x?: number; y?: number; toX?: number; toY?: number; amount?: number; space?: "screenshot" | "screen" }) {
    const space = o.space ?? "screenshot";
    const lines: string[] = [USER32];
    const move = (x: number, y: number) => {
      const p = this.toScreen(x, y, space);
      lines.push(`[void][KUser32]::SetCursorPos(${p.x}, ${p.y}); Start-Sleep -Milliseconds 40`);
      return p;
    };
    let at: { x: number; y: number } | null = null;
    if (o.x !== undefined && o.y !== undefined) at = move(o.x, o.y);
    const ev = (flags: number, data = 0) => lines.push(`[KUser32]::mouse_event(${flags}, 0, 0, ${data}, [UIntPtr]::Zero); Start-Sleep -Milliseconds 30`);
    switch (o.action) {
      case "move":
        if (!at) throw new Error("move requires x and y");
        break;
      case "click":
        ev(0x2), ev(0x4);
        break;
      case "double_click":
        ev(0x2), ev(0x4), ev(0x2), ev(0x4);
        break;
      case "right_click":
        ev(0x8), ev(0x10);
        break;
      case "middle_click":
        ev(0x20), ev(0x40);
        break;
      case "scroll":
        ev(0x800, Math.round((o.amount ?? -3) * 120));
        break;
      case "drag": {
        if (o.toX === undefined || o.toY === undefined || !at) throw new Error("drag requires x, y, toX, toY");
        ev(0x2);
        move(o.toX, o.toY);
        ev(0x4);
        break;
      }
    }
    lines.push(`Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; "{0},{1}" -f $p.X,$p.Y`);
    const pos = await this.ps(lines.join("\n"));
    return { action: o.action, screenPosition: pos };
  }

  async keyboard(o: { text?: string; keys?: string }) {
    if (!o.text && !o.keys) throw new Error("provide text (literal typing) or keys (SendKeys syntax, e.g. ^c, %{F4}, {ENTER})");
    const payload = o.keys ?? escapeSendKeys(o.text!);
    const script = `Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${payload.replace(/'/g, "''")}')
"sent"`;
    await this.ps(script);
    return { sent: o.keys ? `keys ${o.keys}` : `${o.text!.length} characters` };
  }

  async clipboard(o: { action: "get" | "set"; text?: string }) {
    if (o.action === "get") {
      const text = await this.ps(`Add-Type -AssemblyName System.Windows.Forms; $t=[System.Windows.Forms.Clipboard]::GetText(); [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t))`);
      return { text: Buffer.from(text, "base64").toString("utf8") };
    }
    const b64 = Buffer.from(o.text ?? "", "utf8").toString("base64");
    await this.ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))); "ok"`);
    return { set: true, chars: (o.text ?? "").length };
  }

  async windows() {
    const out = await this.ps(
      `Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Sort-Object ProcessName | ForEach-Object { [pscustomobject]@{ pid=$_.Id; process=$_.ProcessName; title=$_.MainWindowTitle } } | ConvertTo-Json -Compress`,
    );
    if (!out) return [];
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  async focusWindow(o: { pid?: number; title?: string }) {
    const selector = o.pid
      ? `Get-Process -Id ${Number(o.pid)}`
      : `Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*${(o.title ?? "").replace(/'/g, "''")}*' } | Select-Object -First 1`;
    const out = await this.ps(`${USER32}
$p = ${selector}
if (-not $p) { throw "window not found" }
[void][KUser32]::ShowWindow($p.MainWindowHandle, 9)
$ok = [KUser32]::SetForegroundWindow($p.MainWindowHandle)
if (-not $ok) { (New-Object -ComObject WScript.Shell).AppActivate($p.Id) | Out-Null }
"{0}|{1}" -f $p.Id, $p.MainWindowTitle`);
    const [pid, title] = out.split("|");
    return { focused: true, pid: Number(pid), title };
  }
}
