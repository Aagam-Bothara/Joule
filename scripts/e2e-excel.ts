/**
 * Joule E2E Test: Universal OS Tools → Open Excel & Write Data
 *
 * This script demonstrates Joule's universal desktop control —
 * the SAME tools (os_open, os_keyboard, os_screenshot) that work
 * for Excel also work for Word, Notepad, Photoshop, or any app.
 *
 * No app-specific tools needed — just universal primitives:
 *   os_open       → launch any application
 *   os_keyboard   → type text, press keys & hotkeys
 *   os_mouse      → click at screen coordinates
 *   os_screenshot → capture the screen
 *   os_window     → focus/manage windows
 *   os_clipboard  → read/write clipboard
 *
 * Usage:
 *   cd packages/cli && pnpm exec tsx ../../scripts/e2e-excel.ts
 */

import {
  osOpenTool,
  osKeyboardTool,
  osScreenshotTool,
  osWindowTool,
  configureOsAutomation,
} from '@joule/tools';

// ── Helpers ──────────────────────────────────────────────────

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('=== Joule E2E: Universal Desktop Control ===');
  console.log('Goal: Open Excel → Write data → Screenshot');
  console.log('Tools: os_open, os_keyboard, os_screenshot, os_window');
  console.log('  (These same tools work for ANY application)');
  console.log('');

  configureOsAutomation({ screenshotDir: '.joule/screenshots' });

  const startTime = Date.now();

  // Step 1: Open Excel
  console.log('--- Step 1: Launch Excel ---');
  await run(osOpenTool, { target: 'excel', waitMs: 4000 }, 'os_open → excel');

  // Step 2: Wait for Excel to fully load, then focus it
  console.log('');
  console.log('--- Step 2: Focus Excel window ---');
  await sleep(2000);
  await run(osWindowTool, { action: 'focus', title: 'Excel' }, 'os_window → focus Excel');
  await sleep(1000);

  // Step 3: Press Escape to dismiss any splash/start screen, then Enter to select Blank Workbook
  console.log('');
  console.log('--- Step 3: Create blank workbook ---');
  // Modern Excel shows a start screen — press Escape to get to a blank workbook,
  // or if already in a blank workbook this is harmless.
  await run(osKeyboardTool, { action: 'press', key: 'escape' }, 'os_keyboard → Escape (dismiss splash)');
  await sleep(1500);

  // Step 4: Type data into cells using keyboard navigation
  console.log('');
  console.log('--- Step 4: Type schedule data ---');

  const scheduleData = [
    // Row 1: Headers
    { text: 'Day',        next: 'tab' },
    { text: 'Time',       next: 'tab' },
    { text: 'Activity',   next: 'enter' },
    // Row 2
    { text: 'Monday',     next: 'tab' },
    { text: '9:00 AM',    next: 'tab' },
    { text: 'Team standup',  next: 'enter' },
    // Row 3
    { text: 'Tuesday',    next: 'tab' },
    { text: '2:00 PM',    next: 'tab' },
    { text: 'Design review', next: 'enter' },
    // Row 4
    { text: 'Wednesday',  next: 'tab' },
    { text: '10:00 AM',   next: 'tab' },
    { text: 'Sprint planning', next: 'enter' },
    // Row 5
    { text: 'Thursday',   next: 'tab' },
    { text: '3:00 PM',    next: 'tab' },
    { text: 'Code review',   next: 'enter' },
    // Row 6
    { text: 'Friday',     next: 'tab' },
    { text: '11:00 AM',   next: 'tab' },
    { text: 'Retrospective', next: 'enter' },
  ];

  for (const { text, next } of scheduleData) {
    await run(osKeyboardTool, { action: 'type', text }, `type "${text}"`);
    await sleep(100);
    await run(osKeyboardTool, { action: 'press', key: next }, `press ${next}`);
    await sleep(100);
  }

  // Step 5: Go back to A1 and make headers bold
  console.log('');
  console.log('--- Step 5: Format headers (bold) ---');
  await run(osKeyboardTool, { action: 'hotkey', key: 'home', modifiers: ['ctrl'] }, 'Ctrl+Home → go to A1');
  await sleep(300);
  // Select header row (A1:C1)
  await run(osKeyboardTool, { action: 'hotkey', key: 'right', modifiers: ['shift'] }, 'Shift+Right → select B1');
  await sleep(100);
  await run(osKeyboardTool, { action: 'hotkey', key: 'right', modifiers: ['shift'] }, 'Shift+Right → select C1');
  await sleep(100);
  // Bold
  await run(osKeyboardTool, { action: 'hotkey', key: 'b', modifiers: ['ctrl'] }, 'Ctrl+B → bold headers');
  await sleep(300);

  // Step 6: Take a screenshot to verify
  console.log('');
  console.log('--- Step 6: Screenshot ---');
  const screenshot = await run(osScreenshotTool, {}, 'os_screenshot → capture screen');
  if (screenshot) {
    console.log(`         Screenshot saved: ${screenshot.path}`);
    console.log(`         Resolution: ${screenshot.width}x${screenshot.height}`);
  }

  // Step 7: List windows to confirm Excel is visible
  console.log('');
  console.log('--- Step 7: Verify window ---');
  const windowList = await run(osWindowTool, { action: 'list' }, 'os_window → list all windows');
  if (windowList?.windows) {
    const excelWindows = windowList.windows.filter((w: any) =>
      w.title?.toLowerCase().includes('excel') || w.processName?.toLowerCase().includes('excel')
    );
    if (excelWindows.length > 0) {
      console.log(`         Excel windows found: ${excelWindows.length}`);
      for (const w of excelWindows) {
        console.log(`           "${w.title}" (PID: ${w.pid}, ${w.width}x${w.height})`);
      }
    } else {
      console.log('         WARNING: No Excel windows detected in window list');
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('');
  console.log(`=== Done (${elapsed}s) ===`);
  console.log('');
  console.log('This same approach works for ANY application:');
  console.log('  - os_open "notepad" + os_keyboard → write in Notepad');
  console.log('  - os_open "code" + os_keyboard → type in VS Code');
  console.log('  - os_open "chrome" + os_mouse/os_keyboard → browse the web');
  console.log('  - os_open "photoshop" + os_mouse → draw/edit images');
  console.log('');
}

main().catch((err) => {
  console.error('E2E test failed:', err);
  process.exit(1);
});
