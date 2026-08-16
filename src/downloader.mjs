import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { DEFAULT_LIMITS, VIDEO_DOWNLOAD_PATH } from './constants.mjs';
import { RunnerError } from './errors.mjs';
import { findConnectedPageByUrl } from './browser-session.mjs';
import { normalizeNativeDownloadUrl } from './parser.mjs';
import { findExecutable, runProcess } from './process.mjs';
import { redactUrl, redactSensitiveText, sanitizeSegment, truncateWithHash } from './utils.mjs';

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

export class MediaDownloader {
  constructor({ processRunner = runProcess, logger = null, limits = {}, ytDlpPath = null, ffprobePath = null, pageResolver = findConnectedPageByUrl } = {}) {
    this.processRunner = processRunner; this.logger=logger; this.limits={...DEFAULT_LIMITS,...limits};
    this.ytDlpPath=ytDlpPath; this.ffprobePath=ffprobePath;this.pageResolver=pageResolver;this.downloadMethodByPath=new Map();
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
      const full=path.join(moduleDir,entry.name);
      try{await fs.unlink(full);removed.push(full);}catch(error){if(error?.code!=='ENOENT')throw new RunnerError(`Artefato parcial não pôde ser removido: ${entry.name}`,{code:'PARTIAL_CLEANUP_FAILED',cause:error,details:{filePath:full}});}
    }
    return removed;
  }

  async validateVideo(filePath,{signal=null}={}) {
    if (!this.ffprobePath) throw new RunnerError('ffprobe não foi inicializado; validação completa indisponível.', { code:'FFPROBE_UNAVAILABLE' });
    let stat;
    try { stat=await fs.stat(filePath); } catch { throw new RunnerError('Arquivo final não existe.',{code:'VERIFY_FILE_MISSING'}); }
    if(!stat.isFile() || stat.size<=0)throw new RunnerError('Arquivo final está vazio.',{code:'VERIFY_EMPTY_FILE'});
    const r=await this.processRunner(this.ffprobePath,['-v','error','-select_streams','v:0','-show_entries','stream=codec_name,codec_type','-show_entries','format=duration,size','-of','json',filePath],{timeoutMs:this.limits.ffprobeTimeoutMs,signal});
    if(r.code!==0)throw new RunnerError(`ffprobe falhou: ${String(r.stderr||'').trim().slice(-1200)}`,{code:'VERIFY_FFPROBE_FAILED'});
    let meta; try{meta=JSON.parse(r.stdout);}catch{throw new RunnerError('ffprobe não retornou JSON válido.',{code:'VERIFY_FFPROBE_INVALID_JSON'});}
    const duration=Number(meta?.format?.duration||0); const streams=Array.isArray(meta?.streams)?meta.streams:[];
    const video=streams.find(s=>s.codec_type==='video');
    if(!video || !(duration>0))throw new RunnerError('Validação falhou: sem stream de vídeo ou duração positiva.',{code:'VERIFY_NO_VIDEO_STREAM'});
    const downloadMethod=this.downloadMethodByPath.get(methodKey(filePath))||null;
    return { size:stat.size,duration,codec:video.codec_name||null,...(downloadMethod?{downloadMethod}:{}) };
  }

  async tryNativeDownload({ refererUrl, paths, signal=null }={}) {
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
    await this.logger?.log('NATIVE_DOWNLOAD','Starting browser download',{output:paths.template});
    let download;
    try{
      [download]=await Promise.all([
        page.waitForEvent('download',{timeout:this.limits.nativeDownloadEventTimeoutMs}),
        locator.click({timeout:this.limits.nativeDownloadEventTimeoutMs,noWaitAfter:true}),
      ]);
    }catch(error){
      return{attempted:true,ok:false,failureCode:'NATIVE_DOWNLOAD_EVENT_FAILED',diagnosticTail:diagnosticTail(error?.message||error),error};
    }
    if(signal?.aborted)throw new RunnerError('Download abortado.',{code:'PROCESS_ABORTED'});
    let browserFailure=null;try{browserFailure=await download.failure();}catch(error){browserFailure=String(error?.message||error);}
    if(browserFailure)return{attempted:true,ok:false,failureCode:'NATIVE_DOWNLOAD_FAILED',diagnosticTail:diagnosticTail(browserFailure)};

    let suggested='';try{suggested=download.suggestedFilename?.()||'';}catch{}
    const ext=safeDownloadExtension(suggested);
    const tempPath=path.join(paths.moduleDir,`${paths.baseName}.native-${process.pid}-${Date.now()}${ext}.part`);
    try{await download.saveAs(tempPath);}catch(error){
      try{await fs.rm(tempPath,{force:true});}catch{}
      return{attempted:true,ok:false,failureCode:'NATIVE_SAVE_FAILED',diagnosticTail:diagnosticTail(error?.message||error),error};
    }
    if(signal?.aborted)throw new RunnerError('Download abortado.',{code:'PROCESS_ABORTED'});

    let validation;
    try{validation=await this.validateVideo(tempPath,{signal});}
    catch(error){
      let quarantine=null;try{quarantine=await this.quarantineCorrupt(tempPath);}catch{}
      return{attempted:true,ok:false,failureCode:error?.code||'NATIVE_VERIFY_FAILED',diagnosticTail:diagnosticTail(error?.message||error),quarantine,error};
    }

    const finalPath=path.join(paths.moduleDir,`${paths.baseName}${ext}`);
    try{
      if(fsSync.existsSync(finalPath))throw new RunnerError('Arquivo final apareceu durante o download nativo.',{code:'DUPLICATE_OUTPUT_FILES'});
      await fs.rename(tempPath,finalPath);
    }catch(error){
      try{await fs.rm(tempPath,{force:true});}catch{}
      return{attempted:true,ok:false,failureCode:error?.code||'NATIVE_PROMOTE_FAILED',diagnosticTail:diagnosticTail(error?.message||error),error};
    }
    this.downloadMethodByPath.set(methodKey(finalPath),'XCURSOS_NATIVE');
    await this.logger?.log('NATIVE_DOWNLOAD','Completed and validated',{output:finalPath,duration:validation.duration,size:validation.size});
    return{attempted:true,ok:true,finalPath,downloadMethod:'XCURSOS_NATIVE',validation:{...validation,downloadMethod:'XCURSOS_NATIVE'}};
  }

  async download({ mediaUrl, refererUrl, paths, signal=null, onProgress=null, cleanStart=false }) {
    await fs.mkdir(paths.moduleDir,{recursive:true});
    if(cleanStart)await this.clearPartialArtifacts(paths.moduleDir,paths.baseName);
    const resumeArg=cleanStart?'--no-continue':'--continue';
    const args=['--no-playlist',resumeArg,'--no-overwrites','--retries','3','--fragment-retries','3','--referer',refererUrl,'--print','after_move:filepath','-o',paths.template,mediaUrl];
    await this.logger?.log('DOWNLOAD','Starting',{media:redactUrl(mediaUrl),output:paths.template,cleanStart:Boolean(cleanStart)});
    let r;
    const feed=chunk=>{if(!onProgress)return;for(const line of String(chunk).split(/\r?\n/)){const p=parseYtDlpProgress(line);if(p)onProgress(p);}};
    try{r=await this.processRunner(this.ytDlpPath,args,{timeoutMs:this.limits.downloadTimeoutMs,signal,onStdout:feed,onStderr:feed});}
    catch(error){
      if(error?.code==='PROCESS_ABORTED')throw error;
      const failureCode=error?.code==='PROCESS_TIMEOUT'?'PROCESS_TIMEOUT':String(error?.code||'SPAWN_ERROR');
      return {ok:false,kind:error?.code==='PROCESS_TIMEOUT'?'TIMEOUT':'SPAWN_ERROR',failureCode,diagnosticTail:diagnosticTail(error?.message||error),error};
    }
    const combined=`${r.stdout}\n${r.stderr}`;
    if(r.code!==0){const failureCode=classifyYtDlpFailure(combined);return {ok:false,kind:failureCode==='DRM'?'DRM':looksExpired(combined)?'EXPIRED':'FAILED',failureCode,diagnosticTail:diagnosticTail(combined),code:r.code,stdout:r.stdout,stderr:r.stderr};}
    let finalPath=r.stdout.split(/\r?\n/).map(x=>x.trim()).filter(Boolean).at(-1);
    if(!finalPath || !fsSync.existsSync(finalPath))finalPath=await this.findExistingFinal(paths.moduleDir,paths.baseName);
    if(!finalPath)return {ok:false,kind:'NO_FINAL_PATH',code:r.code,stdout:r.stdout,stderr:r.stderr};
    this.downloadMethodByPath.set(methodKey(finalPath),'YTDLP');
    return {ok:true,finalPath,downloadMethod:'YTDLP',stdout:r.stdout,stderr:r.stderr};
  }
}
