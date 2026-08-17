import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const script=await fs.readFile(new URL('../download-all.ps1',import.meta.url),'utf8');

test('background status correlates session diagnostics and surfaces liveness/progress fields',()=>{
  assert.match(script,/_xcursos-diagnostics/i);
  assert.match(script,/backgroundSessionId/i);
  assert.match(script,/liveness\.json/i);
  for(const field of ['currentRunId','livenessStatus','position','stage','operation','lastProgressAt','msSinceProgress','activeSubprocess','lastProgressLine']){
    assert.match(script,new RegExp(field,'i'));
  }
});
