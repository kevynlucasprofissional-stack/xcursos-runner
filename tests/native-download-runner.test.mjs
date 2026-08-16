import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { XCursosCourseRunner } from '../src/runner.mjs';
import { DiskFakeDownloader, FakeBrowser, lesson } from './helpers.mjs';

async function tmp(){return await fs.mkdtemp(path.join(os.tmpdir(),'xc-native-runner-'));}

class NativeOnlyFakeDownloader extends DiskFakeDownloader{
  async download({mediaUrl,paths}){
    this.calls.push({mediaUrl});
    assert.equal(mediaUrl,null);
    await fs.mkdir(paths.moduleDir,{recursive:true});
    const finalPath=path.join(paths.moduleDir,`${paths.baseName}.mp4`);
    await fs.writeFile(finalPath,'VIDEO-NATIVE');
    return{ok:true,finalPath,downloadMethod:'XCURSOS_NATIVE'};
  }
}

test('runner processes a trusted native-download-only lesson without waiting for video.src',async()=>{
  const root=await tmp();
  const nativeOnly={...lesson(1,1,{video:false,title:'Native only'}),nativeDownloadUrl:'https://www.xcursos.com/api/video/download?lessonId=lesson-1',nativeDownloadAvailable:true,mediaSourceConfidence:'UNTRUSTED'};
  const browser=new FakeBrowser([nativeOnly]);const downloader=new NativeOnlyFakeDownloader();
  const runner=new XCursosCourseRunner({outputRoot:root,browser,downloader,limits:{mediaReadyTimeoutMs:0,downloadRetries:0}});
  const result=await runner.runCurrent({resume:true});
  assert.equal(result.status,'DOWNLOADED');assert.equal(downloader.calls.length,1);assert.equal(browser.stats.inspect>0,true);
  await runner.dispose();
});

test('runner does not trust a cross-origin native-download lookalike',async()=>{
  const root=await tmp();
  const unsafe={...lesson(1,1,{video:false,title:'Unsafe native'}),nativeDownloadUrl:'https://evil.example/api/video/download?lessonId=lesson-1',nativeDownloadAvailable:true,mediaSourceConfidence:'UNTRUSTED'};
  const browser=new FakeBrowser([unsafe]);const downloader=new NativeOnlyFakeDownloader();
  const runner=new XCursosCourseRunner({outputRoot:root,browser,downloader,limits:{mediaReadyTimeoutMs:0,downloadRetries:0}});
  const result=await runner.runCurrent({resume:true});
  assert.equal(result.status,'MEDIA_NOT_FOUND');assert.equal(downloader.calls.length,0);
  await runner.dispose();
});
