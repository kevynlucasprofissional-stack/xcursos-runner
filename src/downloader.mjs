import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_LIMITS, VIDEO_DOWNLOAD_PATH } from './constants.mjs';
import { RunnerError } from './errors.mjs';
import { findConnectedPageByUrl } from './browser-session.mjs';
import { normalizeNativeDownloadUrl } from './parser.mjs';
import { findExecutable, runProcess } from './process.mjs';
import { redactUrl, redactSensitiveText, sanitizeSegment, truncateWithHash } from './utils.mjs';

const NATIVE_STAGING_DIR='.xcursos-download-staging';
const NATIVE_BROWSER_LOCK=path.join(os.tmpdir(),'xcursos-runner-native-browser-download.lock');
let nativeDownloadTail=Promise.resolve();

function looksExpired(output='') { return /(?:HTTP Error 403|\b403\b|forbidden|signature.*expired|request has expired|expiredtoken)/i.test(output); }
function looksDrm(output='') { return /(?:DRM|Widevine|PlayReady|FairPlay|encrypted media|This video is DRM protected)/i.test(output); }
export function classifyYtDlpFailure(output=''){
  const s=String(output||'');
  if(looksDrm(s))return'DRM';
  if(/(?:HTTP Error 403|\b403\b|forbidden)/i.test(s))return'HTTP_403';
  if(/(?:HTTP Error 404|\b404\b.*not found)/i.test(s))return'HTTP_404';
  if(/(?:HTTP Error 429|\b429\b|too many requests)/i.test(s))return'HTTP_429';
  if(/HTTP Error 5\d\d|\b5\d\d\b.*(?:server|gateway|service)/i.test(s))return'HTTP_5XX';
  if(/(?:connection reset|ECONNRESET|network reset)/i.test(s))return'NETWORK_RESET';
  if(/(?:timed? out|timeout|ETIMEDOUT)/i.test(s))return'NETWORK_TIMEOUT';
  if(/(?:TLS|SSL|certificate|handshake)/i.test(s))return'TLS_ERROR';
  if(/(?:temporary failure in name resolution|EAI_AGAIN|name or service not known|DNS)/i.test(s))return'DNS_ERROR';
  return'YTDLP_FAILED';
}
function diagnosticTail(output='',max=4000){const safe=redactSensitiveText(String(output||''));return safe.length>max?safe.slice(-max):safe;}
export function parseYtDlpProgress(line=''){const s=String(line);const pct=s.match(/\[download\]\s+(\d+(?:\.\d+)?)%/i);if(!pct)return null;const speed=s.match(/\bat\s+([^\s]+\/s)/i);const eta=s.match(/\bETA\s+([0-9:]+)/i);return{percent:Number(pct[1]),speedText:speed?.[1]||null,eta:eta?.[1]||null};}
function safeDownloadExtension(filename=''){const ext=path.extname(String(filename||'')).toLowerCase();return /^\.[a-z0-9]{1,8}$/i.test(ext)?ext:'.mp4';}
function methodKey(filePath=''){return path.resolve(String(filePath||''));}
export function fileFingerprintFromStat(stat){return{size:Number(stat?.size)||0,mtimeMs:Number(stat?.mtimeMs)||0};}
export function sameFileFingerprint(a,b){return Boolean(a&&b&&Number(a.size)===Number(b.size)&&Number(a.mtimeMs)===Number(b.mtimeMs));}

async function serializeNativeDownload(task){
  const previous=nativeDownloadTail;
  let release;
  nativeDownloadTail=new Promise(resolve=>{release=resolve;});
  await previous.catch(()=>{});
  try{return await task();}finally{release();}
}

function processAlive(pid){
  if(!Number.isInteger(pid)||pid<=0)return false;
  try{process.kill(pid,0);return true;}catch(error){return error?.code==='EPERM';}
}
async function acquireNativeBrowserLock({timeoutMs,signal=null,logger=null}={}){
  const deadline=Date.now()+Math.max(1000,Number(timeoutMs)||1000);
  const token=`${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let loggedWait=false;
  while(true){
    if(signal?.aborted)throw new RunnerError('Download abortado.',{code:'PROCESS_ABORTED'});
    try{
      await fs.mkdir(NATIVE_BROWSER_LOCK);
      await fs.writeFile(path.join(NATIVE_BROWSER_LOCK,'owner.json'),JSON.stringify({pid:process.pid,token,startedAt:new Date().toISOString()}),'utf8');
      return async()=>{
        try{
          const owner=JSON.parse(await fs.readFile(path.join(NATIVE_BROWSER_LOCK,'owner.json'),'utf8'));
          if(owner?.token===token)await fs.rm(NATIVE_BROWSER_LOCK,{recursive:true,force:true});
        }catch(error){if(error?.code!=='ENOENT')await logger?.log?.('NATIVE_DOWNLOAD','Failed to release browser download lock',{failureCode:'NATIVE_LOCK_RELEASE_FAILED',diagnosticTail:diagnosticTail(error?.message||error)});}
      };
    }catch(error){
      if(error?.code!=='EEXIST')throw new RunnerError('Não foi possível adquirir o lock global de download do Chrome.',{code:'NATIVE_LOCK_ACQUIRE_FAILED',cause:error});
      let owner=null,stat=null;
      try{owner=JSON.parse(await fs.readFile(path.join(NATIVE_BROWSER_LOCK,'owner.json'),'utf8'));}catch{}
      try{stat=await fs.stat(NATIVE_BROWSER_LOCK);}catch{}
      const ageMs=stat?Date.now()-stat.mtimeMs:0;
      const stale=(owner?.pid&&!processAlive(Number(owner.pid)))||(!owner&&ageMs>60_000);
      if(stale){await fs.rm(NATIVE_BROWSER_LOCK,{recursive:true,force:true}).catch(()=>{});continue;}
      if(Date.now()>=deadline)throw new RunnerError('Outro download nativo está usando a política global do Chrome há tempo demais.',{code:'NATIVE_DOWNLOAD_LOCK_TIMEOUT',details:{ownerPid:owner?.pid??null}});
      if(!loggedWait){loggedWait=true;await logger?.log?.('NATIVE_DOWNLOAD','Waiting for browser-global download routing lock',{ownerPid:owner?.pid??null});}
      await new Promise(resolve=>setTimeout(resolve,200));
    }
  }
}

function nativeLessonId(url=''){
  try{return new URL(String(url)).searchParams.get('lessonId')||null;}catch{return null;}
}
function isExpectedNativeUrl(actual='',expected=''){
  const expectedId=nativeLessonId(expected);if(!expectedId)return false;
  const normalized=normalizeNativeDownloadUrl(actual,expected);return Boolean(normalized&&nativeLessonId(normalized)===expectedId);
}
function delayReject(ms,error,signal=null){
  return new Promise((_,reject)=>{
    const timer=setTimeout(()=>{cleanup();reject(error);},Math.max(1,Number(ms)||1));
    const onAbort=()=>{cleanup();reject(new RunnerError('Download abortado.',{code:'PROCESS_ABORTED'}));};
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener?.('abort',onAbort);};
    if(signal?.aborted)return onAbort();
    signal?.addEventListener?.('abort',onAbort,{once:true});
  });
}
async function withTimeout(promise,ms,error,signal=null){return await Promise.race([promise,delayReject(ms,error,signal)]);}
async function waitForFile(filePath,{timeoutMs=5000,signal=null}={}){
  const end=Date.now()+Math.max(1,Number(timeoutMs)||1);
  while(Date.now()<=end){
    if(signal?.aborted)throw new RunnerError('Download abortado.',{code:'PROCESS_ABORTED'});
    try{const stat=await fs.stat(filePath);if(stat.isFile()&&stat.size>0)return stat;}catch{}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw new RunnerError(`Arquivo concluído pelo Chrome não apareceu no staging: ${path.basename(filePath)}`,{code:'NATIVE_STAGING_FILE_MISSING'});
}
async function cleanupStaging(stagingRoot){
  try{await fs.rm(stagingRoot,{recursive:true,force:true});}catch(error){throw new RunnerError('Não foi possível limpar o staging de download nativo.',{code:'NATIVE_STAGING_CLEANUP_FAILED',cause:error,details:{stagingRoot}});}
}
function createCdpDownloadTracker(cdp,expectedUrl,{startTimeoutMs,completionTimeoutMs,signal=null}={}){
  let guid=null,suggestedFilename='',startTimer=null,completionTimer=null,settledStart=false,settledCompletion=false;
  let startResolve,startReject,completionResolve,completionReject;
  const started=new Promise((resolve,reject)=>{startResolve=resolve;startReject=reject;});
  const completed=new Promise((resolve,reject)=>{completionResolve=resolve;completionReject=reject;});
  started.catch(()=>{});completed.catch(()=>{});
  const cleanupTimers=()=>{if(startTimer)clearTimeout(startTimer);if(completionTimer)clearTimeout(completionTimer);};
  const rejectStart=error=>{if(settledStart)return;settledStart=true;startReject(error);};
  const rejectCompletion=error=>{if(settledCompletion)return;settledCompletion=true;completionReject(error);};
  const onWillBegin=event=>{
    if(guid||!isExpectedNativeUrl(event?.url||'',expectedUrl))return;
    guid=String(event.guid||'');suggestedFilename=String(event.suggestedFilename||'');
    if(!guid)return;
    if(startTimer)clearTimeout(startTimer);settledStart=true;startResolve({guid,suggestedFilename,url:event.url||null});
    completionTimer=setTimeout(()=>rejectCompletion(new RunnerError('Download nativo excedeu o tempo limite.',{code:'NATIVE_DOWNLOAD_TIMEOUT',details:{guid}})),Math.max(1,Number(completionTimeoutMs)||1));
  };
  const onProgress=event=>{
    if(!guid||event?.guid!==guid)return;
    if(event.state==='completed'){
      if(completionTimer)clearTimeout(completionTimer);if(settledCompletion)return;settledCompletion=true;
      completionResolve({guid,suggestedFilename,totalBytes:Number(event.totalBytes)||null,receivedBytes:Number(event.receivedBytes)||null});
    }else if(event.state==='canceled'){
      if(completionTimer)clearTimeout(completionTimer);
      rejectCompletion(new RunnerError('Chrome cancelou o download nativo.',{code:'NATIVE_DOWNLOAD_CANCELED',details:{guid}}));
    }
  };
  const onAbort=()=>{
    const error=new RunnerError('Download abortado.',{code:'PROCESS_ABORTED'});rejectStart(error);rejectCompletion(error);
  };
  cdp.on?.('Browser.downloadWillBegin',onWillBegin);cdp.on?.('Browser.downloadProgress',onProgress);
  startTimer=setTimeout(()=>rejectStart(new RunnerError('Chrome não emitiu Browser.downloadWillBegin para a aula atual.',{code:'NATIVE_CDP_START_TIMEOUT'})),Math.max(1,Number(startTimeoutMs)||1));
  signal?.addEventListener?.('abort',onAbort,{once:true});
  return{started,completed,get guid(){return guid;},dispose(){cleanupTimers();signal?.removeEventListener?.('abort',onAbort);cdp.off?.('Browser.downloadWillBegin',onWillBegin);cdp.off?.('Browser.downloadProgress',onProgress);}};
}

export class MediaDownloader {
  constructor({ processRunner = runProcess, logger = null, limits = {}, ytDlpPath = null, ffprobePath = null, pageResolver = findConnectedPageByUrl } = {}) {
    this.processRunner = processRunner; this.logger=logger; this.limits={...DEFAULT_LIMITS,...limits};
    this.ytDlpPath=ytDlpPath; this.ffprobePath=ffprobePath;this.pageResolver=pageResolver;this.downloadMethodByPath=new Map();this.validationCacheByPath=new Map();
  }

  async preflight() {
    if (!this.ytDlpPath) this.ytDlpPath=(await findExecutable('yt-dlp',{envVar:'YTDLP_PATH',processRunner:this.processRunner})).path;
    if (!this.ffprobePath) this.ffprobePath=(await findExecutable('ffprobe',{envVar:'FFPROBE_PATH',versionArgs:['-version'],processRunner:this.processRunner})).path;
    return { ytDlp:this.ytDlpPath, ffprobe:this.ffprobePath };
  }

  buildPaths({ root, courseName, moduleName, modulePath=null, lessonTitle, position, total }) {
    let course=sanitizeSegment(courseName,'Curso XCursos',90);
    let modules=(Array.isArray(modulePath)?modulePath:[]).map(x=>String(x||'').trim()).filter(Boolean).map(x=>sanitizeSegment(x,'Modulo desconhecido',80));
    if(!modules.length)modules=[sanitizeSegment(moduleName || 'Modulo desconhecido','Modulo desconhecido',80)];
    let title=sanitizeSegment(lessonTitle,'Aula',110);
    const width=Math.max(3,String(total || 999).length);const prefix=position != null ? String(position).padStart(width,'0') : '000';
    const templateFor=()=>path.join(root,course,...modules,`${prefix} - ${title}.%(ext)s`);const maxPath=235;let guard=0;
    while(templateFor().length>maxPath&&guard++<100){
      if(title.length>32){title=truncateWithHash(title,Math.max(32,title.length-10));continue;}
      let longest=-1;for(let i=0;i<modules.length;i++)if(modules[i].length>24&&(longest<0||modules[i].length>modules[longest].length))longest=i;
      if(longest>=0){modules[longest]=truncateWithHash(modules[longest],Math.max(24,modules[longest].length-10));continue;}
      if(course.length>32){course=truncateWithHash(course,Math.max(32,course.length-10));continue;}break;
    }
    if(templateFor().length>maxPath)throw new RunnerError(`Caminho de saída excede limite seguro (${templateFor().length} > ${maxPath}). Escolha um outputRoot mais curto.`,{code:'OUTPUT_PATH_TOO_LONG'});
    const courseDir=path.join(root,course);const moduleDir=path.join(courseDir,...modules);const baseName=`${prefix} - ${title}`;
    return{courseDir,moduleDir,modulePath:modules,baseName,template:path.join(moduleDir,`${baseName}.%(ext)s`)};
  }

  async findExistingFinal(moduleDir, baseName) {
    try {
      const entries=await fs.readdir(moduleDir,{withFileTypes:true});
      const prefix=`${baseName}.`;
      const finals=entries.filter(e=>e.isFile() && e.name.startsWith(prefix) && e.name.slice(prefix.length).length>0 && !/\.(?:part|ytdl|temp)$/i.test(e.name) && !/\.corrupt-/i.test(e.name));
      if(finals.length===1)return path.join(moduleDir,finals[0].name);
      if(finals.length>1)throw new RunnerError(`Mais de um arquivo final corresponde a ${baseName}.`,{code:'DUPLICATE_OUTPUT_FILES'});
      return null;
    } catch(error){ if(error?.code==='ENOENT')return null; throw error; }
  }

  async quarantineCorrupt(filePath) {
    const key=methodKey(filePath);this.validationCacheByPath.delete(key);this.downloadMethodByPath.delete(key);
    const quarantine=`${filePath}.corrupt-${Date.now()}`;
    try { await fs.rename(filePath,quarantine); return quarantine; }
    catch(error){ throw new RunnerError(`Arquivo inválido não pôde ser movido para quarentena: ${path.basename(filePath)}`,{code:'CORRUPT_FILE_QUARANTINE_FAILED',cause:error,details:{filePath}}); }
  }

  async clearPartialArtifacts(moduleDir,baseName) {
    let entries=[];
    try{entries=await fs.readdir(moduleDir,{withFileTypes:true});}catch(error){if(error?.code==='ENOENT')return[];throw error;}
    const removed=[];
    for(const entry of entries){
      if(!entry.isFile()||!entry.name.startsWith(`${baseName}.`)||!/\.(?:part|ytdl|temp)$/i.test(entry.name))continue;
      const full=path.join(moduleDir,entry.name);const key=methodKey(full);this.validationCacheByPath.delete(key);this.downloadMethodByPath.delete(key);
      try{await fs.unlink(full);removed.push(full);}catch(error){if(error?.code!=='ENOENT')throw new RunnerError(`Artefato parcial não pôde ser removido: ${entry.name}`,{code:'PARTIAL_CLEANUP_FAILED',cause:error,details:{filePath:full}});}
    }
    return removed;
  }

  async validateVideo(filePath,{signal=null}={}) {
    if (!this.ffprobePath) throw new RunnerError('ffprobe não foi inicializado; validação completa indisponível.', { code:'FFPROBE_UNAVAILABLE' });
    let stat;
    try { stat=await fs.stat(filePath); } catch { throw new RunnerError('Arquivo final não existe.',{code:'VERIFY_FILE_MISSING'}); }
    if(!stat.isFile() || stat.size<=0)throw new RunnerError('Arquivo final está vazio.',{code:'VERIFY_EMPTY_FILE'});
    const fingerprint=fileFingerprintFromStat(stat);const key=methodKey(filePath);const cached=this.validationCacheByPath.get(key);
    if(cached&&sameFileFingerprint(cached.fingerprint,fingerprint)){this.validationCacheByPath.delete(key);return cached.validation;}
    if(cached)this.validationCacheByPath.delete(key);
    const r=await this.processRunner(this.ffprobePath,['-v','error','-select_streams','v:0','-show_entries','stream=codec_name,codec_type','-show_entries','format=duration,size','-of','json',filePath],{timeoutMs:this.limits.ffprobeTimeoutMs,signal});
    if(r.code!==0)throw new RunnerError(`ffprobe falhou: ${String(r.stderr||'').trim().slice(-1200)}`,{code:'VERIFY_FFPROBE_FAILED'});
    let meta; try{meta=JSON.parse(r.stdout);}catch{throw new RunnerError('ffprobe não retornou JSON válido.',{code:'VERIFY_FFPROBE_INVALID_JSON'});}
    const duration=Number(meta?.format?.duration||0); const streams=Array.isArray(meta?.streams)?meta.streams:[];
    const video=streams.find(s=>s.codec_type==='video');
    if(!video || !(duration>0))throw new RunnerError('Validação falhou: sem stream de vídeo ou duração positiva.',{code:'VERIFY_NO_VIDEO_STREAM'});
    const downloadMethod=this.downloadMethodByPath.get(key)||null;
    return{size:stat.size,duration,codec:video.codec_name||null,fileFingerprint:fingerprint,...(downloadMethod?{downloadMethod}:{})};
  }

  async tryNativeDownload({ refererUrl, paths, signal=null }={}) {
    return await serializeNativeDownload(async()=>{
      if(signal?.aborted)throw new RunnerError('Download abortado.',{code:'PROCESS_ABORTED'});
      if(typeof this.pageResolver!=='function')return{attempted:false,ok:false,failureCode:'NATIVE_PAGE_RESOLVER_UNAVAILABLE'};
      const page=await this.pageResolver(refererUrl);
      if(!page||page.isClosed?.()===true||typeof page.locator!=='function'||typeof page.waitForEvent!=='function')return{attempted:false,ok:false,failureCode:'NATIVE_PAGE_UNAVAILABLE'};
      let locator;
      try{locator=page.locator(`a[href*="${VIDEO_DOWNLOAD_PATH}"]`).first();}catch{return{attempted:false,ok:false,failureCode:'NATIVE_BUTTON_UNAVAILABLE'};}
      let count=0;try{count=await locator.count();}catch{return{attempted:false,ok:false,failureCode:'NATIVE_BUTTON_UNAVAILABLE'};}
      if(count<1)return{attempted:false,ok:false,failureCode:'NATIVE_BUTTON_UNAVAILABLE'};
      let href=null;try{href=await locator.getAttribute('href');}catch{}
      const nativeDownloadUrl=normalizeNativeDownloadUrl(href,refererUrl);
      if(!nativeDownloadUrl)return{attempted:false,ok:false,failureCode:'NATIVE_BUTTON_UNTRUSTED'};

      await fs.mkdir(paths.moduleDir,{recursive:true});
      const stagingRoot=path.join(paths.moduleDir,NATIVE_STAGING_DIR);
      await cleanupStaging(stagingRoot);
      const attemptDir=path.join(stagingRoot,`n-${process.pid}-${Date.now()}`);
      await fs.mkdir(attemptDir,{recursive:true});

      let cdp=null,tracker=null,behaviorSet=false,download=null,success=false,cdpSetupError=null;
      await this.logger?.log('NATIVE_DOWNLOAD','Starting browser download',{output:paths.template,staging:stagingRoot});
      const releaseBrowserLock=await acquireNativeBrowserLock({timeoutMs:this.limits.downloadTimeoutMs+60_000,signal,logger:this.logger});
      try{
        const browser=page.context?.()?.browser?.()||null;
        if(browser&&typeof browser.newBrowserCDPSession==='function'){
          try{
            cdp=await browser.newBrowserCDPSession();
            tracker=createCdpDownloadTracker(cdp,nativeDownloadUrl,{startTimeoutMs:this.limits.nativeDownloadEventTimeoutMs,completionTimeoutMs:this.limits.downloadTimeoutMs,signal});
            await cdp.send('Browser.setDownloadBehavior',{behavior:'allowAndName',downloadPath:attemptDir,eventsEnabled:true});
            behaviorSet=true;
          }catch(error){
            cdpSetupError=error;tracker?.dispose?.();tracker=null;
            await this.logger?.log('NATIVE_DOWNLOAD','CDP download routing unavailable; using Playwright path fallback',{failureCode:'NATIVE_CDP_SETUP_FAILED',diagnosticTail:diagnosticTail(error?.message||error)});
          }
        }else{
          cdpSetupError=new RunnerError('Browser-level CDP session unavailable.',{code:'NATIVE_CDP_UNAVAILABLE'});
        }

        const playwrightDownloadPromise=page.waitForEvent('download',{timeout:this.limits.nativeDownloadEventTimeoutMs}).then(value=>({ok:true,value}),error=>({ok:false,error}));
        try{await locator.click({timeout:this.limits.nativeDownloadEventTimeoutMs,noWaitAfter:true});}
        catch(error){return{attempted:true,ok:false,failureCode:'NATIVE_DOWNLOAD_EVENT_FAILED',diagnosticTail:diagnosticTail(error?.message||error),error};}

        let sourcePath=null,suggestedFilename='',guid=null,completionMode=null;
        if(behaviorSet&&tracker){
          let started=null,startError=null;
          try{started=await tracker.started;}catch(error){startError=error;}
          if(started){
            guid=started.guid;suggestedFilename=started.suggestedFilename||'';
            try{
              const cdpCompletion=tracker.completed.then(async event=>{
                const file=path.join(attemptDir,event.guid);await waitForFile(file,{timeoutMs:5000,signal});
                return{mode:'CDP',path:file,guid:event.guid,suggestedFilename:event.suggestedFilename||started.suggestedFilename||''};
              });
              const playwrightCompletion=playwrightDownloadPromise.then(async result=>{
                // Playwright é apenas uma confirmação alternativa de sucesso. Falha desse
                // observador não pode cancelar um download que o CDP ainda acompanha.
                if(!result.ok)return await new Promise(()=>{});download=result.value;
                let browserFailure=null;try{browserFailure=await download.failure();}catch{return await new Promise(()=>{});}
                if(browserFailure)return await new Promise(()=>{});
                try{
                  const file=await withTimeout(download.path(),this.limits.downloadTimeoutMs,new RunnerError('Playwright não retornou o caminho do download a tempo.',{code:'NATIVE_DOWNLOAD_TIMEOUT'}),signal);
                  if(!file)return await new Promise(()=>{});
                  return{mode:'PLAYWRIGHT_PATH',path:file,guid,suggestedFilename:download.suggestedFilename?.()||suggestedFilename};
                }catch{return await new Promise(()=>{});}
              });
              // race (não Promise.any): cancelamento/erro CDP deve vencer imediatamente e nunca
              // ser mascarado por um caminho parcial que o Playwright eventualmente exponha.
              const completed=await Promise.race([cdpCompletion,playwrightCompletion]);
              sourcePath=completed.path;guid=completed.guid||guid;suggestedFilename=completed.suggestedFilename||suggestedFilename;completionMode=completed.mode;
            }catch(error){
              if(tracker.guid&&cdp)await cdp.send('Browser.cancelDownload',{guid:tracker.guid}).catch(()=>{});
              return{attempted:true,ok:false,failureCode:error?.code||'NATIVE_DOWNLOAD_FAILED',diagnosticTail:diagnosticTail(error?.message||error),error};
            }
          }else{
            // Browser.downloadWillBegin não chegou. A política CDP já foi aplicada, mas o
            // Playwright ainda pode provar a conclusão por download.path() sem cópia.
            const result=await playwrightDownloadPromise;
            if(!result.ok)return{attempted:true,ok:false,failureCode:startError?.code||'NATIVE_DOWNLOAD_EVENT_FAILED',diagnosticTail:diagnosticTail(startError?.message||result.error?.message||result.error),error:startError||result.error};
            download=result.value;
            let browserFailure=null;try{browserFailure=await download.failure();}catch(error){browserFailure=String(error?.message||error);}
            if(browserFailure)return{attempted:true,ok:false,failureCode:'NATIVE_DOWNLOAD_FAILED',diagnosticTail:diagnosticTail(browserFailure)};
            suggestedFilename=download.suggestedFilename?.()||'';
            try{sourcePath=await withTimeout(download.path(),this.limits.downloadTimeoutMs,new RunnerError('Playwright não retornou o caminho do download a tempo.',{code:'NATIVE_DOWNLOAD_TIMEOUT'}),signal);}catch(error){return{attempted:true,ok:false,failureCode:error?.code||startError?.code||'NATIVE_PATH_UNAVAILABLE',diagnosticTail:diagnosticTail(error?.message||error),error};}
            completionMode='PLAYWRIGHT_PATH';
          }
        }else{
          const result=await playwrightDownloadPromise;
          if(!result.ok)return{attempted:true,ok:false,failureCode:'NATIVE_DOWNLOAD_EVENT_FAILED',diagnosticTail:diagnosticTail(result.error?.message||result.error),error:result.error,cdpFailure:cdpSetupError?diagnosticTail(cdpSetupError?.message||cdpSetupError):null};
          download=result.value;
          let browserFailure=null;try{browserFailure=await download.failure();}catch(error){browserFailure=String(error?.message||error);}
          if(browserFailure)return{attempted:true,ok:false,failureCode:'NATIVE_DOWNLOAD_FAILED',diagnosticTail:diagnosticTail(browserFailure)};
          suggestedFilename=download.suggestedFilename?.()||'';
          try{sourcePath=await download.path();}catch{}
          completionMode='PLAYWRIGHT_PATH';
        }

        if(signal?.aborted)throw new RunnerError('Download abortado.',{code:'PROCESS_ABORTED'});
        const ext=safeDownloadExtension(suggestedFilename);
        let stagedPath=sourcePath;
        if(!stagedPath||!fsSync.existsSync(stagedPath)){
          if(!download){const result=await playwrightDownloadPromise;if(result.ok)download=result.value;}
          if(!download)return{attempted:true,ok:false,failureCode:'NATIVE_PATH_UNAVAILABLE',diagnosticTail:'Download concluído sem arquivo acessível.'};
          stagedPath=path.join(attemptDir,`fallback${ext}.part`);
          try{await download.saveAs(stagedPath);completionMode='PLAYWRIGHT_SAVEAS';}
          catch(error){return{attempted:true,ok:false,failureCode:'NATIVE_SAVE_FAILED',diagnosticTail:diagnosticTail(error?.message||error),error};}
        }else if(path.dirname(path.resolve(stagedPath))!==path.resolve(attemptDir)){
          const movedPath=path.join(attemptDir,`moved${ext}.part`);
          try{await fs.rename(stagedPath,movedPath);stagedPath=movedPath;completionMode='PLAYWRIGHT_RENAME';}
          catch(error){
            if(!download){const result=await playwrightDownloadPromise;if(result.ok)download=result.value;}
            if(!download)return{attempted:true,ok:false,failureCode:'NATIVE_MOVE_FAILED',diagnosticTail:diagnosticTail(error?.message||error),error};
            try{await download.saveAs(movedPath);await fs.rm(stagedPath,{force:true}).catch(()=>{});stagedPath=movedPath;completionMode='PLAYWRIGHT_SAVEAS';}
            catch(copyError){return{attempted:true,ok:false,failureCode:'NATIVE_SAVE_FAILED',diagnosticTail:diagnosticTail(copyError?.message||copyError),error:copyError};}
          }
        }

        if(/\.crdownload$/i.test(stagedPath))return{attempted:true,ok:false,failureCode:'NATIVE_DOWNLOAD_INCOMPLETE',diagnosticTail:'Arquivo .crdownload não pode ser promovido.'};
        let validation;
        try{validation=await this.validateVideo(stagedPath,{signal});}
        catch(error){return{attempted:true,ok:false,failureCode:error?.code||'NATIVE_VERIFY_FAILED',diagnosticTail:diagnosticTail(error?.message||error),error};}

        const finalPath=path.join(paths.moduleDir,`${paths.baseName}${ext}`);
        try{
          if(fsSync.existsSync(finalPath))throw new RunnerError('Arquivo final apareceu durante o download nativo.',{code:'DUPLICATE_OUTPUT_FILES'});
          await fs.rename(stagedPath,finalPath);
        }catch(error){return{attempted:true,ok:false,failureCode:error?.code||'NATIVE_PROMOTE_FAILED',diagnosticTail:diagnosticTail(error?.message||error),error};}
        const stagedKey=methodKey(stagedPath);this.validationCacheByPath.delete(stagedKey);this.downloadMethodByPath.delete(stagedKey);
        const finalKey=methodKey(finalPath);this.downloadMethodByPath.set(finalKey,'XCURSOS_NATIVE');
        const finalValidation={...validation,downloadMethod:'XCURSOS_NATIVE'};this.validationCacheByPath.set(finalKey,{fingerprint:validation.fileFingerprint,validation:finalValidation});
        success=true;
        await this.logger?.log('NATIVE_DOWNLOAD','Completed and validated',{output:finalPath,duration:validation.duration,size:validation.size,mode:completionMode,guid:guid||null});
        return{attempted:true,ok:true,finalPath,downloadMethod:'XCURSOS_NATIVE',validation:finalValidation,nativeTransport:completionMode};
      }finally{
        if(!success){try{await download?.cancel?.();}catch{}if(tracker?.guid&&cdp)await cdp.send('Browser.cancelDownload',{guid:tracker.guid}).catch(()=>{});}
        tracker?.dispose?.();
        if(behaviorSet&&cdp)await cdp.send('Browser.setDownloadBehavior',{behavior:'default'}).catch(async error=>{await this.logger?.log('NATIVE_DOWNLOAD','Failed to restore browser download behavior',{failureCode:'NATIVE_CDP_RESTORE_FAILED',diagnosticTail:diagnosticTail(error?.message||error)});});
        try{await cdp?.detach?.();}catch{}
        await cleanupStaging(stagingRoot).catch(async error=>{await this.logger?.log('NATIVE_DOWNLOAD','Staging cleanup failed',{failureCode:error?.code||'NATIVE_STAGING_CLEANUP_FAILED',diagnosticTail:diagnosticTail(error?.message||error)});});
        await releaseBrowserLock();
      }
    });
  }

  async download({ mediaUrl, refererUrl, paths, signal=null, onProgress=null, cleanStart=false }) {
    await fs.mkdir(paths.moduleDir,{recursive:true});
    if(cleanStart)await this.clearPartialArtifacts(paths.moduleDir,paths.baseName);

    let nativeFailure=null;
    const native=await this.tryNativeDownload({refererUrl,paths,signal});
    if(native.ok)return native;
    if(native.attempted){
      nativeFailure={failureCode:native.failureCode||'NATIVE_DOWNLOAD_FAILED',diagnosticTail:native.diagnosticTail||null,quarantine:native.quarantine||null};
      await this.logger?.log('NATIVE_FALLBACK','Native lesson download failed; falling back to yt-dlp',nativeFailure);
    }

    if(!/^https?:/i.test(String(mediaUrl||''))){
      const failureCode=nativeFailure?.failureCode||'MEDIA_URL_UNAVAILABLE';
      return{ok:false,kind:'FAILED',failureCode,diagnosticTail:nativeFailure?.diagnosticTail||'Nenhuma URL de mídia segura disponível para fallback yt-dlp.',...(nativeFailure?{nativeFailure}: {})};
    }

    const resumeArg=cleanStart?'--no-continue':'--continue';
    const args=['--no-playlist',resumeArg,'--no-overwrites','--retries','3','--fragment-retries','3','--referer',refererUrl,'--print','after_move:filepath','-o',paths.template,mediaUrl];
    await this.logger?.log('DOWNLOAD','Starting yt-dlp fallback',{media:redactUrl(mediaUrl),output:paths.template,cleanStart:Boolean(cleanStart),nativeAttempted:Boolean(native.attempted)});
    let r;
    const feed=chunk=>{if(!onProgress)return;for(const line of String(chunk).split(/\r?\n/)){const p=parseYtDlpProgress(line);if(p)onProgress(p);}};
    try{r=await this.processRunner(this.ytDlpPath,args,{timeoutMs:this.limits.downloadTimeoutMs,signal,onStdout:feed,onStderr:feed});}
    catch(error){
      if(error?.code==='PROCESS_ABORTED')throw error;
      const failureCode=error?.code==='PROCESS_TIMEOUT'?'PROCESS_TIMEOUT':String(error?.code||'SPAWN_ERROR');
      return {ok:false,kind:error?.code==='PROCESS_TIMEOUT'?'TIMEOUT':'SPAWN_ERROR',failureCode,diagnosticTail:diagnosticTail(error?.message||error),error,...(nativeFailure?{nativeFailure}: {})};
    }
    const combined=`${r.stdout}\n${r.stderr}`;
    if(r.code!==0){const failureCode=classifyYtDlpFailure(combined);return {ok:false,kind:failureCode==='DRM'?'DRM':looksExpired(combined)?'EXPIRED':'FAILED',failureCode,diagnosticTail:diagnosticTail(combined),code:r.code,stdout:r.stdout,stderr:r.stderr,...(nativeFailure?{nativeFailure}: {})};}
    let finalPath=r.stdout.split(/\r?\n/).map(x=>x.trim()).filter(Boolean).at(-1);
    if(!finalPath || !fsSync.existsSync(finalPath))finalPath=await this.findExistingFinal(paths.moduleDir,paths.baseName);
    if(!finalPath)return {ok:false,kind:'NO_FINAL_PATH',code:r.code,stdout:r.stdout,stderr:r.stderr,...(nativeFailure?{nativeFailure}: {})};
    this.downloadMethodByPath.set(methodKey(finalPath),'YTDLP');
    return {ok:true,finalPath,downloadMethod:'YTDLP',stdout:r.stdout,stderr:r.stderr,...(nativeFailure?{nativeFailure}: {})};
  }
}
