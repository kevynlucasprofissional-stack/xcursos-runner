import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const script=await fs.readFile(new URL('../download-all.ps1',import.meta.url),'utf8');

test('xcursos-all treats a requested STOPPED child result as graceful completion, not an error exit',()=>{
  assert.match(script,/\$status\s+-eq\s+'STOPPED'/i);
  assert.match(script,/STOPPED[\s\S]{0,500}exit\s+0/i);
});
