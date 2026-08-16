import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MediaDownloader } from '../src/downloader.mjs';

async function tmp(){return await fs.mkdtemp(path.join(os.tmpdir(),'xc-native-flow-'));}
function pathsFor(root){return{moduleDir:root,baseName:'007 - Aula',template:path.join(root,'007 - Aula.%(ext)s')};}
function goodFfprobe(){return{code:0,stdout:JSON.stringify({streams:[{codec_type:'video',codec_name:'h264'}],format:{duration:'42'}}),stderr:''};}
function nativePage({href='/api/video/download?lessonId=lesson-7',eventError=null}={}){
  const locator={async count(){return 1;},async getAttribute(){return href;},async click(){}};
  const download={failure:async()=>null,suggestedFilename:()=> 'server-name.mp4',async saveAs(file){await fs.writeFile(file,'native-video');}};
  return{isClosed:()=>false,locator:()=>({first:()=>locator}),async waitForEvent(){if(eventError)throw eventError;return download;}};
}

test('download prefers native XCursos button and never invokes yt-dlp when native succeeds',async()=>{
  const root=await tmp();let ytCalls=0;
  const d=new MediaDownloader({ytDlpPath:'yt',ffprobePath:'ff',pageResolver:async()=>nativePage(),processRunner:async command=>{if(command==='yt'){ytCalls++;throw new Error('yt-dlp should not run');}return goodFfprobe();}});
  const r=await d.download({mediaUrl:'https://cdn.example/video.mp4',refererUrl:'https://www.xcursos.com/curso/c/aula/7',paths:pathsFor(root)});
  assert.equal(r.ok,true);assert.equal(r.downloadMethod,'XCURSOS_NATIVE');assert.equal(ytCalls,0);assert.equal(path.basename(r.finalPath),'007 - Aula.mp4');
  const validation=await d.validateVideo(r.finalPath);assert.equal(validation.downloadMethod,'XCURSOS_NATIVE');
});

test('download uses yt-dlp normally when native button is absent',async()=>{
  const root=await tmp();let ytCalls=0;const final=path.join(root,'007 - Aula.mp4');
  const d=new MediaDownloader({ytDlpPath:'yt',ffprobePath:'ff',pageResolver:async()=>null,processRunner:async command=>{if(command==='yt'){ytCalls++;await fs.writeFile(final,'yt-video');return{code:0,stdout:`${final}\n`,stderr:''};}return goodFfprobe();}});
  const r=await d.download({mediaUrl:'https://cdn.example/video.mp4',refererUrl:'https://www.xcursos.com/curso/c/aula/7',paths:pathsFor(root)});
  assert.equal(r.ok,true);assert.equal(r.downloadMethod,'YTDLP');assert.equal(ytCalls,1);assert.equal(r.nativeFailure,undefined);
  const validation=await d.validateVideo(r.finalPath);assert.equal(validation.downloadMethod,'YTDLP');
});

test('native browser failure falls back to yt-dlp in the same lesson attempt',async()=>{
  const root=await tmp();let ytCalls=0;const final=path.join(root,'007 - Aula.mp4');const logs=[];
  const d=new MediaDownloader({ytDlpPath:'yt',ffprobePath:'ff',logger:{log:async(...args)=>logs.push(args)},pageResolver:async()=>nativePage({eventError:new Error('download event timeout')}),processRunner:async command=>{if(command==='yt'){ytCalls++;await fs.writeFile(final,'yt-video');return{code:0,stdout:`${final}\n`,stderr:''};}return goodFfprobe();}});
  const r=await d.download({mediaUrl:'https://cdn.example/video.mp4',refererUrl:'https://www.xcursos.com/curso/c/aula/7',paths:pathsFor(root)});
  assert.equal(r.ok,true);assert.equal(r.downloadMethod,'YTDLP');assert.equal(ytCalls,1);assert.equal(r.nativeFailure.failureCode,'NATIVE_DOWNLOAD_EVENT_FAILED');assert.ok(logs.some(([scope])=>scope==='NATIVE_FALLBACK'));
});

test('when native and yt-dlp both fail, yt-dlp keeps the primary failure and native failure remains diagnostic context',async()=>{
  const root=await tmp();
  const d=new MediaDownloader({ytDlpPath:'yt',ffprobePath:'ff',pageResolver:async()=>nativePage({eventError:new Error('download event timeout')}),processRunner:async command=>command==='yt'?{code:1,stdout:'',stderr:'HTTP Error 403: Forbidden'}:goodFfprobe()});
  const r=await d.download({mediaUrl:'https://cdn.example/video.mp4',refererUrl:'https://www.xcursos.com/curso/c/aula/7',paths:pathsFor(root)});
  assert.equal(r.ok,false);assert.equal(r.failureCode,'HTTP_403');assert.equal(r.kind,'EXPIRED');assert.equal(r.nativeFailure.failureCode,'NATIVE_DOWNLOAD_EVENT_FAILED');
});
