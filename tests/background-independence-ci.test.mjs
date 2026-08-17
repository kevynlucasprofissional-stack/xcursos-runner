import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const workflow = await fs.readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

test('Windows CI proves a background worker survives launcher exit and advances heartbeat', () => {
  assert.match(workflow, /Windows background independence smoke/i);
  assert.match(workflow, /background-heartbeat-worker\.mjs/i);
  assert.match(workflow, /heartbeat/i);
  assert.match(workflow, /Get-Process/i);
  assert.match(workflow, /Stop-Process/i);
});
