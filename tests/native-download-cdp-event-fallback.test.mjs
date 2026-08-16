import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MediaDownloader } from '../src/downloader.mjs';

class SilentCdp extends EventEmitter{
  constructor(){super();this.downloadPath=null;this.commands=[];}
  async send(method,params={}){this.commands.push({method,params});if(method==='Browser.setDownloadBehavior'&&params.behavior==='allowAndName')this.downloadPath=params.downloadPath;return{};}
  async detach(){}
}

test('missing Browser.downloadWillBegin falls back to download.path without saveAs or invalid promotion',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'xc-cdp-silent-'));const cdp=new SilentCdp();let resolveDownload,saveAsCalls=0;
  const downloadPromise=new Promise(resolve=>{resolveDownload=resolve;});
  const download={failure:async()=>null,suggestedFilename:()=> 'silent.mp4',async path(){return path.join(cdp.downloadPath,'silent-guid');},async saveAs(){saveAsCalls++;throw new Error('saveAs must not be used');},async cancel(){}};
  const locator={async count(){return 1;},async getAttribute(){return'/api/video/download?lessonId=silent-7';},async click(){queueMicrotask(async()=>{await fs.writeFile(path.join(cdp.downloadPath,'silent-guid'),'silent-video');resolveDownload(download);});}};
  const page={isClosed:()=>false,locator:()=>({first:()=>locator}),context:()=>({browser:()=>({async newBrowserCDPSession(){return cdp;}})}),async waitForEvent(){return await downloadPromise;}};
  const downloader=new MediaDownloader({ytDlpPath:'yt',ffprobePath:'ff',pageResolver:async()=>page,limits:{nativeDownloadEventTimeoutMs:40,downloadTimeoutMs:1000,ffprobeTimeoutMs:200},processRunner:async command=>{if(command==='yt')throw new Error('yt-dlp must not run');return{code:0,stdout:JSON.stringify({streams:[{codec_type:'video',codec_name:'h264'}],format:{duration:'10'}}),stderr:''};}});
  const paths={moduleDir:root,baseName:'007 - Silent',template:path.join(root,'007 - Silent.%(ext)s')};
  const result=await downloader.download({mediaUrl:null,refererUrl:'https://www.xcursos.com/curso/c/aula/7',paths});
  assert.equal(result.ok,true);assert.equal(result.nativeTransport,'PLAYWRIGHT_PATH');assert.equal(saveAsCalls,0);assert.equal(await fs.readFile(result.finalPath,'utf8'),'silent-video');
  await assert.rejects(fs.access(path.join(root,'.xcursos-download-staging')),{code:'ENOENT'});
  assert.deepEqual(cdp.commands.filter(x=>x.method==='Browser.setDownloadBehavior').map(x=>x.params.behavior),['allowAndName','default']);
});
