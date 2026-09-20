import os from "node:os";
import path from "node:path";
import type { Executor } from "./executor.js";
import type { ShellManager } from "./shell.js";
import { formatBytes, randomId } from "./util.js";

const USER32 = `
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)] public struct KRECT { public int Left; public int Top; public int Right; public int Bottom; }
public static class KUser32 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out KRECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
}
"@ -ErrorAction SilentlyContinue
[void][KUser32]::SetProcessDPIAware()
`;

/**
 * Puts the title of whatever is in front into $fgTitle, so an action can report where it actually landed.
 * These are statements, not an expression: assigning the whole thing to a variable captures the window
 * handle instead of the title.
 */
const FOREGROUND_PS = `$fgh=[KUser32]::GetForegroundWindow(); $fgsb=New-Object System.Text.StringBuilder 512; [void][KUser32]::GetWindowText($fgh,$fgsb,512); $fgTitle=$fgsb.ToString()`;

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
  private lastShotAt = 0;

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

  async screenshot(opts: { maxWidth?: number; display?: "all" | "primary"; window?: string | number } = {}) {
    // A screenshot of one window beats a shrunken picture of the whole desktop: the target is bigger, so
    // the model's coordinates are better, and they land in a space that cannot drift between monitors.
    const maxWidth = Math.min(Math.max(opts.maxWidth ?? 1920, 320), 3840);
    const file = path.join(os.tmpdir(), `chatbridge-shot-${randomId("", 4)}.png`);
    const windowSelector =
      opts.window === undefined
        ? null
        : typeof opts.window === "number"
          ? `Get-Process -Id ${Math.round(opts.window)}`
          : `Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*${String(opts.window).replace(/'/g, "''")}*' } | Select-Object -First 1`;
    const bounds = windowSelector
      ? `$p = ${windowSelector}
if (-not $p) { throw "window not found" }
$r = New-Object KRECT
[void][KUser32]::GetWindowRect($p.MainWindowHandle, [ref]$r)
if ($r.Left -lt -30000) { throw "that window is minimised — focus it first with window_focus" }
$b = New-Object System.Drawing.Rectangle $r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top)`
      : `$b = ${opts.display === "primary" ? "[System.Windows.Forms.Screen]::PrimaryScreen.Bounds" : "[System.Windows.Forms.SystemInformation]::VirtualScreen"}`;
    const script = `${USER32}
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
${bounds}
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
    this.lastShotAt = Date.now();
    return { png, meta };
  }

  /** How long a screenshot is treated as describing the screen. Windows move; menus close. */
  private static readonly SHOT_FRESH_MS = 120_000;

  private toScreen(x: number, y: number, space: "screenshot" | "screen") {
    if (space === "screen") return { x: Math.round(x), y: Math.round(y) };
    // Without a screenshot there is no coordinate space to convert from, and guessing 1:1 silently clicks
    // the wrong place — which looks like the click "not working" rather than a missing step.
    if (!this.lastShotAt) {
      throw new Error("no screenshot has been taken yet, so screenshot coordinates mean nothing. Call screen_capture first (ideally with window set), or pass space='screen' for real screen pixels.");
    }
    return { x: Math.round(x / this.lastScale + this.lastOrigin.x), y: Math.round(y / this.lastScale + this.lastOrigin.y) };
  }

  private staleWarning(space: "screenshot" | "screen"): string {
    if (space !== "screenshot" || !this.lastShotAt) return "";
    const age = Date.now() - this.lastShotAt;
    return age > DesktopService.SHOT_FRESH_MS ? ` WARNING: the screenshot these coordinates came from is ${Math.round(age / 1000)}s old; take a fresh one if this did not land where you expected.` : "";
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
    // Report where the pointer actually ended up and what is in front afterwards, so the model has
    // evidence the click landed instead of an "ok" that means nothing.
    lines.push(`Start-Sleep -Milliseconds 120`);
    lines.push(`Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position`);
    lines.push(FOREGROUND_PS);
    lines.push(`"{0},{1}|{2}" -f $p.X,$p.Y,$fgTitle`);
    const out = await this.ps(lines.join("\n"));
    const [pos = "", front = ""] = out.split("|");
    const asked = at ? `${at.x},${at.y}` : "";
    const drift = asked && pos.trim() !== asked ? ` (asked for ${asked}; something moved the pointer)` : "";
    return { action: o.action, screenPosition: pos.trim() + drift, foregroundWindow: front.trim() || "(none)", note: this.staleWarning(space).trim() || undefined };
  }

  async keyboard(o: { text?: string; keys?: string }) {
    if (!o.text && !o.keys) throw new Error("provide text (literal typing) or keys (SendKeys syntax, e.g. ^c, %{F4}, {ENTER})");
    const payload = o.keys ?? escapeSendKeys(o.text!);
    const script = `${USER32}
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${payload.replace(/'/g, "''")}')
Start-Sleep -Milliseconds 120
${FOREGROUND_PS}
$fgTitle`;
    // Typing goes wherever the focus is, so naming the window it landed in is the only way to notice a miss.
    const front = (await this.ps(script)).trim();
    return { sent: o.keys ? `keys ${o.keys}` : `${o.text!.length} characters`, wentTo: front || "(no focused window)" };
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
