import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { XCursosCourseRunner } from '../src/runner.mjs';
import { FakeBrowser, DiskFakeDownloader, lesson, readJsonlFile } from './helpers.mjs';

class StopAfterFirstDownloader extends DiskFakeDownloader {
  constructor(stopFile){super();this.stopFile=stopFile;}
  async download(args){
    const result=await super.download(args);
    if(this.calls.length===1)await fs.writeFile(this.stopFile,'stop','utf8');
    return result;
  }
}

test('background stop request finishes current atomic lesson, checkpoints, then starts no next lesson',async()=>{
  const outputRoot=await fs.mkdtemp(path.join(os.tmpdir(),'xc-bg-stop-'));
  const stopFile=path.join(outputRoot,'stop.request');
  const lessons=Array.from({length:4},(_,i)=>lesson(i+1,4,{course:'Background Stop Course'}));
  const browser=new FakeBrowser(lessons);
  const downloader=new StopAfterFirstDownloader(stopFile);
  const runner=new XCursosCourseRunner({
    outputRoot,browser,downloader,stopRequestFile:stopFile,
    limits:{retryBaseDelayMs:0,retryMaxDelayMs:0,retryJitterRatio:0},sleepFn:async()=>{},
  });
  try{
    const result=await runner.runRange({start:1,end:4,resume:false,finalAudit:false});
    assert.equal(result.status,'STOPPED');
    assert.deepEqual(downloader.calls.map(x=>x.pos),[1],'stop request must prevent lesson 2 from starting');
    const meta=path.join(outputRoot,'Background Stop Course','_xcursos-runner');
    const manifest=await readJsonlFile(path.join(meta,'manifest.jsonl'));
    assert.deepEqual(manifest.map(row=>row.position),[1]);
    const checkpoint=JSON.parse(await fs.readFile(path.join(meta,'scheduler.checkpoint.json'),'utf8'));
    assert.ok((checkpoint.ready||[]).some(task=>task.position===2),'next lesson remains ready for resume');
  }finally{await runner.dispose();}
});
