import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const script = await fs.readFile(new URL('../download-all.ps1', import.meta.url), 'utf8');

test('xcursos-all exposes a background launch mode decoupled from the caller console', () => {
  assert.match(script, /\[switch\]\$Background/i);
  assert.match(script, /Start-Process\s+-FilePath/i);
  assert.match(script, /-RedirectStandardOutput/i);
  assert.match(script, /-RedirectStandardError/i);
  assert.match(script, /-WindowStyle\s+Hidden/i);
  assert.match(script, /-PassThru/i);
});

test('background launch does not recursively relaunch itself', () => {
  assert.match(script, /XCURSOS_BACKGROUND_WORKER/i);
  assert.match(script, /\$env:XCURSOS_BACKGROUND_WORKER\s*=\s*'1'/i);
});
