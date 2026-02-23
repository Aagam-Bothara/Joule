import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';
import type { ToolDefinition } from '@joule/shared';

// --- Configuration ---

let osConfig = {
  screenshotDir: '.joule/screenshots',
  commandTimeoutMs: 15_000,
};

export function configureOsAutomation(config?: {
  screenshotDir?: string;
  commandTimeoutMs?: number;
}): void {
  if (config?.screenshotDir) osConfig.screenshotDir = config.screenshotDir;
  if (config?.commandTimeoutMs) osConfig.commandTimeoutMs = config.commandTimeoutMs;
}

// --- Helpers ---

const platform = process.platform;

function estimateEnergy(durationMs: number): number {
  // OS automation: 0.3 mWh base + 0.05 mWh per second (lighter than browser ops)
  return 0.3 + 0.05 * (durationMs / 1000);
}

function runPowershell(script: string, timeoutMs?: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: timeoutMs ?? osConfig.commandTimeoutMs,
      maxBuffer: 5 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        exitCode: error && 'code' in error ? (error as any).code ?? 1 : 0,
      });
    });
  });
}

function runShell(cmd: string, args: string[], timeoutMs?: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      timeout: timeoutMs ?? osConfig.commandTimeoutMs,
      maxBuffer: 5 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        exitCode: error && 'code' in error ? (error as any).code ?? 1 : 0,
      });
    });
  });
}

// Virtual key code mapping for Windows keyboard input
const VK_CODES: Record<string, number> = {
  enter: 0x0D, return: 0x0D, tab: 0x09, escape: 0x1B, esc: 0x1B,
  space: 0x20, backspace: 0x08, delete: 0x2E, insert: 0x2D,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  ctrl: 0xA2, alt: 0xA4, shift: 0xA0, win: 0x5B, meta: 0x5B, cmd: 0x5B,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7A, f12: 0x7B,
  printscreen: 0x2C, scrolllock: 0x91, pause: 0x13,
  a: 0x41, b: 0x42, c: 0x43, d: 0x44, e: 0x45, f: 0x46,
  g: 0x47, h: 0x48, i: 0x49, j: 0x4A, k: 0x4B, l: 0x4C,
  m: 0x4D, n: 0x4E, o: 0x4F, p: 0x50, q: 0x51, r: 0x52,
  s: 0x53, t: 0x54, u: 0x55, v: 0x56, w: 0x57, x: 0x58,
  y: 0x59, z: 0x5A,
  '0': 0x30, '1': 0x31, '2': 0x32, '3': 0x33, '4': 0x34,
  '5': 0x35, '6': 0x36, '7': 0x37, '8': 0x38, '9': 0x39,
  // Punctuation / OEM keys
  ';': 0xBA, semicolon: 0xBA, '=': 0xBB, equals: 0xBB, plus: 0xBB,
  ',': 0xBC, comma: 0xBC, '-': 0xBD, minus: 0xBD, hyphen: 0xBD,
  '.': 0xBE, period: 0xBE, '/': 0xBF, slash: 0xBF,
  '`': 0xC0, backtick: 0xC0, tilde: 0xC0,
  '[': 0xDB, leftbracket: 0xDB, ']': 0xDD, rightbracket: 0xDD,
  '\\': 0xDC, backslash: 0xDC, "'": 0xDE, quote: 0xDE,
};

// ============================================================
// Tool 1: os_screenshot
// ============================================================

const screenshotInput = z.object({
  region: z.object({
    x: z.number().int().describe('Left edge X coordinate'),
    y: z.number().int().describe('Top edge Y coordinate'),
    width: z.number().int().positive().describe('Width in pixels'),
    height: z.number().int().positive().describe('Height in pixels'),
  }).optional().describe('Capture only this rectangular region (default: full screen)'),
  display: z.number().int().min(0).default(0).optional().describe('Display index for multi-monitor setups'),
  returnBase64: z.boolean().optional().default(false).describe('Also return base64 image data for LLM vision'),
});

const screenshotOutput = z.object({
  path: z.string(),
  width: z.number(),
  height: z.number(),
  energyMWh: z.number(),
  base64: z.string().optional(),
});

export const osScreenshotTool: ToolDefinition = {
  name: 'os_screenshot',
  description: 'Capture a screenshot of the desktop screen or a specific region. Returns the file path and dimensions.',
  inputSchema: screenshotInput,
  outputSchema: screenshotOutput,
  tags: ['system', 'os-automation'],
  timeoutMs: 10_000,
  async execute(input) {
    const parsed = input as z.infer<typeof screenshotInput>;
    const start = Date.now();

    await fsPromises.mkdir(osConfig.screenshotDir, { recursive: true });
    const filename = `os-screenshot-${Date.now()}.png`;
    const outputPath = join(osConfig.screenshotDir, filename);

    let width = 0;
    let height = 0;

    if (platform === 'win32') {
      const script = parsed.region
        ? `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(${parsed.region.width}, ${parsed.region.height})
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${parsed.region.x}, ${parsed.region.y}, 0, 0, (New-Object System.Drawing.Size(${parsed.region.width}, ${parsed.region.height})))
$g.Dispose()
$bmp.Save('${outputPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "${parsed.region.width}x${parsed.region.height}"
`
        : `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$screen = [System.Windows.Forms.Screen]::AllScreens[${parsed.display ?? 0}]
$bounds = $screen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$g.Dispose()
$bmp.Save('${outputPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "$($bounds.Width)x$($bounds.Height)"
`;
      const result = await runPowershell(script);
      if (result.exitCode !== 0) throw new Error(`Screenshot failed: ${result.stderr.trim()}`);
      const dims = result.stdout.trim().split('x');
      width = parseInt(dims[0], 10);
      height = parseInt(dims[1], 10);
    } else if (platform === 'darwin') {
      if (parsed.region) {
        const { x, y, width: w, height: h } = parsed.region;
        await runShell('screencapture', ['-x', `-R${x},${y},${w},${h}`, outputPath]);
        width = w;
        height = h;
      } else {
        await runShell('screencapture', ['-x', outputPath]);
        // Get dimensions via sips
        const result = await runShell('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', outputPath]);
        const wMatch = result.stdout.match(/pixelWidth:\s*(\d+)/);
        const hMatch = result.stdout.match(/pixelHeight:\s*(\d+)/);
        width = wMatch ? parseInt(wMatch[1], 10) : 0;
        height = hMatch ? parseInt(hMatch[1], 10) : 0;
      }
    } else {
      // Linux: use scrot or import (ImageMagick)
      if (parsed.region) {
        const { x, y, width: w, height: h } = parsed.region;
        await runShell('import', ['-window', 'root', '-crop', `${w}x${h}+${x}+${y}`, outputPath]);
        width = w;
        height = h;
      } else {
        await runShell('scrot', [outputPath]);
        const result = await runShell('identify', ['-format', '%wx%h', outputPath]);
        const dims = result.stdout.trim().split('x');
        width = parseInt(dims[0], 10) || 0;
        height = parseInt(dims[1], 10) || 0;
      }
    }

    const duration = Date.now() - start;
    const result: Record<string, unknown> = { path: outputPath, width, height, energyMWh: estimateEnergy(duration) };

    if (parsed.returnBase64) {
      const fileData = await fsPromises.readFile(outputPath);
      result.base64 = fileData.toString('base64');
    }

    return result;
  },
};

// ============================================================
// Tool 2: os_mouse
// ============================================================

const mouseInput = z.object({
  action: z.enum(['move', 'click', 'doubleclick', 'rightclick', 'scroll']).describe('Mouse action to perform'),
  x: z.number().int().optional().describe('Target X coordinate (required for move/click actions)'),
  y: z.number().int().optional().describe('Target Y coordinate (required for move/click actions)'),
  scrollAmount: z.number().int().optional().describe('Scroll lines: positive=down, negative=up (for scroll action)'),
});

const mouseOutput = z.object({
  success: z.boolean(),
  x: z.number(),
  y: z.number(),
  energyMWh: z.number(),
});

const WIN_MOUSE_CSHARP = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinMouse {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, IntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    public const uint MOUSEEVENTF_LEFTDOWN = 0x02;
    public const uint MOUSEEVENTF_LEFTUP = 0x04;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x08;
    public const uint MOUSEEVENTF_RIGHTUP = 0x10;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;
}
"@
`;

function buildMouseScript(action: string, x?: number, y?: number, scrollAmount?: number): string {
  let script = WIN_MOUSE_CSHARP;

  if (action === 'move' || action === 'click' || action === 'doubleclick' || action === 'rightclick') {
    script += `[WinMouse]::SetCursorPos(${x}, ${y})\n`;
    script += `Start-Sleep -Milliseconds 50\n`;
  }

  if (action === 'click') {
    script += `[WinMouse]::mouse_event([WinMouse]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)\n`;
    script += `[WinMouse]::mouse_event([WinMouse]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [IntPtr]::Zero)\n`;
  } else if (action === 'doubleclick') {
    script += `[WinMouse]::mouse_event([WinMouse]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)\n`;
    script += `[WinMouse]::mouse_event([WinMouse]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [IntPtr]::Zero)\n`;
    script += `Start-Sleep -Milliseconds 50\n`;
    script += `[WinMouse]::mouse_event([WinMouse]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)\n`;
    script += `[WinMouse]::mouse_event([WinMouse]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [IntPtr]::Zero)\n`;
  } else if (action === 'rightclick') {
    script += `[WinMouse]::mouse_event([WinMouse]::MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, [IntPtr]::Zero)\n`;
    script += `[WinMouse]::mouse_event([WinMouse]::MOUSEEVENTF_RIGHTUP, 0, 0, 0, [IntPtr]::Zero)\n`;
  } else if (action === 'scroll') {
    // Windows wheel delta unit is 120 per notch
    const delta = (scrollAmount ?? 0) * 120;
    script += `[WinMouse]::mouse_event([WinMouse]::MOUSEEVENTF_WHEEL, 0, 0, ${delta}, [IntPtr]::Zero)\n`;
  }

  // Get final cursor position
  script += `$p = New-Object WinMouse+POINT\n`;
  script += `[WinMouse]::GetCursorPos([ref]$p) | Out-Null\n`;
  script += `Write-Output "$($p.X),$($p.Y)"\n`;

  return script;
}

export const osMouseTool: ToolDefinition = {
  name: 'os_mouse',
  description: 'Control the mouse cursor: move, click, double-click, right-click, or scroll at specific screen coordinates.',
  inputSchema: mouseInput,
  outputSchema: mouseOutput,
  tags: ['system', 'os-automation', 'dangerous'],
  requiresConfirmation: true,
  timeoutMs: 5_000,
  async execute(input) {
    const parsed = input as z.infer<typeof mouseInput>;
    const start = Date.now();

    // Validate required coordinates
    if (['move', 'click', 'doubleclick', 'rightclick'].includes(parsed.action)) {
      if (parsed.x === undefined || parsed.y === undefined) {
        throw new Error(`Action "${parsed.action}" requires x and y coordinates`);
      }
    }
    if (parsed.action === 'scroll' && parsed.scrollAmount === undefined) {
      throw new Error('Action "scroll" requires scrollAmount');
    }

    let finalX = parsed.x ?? 0;
    let finalY = parsed.y ?? 0;

    if (platform === 'win32') {
      const script = buildMouseScript(parsed.action, parsed.x, parsed.y, parsed.scrollAmount);
      const result = await runPowershell(script);
      if (result.exitCode !== 0) throw new Error(`os_mouse ${parsed.action} failed: ${result.stderr.trim()}`);
      const coords = result.stdout.trim().split(',');
      finalX = parseInt(coords[0], 10) || finalX;
      finalY = parseInt(coords[1], 10) || finalY;
    } else if (platform === 'darwin') {
      if (parsed.action === 'move') {
        await runShell('cliclick', [`m:${parsed.x},${parsed.y}`]);
      } else if (parsed.action === 'click') {
        await runShell('cliclick', [`c:${parsed.x},${parsed.y}`]);
      } else if (parsed.action === 'doubleclick') {
        await runShell('cliclick', [`dc:${parsed.x},${parsed.y}`]);
      } else if (parsed.action === 'rightclick') {
        await runShell('cliclick', [`rc:${parsed.x},${parsed.y}`]);
      }
    } else {
      // Linux: xdotool
      if (parsed.action === 'move') {
        await runShell('xdotool', ['mousemove', String(parsed.x), String(parsed.y)]);
      } else if (parsed.action === 'click') {
        await runShell('xdotool', ['mousemove', String(parsed.x), String(parsed.y)]);
        await runShell('xdotool', ['click', '1']);
      } else if (parsed.action === 'doubleclick') {
        await runShell('xdotool', ['mousemove', String(parsed.x), String(parsed.y)]);
        await runShell('xdotool', ['click', '--repeat', '2', '1']);
      } else if (parsed.action === 'rightclick') {
        await runShell('xdotool', ['mousemove', String(parsed.x), String(parsed.y)]);
        await runShell('xdotool', ['click', '3']);
      } else if (parsed.action === 'scroll') {
        const button = (parsed.scrollAmount ?? 0) > 0 ? '5' : '4';
        const clicks = Math.abs(parsed.scrollAmount ?? 0);
        await runShell('xdotool', ['click', '--repeat', String(clicks), button]);
      }
    }

    const duration = Date.now() - start;
    return { success: true, x: finalX, y: finalY, energyMWh: estimateEnergy(duration) };
  },
};

// ============================================================
// Tool 3: os_keyboard
// ============================================================

const keyboardInput = z.object({
  action: z.enum(['type', 'press', 'hotkey']).describe('Keyboard action: type text, press a single key, or press a hotkey combo'),
  text: z.string().optional().describe('Text to type (for "type" action)'),
  key: z.string().optional().describe('Key name to press (for "press"/"hotkey"), e.g. "enter", "tab", "escape", "a", "f5"'),
  modifiers: z.array(z.enum(['ctrl', 'alt', 'shift', 'win', 'meta', 'cmd'])).optional()
    .describe('Modifier keys for hotkey, e.g. ["ctrl", "shift"]'),
});

const keyboardOutput = z.object({
  success: z.boolean(),
  energyMWh: z.number(),
});

function buildKeyboardScript(action: string, text?: string, key?: string, modifiers?: string[]): string {
  if (action === 'type' && text) {
    // Base64 encode to prevent PowerShell injection
    const b64 = Buffer.from(text, 'utf-8').toString('base64');
    return `
Add-Type -AssemblyName System.Windows.Forms
$text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
foreach ($char in $text.ToCharArray()) {
  $str = [string]$char
  if ('+^%~(){}[]'.Contains($str)) { $str = '{' + $str + '}' }
  [System.Windows.Forms.SendKeys]::SendWait($str)
}
Write-Output "OK"
`;
  }

  if ((action === 'press' || action === 'hotkey') && key) {
    const vk = VK_CODES[key.toLowerCase()];
    if (vk === undefined) {
      throw new Error(`Unknown key: "${key}". Supported keys: ${Object.keys(VK_CODES).join(', ')}`);
    }

    let script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinKbd {
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);
    public const uint KEYEVENTF_KEYUP = 0x02;
}
"@
`;

    const modVks: number[] = [];
    if (modifiers && modifiers.length > 0) {
      for (const mod of modifiers) {
        const modVk = VK_CODES[mod.toLowerCase()];
        if (modVk !== undefined) modVks.push(modVk);
      }
    }

    // Press modifiers down
    for (const mvk of modVks) {
      script += `[WinKbd]::keybd_event(${mvk}, 0, 0, [IntPtr]::Zero)\n`;
    }
    // Press key
    script += `[WinKbd]::keybd_event(${vk}, 0, 0, [IntPtr]::Zero)\n`;
    script += `Start-Sleep -Milliseconds 30\n`;
    script += `[WinKbd]::keybd_event(${vk}, 0, [WinKbd]::KEYEVENTF_KEYUP, [IntPtr]::Zero)\n`;
    // Release modifiers in reverse
    for (const mvk of modVks.reverse()) {
      script += `[WinKbd]::keybd_event(${mvk}, 0, [WinKbd]::KEYEVENTF_KEYUP, [IntPtr]::Zero)\n`;
    }
    script += `Write-Output "OK"\n`;
    return script;
  }

  throw new Error(`Invalid keyboard action: "${action}" requires ${action === 'type' ? 'text' : 'key'}`);
}

export const osKeyboardTool: ToolDefinition = {
  name: 'os_keyboard',
  description: 'Control the keyboard: type text, press a single key, or perform a hotkey combo (e.g., Ctrl+C, Alt+Tab, Win+R).',
  inputSchema: keyboardInput,
  outputSchema: keyboardOutput,
  tags: ['system', 'os-automation', 'dangerous'],
  requiresConfirmation: true,
  timeoutMs: 10_000,
  async execute(input) {
    const parsed = input as z.infer<typeof keyboardInput>;
    const start = Date.now();

    if (platform === 'win32') {
      const script = buildKeyboardScript(parsed.action, parsed.text, parsed.key, parsed.modifiers);
      const result = await runPowershell(script);
      if (result.exitCode !== 0) throw new Error(`os_keyboard ${parsed.action} failed: ${result.stderr.trim()}`);
    } else if (platform === 'darwin') {
      if (parsed.action === 'type' && parsed.text) {
        await runShell('osascript', ['-e', `tell application "System Events" to keystroke "${parsed.text.replace(/"/g, '\\"')}"`]);
      } else if (parsed.action === 'press' && parsed.key) {
        await runShell('osascript', ['-e', `tell application "System Events" to key code ${VK_CODES[parsed.key.toLowerCase()] ?? 0}`]);
      } else if (parsed.action === 'hotkey' && parsed.key) {
        const mods = (parsed.modifiers ?? []).map(m => m === 'ctrl' ? 'control' : m === 'win' || m === 'meta' ? 'command' : m);
        const modStr = mods.map(m => `${m} down`).join(', ');
        await runShell('osascript', ['-e', `tell application "System Events" to keystroke "${parsed.key}" using {${modStr}}`]);
      }
    } else {
      // Linux: xdotool
      if (parsed.action === 'type' && parsed.text) {
        await runShell('xdotool', ['type', '--', parsed.text]);
      } else if (parsed.action === 'press' && parsed.key) {
        await runShell('xdotool', ['key', parsed.key]);
      } else if (parsed.action === 'hotkey' && parsed.key) {
        const combo = [...(parsed.modifiers ?? []), parsed.key].join('+');
        await runShell('xdotool', ['key', combo]);
      }
    }

    const duration = Date.now() - start;
    return { success: true, energyMWh: estimateEnergy(duration) };
  },
};

// ============================================================
// Tool 4: os_window
// ============================================================

const windowInput = z.object({
  action: z.enum(['list', 'focus', 'minimize', 'maximize', 'close', 'resize', 'move'])
    .describe('Window management action to perform'),
  title: z.string().optional().describe('Window title substring to match (case-insensitive)'),
  pid: z.number().int().optional().describe('Process ID of the target window'),
  width: z.number().int().optional().describe('New width for resize action'),
  height: z.number().int().optional().describe('New height for resize action'),
  x: z.number().int().optional().describe('New X position for move action'),
  y: z.number().int().optional().describe('New Y position for move action'),
});

const windowEntrySchema = z.object({
  title: z.string(),
  pid: z.number(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  processName: z.string(),
});

const windowOutput = z.object({
  windows: z.array(windowEntrySchema).optional(),
  success: z.boolean(),
  energyMWh: z.number(),
});

const WIN_WINDOW_CSHARP = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinWindow {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    public const int SW_MINIMIZE = 6;
    public const int SW_MAXIMIZE = 3;
    public const int SW_RESTORE = 9;
}
"@
`;

function buildWindowScript(action: string, title?: string, pid?: number, width?: number, height?: number, x?: number, y?: number): string {
  const safeTitle = title ? title.replace(/'/g, "''") : '';

  if (action === 'list') {
    return `
${WIN_WINDOW_CSHARP}
$windows = @()
Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | ForEach-Object {
    $rect = New-Object WinWindow+RECT
    [WinWindow]::GetWindowRect($_.MainWindowHandle, [ref]$rect) | Out-Null
    $windows += [PSCustomObject]@{
        title = $_.MainWindowTitle
        pid = $_.Id
        processName = $_.ProcessName
        x = $rect.Left
        y = $rect.Top
        width = $rect.Right - $rect.Left
        height = $rect.Bottom - $rect.Top
    }
}
$windows | ConvertTo-Json -Compress
`;
  }

  // Find the target process
  let findProc: string;
  if (pid) {
    findProc = `$proc = Get-Process -Id ${pid} -ErrorAction Stop`;
  } else if (title) {
    findProc = `$proc = Get-Process | Where-Object { $_.MainWindowTitle -like '*${safeTitle}*' } | Select-Object -First 1
if (-not $proc) { throw "No window matching '${safeTitle}' found" }`;
  } else {
    return `throw "Either title or pid is required for action '${action}'"`;
  }

  if (action === 'focus') {
    return `
${WIN_WINDOW_CSHARP}
${findProc}
[WinWindow]::ShowWindow($proc.MainWindowHandle, [WinWindow]::SW_RESTORE) | Out-Null
[WinWindow]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
Write-Output "OK"
`;
  }

  if (action === 'minimize') {
    return `
${WIN_WINDOW_CSHARP}
${findProc}
[WinWindow]::ShowWindow($proc.MainWindowHandle, [WinWindow]::SW_MINIMIZE) | Out-Null
Write-Output "OK"
`;
  }

  if (action === 'maximize') {
    return `
${WIN_WINDOW_CSHARP}
${findProc}
[WinWindow]::ShowWindow($proc.MainWindowHandle, [WinWindow]::SW_MAXIMIZE) | Out-Null
Write-Output "OK"
`;
  }

  if (action === 'close') {
    return `
${findProc}
$proc.CloseMainWindow() | Out-Null
Write-Output "OK"
`;
  }

  if (action === 'resize') {
    return `
${WIN_WINDOW_CSHARP}
${findProc}
$rect = New-Object WinWindow+RECT
[WinWindow]::GetWindowRect($proc.MainWindowHandle, [ref]$rect) | Out-Null
[WinWindow]::MoveWindow($proc.MainWindowHandle, $rect.Left, $rect.Top, ${width ?? 800}, ${height ?? 600}, $true) | Out-Null
Write-Output "OK"
`;
  }

  if (action === 'move') {
    return `
${WIN_WINDOW_CSHARP}
${findProc}
$rect = New-Object WinWindow+RECT
[WinWindow]::GetWindowRect($proc.MainWindowHandle, [ref]$rect) | Out-Null
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
[WinWindow]::MoveWindow($proc.MainWindowHandle, ${x ?? 0}, ${y ?? 0}, $w, $h, $true) | Out-Null
Write-Output "OK"
`;
  }

  return `throw "Unknown action: ${action}"`;
}

export const osWindowTool: ToolDefinition = {
  name: 'os_window',
  description: 'Manage desktop windows: list all open windows, focus/minimize/maximize/close/resize/move a window by title or PID.',
  inputSchema: windowInput,
  outputSchema: windowOutput,
  tags: ['system', 'os-automation'],
  requiresConfirmation: true,
  timeoutMs: 10_000,
  async execute(input) {
    const parsed = input as z.infer<typeof windowInput>;
    const start = Date.now();

    if (platform === 'win32') {
      const script = buildWindowScript(parsed.action, parsed.title, parsed.pid, parsed.width, parsed.height, parsed.x, parsed.y);
      const result = await runPowershell(script);
      if (result.exitCode !== 0) throw new Error(`os_window ${parsed.action} failed: ${result.stderr.trim()}`);

      if (parsed.action === 'list') {
        let windows: any[] = [];
        try {
          const parsed = JSON.parse(result.stdout.trim());
          windows = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          windows = [];
        }
        const duration = Date.now() - start;
        return { windows, success: true, energyMWh: estimateEnergy(duration) };
      }

      const duration = Date.now() - start;
      return { success: true, energyMWh: estimateEnergy(duration) };
    } else if (platform === 'darwin') {
      if (parsed.action === 'list') {
        const result = await runShell('osascript', ['-e', `
tell application "System Events"
  set windowList to {}
  repeat with p in (every process whose visible is true)
    try
      set windowList to windowList & (name of p as string) & "|"
    end try
  end repeat
  return windowList
end tell`]);
        const names = result.stdout.trim().split('|').filter(Boolean);
        const windows = names.map(n => ({ title: n, pid: 0, processName: n, x: 0, y: 0, width: 0, height: 0 }));
        const duration = Date.now() - start;
        return { windows, success: true, energyMWh: estimateEnergy(duration) };
      }
      if (parsed.action === 'focus' && parsed.title) {
        await runShell('osascript', ['-e', `tell application "${parsed.title}" to activate`]);
      }
      const duration = Date.now() - start;
      return { success: true, energyMWh: estimateEnergy(duration) };
    } else {
      // Linux: wmctrl / xdotool
      if (parsed.action === 'list') {
        const result = await runShell('wmctrl', ['-l', '-p']);
        const lines = result.stdout.trim().split('\n').filter(Boolean);
        const windows = lines.map(line => {
          const parts = line.split(/\s+/);
          return { title: parts.slice(4).join(' '), pid: parseInt(parts[2], 10) || 0, processName: '', x: 0, y: 0, width: 0, height: 0 };
        });
        const duration = Date.now() - start;
        return { windows, success: true, energyMWh: estimateEnergy(duration) };
      }
      if (parsed.action === 'focus' && parsed.title) {
        await runShell('wmctrl', ['-a', parsed.title]);
      } else if (parsed.action === 'close' && parsed.title) {
        await runShell('wmctrl', ['-c', parsed.title]);
      } else if (parsed.action === 'minimize' && parsed.title) {
        const result = await runShell('xdotool', ['search', '--name', parsed.title]);
        const winId = result.stdout.trim().split('\n')[0];
        if (winId) await runShell('xdotool', ['windowminimize', winId]);
      }
      const duration = Date.now() - start;
      return { success: true, energyMWh: estimateEnergy(duration) };
    }
  },
};

// ============================================================
// Tool 5: os_clipboard
// ============================================================

const clipboardInput = z.object({
  action: z.enum(['read', 'write']).describe('Read from or write to the system clipboard'),
  content: z.string().optional().describe('Content to write (required for write action)'),
});

const clipboardOutput = z.object({
  content: z.string().optional(),
  success: z.boolean(),
  energyMWh: z.number(),
});

// ============================================================
// Tool 5: os_open
// ============================================================

const openInput = z.object({
  target: z.string().describe('Application name (e.g. "excel", "notepad", "chrome") or file path to open'),
  args: z.array(z.string()).optional().describe('Optional arguments to pass to the application'),
  waitMs: z.number().int().min(0).max(30000).default(2000).optional()
    .describe('Milliseconds to wait for the application to start (default 2000)'),
});

const openOutput = z.object({
  success: z.boolean(),
  pid: z.number().optional(),
  energyMWh: z.number(),
});

export const osOpenTool: ToolDefinition = {
  name: 'os_open',
  description: 'Open a file with its default application, or launch an application by name. Works like double-clicking a file or launching from Start menu. Examples: "excel", "notepad", "chrome", "C:/Users/me/doc.xlsx"',
  inputSchema: openInput,
  outputSchema: openOutput,
  tags: ['system', 'os-automation'],
  requiresConfirmation: true,
  timeoutMs: 35_000,
  async execute(input) {
    const parsed = input as z.infer<typeof openInput>;
    const start = Date.now();
    const waitMs = parsed.waitMs ?? 2000;
    let pid: number | undefined;

    if (platform === 'win32') {
      const argsStr = parsed.args?.length ? ` -ArgumentList '${parsed.args.join("','")}'` : '';
      const safeTarget = parsed.target.replace(/'/g, "''");
      const script = `$p = Start-Process '${safeTarget}'${argsStr} -PassThru; Write-Output $p.Id`;
      const result = await runPowershell(script);
      if (result.exitCode !== 0) throw new Error(`os_open failed: ${result.stderr.trim()}`);
      pid = parseInt(result.stdout.trim(), 10) || undefined;
    } else if (platform === 'darwin') {
      const allArgs = parsed.args?.length ? [...parsed.args] : [];
      const result = await runShell('open', ['-a', parsed.target, ...allArgs]);
      if (result.exitCode !== 0) {
        // Fallback: try as file path
        const result2 = await runShell('open', [parsed.target, ...allArgs]);
        if (result2.exitCode !== 0) throw new Error(`os_open failed: ${result2.stderr.trim()}`);
      }
    } else {
      // Linux: xdg-open for files, or launch by command name
      const allArgs = parsed.args?.length ? [...parsed.args] : [];
      const result = await runShell(parsed.target, allArgs);
      if (result.exitCode !== 0) {
        const result2 = await runShell('xdg-open', [parsed.target]);
        if (result2.exitCode !== 0) throw new Error(`os_open failed: ${result2.stderr.trim()}`);
      }
    }

    // Wait for the application to start up
    if (waitMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    const duration = Date.now() - start;
    return { success: true, pid, energyMWh: estimateEnergy(duration) };
  },
};

// ============================================================
// Tool 6: os_clipboard
// ============================================================

export const osClipboardTool: ToolDefinition = {
  name: 'os_clipboard',
  description: 'Read from or write to the system clipboard.',
  inputSchema: clipboardInput,
  outputSchema: clipboardOutput,
  tags: ['system', 'os-automation'],
  timeoutMs: 5_000,
  async execute(input) {
    const parsed = input as z.infer<typeof clipboardInput>;
    const start = Date.now();

    if (parsed.action === 'write' && !parsed.content) {
      throw new Error('Action "write" requires content');
    }

    if (platform === 'win32') {
      if (parsed.action === 'read') {
        const result = await runPowershell('Get-Clipboard');
        if (result.exitCode !== 0) throw new Error(`os_clipboard read failed: ${result.stderr.trim()}`);
        const duration = Date.now() - start;
        return { content: result.stdout.trimEnd(), success: true, energyMWh: estimateEnergy(duration) };
      } else {
        // Base64 encode content to prevent PowerShell injection
        const b64 = Buffer.from(parsed.content!, 'utf-8').toString('base64');
        const script = `$c = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))\nSet-Clipboard -Value $c`;
        const result = await runPowershell(script);
        if (result.exitCode !== 0) throw new Error(`os_clipboard write failed: ${result.stderr.trim()}`);
        const duration = Date.now() - start;
        return { success: true, energyMWh: estimateEnergy(duration) };
      }
    } else if (platform === 'darwin') {
      if (parsed.action === 'read') {
        const result = await runShell('pbpaste', []);
        const duration = Date.now() - start;
        return { content: result.stdout, success: true, energyMWh: estimateEnergy(duration) };
      } else {
        const result = await runShell('bash', ['-c', `echo -n ${JSON.stringify(parsed.content)} | pbcopy`]);
        if (result.exitCode !== 0) throw new Error(`os_clipboard write failed: ${result.stderr.trim()}`);
        const duration = Date.now() - start;
        return { success: true, energyMWh: estimateEnergy(duration) };
      }
    } else {
      // Linux: xclip
      if (parsed.action === 'read') {
        const result = await runShell('xclip', ['-selection', 'clipboard', '-o']);
        const duration = Date.now() - start;
        return { content: result.stdout, success: true, energyMWh: estimateEnergy(duration) };
      } else {
        const result = await runShell('bash', ['-c', `echo -n ${JSON.stringify(parsed.content)} | xclip -selection clipboard`]);
        if (result.exitCode !== 0) throw new Error(`os_clipboard write failed: ${result.stderr.trim()}`);
        const duration = Date.now() - start;
        return { success: true, energyMWh: estimateEnergy(duration) };
      }
    }
  },
};
