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
    const unfinished=checkpoint.tasks.filter(task=>task.position>=2);
    assert.ok(unfinished.length>=4,'all untouched positions must remain represented in checkpoint');
    assert.ok(unfinished.every(task=>task.status!=='DONE'),'no failed or untouched position may be committed as DONE');
  } finally {
    await runner.dispose();
  }
});
