import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MediaDownloader } from '../src/downloader.mjs';

async function tmp(){return await fs.mkdtemp(path.join(os.tmpdir(),'xc-native-cdp-'));}
function pathsFor(root,baseName='007 - Aula'){return{moduleDir:root,baseName,template:path.join(root,`${baseName}.%(ext)s`) };}
function goodFfprobe(){return{code:0,stdout:JSON.stringify({streams:[{codec_type:'video',codec_name:'h264'}],format:{duration:'42'}}),stderr:''};}

class FakeCdp extends EventEmitter{
  constructor(){super();this.downloadPath=null;this.commands=[];this.detached=false;}
  async send(method,params={}){
    this.commands.push({method,params});
    if(method==='Browser.setDownloadBehavior'&&params.behavior==='allowAndName')this.downloadPath=params.downloadPath;
    return{};
  }
  async detach(){this.detached=true;}
}

function cdpNativePage({lessonId='lesson-7',guid='guid-7',content='native-video',completionGate=null,cancel=false}={}){
  const cdp=new FakeCdp();let saveAsCalls=0,cancelCalls=0,downloadResolve;
  const downloadPromise=new Promise(resolve=>{downloadResolve=resolve;});
  const download={
    failure:async()=>cancel?'canceled':null,
    suggestedFilename:()=> 'server-name.mp4',
    async path(){return cdp.downloadPath?path.join(cdp.downloadPath,guid):null;},
    async saveAs(file){saveAsCalls++;await fs.writeFile(file,content);},
    async cancel(){cancelCalls++;},
  };
  const locator={
    async count(){return 1;},
    async getAttribute(){return `/api/video/download?lessonId=${lessonId}`;},
    async click(){
      queueMicrotask(async()=>{
        const url=`https://www.xcursos.com/api/video/download?lessonId=${lessonId}`;
        cdp.emit('Browser.downloadWillBegin',{guid,url,suggestedFilename:'server-name.mp4'});
        if(cdp.downloadPath)await fs.writeFile(path.join(cdp.downloadPath,guid),content);
        if(completionGate)await completionGate;
        if(cancel){
          cdp.emit('Browser.downloadProgress',{guid,state:'canceled',receivedBytes:3,totalBytes:100});
        }else{
          cdp.emit('Browser.downloadProgress',{guid,state:'completed',receivedBytes:content.length,totalBytes:content.length});
        }
        downloadResolve(download);
      });
    },
  };
  const browser={async newBrowserCDPSession(){return cdp;}};
  const page={
    isClosed:()=>false,
    locator:()=>({first:()=>locator}),
    context:()=>({browser:()=>browser}),
    async waitForEvent(name){assert.equal(name,'download');return await downloadPromise;},
  };
  return{page,cdp,get saveAsCalls(){return saveAsCalls;},get cancelCalls(){return cancelCalls;}};
}

function downloaderFor(pageFactory,{onFfprobe=null}={}){
  let ytCalls=0;
  const downloader=new MediaDownloader({
    ytDlpPath:'yt',ffprobePath:'ff',pageResolver:async()=>pageFactory.page,
    limits:{nativeDownloadEventTimeoutMs:500,downloadTimeoutMs:2_000,ffprobeTimeoutMs:500},
    processRunner:async command=>{
      if(command==='yt'){ytCalls++;throw new Error('yt-dlp should not run');}
      onFfprobe?.();return goodFfprobe();
    },
  });
  return{downloader,get ytCalls(){return ytCalls;}};
}

test('CDP routes the native download directly to module staging, validates it, renames it, and restores browser policy',async()=>{
  const root=await tmp();const native=cdpNativePage();const state=downloaderFor(native);
  const result=await state.downloader.download({mediaUrl:null,refererUrl:'https://www.xcursos.com/curso/c/aula/7',paths:pathsFor(root)});
  assert.equal(result.ok,true);assert.equal(result.downloadMethod,'XCURSOS_NATIVE');assert.equal(result.nativeTransport,'CDP');assert.equal(state.ytCalls,0);assert.equal(native.saveAsCalls,0);
  assert.equal(path.basename(result.finalPath),'007 - Aula.mp4');assert.equal(await fs.readFile(result.finalPath,'utf8'),'native-video');
  await assert.rejects(fs.access(path.join(root,'.xcursos-download-staging')),{code:'ENOENT'});
  const policies=native.cdp.commands.filter(x=>x.method==='Browser.setDownloadBehavior').map(x=>x.params.behavior);
  assert.deepEqual(policies,['allowAndName','default']);assert.equal(native.cdp.detached,true);
});

test('CDP completion event gates ffprobe and promotion for a slow/large download',async()=>{
  const root=await tmp();let release;const gate=new Promise(resolve=>{release=resolve;});let probed=false;
  const native=cdpNativePage({completionGate:gate,content:'large-video'});const {downloader}=downloaderFor(native,{onFfprobe:()=>{probed=true;}});
  const pending=downloader.download({mediaUrl:null,refererUrl:'https://www.xcursos.com/curso/c/aula/7',paths:pathsFor(root)});
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(probed,false);await assert.rejects(fs.access(path.join(root,'007 - Aula.mp4')),{code:'ENOENT'});
  release();const result=await pending;assert.equal(result.ok,true);assert.equal(probed,true);
});

test('canceled CDP download is never promoted and staging is cleaned',async()=>{
  const root=await tmp();const native=cdpNativePage({cancel:true});const {downloader}=downloaderFor(native);
  const result=await downloader.download({mediaUrl:null,refererUrl:'https://www.xcursos.com/curso/c/aula/7',paths:pathsFor(root)});
  assert.equal(result.ok,false);assert.equal(result.failureCode,'NATIVE_DOWNLOAD_CANCELED');
  await assert.rejects(fs.access(path.join(root,'007 - Aula.mp4')),{code:'ENOENT'});
  await assert.rejects(fs.access(path.join(root,'.xcursos-download-staging')),{code:'ENOENT'});
});

test('consecutive native downloads do not reuse the previous GUID or staging artifact',async()=>{
  const root=await tmp();let n=0;const sessions=[];
  const page={
    isClosed:()=>false,
    locator:()=>({first:()=>({async count(){return 1;},async getAttribute(){return'/api/video/download?lessonId=lesson-7';},async click(){const current=sessions.at(-1);const guid=`guid-${++n}`;const url='https://www.xcursos.com/api/video/download?lessonId=lesson-7';queueMicrotask(async()=>{current.cdp.emit('Browser.downloadWillBegin',{guid,url,suggestedFilename:'lesson.mp4'});await fs.writeFile(path.join(current.cdp.downloadPath,guid),`video-${n}`);current.cdp.emit('Browser.downloadProgress',{guid,state:'completed'});current.resolve({suggestedFilename:()=> 'lesson.mp4',path:async()=>path.join(current.cdp.downloadPath,guid),failure:async()=>null,saveAs:async()=>{throw new Error('saveAs must not run');}});});}})}),
    context:()=>({browser:()=>({async newBrowserCDPSession(){const cdp=new FakeCdp();sessions.push({cdp,resolve:null});return cdp;}})}),
    async waitForEvent(){const current=sessions.at(-1);let resolve;const promise=new Promise(r=>{resolve=r;});if(!current)throw new Error('session not prepared');current.resolve=resolve;return await promise;},
  };
  const {downloader}=downloaderFor({page});
  const first=await downloader.download({mediaUrl:null,refererUrl:'https://www.xcursos.com/curso/c/aula/7',paths:pathsFor(root,'007 - Primeira')});
  const second=await downloader.download({mediaUrl:null,refererUrl:'https://www.xcursos.com/curso/c/aula/8',paths:pathsFor(root,'008 - Segunda')});
  assert.equal(await fs.readFile(first.finalPath,'utf8'),'video-1');assert.equal(await fs.readFile(second.finalPath,'utf8'),'video-2');
  assert.equal(sessions.length,2);for(const session of sessions){assert.equal(session.cdp.commands.some(x=>x.params?.behavior==='default'),true);}
});

test('restart residue in staging is removed before a new native download and cannot be mistaken for a valid lesson',async()=>{
  const root=await tmp();const staging=path.join(root,'.xcursos-download-staging');await fs.mkdir(staging,{recursive:true});await fs.writeFile(path.join(staging,'stale.crdownload'),'partial');
  const native=cdpNativePage({guid:'fresh-guid',content:'fresh-video'});const {downloader}=downloaderFor(native);
  const result=await downloader.download({mediaUrl:null,refererUrl:'https://www.xcursos.com/curso/c/aula/7',paths:pathsFor(root)});
  assert.equal(result.ok,true);assert.equal(await fs.readFile(result.finalPath,'utf8'),'fresh-video');
  await assert.rejects(fs.access(staging),{code:'ENOENT'});
});

test('when browser-level CDP is unavailable, download.path is moved before saveAs is considered',async()=>{
  const root=await tmp();const original=path.join(root,'browser-default.mp4');await fs.writeFile(original,'path-video');let saveAsCalls=0;
  const locator={async count(){return 1;},async getAttribute(){return'/api/video/download?lessonId=lesson-7';},async click(){}};
  const download={failure:async()=>null,suggestedFilename:()=> 'browser-default.mp4',path:async()=>original,async saveAs(){saveAsCalls++;}};
  const page={isClosed:()=>false,locator:()=>({first:()=>locator}),context:()=>({browser:()=>null}),async waitForEvent(){return download;}};
  const {downloader}=downloaderFor({page});
  const result=await downloader.download({mediaUrl:null,refererUrl:'https://www.xcursos.com/curso/c/aula/7',paths:pathsFor(root)});
  assert.equal(result.ok,true);assert.equal(result.nativeTransport,'PLAYWRIGHT_RENAME');assert.equal(saveAsCalls,0);await assert.rejects(fs.access(original),{code:'ENOENT'});
  assert.equal(await fs.readFile(result.finalPath,'utf8'),'path-video');
});
