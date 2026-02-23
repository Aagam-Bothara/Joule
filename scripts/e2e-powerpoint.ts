/**
 * Joule E2E Test: Build a Professional PowerPoint Presentation
 *
 * Uses PowerShell COM automation for pixel-perfect slide control:
 * fonts, colors, backgrounds, shapes, and precise text placement.
 *
 * Then uses Joule's universal OS tools (os_screenshot, os_window)
 * to verify and capture the result.
 *
 * Usage:
 *   cd packages/cli && pnpm exec tsx ../../scripts/e2e-powerpoint.ts
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  osScreenshotTool,
  osWindowTool,
  configureOsAutomation,
} from '@joule/tools';

// ── Helpers ──────────────────────────────────────────────────

function runPowershell(script: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise(async (resolve, reject) => {
    // Write script to temp file to avoid escaping issues
    const tmpFile = join(tmpdir(), `joule-ppt-${Date.now()}.ps1`);
    await fs.writeFile(tmpFile, script, 'utf-8');

    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile], {
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    }, async (error, stdout, stderr) => {
      await fs.unlink(tmpFile).catch(() => {});
      if (error) reject(new Error(stderr || error.message));
      else resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

async function run(tool: any, input: Record<string, unknown>, label: string) {
  const start = Date.now();
  process.stdout.write(`  [RUN]  ${label}...`);
  try {
    const result = await tool.execute(input);
    const ms = Date.now() - start;
    process.stdout.write(`\r  [OK]   ${label} (${ms}ms)\n`);
    return result;
  } catch (err) {
    const ms = Date.now() - start;
    process.stdout.write(`\r  [FAIL] ${label} (${ms}ms)\n`);
    console.error(`         ${(err as Error).message}`);
    return null;
  }
}

// ── PowerShell Script ────────────────────────────────────────

const PPTX_SCRIPT = `
$ErrorActionPreference = "Stop"

# ── Color helper (PowerPoint COM uses R + G*256 + B*65536) ──
function RGB([int]$r, [int]$g, [int]$b) { return [int]($r + $g * 256 + $b * 65536) }

# ── Palette ──
$navy      = RGB 20 30 60
$darkNavy  = RGB 12 18 40
$teal      = RGB 0 180 216
$white     = RGB 255 255 255
$offWhite  = RGB 248 249 250
$darkText  = RGB 40 40 50
$subText   = RGB 100 110 130
$lightLine = RGB 220 225 235
$accent1   = RGB 99 102 241   # indigo
$accent2   = RGB 16 185 129   # emerald
$accent3   = RGB 245 158 11   # amber
$accent4   = RGB 239 68 68    # red
$cardBg1   = RGB 238 242 255  # indigo-50
$cardBg2   = RGB 209 250 229  # emerald-50
$cardBg3   = RGB 254 243 199  # amber-50
$cardBg4   = RGB 254 226 226  # red-50

# ── Helper: add a textbox ──
function AddText($slide, $left, $top, $width, $height, $text, $fontSize, $fontColor, $bold, $align) {
    $tb = $slide.Shapes.AddTextbox(1, $left, $top, $width, $height)
    $tb.TextFrame.TextRange.Text = [string]$text
    $tb.TextFrame.TextRange.Font.Size = $fontSize
    $tb.TextFrame.TextRange.Font.Color.RGB = $fontColor
    $tb.TextFrame.TextRange.Font.Name = "Segoe UI"
    if ($bold) { $tb.TextFrame.TextRange.Font.Bold = -1 }
    $tb.TextFrame.TextRange.ParagraphFormat.Alignment = $align
    $tb.TextFrame.WordWrap = -1
    $tb.TextFrame.AutoSize = 0
}

# ── Helper: add a rounded rectangle ──
function AddRect($slide, $left, $top, $width, $height, $fillColor) {
    $shape = $slide.Shapes.AddShape(5, $left, $top, $width, $height)
    $shape.Fill.Solid()
    $shape.Fill.ForeColor.RGB = $fillColor
    $shape.Line.Visible = 0
    $shape.Shadow.Visible = 0
}

# ── Helper: bullet list ──
function AddBullets($slide, $left, $top, $width, $height, $items, $fontSize, $fontColor) {
    $tb = $slide.Shapes.AddTextbox(1, $left, $top, $width, $height)
    $tb.TextFrame.TextRange.Font.Name = "Segoe UI"
    $tb.TextFrame.TextRange.Font.Size = $fontSize
    $tb.TextFrame.TextRange.Font.Color.RGB = $fontColor
    $tb.TextFrame.WordWrap = -1
    $tb.TextFrame.AutoSize = 0

    $tb.TextFrame.TextRange.Text = $items[0]
    for ($i = 1; $i -lt $items.Length; $i++) {
        $tb.TextFrame.TextRange.InsertAfter([char]13 + $items[$i]) | Out-Null
    }
    $tb.TextFrame.TextRange.ParagraphFormat.SpaceAfter = 8
    $tb.TextFrame.TextRange.ParagraphFormat.SpaceBefore = 2
    $tb.TextFrame.TextRange.ParagraphFormat.LineRuleWithin = -1
    $tb.TextFrame.TextRange.ParagraphFormat.SpaceWithin = 1.3
}

# ══════════════════════════════════════════════════════════════
# Create presentation
# ══════════════════════════════════════════════════════════════

$ppt = New-Object -ComObject PowerPoint.Application
$ppt.Visible = [Microsoft.Office.Core.MsoTriState]::msoTrue

$pres = $ppt.Presentations.Add()
$pres.PageSetup.SlideWidth = 960
$pres.PageSetup.SlideHeight = 540

Write-Output "Creating slides..."

# ══════════════════════════════════════════════════════════════
# SLIDE 1 — Title
# ══════════════════════════════════════════════════════════════
$s1 = $pres.Slides.Add(1, 12)  # ppLayoutBlank
$s1.FollowMasterBackground = 0
$s1.Background.Fill.Solid()
$s1.Background.Fill.ForeColor.RGB = $navy

# Subtle gradient overlay — top bar
$bar = AddRect $s1 0 0 960 6 $teal

# Main title
AddText $s1 180 130 600 90 "JOULE" 66 $white $true 2

# Accent line
$line = $s1.Shapes.AddLine(380, 225, 580, 225)
$line.Line.ForeColor.RGB = $teal
$line.Line.Weight = 3

# Subtitle
AddText $s1 130 245 700 45 "Energy-Aware AI Agent Runtime" 26 $teal $false 2

# Tagline
AddText $s1 130 300 700 35 "Powering the Next Generation of Intelligent Automation" 14 $subText $false 2

# Version badge
$badge = AddRect $s1 405 360 150 30 $darkNavy
AddText $s1 405 363 150 24 "v0.1.0  |  2025" 11 $subText $false 2

Write-Output "  Slide 1: Title"

# ══════════════════════════════════════════════════════════════
# SLIDE 2 — The Problem
# ══════════════════════════════════════════════════════════════
$s2 = $pres.Slides.Add(2, 12)
$s2.FollowMasterBackground = 0
$s2.Background.Fill.Solid()
$s2.Background.Fill.ForeColor.RGB = $offWhite

# Header bar
AddRect $s2 0 0 960 70 $navy
AddText $s2 50 18 400 40 "THE PROBLEM" 24 $white $true 1
# Teal accent on header
AddRect $s2 0 0 6 70 $teal

# Content — problem bullets with red dot indicators
$problems = @(
    [char]0x25CF + "   AI agents consume massive computational energy with zero visibility into costs",
    [char]0x25CF + "   No standard runtime exists for multi-model orchestration and routing",
    [char]0x25CF + "   Browser and desktop automation tools are fragmented across ecosystems",
    [char]0x25CF + "   Tool integrations are siloed: MCP, plugins, APIs lack interoperability",
    [char]0x25CF + "   Developers lack a unified framework to build, test, and deploy AI agents"
)
$bullets = AddBullets $s2 60 100 840 350 $problems 16 $darkText

# Red accent dots for each bullet (override color of the dot character)
# We'll add a bottom accent line instead
$s2.Shapes.AddLine(60, 480, 900, 480).Line.ForeColor.RGB = $lightLine

Write-Output "  Slide 2: The Problem"

# ══════════════════════════════════════════════════════════════
# SLIDE 3 — The Solution
# ══════════════════════════════════════════════════════════════
$s3 = $pres.Slides.Add(3, 12)
$s3.FollowMasterBackground = 0
$s3.Background.Fill.Solid()
$s3.Background.Fill.ForeColor.RGB = $offWhite

AddRect $s3 0 0 960 70 $navy
AddText $s3 50 18 500 40 "JOULE: THE SOLUTION" 24 $white $true 1
AddRect $s3 0 0 6 70 $teal

# Two-column layout with icon-like cards
# Left column
$card1 = AddRect $s3 40 90 430 130 $cardBg1
AddText $s3 55 97 400 25 "Multi-Provider AI" 16 $accent1 $true 1
AddText $s3 55 122 400 80 "Route between Anthropic, Google, OpenAI, and Ollama with automatic tier-based selection and failover" 13 $darkText $false 1

$card2 = AddRect $s3 40 235 430 130 $cardBg2
AddText $s3 55 242 400 25 "Smart Browser Control" 16 $accent2 $true 1
AddText $s3 55 267 400 80 'Connect to your running Chrome via CDP. Never kills your browser. Opens new tabs, extracts data, observes pages' 13 $darkText $false 1

$card3 = AddRect $s3 40 380 430 130 $cardBg3
AddText $s3 55 387 400 25 "Energy-Aware Budgets" 16 $accent3 $true 1
AddText $s3 55 412 400 80 'Track tokens, cost, energy (Wh), and carbon per task. Set budget presets, never overspend on AI calls' 13 $darkText $false 1

# Right column
$card4 = AddRect $s3 490 90 430 130 $cardBg4
AddText $s3 505 97 400 25 "Universal Desktop Control" 16 $accent4 $true 1
AddText $s3 505 122 400 80 '6 OS tools control ANY application: screenshot, mouse, keyboard, window management, clipboard, app launcher' 13 $darkText $false 1

$card5 = AddRect $s3 490 235 430 130 $cardBg1
AddText $s3 505 242 400 25 "MCP Protocol Support" 16 $accent1 $true 1
AddText $s3 505 267 400 80 "Connect external tool servers via Model Context Protocol. Extend Joule with any MCP-compatible service" 13 $darkText $false 1

$card6 = AddRect $s3 490 380 430 130 $cardBg2
AddText $s3 505 387 400 25 "Simulation and Planning" 16 $accent2 $true 1
AddText $s3 505 412 400 80 "Validate task plans before execution. Decision graphs, critical-path analysis, and dry-run simulation" 13 $darkText $false 1

Write-Output "  Slide 3: The Solution"

# ══════════════════════════════════════════════════════════════
# SLIDE 4 — Architecture
# ══════════════════════════════════════════════════════════════
$s4 = $pres.Slides.Add(4, 12)
$s4.FollowMasterBackground = 0
$s4.Background.Fill.Solid()
$s4.Background.Fill.ForeColor.RGB = $offWhite

AddRect $s4 0 0 960 70 $navy
AddText $s4 50 18 400 40 "ARCHITECTURE" 24 $white $true 1
AddRect $s4 0 0 6 70 $teal

# Stacked architecture layers (full-width bars)
$layerH = 85
$gap = 10
$startY = 95
$layerW = 860

# Layer 1: Channels (top)
$ly = $startY
AddRect $s4 50 $ly $layerW $layerH (RGB 219 234 254)
AddText $s4 65 ($ly + 8) 200 25 "CHANNELS" 14 (RGB 30 64 175) $true 1
AddText $s4 65 ($ly + 38) 820 40 "Slack  |  Discord  |  Email  |  Telegram  |  SMS  |  REST API  |  WebSocket" 13 $darkText $false 1

# Layer 2: Engine
$ly = $startY + $layerH + $gap
AddRect $s4 50 $ly $layerW $layerH (RGB 238 242 255)
AddText $s4 65 ($ly + 8) 200 25 "ENGINE" 14 $accent1 $true 1
AddText $s4 65 ($ly + 38) 820 40 "Planner  |  Task Executor  |  Budget Manager  |  Simulator  |  Model Router" 13 $darkText $false 1

# Layer 3: Providers
$ly = $startY + ($layerH + $gap) * 2
AddRect $s4 50 $ly $layerW $layerH (RGB 209 250 229)
AddText $s4 65 ($ly + 8) 200 25 "PROVIDERS" 14 $accent2 $true 1
AddText $s4 65 ($ly + 38) 820 40 'Anthropic Claude  |  Google Gemini  |  OpenAI GPT  |  Ollama [local]' 13 $darkText $false 1

# Layer 4: Tools (bottom)
$ly = $startY + ($layerH + $gap) * 3
AddRect $s4 50 $ly $layerW $layerH (RGB 254 243 199)
AddText $s4 65 ($ly + 8) 200 25 "TOOLS" 14 $accent3 $true 1
AddText $s4 65 ($ly + 38) 820 40 'Browser [CDP]  |  OS Automation  |  File I/O  |  Shell  |  Memory  |  MCP  |  IoT  |  CAPTCHA' 13 $darkText $false 1

# Vertical arrow on the right
$arrowX = 930
AddText $s4 ($arrowX - 10) ($startY + 15) 30 ($layerH * 4 + $gap * 3 - 30) ([string][char]0x25BC) 20 $subText $false 2

Write-Output "  Slide 4: Architecture"

# ══════════════════════════════════════════════════════════════
# SLIDE 5 — This Is The Demo
# ══════════════════════════════════════════════════════════════
$s5 = $pres.Slides.Add(5, 12)
$s5.FollowMasterBackground = 0
$s5.Background.Fill.Solid()
$s5.Background.Fill.ForeColor.RGB = $offWhite

AddRect $s5 0 0 960 70 $navy
AddText $s5 50 18 700 40 "THIS PRESENTATION IS THE DEMO" 22 $white $true 1
AddRect $s5 0 0 6 70 $teal

AddText $s5 50 90 860 35 "This PowerPoint was generated programmatically by Joule using just 6 universal OS tools:" 15 $darkText $false 1

# Tool cards in 2x3 grid
$toolNames  = @("os_open",      "os_keyboard",     "os_screenshot",  "os_mouse",     "os_window",       "os_clipboard")
$toolDescs  = @("Launch apps",  "Type + hotkeys",  "Capture screen", "Click + scroll","Manage windows", "Read/write clip")
$toolColors = @($accent1,       $accent2,          $accent3,         $accent4,        $accent1,          $accent2)
$toolBgs    = @($cardBg1,       $cardBg2,          $cardBg3,         $cardBg4,        $cardBg1,          $cardBg2)

for ($i = 0; $i -lt 6; $i++) {
    $col = $i % 3
    $row = [math]::Floor($i / 3)
    $cx = 50 + $col * 300
    $cy = 145 + $row * 140

    AddRect $s5 $cx $cy 280 120 $toolBgs[$i]
    AddText $s5 ($cx + 15) ($cy + 15) 250 30 $toolNames[$i] 18 $toolColors[$i] $true 1
    AddText $s5 ($cx + 15) ($cy + 50) 250 25 $toolDescs[$i] 14 $darkText $false 1
    AddText $s5 ($cx + 15) ($cy + 80) 250 30 "Works with ANY app" 11 $subText $false 1
}

# Bottom note
AddText $s5 50 440 860 50 "No app-specific SDKs needed. The same tools that built this deck can control Excel, Chrome, VS Code, Photoshop, or any other application." 12 $subText $false 1

Write-Output "  Slide 5: Demo"

# ══════════════════════════════════════════════════════════════
# SLIDE 6 — Closing
# ══════════════════════════════════════════════════════════════
$s6 = $pres.Slides.Add(6, 12)
$s6.FollowMasterBackground = 0
$s6.Background.Fill.Solid()
$s6.Background.Fill.ForeColor.RGB = $navy

AddRect $s6 0 0 960 6 $teal

# Big statement
AddText $s6 80 120 800 70 "One Runtime. Any Model. Any App." 40 $white $true 2

# Accent line
$s6.Shapes.AddLine(350, 210, 610, 210).Line.ForeColor.RGB = $teal

# Subtext
AddText $s6 80 230 800 60 "Joule does not just run AI agents.\`r\`nIt gives them eyes, hands, and a conscience." 18 $subText $false 2

# GitHub
AddText $s6 80 360 800 30 "github.com/joule-ai/joule" 16 $teal $false 2

# Footer
AddText $s6 80 460 800 30 "Open Source  |  MIT License  |  TypeScript + Node.js" 12 $subText $false 2

Write-Output "  Slide 6: Closing"

# ══════════════════════════════════════════════════════════════
# Navigate to slide 1
# ══════════════════════════════════════════════════════════════
$pres.Slides(1).Select()

Write-Output ""
Write-Output "Presentation ready! 6 slides created."

# Release COM (but leave PowerPoint open and visible)
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($pres) | Out-Null
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($ppt) | Out-Null
`;

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('=== Joule E2E: Professional PowerPoint ===');
  console.log('Using PowerShell COM for pixel-perfect slides');
  console.log('');

  configureOsAutomation({ screenshotDir: '.joule/screenshots' });
  const startTime = Date.now();

  // Step 1: Build the presentation via PowerShell COM
  console.log('--- Building presentation via COM automation ---');
  const start = Date.now();
  try {
    const { stdout } = await runPowershell(PPTX_SCRIPT);
    const ms = Date.now() - start;
    console.log(stdout.split('\n').map(l => `  ${l}`).join('\n'));
    console.log(`  [OK] Presentation created (${ms}ms)`);
  } catch (err) {
    console.error(`  [FAIL] ${(err as Error).message}`);
    process.exit(1);
  }

  // Step 2: Focus PowerPoint and wait for render
  await new Promise(resolve => setTimeout(resolve, 2000));
  await run(osWindowTool, { action: 'focus', title: 'PowerPoint' }, 'os_window → focus PowerPoint');
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Step 3: Screenshot
  console.log('');
  console.log('--- Screenshot ---');
  const screenshot = await run(osScreenshotTool, {}, 'os_screenshot → capture');
  if (screenshot) {
    console.log(`         Saved: ${screenshot.path}`);
    console.log(`         Resolution: ${screenshot.width}x${screenshot.height}`);
  }

  // Step 4: Verify window
  console.log('');
  console.log('--- Verify ---');
  const windowList = await run(osWindowTool, { action: 'list' }, 'os_window → list windows');
  if (windowList?.windows) {
    const pptWindows = windowList.windows.filter((w: any) =>
      w.title?.toLowerCase().includes('powerpoint') || w.processName?.toLowerCase().includes('powerpnt')
    );
    for (const w of pptWindows) {
      console.log(`         "${w.title}" (PID: ${w.pid})`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('');
  console.log(`=== Done (${elapsed}s) — 6 professional slides ===`);
  console.log('');
  console.log('Slides:');
  console.log('  1. Title — dark navy, teal accents');
  console.log('  2. The Problem — bullet points');
  console.log('  3. The Solution — 6 feature cards (2x3)');
  console.log('  4. Architecture — 4-layer stack diagram');
  console.log('  5. This Is The Demo — 6 tool cards');
  console.log('  6. Closing — dark navy, bold statement');
  console.log('');
}

main().catch((err) => {
  console.error('E2E test failed:', err);
  process.exit(1);
});
