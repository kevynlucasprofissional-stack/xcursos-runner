import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { XCursosCourseRunner } from '../src/runner.mjs';
import { BrowserAutomationError } from '../src/errors.mjs';
import { FakeBrowser, DiskFakeDownloader, lesson, readJsonlFile } from './helpers.mjs';

class PermanentlyClosedBrowser extends FakeBrowser {
  constructor(lessons) {
    super(lessons);
    this.closedObservedPositions=[];
    this.recoveryAttempts=0;
  }
  async inspectLesson(page) {
    if (this.current >= 2) {
      this.closedObservedPositions.push(this.current);
      throw new BrowserAutomationError('A página Playwright não está mais disponível.', { code:'PAGE_CLOSED' });
    }
    return await super.inspectLesson(page);
  }
  async recoverWorkingPage() {
    this.recoveryAttempts++;
    throw new BrowserAutomationError('Não foi possível recuperar a página de trabalho.', { code:'PAGE_RECOVERY_FAILED' });
  }
}

class RecoverOnceBrowser extends FakeBrowser {
  constructor(lessons) {
    super(lessons);
    this.recovered=false;
    this.closedInjected=false;
    this.recoveryAttempts=0;
    this.inspectPageIds=[];
    this.position2Inspects=0;
  }
  async inspectLesson(page) {
    this.inspectPageIds.push(page?.id||null);
    if (this.current === 2 && !this.recovered) {
      this.position2Inspects++;
      if (this.position2Inspects >= 2 && !this.closedInjected) {
        this.closedInjected=true;
        throw new BrowserAutomationError('A página Playwright não está mais disponível.', { code:'PAGE_CLOSED' });
      }
    }
    if (this.recovered && page?.id !== 'fresh-recovered-page') {
      throw new BrowserAutomationError('stale page reused after recovery', { code:'STALE_PAGE_REUSED' });
    }
    return await super.inspectLesson(page);
  }
  async recoverWorkingPage() {
    this.recoveryAttempts++;
    this.recovered=true;
    this.page={id:'fresh-recovered-page',url:`https://www.xcursos.com/aula/${this.current}`,title:'Assistir Aula | XCURSOS'};
    return this.page;
  }
}

test('persistent shared PAGE_CLOSED opens a global circuit instead of retrying many lesson positions', async()=>{
  const outputRoot=await fs.mkdtemp(path.join(os.tmpdir(),'xc-page-circuit-'));
  const lessons=Array.from({length:5},(_,i)=>lesson(i+1,5,{course:'Page Circuit Course'}));
  const browser=new PermanentlyClosedBrowser(lessons);
  const downloader=new DiskFakeDownloader();
  const runner=new XCursosCourseRunner({
    outputRoot,browser,downloader,
    limits:{navigationRetries:0,downloadRetries:2,retryBaseDelayMs:0,retryMaxDelayMs:0,retryJitterRatio:0},
    sleepFn:async()=>{},
  });
  try {
    await assert.rejects(
      runner.runRange({start:1,end:5,resume:false,finalAudit:false}),
      error=>error?.code==='BROWSER_RECOVERY_EXHAUSTED',
    );
    assert.equal(browser.recoveryAttempts,1,'shared browser recovery must be bounded to one global attempt before opening the circuit');
    assert.deepEqual([...new Set(browser.closedObservedPositions)],[2],'positions 3..5 must never be attempted after shared page recovery is proven unavailable');

    const courseRoot=path.join(outputRoot,'Page Circuit Course','_xcursos-runner');
    const manifest=await readJsonlFile(path.join(courseRoot,'manifest.jsonl'));
    assert.deepEqual(manifest.map(row=>row.position),[1],'only the healthy committed prefix may remain durable');

    const checkpoint=JSON.parse(await fs.readFile(path.join(courseRoot,'scheduler.checkpoint.json'),'utf8'));
    const unfinished=[...(checkpoint.ready||[]),...(checkpoint.retryLater||[]),...(checkpoint.inFlight||[]),...(checkpoint.blocked||[])]
      .filter(task=>task.position>=2);
    assert.equal(unfinished.length,4,'all untouched positions must remain represented in checkpoint');
  } finally {
    await runner.dispose();
  }
});

test('PAGE_CLOSED recovery replaces the stale PageRef and continues the same course without duplicate commits', async()=>{
  const outputRoot=await fs.mkdtemp(path.join(os.tmpdir(),'xc-page-recover-'));
  const lessons=Array.from({length:3},(_,i)=>lesson(i+1,3,{course:'Page Recovery Course'}));
  const browser=new RecoverOnceBrowser(lessons);
  const runner=new XCursosCourseRunner({
    outputRoot,browser,downloader:new DiskFakeDownloader(),
    limits:{navigationRetries:0,downloadRetries:1,retryBaseDelayMs:0,retryMaxDelayMs:0,retryJitterRatio:0},
    sleepFn:async()=>{},
  });
  try {
    const result=await runner.runRange({start:1,end:3,resume:false,finalAudit:false});
    assert.equal(result.ok,true);
    assert.equal(result.status,'RANGE_COMPLETE');
    assert.equal(browser.recoveryAttempts,1);
    assert.equal(runner.workPage.id,'fresh-recovered-page');
    const firstFresh=browser.inspectPageIds.indexOf('fresh-recovered-page');
    assert.ok(firstFresh>=0);
    assert.ok(browser.inspectPageIds.slice(firstFresh).every(id=>id==='fresh-recovered-page'),'the stale PageRef must never be reused after recovery');

    const manifest=await readJsonlFile(path.join(outputRoot,'Page Recovery Course','_xcursos-runner','manifest.jsonl'));
    assert.deepEqual(manifest.map(row=>row.position),[1,2,3]);
    assert.equal(new Set(manifest.map(row=>row.position)).size,3,'recovery must not create duplicate commits');
  } finally {
    await runner.dispose();
  }
});