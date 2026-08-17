import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MediaDownloader } from '../src/downloader.mjs';

class LateCdp extends EventEmitter {
  constructor(){super();this.downloadPath=null;this.commands=[];this.detached=false;}
  async send(method,params={}){
    this.commands.push({method,params});
    if(method==='Browser.setDownloadBehavior'&&params.behavior==='allowAndName')this.downloadPath=params.downloadPath;
    return{};
  }
  async detach(){this.detached=true;}
}

function goodFfprobe(){return{code:0,stdout:JSON.stringify({streams:[{codec_type:'video',codec_name:'h264'}],format:{duration:'12'}}),stderr:''};}

test('late Browser.downloadWillBegin is absorbed before yt-dlp fallback so one lesson never starts two transfers',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'xc-native-late-start-'));
  const cdp=new LateCdp();let ytCalls=0;let nativeClicks=0;
  const lessonId='late-7';const guid='late-guid';
  const locator={
    async count(){return 1;},
    async getAttribute(){return `/api/video/download?lessonId=${lessonId}`;},
    async click(){
      nativeClicks++;
      setTimeout(async()=>{
        try{
          const url=`https://www.xcursos.com/api/video/download?lessonId=${lessonId}`;
          cdp.emit('Browser.downloadWillBegin',{guid,url,suggestedFilename:'late.mp4'});
          if(cdp.downloadPath){
            await fs.mkdir(cdp.downloadPath,{recursive:true});
            await fs.writeFile(path.join(cdp.downloadPath,guid),'late-native-video');
          }
          cdp.emit('Browser.downloadProgress',{guid,state:'completed',receivedBytes:17,totalBytes:17});
        }catch{}
      },35);
    },
  };
  const page={
    isClosed:()=>false,
    locator:()=>({first:()=>locator}),
    context:()=>({browser:()=>({async newBrowserCDPSession(){return cdp;}})}),
    async waitForEvent(name,{timeout}={}){
      assert.equal(name,'download');
      return await new Promise((_,reject)=>setTimeout(()=>reject(new Error('Playwright download event timeout')),Math.min(20,timeout||20)));
    },
  };
  const finalViaYt=path.join(root,'007 - Late.mp4');
  const downloader=new MediaDownloader({
    ytDlpPath:'yt',ffprobePath:'ff',pageResolver:async()=>page,
    limits:{nativeDownloadEventTimeoutMs:20,downloadTimeoutMs:1000,ffprobeTimeoutMs:200},
    processRunner:async command=>{
      if(command==='yt'){
        ytCalls++;
        await fs.writeFile(finalViaYt,'yt-video');
        return{code:0,stdout:`${finalViaYt}\n`,stderr:''};
      }
      return goodFfprobe();
    },
  });
  const paths={moduleDir:root,baseName:'007 - Late',template:path.join(root,'007 - Late.%(ext)s')};
  const result=await downloader.download({mediaUrl:'https://cdn.example/late.mp4',refererUrl:'https://www.xcursos.com/curso/c/aula/7',paths});

  assert.equal(result.ok,true);
  assert.equal(result.downloadMethod,'XCURSOS_NATIVE','a bounded late-start grace must prefer the native transfer that was already triggered');
  assert.equal(result.nativeTransport,'CDP');
  assert.equal(nativeClicks,1);
  assert.equal(ytCalls,0,'yt-dlp must not start while the already-triggered native download is still entering CDP');
  assert.equal(await fs.readFile(result.finalPath,'utf8'),'late-native-video');
  await new Promise(resolve=>setTimeout(resolve,70));
  await assert.rejects(fs.access(path.join(root,'.xcursos-download-staging')),{code:'ENOENT'});
  assert.deepEqual(cdp.commands.filter(x=>x.method==='Browser.setDownloadBehavior').map(x=>x.params.behavior),['allowAndName','default']);
  assert.equal(cdp.detached,true);
});
