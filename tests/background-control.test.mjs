import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const script=await fs.readFile(new URL('../download-all.ps1',import.meta.url),'utf8');

test('xcursos-all exposes persistent background status and graceful stop control',()=>{
  assert.match(script,/\[switch\]\$Status/i);
  assert.match(script,/\[switch\]\$Stop/i);
  assert.match(script,/background\\xcursos-all\.json/i);
  assert.match(script,/stop.*request/i);
  assert.doesNotMatch(script,/\$Stop[\s\S]{0,500}Stop-Process/i,'normal stop must request graceful shutdown instead of killing a PID');
});

test('background launch publishes a descriptor with PID, instance identity, start time and log paths',()=>{
  for(const field of ['instanceId','pid','startedAt','stdoutPath','stderrPath','stopFile'])assert.match(script,new RegExp(field,'i'));
  assert.match(script,/ConvertTo-Json/i);
});
