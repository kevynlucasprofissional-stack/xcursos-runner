import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { XCursosCourseRunner } from '../src/runner.mjs';
import { MediaDownloader } from '../src/downloader.mjs';
import { RuntimeStats } from '../src/runtime-stats.mjs';
import { parseXcursosLessonHtml, normalizeLiveLessonMeta } from '../src/parser.mjs';
import { FakeBrowser } from './helpers.mjs';

async function tmp(){return await fs.mkdtemp(path.join(os.tmpdir(),'xc-integrated-'));}
function lessonHtml(position,total,body){return `<html><head><title>Assistir Aula | XCURSOS</title></head><body><h2>Curso Integrado</h2><h1>Aula ${position}</h1><p>1. Módulo</p><span>${position} / ${total}</span>${body}</body></html>`;}
function parsedLesson(position,total,body){
  const url=`https://www.xcursos.com/aula/${position}`;
  return normalizeLiveLessonMeta(parseXcursosLessonHtml(lessonHtml(position,total,body),url),{url,title:'Assistir Aula | XCURSOS'});
}

class FakeCdp extends EventEmitter{
  constructor(){super();this.downloadPath=null;this.commands=[];}
  async send(method,params={}){this.commands.push({method,params});if(method==='Browser.setDownloadBehavior'&&params.behavior==='allowAndName')this.downloadPath=params.downloadPath;return{};}
  async detach(){}
}
function nativePageFor(position,{clock,transports}){
  const lessonId=`lesson-${position}`;const guid=`guid-${position}`;const cdp=new FakeCdp();let resolveDownload;
  const downloadPromise=new Promise(resolve=>{resolveDownload=resolve;});
  const download={failure:async()=>null,suggestedFilename:()=>`server-${position}.mp4`,path:async()=>path.join(cdp.downloadPath,guid),async saveAs(){throw new Error('saveAs must not be used in integrated CDP flow');},async cancel(){}};
  const locator={
    async count(){return 1;},async getAttribute(){return `/api/video/download?lessonId=${lessonId}`;},
    async click(){queueMicrotask(async()=>{
      const nativeUrl=`https://www.xcursos.com/api/video/download?lessonId=${lessonId}`;
      cdp.emit('Browser.downloadWillBegin',{guid,url:nativeUrl,suggestedFilename:`server-${position}.mp4`});
      await fs.writeFile(path.join(cdp.downloadPath,guid),`VIDEO-${position}`);
      clock.value+=60_000;
      cdp.emit('Browser.downloadProgress',{guid,state:'completed',receivedBytes:7,totalBytes:7});
      resolveDownload(download);
    });}
  };
  const page={
    isClosed:()=>false,
    locator:()=>({first:()=>locator}),
    context:()=>({browser:()=>({async newBrowserCDPSession(){return cdp;}})}),
    async waitForEvent(name){assert.equal(name,'download');return await downloadPromise;},
  };
  transports.push(cdp);return page;
}

test('integrated flow: material-only -> native CDP staging -> validated commit -> next lesson -> robust ETA',async()=>{
  const root=await tmp();const total=3;const clock={value:0};const transports=[];const progress=[];let ffprobes=0,ytCalls=0;
  const lessons=[
    parsedLesson(1,total,'<a href="/api/materials/download?lessonId=lesson-1&index=0">Baixar PDF</a><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-X"></iframe>'),
    parsedLesson(2,total,'<a href="/api/video/download?lessonId=lesson-2">Baixar aula</a>'),
    parsedLesson(3,total,'<a href="/api/video/download?lessonId=lesson-3">Baixar aula</a>'),
  ];
  assert.equal(lessons[0].materialOnly,true);assert.equal(lessons[1].nativeDownloadAvailable,true);assert.equal(lessons[2].nativeDownloadAvailable,true);
  const browser=new FakeBrowser(lessons,{startPosition:1});
  const downloader=new MediaDownloader({
    ytDlpPath:'yt',ffprobePath:'ff',limits:{nativeDownloadEventTimeoutMs:500,downloadTimeoutMs:2000,ffprobeTimeoutMs:500},
    pageResolver:async referer=>nativePageFor(Number(String(referer).match(/\/aula\/(\d+)/)?.[1]),{clock,transports}),
    processRunner:async command=>{
      if(command==='yt'){ytCalls++;throw new Error('yt-dlp must not run for native-only lessons');}
      ffprobes++;return{code:0,stdout:JSON.stringify({streams:[{codec_type:'video',codec_name:'h264'}],format:{duration:'60'}}),stderr:''};
    },
  });
  const runtimeStats=new RuntimeStats({total,nowFn:()=>clock.value});
  const runner=new XCursosCourseRunner({outputRoot:root,browser,downloader,runtimeStats,progressSink:line=>progress.push(line),limits:{navigationRetries:1,mediaReadyTimeoutMs:50,mediaReadyPollMs:5,retryBaseDelayMs:1,retryMaxDelayMs:5,downloadRetries:1,throttleMinDelayMs:0,throttleMaxDelayMs:0}});
  try{
    const result=await runner.runRange({start:1,end:3,resume:false,finalAudit:false});
    assert.equal(result.ok,true);assert.equal(result.status,'RANGE_COMPLETE');assert.equal(result.audit.processed,3);assert.deepEqual(result.audit.missingPositions,[]);assert.deepEqual(result.audit.invalidFilePositions,[]);
    const records=runner.state.manifestRecords.sort((a,b)=>a.position-b.position);
    assert.equal(records[0].status,'NO_VIDEO');assert.equal(records[0].outputFile,null);
    assert.equal(records[1].status,'DOWNLOADED');assert.equal(records[1].validation.downloadMethod,'XCURSOS_NATIVE');
    assert.equal(records[2].status,'DOWNLOADED');assert.equal(records[2].validation.downloadMethod,'XCURSOS_NATIVE');
    assert.equal(ytCalls,0);assert.ok(ffprobes>=2);
    for(const rec of records.slice(1)){assert.equal(await fs.readFile(rec.outputFile,'utf8'),`VIDEO-${rec.position}`);await assert.rejects(fs.access(path.join(path.dirname(rec.outputFile),'.xcursos-download-staging')),{code:'ENOENT'});}
    assert.equal(browser.stats.clickNext,2);
    assert.equal(transports.length,2);for(const cdp of transports){const behavior=cdp.commands.filter(x=>x.method==='Browser.setDownloadBehavior').map(x=>x.params.behavior);assert.deepEqual(behavior,['allowAndName','default']);}
    assert.equal(result.stats.etaStatus,'COMPLETE');assert.equal(result.stats.etaMs,0);
    assert.ok(progress.some(line=>line.includes('[1/3] Processing')));assert.ok(progress.some(line=>line.includes('[2/3] Processing')));assert.ok(progress.some(line=>line.includes('[3/3] Processing')));
  }finally{await runner.dispose();}
});
