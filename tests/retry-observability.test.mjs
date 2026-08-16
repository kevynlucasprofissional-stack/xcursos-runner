import test from 'node:test';
import assert from 'node:assert/strict';
import { XCursosCourseRunner, formatRetryProgress } from '../src/runner.mjs';

function makeRunner(){
  const logs=[];const progress=[];
  const runner=new XCursosCourseRunner({
    browser:{},downloader:{},
    logger:{async log(scope,message,data){logs.push({scope,message,data});}},
    progressSink:line=>progress.push(line),
  });
  runner.total=144;
  return{runner,logs,progress};
}

test('native download retry exposes the concrete failure code, attempt budget, and delay',async()=>{
  const {runner,logs,progress}=makeRunner();
  const decision={attempt:1,maxAttempts:3,delayMs:2000,retry:true,classification:'TRANSIENT'};
  const result=await runner.reportRetry({position:56,decision,code:'DOWNLOAD_FAILED',status:'DOWNLOAD_FAILED',failureCode:'NATIVE_DOWNLOAD_EVENT_FAILED'});
  assert.equal(result.line,'[RETRY] 56/144 | NATIVE_DOWNLOAD_EVENT_FAILED | tentativa 1/3 | retry em 2s');
  assert.deepEqual(progress,[result.line]);
  assert.equal(logs.length,1);assert.equal(logs[0].scope,'RETRY');
  assert.equal(logs[0].data.causeCode,'NATIVE_DOWNLOAD_EVENT_FAILED');
  assert.equal(logs[0].data.status,'DOWNLOAD_FAILED');
  assert.equal(logs[0].data.attempt,1);assert.equal(logs[0].data.maxAttempts,3);assert.equal(logs[0].data.delayMs,2000);assert.equal(logs[0].data.retry,true);
});

test('navigation retry includes semantic runner code plus the concrete net::ERR cause',async()=>{
  const {runner,logs,progress}=makeRunner();
  const decision={attempt:2,maxAttempts:3,delayMs:500,retry:true,classification:'TRANSIENT'};
  const result=await runner.reportRetry({position:80,decision,code:'NAV_NETWORK_ERROR',networkCode:'ERR_NETWORK_ACCESS_DENIED',message:'Falha transitória de navegação após recovery limitado: ERR_NETWORK_ACCESS_DENIED'});
  assert.equal(result.line,'[RETRY] 80/144 | NAV_NETWORK_ERROR | ERR_NETWORK_ACCESS_DENIED | tentativa 2/3 | retry em 500ms');
  assert.equal(progress[0],result.line);
  assert.equal(logs[0].data.causeCode,'NAV_NETWORK_ERROR');assert.equal(logs[0].data.networkCode,'ERR_NETWORK_ACCESS_DENIED');assert.equal(logs[0].data.classification,'TRANSIENT');
});

test('retry budget exhaustion is explicit and does not claim another retry',async()=>{
  const {runner,logs,progress}=makeRunner();
  const decision={attempt:3,maxAttempts:3,delayMs:0,retry:false,classification:'TRANSIENT'};
  const result=await runner.reportRetry({position:56,decision,status:'VERIFY_FAILED',failureCode:'VERIFY_NO_VIDEO_STREAM'});
  assert.equal(result.line,'[RETRY] 56/144 | VERIFY_NO_VIDEO_STREAM | tentativa 3/3 | orçamento esgotado');
  assert.equal(progress[0],result.line);assert.equal(logs[0].data.retry,false);assert.equal(logs[0].data.delayMs,0);
});

test('retry formatter is single-line and keeps concise retry timing',()=>{
  const line=formatRetryProgress({position:3,total:10,causeCode:'NETWORK_TIMEOUT',detail:'connection timed out',attempt:1,maxAttempts:3,delayMs:1250,retry:true});
  assert.equal(line,'[RETRY] 3/10 | NETWORK_TIMEOUT | connection timed out | tentativa 1/3 | retry em 1.3s');
  assert.equal(line.includes('\n'),false);
});
