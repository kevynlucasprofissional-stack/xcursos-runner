import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LESSON_SKIP_POLICIES, RETRYABLE_FAILURE_STATUSES, TERMINAL_STATUSES } from '../src/constants.mjs';
import { StateStore, summarizeAudit } from '../src/state.mjs';

const COURSE='VENDA TODO SANTO DIA 2026 - LEANDRO LADEIRA';
const TOTAL=198;
const SKIPPED=Array.from({length:18},(_,i)=>106+i);
async function tmp(){return await fs.mkdtemp(path.join(os.tmpdir(),'xc-v427-skip-'));}

test('configured skip policy is narrowly scoped to VTSD 2026 positions 106-123',()=>{
  assert.equal(LESSON_SKIP_POLICIES.length,1);
  const policy=LESSON_SKIP_POLICIES[0];
  assert.equal(policy.courseName,COURSE);
  assert.equal(policy.totalPositions,TOTAL);
  assert.deepEqual(policy.ranges,[{start:106,end:123}]);
  assert.equal(TERMINAL_STATUSES.has('SKIPPED'),true);
  assert.equal(RETRYABLE_FAILURE_STATUSES.has('SKIPPED'),false);
});

test('StateStore marks 106-123 SKIPPED before scheduler reconciliation and persists reason',async()=>{
  const root=await tmp();
  const state=new StateStore({outputRoot:root,courseName:COURSE,totalPositions:TOTAL});
  await state.initialize({resume:true,workPageUrl:'https://www.xcursos.com/curso/vtsd/aula/105'});
  const actual=state.manifestRecords.filter(r=>r.status==='SKIPPED').map(r=>r.position);
  assert.deepEqual(actual,SKIPPED);
  for(const position of SKIPPED){
    const rec=state.get(position);
    assert.equal(rec.status,'SKIPPED');
    assert.equal(rec.outputFile,null);
    assert.equal(rec.attempts,0);
    assert.equal(rec.validation.skipPolicyId,'vtsd-2026-audio-ads-106-123');
    assert.equal(rec.validation.skipReason,'USER_EXCLUDED_AD_AUDIO_BLOCK');
    assert.equal(rec.validation.skipLabel,'Propagandas em áudio');
  }
  assert.equal(state.get(105),null);
  assert.equal(state.get(124),null);
});

test('same numeric positions in another course are never skipped',async()=>{
  const root=await tmp();
  const state=new StateStore({outputRoot:root,courseName:'OUTRO CURSO',totalPositions:TOTAL});
  await state.initialize({resume:true,workPageUrl:'https://www.xcursos.com/curso/outro/aula/1'});
  assert.equal(state.manifestRecords.some(r=>r.status==='SKIPPED'),false);
  assert.equal(state.get(108),null);
});

test('a previous retryable failure inside the excluded block is replaced by SKIPPED on resume',async()=>{
  const root=await tmp();
  const state=new StateStore({outputRoot:root,courseName:COURSE,totalPositions:TOTAL});
  await fs.mkdir(state.metaDir,{recursive:true});
  await fs.writeFile(state.manifestPath,`${JSON.stringify({position:108,courseName:COURSE,lessonTitle:'e_Aula',status:'VERIFY_FAILED',outputFile:null,attempts:3,timestamp:new Date().toISOString()})}\n`,'utf8');
  await state.initialize({resume:true,workPageUrl:'https://www.xcursos.com/curso/vtsd/aula/108'});
  assert.equal(state.get(108).status,'SKIPPED');
  assert.equal(state.manifestRecords.filter(r=>r.position===108).length,1);
});

test('SKIPPED contributes to complete healthy coverage without pretending a download occurred',()=>{
  const manifestRecords=Array.from({length:TOTAL},(_,i)=>({
    position:i+1,
    status:SKIPPED.includes(i+1)?'SKIPPED':'NO_VIDEO',
  }));
  const audit=summarizeAudit({total:TOTAL,manifestRecords});
  assert.equal(audit.processed,TOTAL);
  assert.equal(audit.skipped,18);
  assert.equal(audit.downloaded,0);
  assert.deepEqual(audit.missingPositions,[]);
  assert.equal(audit.coverageComplete,true);
  assert.equal(audit.healthyComplete,true);
});
