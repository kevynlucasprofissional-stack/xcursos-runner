import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeStats, robustEtaLessonDuration } from '../src/runtime-stats.mjs';
import { AutoThrottle } from '../src/auto-throttle.mjs';
import { GracefulShutdownController } from '../src/shutdown-controller.mjs';

test('RuntimeStats waits for enough samples before publishing ETA, then uses a robust estimate',()=>{
  let now=0;const s=new RuntimeStats({total:10,nowFn:()=>now});
  let x=s.snapshot();assert.equal(x.etaMs,null);assert.equal(x.etaStatus,'CALCULATING');assert.equal(x.etaSampleCount,0);
  s.beginLesson(1,'One');now=1000;s.finishLesson({status:'DOWNLOADED',healthy:true,bytes:100});
  s.beginLesson(2,'Two');now=3000;s.finishLesson({status:'DOWNLOADED',healthy:true,bytes:200});
  x=s.snapshot();assert.equal(x.processed,2);assert.equal(x.healthy,2);assert.equal(x.averageLessonDurationMs,1500);assert.equal(x.etaMs,null);assert.equal(x.etaStatus,'CALCULATING');assert.match(s.render(),/ETA=calculando\.\.\. \(2\/3\)/);assert.equal(x.downloadBytes,300);
  s.beginLesson(3,'Three');now=4000;s.finishLesson({status:'DOWNLOADED',healthy:true,bytes:300});
  x=s.snapshot();assert.equal(x.processed,3);assert.equal(x.averageLessonDurationMs,1333);assert.equal(x.etaLessonDurationMs,1000);assert.equal(x.etaMs,7000);assert.equal(x.etaStatus,'READY');assert.equal(x.ETA,'00:00:07');
});

test('robust ETA estimator stabilizes quickly for similar lesson times',()=>{
  assert.equal(robustEtaLessonDuration([60_000,65_000,58_000,62_000]),61_000);
});

test('robust ETA estimator resists a single large outlier',()=>{
  assert.equal(robustEtaLessonDuration([60_000,62_000,600_000,61_000,59_000]),61_000);
});

test('robust ETA estimator refuses to publish with fewer than three samples',()=>{
  assert.equal(robustEtaLessonDuration([]),null);
  assert.equal(robustEtaLessonDuration([60_000]),null);
  assert.equal(robustEtaLessonDuration([60_000,62_000]),null);
});

test('RuntimeStats retries/failures do not inflate processed count or ETA samples',()=>{const s=new RuntimeStats({total:5});s.beginLesson(1,'A');s.recordRetry();s.recordFailure();const x=s.snapshot();assert.equal(x.processed,0);assert.equal(x.retries,1);assert.equal(x.downloadsFailed,1);assert.equal(x.etaSampleCount,0);assert.equal(x.etaMs,null);});

test('AutoThrottle increases on instability, respects Retry-After/max, then decreases gradually on success',()=>{
  const t=new AutoThrottle({minDelayMs:100,maxDelayMs:3000,initialDelayMs:100});
  t.recordFailure({status:500});const a=t.currentDelayMs;assert.ok(a>100);
  t.recordFailure({status:429,retryAfterMs:2500});assert.equal(t.currentDelayMs,2500);
  t.recordFailure({status:429,retryAfterMs:99999});assert.equal(t.currentDelayMs,3000);
  t.recordSuccess({latencyMs:100});assert.ok(t.currentDelayMs<3000);assert.ok(t.currentDelayMs>=100);
});

test('Graceful shutdown first signal requests safe stop/checkpoint, second signal force-aborts',async()=>{
  let checkpoints=0,logs=[];const g=new GracefulShutdownController({onCheckpoint:async()=>{checkpoints++;},onLog:m=>logs.push(m)});
  await g.requestStop('SIGINT');assert.equal(g.stopRequested,true);assert.equal(g.forceRequested,false);assert.equal(g.signal.aborted,false);assert.equal(checkpoints,1);
  await g.requestStop('SIGINT');assert.equal(g.forceRequested,true);assert.equal(g.signal.aborted,true);assert.equal(checkpoints,2);assert.ok(logs.length>=2);
});
import { runProcess } from '../src/process.mjs';

test('runProcess force AbortSignal terminates a long subprocess with PROCESS_ABORTED',async()=>{
  const c=new AbortController();const promise=runProcess(process.execPath,['-e','setTimeout(()=>{},30000)'],{timeoutMs:0,signal:c.signal,killGraceMs:50});setTimeout(()=>c.abort(),40);
  await assert.rejects(promise,e=>e?.code==='PROCESS_ABORTED');
});

test('RuntimeStats can seed resume baseline without inventing ETA samples',()=>{const s=new RuntimeStats({total:10});s.seed({processed:4,healthy:4,downloadsSucceeded:3});const x=s.snapshot();assert.equal(x.processed,4);assert.equal(x.healthy,4);assert.equal(x.downloadsSucceeded,3);assert.equal(x.etaMs,null);assert.equal(x.etaSampleCount,0);assert.equal(x.etaStatus,'CALCULATING');});

test('RuntimeStats does not inflate coverage when an already-covered position is operated again',()=>{
  let now=0;const s=new RuntimeStats({total:198,nowFn:()=>now});
  const covered=Array.from({length:64},(_,i)=>i+1);
  s.seed({completedPositions:covered,healthyPositions:covered,downloadedPositions:covered});
  s.beginLesson(1,'already covered');now=5;s.finishLesson({status:'DOWNLOADED',healthy:true,bytes:100});
  const x=s.snapshot();
  assert.equal(x.processed,64);
  assert.equal(x.coverageProcessed,64);
  assert.equal(x.runOperations,1);
  assert.equal(x.downloadsSucceeded,64);
  assert.equal(x.averageLessonDurationMs,null);
  assert.equal(x.etaMs,null);
  assert.equal(x.etaSampleCount,0);
  assert.equal(x.downloadBytes,0);
});

test('RuntimeStats ETA uses only newly covered positions from this run, never seeded resume history',()=>{
  let now=0;const s=new RuntimeStats({total:70,nowFn:()=>now});
  const covered=Array.from({length:64},(_,i)=>i+1);
  s.seed({completedPositions:covered,healthyPositions:covered,downloadedPositions:covered});
  s.beginLesson(65,'new 65');now=1000;s.finishLesson({status:'DOWNLOADED',healthy:true,bytes:100});
  s.beginLesson(66,'new 66');now=3000;s.finishLesson({status:'DOWNLOADED',healthy:true,bytes:200});
  let x=s.snapshot();
  assert.equal(x.coverageProcessed,66);
  assert.equal(x.runOperations,2);
  assert.equal(x.averageLessonDurationMs,1500);
  assert.equal(x.etaMs,null);
  assert.equal(x.etaSampleCount,2);
  s.beginLesson(67,'new 67');now=4000;s.finishLesson({status:'DOWNLOADED',healthy:true,bytes:300});
  x=s.snapshot();
  assert.equal(x.coverageProcessed,67);
  assert.equal(x.runOperations,3);
  assert.equal(x.averageLessonDurationMs,1333);
  assert.equal(x.etaLessonDurationMs,1000);
  assert.equal(x.etaMs,3000);
  assert.equal(x.downloadBytes,600);
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { XCursosCourseRunner } from '../src/runner.mjs';
import { StateStore } from '../src/state.mjs';
import { FakeBrowser, DiskFakeDownloader, lesson } from './helpers.mjs';

test('live regression: runCurrent on already-covered position keeps stats coverage equal to audit coverage',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'xc-stats-live-'));const total=198;
  const store=new StateStore({outputRoot:root,courseName:'Fake Course',totalPositions:total});await store.initialize({resume:false,workPageUrl:'https://www.xcursos.com/aula/1'});
  for(let p=1;p<=64;p++)await store.commit({position:p,status:'NO_VIDEO',lessonTitle:`Lesson ${p}`,lessonUrl:null});
  const lessons=Array.from({length:total},(_,i)=>lesson(i+1,total,{video:false,materials:true}));
  const runner=new XCursosCourseRunner({outputRoot:root,browser:new FakeBrowser(lessons,{startPosition:1}),downloader:new DiskFakeDownloader()});
  try{
    const result=await runner.runCurrent({resume:true});
    assert.equal(result.audit.processed,64);
    assert.equal(result.stats.processed,64);
    assert.equal(result.stats.coverageProcessed,64);
    assert.equal(result.stats.runOperations,1);
    assert.equal(result.stats.etaMs,null);
  }finally{await runner.dispose();}
});

test('reposition steps are observable but never inflate coverage or downloads',()=>{const s=new RuntimeStats({total:10,nowFn:()=>1000});s.seed({completedPositions:[1,2],healthyPositions:[1,2],downloadedPositions:[1,2]});s.recordRepositionStep();s.recordRepositionStep();const snap=s.snapshot();assert.equal(snap.repositionSteps,2);assert.equal(snap.coverageProcessed,2);assert.equal(snap.downloadsSucceeded,2);assert.equal(snap.runOperations,0);});
