import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { DEFAULT_LIMITS, RETRYABLE_FAILURE_STATUSES } from './constants.mjs';
import { RunnerError } from './errors.mjs';
import { BrowserSession, isTargetClosedError } from './browser-session.mjs';
import { PageController } from './page-controller.mjs';
import { MediaDownloader } from './downloader.mjs';
import { RunnerLogger } from './logger.mjs';
import { StateStore, discoverRecentState, summarizeAudit } from './state.mjs';
import { sanitizeForPersistence, sanitizeSegment, safeError, sleep } from './utils.mjs';
import { LessonScheduler } from './lesson-scheduler.mjs';
import { RetryPolicy } from './retry-policy.mjs';
import { DurableSchedulerCheckpoint } from './scheduler-checkpoint.mjs';
import { RuntimeStats } from './runtime-stats.mjs';
import { AutoThrottle } from './auto-throttle.mjs';
import { GracefulShutdownController } from './shutdown-controller.mjs';
import { DebugSnapshotManager } from './debug-snapshots.mjs';
import { NavigationIndex } from './navigation-index.mjs';
import { NavigationPlanner } from './navigation-planner.mjs';
import { correlateMediaObjects } from './network-media-observer.mjs';
import { isSafeDownloadMedia } from './parser.mjs';

function sameCourse(a,b){return String(a||'').trim().toLocaleLowerCase()===String(b||'').trim().toLocaleLowerCase();}
const REFRESHABLE_SIGNED_MEDIA_FAILURES=new Set(['HTTP_403','HTTP_429','HTTP_5XX','NETWORK_RESET','NETWORK_TIMEOUT','DNS_ERROR','TLS_ERROR','PROCESS_TIMEOUT','YTDLP_FAILED']);
function shouldRefreshSignedMedia(dl,lesson){return Boolean(lesson?.isSignedDirectMp4&&lesson?.mediaType==='DIRECT_MP4'&&(dl?.kind==='EXPIRED'||REFRESHABLE_SIGNED_MEDIA_FAILURES.has(String(dl?.failureCode||''))));}
function failureSummary(records=[]){
  const map=new Map();
  for(const rec of records){const code=rec?.failureCode||rec?.status||'UNKNOWN';let entry=map.get(code);if(!entry){entry={code,count:0,positions:[]};map.set(code,entry);}entry.count++;entry.positions.push(rec.position);}
  return [...map.values()].map(x=>({...x,positions:x.positions.sort((a,b)=>a-b)})).sort((a,b)=>String(a.code).localeCompare(String(b.code)));
}
function retryDelayText(ms){const n=Math.max(0,Number(ms)||0);if(n<1000)return`${Math.round(n)}ms`;const seconds=n/1000;return`${Number.isInteger(seconds)?seconds:seconds.toFixed(1)}s`;}
function shortRetryDetail(value=''){const text=String(value||'').replace(/\s+/g,' ').trim();return text?text.slice(0,140):null;}
export function formatRetryProgress({position,total,causeCode='UNKNOWN',detail=null,attempt=1,maxAttempts=1,delayMs=0,retry=true}={}){
  const base=`[RETRY] ${position}/${total} | ${causeCode}${detail?` | ${detail}`:''} | tentativa ${attempt}/${maxAttempts}`;
  return retry?`${base} | retry em ${retryDelayText(delayMs)}`:`${base} | orçamento esgotado`;
}

export class XCursosCourseRunner {
  constructor({ profileDir=null, cdpEndpoint='http://127.0.0.1:9222', startUrl=null, headless=false, outputRoot=null, browser=null, browserSession=null, pageController=null, downloader=null, logger=null, limits={}, playwrightLoader=null, retryPolicy=null, schedulerFactory=null, sleepFn=sleep, runtimeStats=null, autoThrottle=null, shutdownController=null, progressSink=null, enableSignalHandlers=false, debugSnapshots=null }={}) {
    this.profileDir=profileDir; this.cdpEndpoint=cdpEndpoint; this.startUrl=startUrl; this.headless=headless;
    this.outputRoot=outputRoot || path.join(os.homedir(),'Downloads','Cursos');
    this.limits={...DEFAULT_LIMITS,...limits};
    this.logger=logger || new RunnerLogger();
    this.runtimeStats=runtimeStats || new RuntimeStats({total:0});
    this.browserSession=browserSession || (!browser && !pageController ? new BrowserSession({cdpEndpoint,logger:this.logger,limits:this.limits,playwrightLoader,runtimeStats:this.runtimeStats}) : null);
    this.pageController=pageController || browser || new PageController({session:this.browserSession,logger:this.logger,limits:this.limits});
    this.browser=this.pageController;
    this.downloader=downloader || new MediaDownloader({logger:this.logger,limits:this.limits});
    this.retryPolicy=retryPolicy || new RetryPolicy({baseDelayMs:this.limits.retryBaseDelayMs,maxDelayMs:this.limits.retryMaxDelayMs,maxAttempts:Math.max(1,Number(this.limits.downloadRetries||0)+1),jitterRatio:this.limits.retryJitterRatio});
    this.schedulerFactory=schedulerFactory || (opts=>new LessonScheduler(opts));
    this.sleepFn=sleepFn;this.autoThrottle=autoThrottle||new AutoThrottle({minDelayMs:this.limits.throttleMinDelayMs,maxDelayMs:this.limits.throttleMaxDelayMs,sleepFn});
    this.shutdown=shutdownController||new GracefulShutdownController();this.enableSignalHandlers=enableSignalHandlers;this.progressSink=progressSink;this.debugSnapshots=debugSnapshots||null;
    this.scheduler=null;this.schedulerCheckpoint=null;this.navigationIndex=null;this.navigationPlanner=new NavigationPlanner();
    this.state=null; this.workPage=null; this.courseName=null; this.total=null; this.repairPositions=new Set();
  }

  async boot({ resume=true, requireDownloader=true }={}) {
    if(requireDownloader) await this.downloader.preflight();
    await this.browser.connect();
    let chosen;
    try { chosen=await this.browser.chooseWorkingPage({preferredUrl:this.startUrl||null}); }
    catch(error){
      if(!resume)throw error;
      const recent=await discoverRecentState(this.outputRoot);
      if(!recent?.state?.workPageUrl)throw error;
      await this.logger.log('RECOVERY','No live XCursos page; recovering recent RUNNING state',{course:recent.state.courseName});
      chosen=await this.browser.chooseWorkingPage({preferredUrl:this.startUrl||recent.state.workPageUrl});
    }
    this.workPage=chosen.page;
    const lesson=chosen.lesson || await this.browser.inspectLesson(this.workPage);
    if(!lesson.courseName || lesson.courseName==='Curso XCursos')throw new RunnerError('Não foi possível identificar o nome real do curso.',{code:'COURSE_NAME_MISSING'});
    if(!Number.isInteger(lesson.totalPositions)||lesson.totalPositions<1)throw new RunnerError('Contador TOTAL do curso não foi identificado.',{code:'TOTAL_MISSING'});
    this.courseName=lesson.courseName; this.total=lesson.totalPositions;this.runtimeStats.setTotal(this.total);
    this.state=new StateStore({outputRoot:this.outputRoot,courseName:this.courseName,totalPositions:this.total,logger:this.logger});
    this.logger.logFile=this.state.logPath;
    if(!this.debugSnapshots)this.debugSnapshots=new DebugSnapshotManager({debugRoot:path.join(this.state.metaDir,'debug'),logger:this.logger});
    if(requireDownloader) await this.state.acquireRunLock();
    try {
      await this.state.initialize({resume,workPageUrl:lesson.pageUrl || this.workPage.url});
    } catch(error) {
      if(requireDownloader) await this.state.releaseRunLock().catch(()=>{});
      throw error;
    }
    await this.state.setWorkPage(lesson.pageUrl || this.workPage.url);
    this.navigationIndex=new NavigationIndex({filePath:this.state.navigationPath,courseName:this.courseName,totalPositions:this.total,logger:this.logger});
    await this.navigationIndex.load();
    await this.navigationIndex.recordMany(this.state.manifestRecords);
    await this.rememberNavigation(lesson);
    const invalidFiles=requireDownloader?await this.state.verifyFileBackedEntries(f=>this.downloader.validateVideo(f)):[];
    this.repairPositions=new Set(invalidFiles);
    const validExistingEntries=[...this.state.manifestIndex.entries()].filter(([position])=>!this.repairPositions.has(position));
    const validExisting=validExistingEntries.map(([,rec])=>rec);
    this.runtimeStats.seed({
      completedPositions:validExistingEntries.map(([position])=>position),
      healthyPositions:validExistingEntries.filter(([,rec])=>!['DRM_PROTECTED'].includes(rec.status)).map(([position])=>position),
      downloadedPositions:validExistingEntries.filter(([,rec])=>['DOWNLOADED','ALREADY_PRESENT'].includes(rec.status)).map(([position])=>position),
    });
    for(const position of invalidFiles)await this.state.appendError({scope:'STATE',position,status:'FILE_INCONSISTENCY',message:'Manifesto aponta arquivo final ausente ou inválido; posição será reparada.'});
    await this.logger.log('BOOT',`Course detected: ${this.courseName}`,{current:lesson.currentPosition,total:this.total,repairs:invalidFiles});
    return lesson;
  }

  nextPending({start=1,end=this.total}={}){
    for(let p=Math.max(1,start);p<=Math.min(end,this.total);p++)if(this.repairPositions.has(p)||!this.state.hasTerminal(p))return p;
    return null;
  }

  async rememberNavigation(lesson){
    if(!this.navigationIndex||!lesson)return false;
    return await this.navigationIndex.record(lesson.currentPosition,lesson.pageUrl||this.workPage?.url);
  }

  canWalkForward(fromPosition,targetPosition){
    const from=Number(fromPosition),target=Number(targetPosition);
    return Number.isInteger(from)&&Number.isInteger(target)&&from>=1&&target<=this.total&&target>from;
  }

  async moveOneConfirmed(fromPosition,toPosition){
    if(toPosition!==fromPosition+1)throw new RunnerError(`Transição não adjacente recusada: ${fromPosition} → ${toPosition}.`,{code:'NAV_NON_ADJACENT'});
    let next;
    if(typeof this.browser.navigateNext==='function'){
      const moved=await this.browser.navigateNext(this.workPage,{fromPosition,target:toPosition});this.workPage=moved.page||this.workPage;next=moved.lesson;
    }else{
      await this.browser.clickNext(this.workPage);next=await this.browser.waitForPosition(this.workPage,toPosition,{timeoutMs:this.limits.transitionTimeoutMs,pollMs:this.limits.transitionPollMs});
    }
    if(next?.currentPosition!==toPosition)throw new RunnerError(`Transição observou ${next?.currentPosition}, esperada ${toPosition}.`,{code:'POSITION_MISMATCH'});
    if(!sameCourse(next?.courseName,this.courseName))throw new RunnerError(`Reposicionamento mudou para outro curso: ${next?.courseName}`,{code:'COURSE_IDENTITY_MISMATCH',details:{fromPosition,toPosition,observedCourse:next?.courseName,expectedCourse:this.courseName}});
    if(Number(next?.totalPositions)!==Number(this.total))throw new RunnerError(`TOTAL mudou durante reposicionamento: ${next?.totalPositions}; esperado ${this.total}.`,{code:'TOTAL_CHANGED',details:{fromPosition,toPosition,observedTotal:next?.totalPositions,expectedTotal:this.total}});
    await this.state.setWorkPage(next.pageUrl||this.workPage.url);
    await this.rememberNavigation(next);
    this.runtimeStats.recordRepositionStep?.();
    await this.repositionLog(`${fromPosition} → ${toPosition} confirmed`,{downloadState:this.state.hasTerminal(toPosition)?'TERMINAL':'MISSING'});
    return next;
  }

  async walkForwardConfirmed(fromPosition,targetPosition){
    if(!this.canWalkForward(fromPosition,targetPosition))throw new RunnerError(`Caminhada navegacional inválida: ${fromPosition} → ${targetPosition}.`,{code:'NAV_WALK_INVALID'});
    let lesson=null;
    for(let p=fromPosition;p<targetPosition;p++)lesson=await this.moveOneConfirmed(p,p+1);
    return lesson;
  }

  findNearestKnownCheckpoint(targetPosition){
    return this.navigationIndex?.nearestBefore(targetPosition) || null;
  }

  assertRepositionIdentity(lesson,{expectedPosition=null,strategy=null}={}){
    if(!lesson)throw new RunnerError('Inspeção de reposicionamento não retornou aula.',{code:'REPOSITION_INSPECTION_EMPTY',details:{strategy,expectedPosition}});
    if(!sameCourse(lesson.courseName,this.courseName))throw new RunnerError(`Reposicionamento abriu outro curso: ${lesson.courseName}`,{code:'COURSE_IDENTITY_MISMATCH',details:{strategy,expectedCourse:this.courseName,observedCourse:lesson.courseName,expectedPosition,observedPosition:lesson.currentPosition}});
    if(Number(lesson.totalPositions)!==Number(this.total))throw new RunnerError(`TOTAL mudou durante reposicionamento: ${lesson.totalPositions}; esperado ${this.total}.`,{code:'TOTAL_CHANGED',details:{strategy,expectedTotal:this.total,observedTotal:lesson.totalPositions,expectedPosition,observedPosition:lesson.currentPosition}});
    return lesson;
  }

  async repositionLog(message,data=null){
    await this.logger.log('REPOSITION',message,data||undefined);
    const suffix=data?` ${Object.entries(data).filter(([,v])=>v!=null).map(([k,v])=>`${k}=${typeof v==='object'?JSON.stringify(v):v}`).join(' ')}`:'';
    this.progressSink?.(`[REPOSITION] ${message}${suffix}`);
  }

  async reportRetry({position,decision,code=null,status=null,failureCode=null,networkCode=null,message=null}={}){
    const causeCode=String(failureCode||code||status||'UNKNOWN');
    let detail=networkCode||null;
    if(!detail&&message){const short=shortRetryDetail(message);if(short&&!short.toUpperCase().includes(causeCode.toUpperCase()))detail=short;}
    const line=formatRetryProgress({position,total:this.total,causeCode,detail,attempt:decision.attempt,maxAttempts:decision.maxAttempts,delayMs:decision.delayMs,retry:decision.retry});
    const data={position,total:this.total,causeCode,status:status||null,failureCode:failureCode||null,networkCode:networkCode||null,attempt:decision.attempt,maxAttempts:decision.maxAttempts,delayMs:decision.delayMs,classification:decision.classification,retry:decision.retry};
    await this.logger.log('RETRY',line.replace(/^\[RETRY\]\s*/,''),data);
    this.progressSink?.(line);
    return{line,data};
  }

  repositionDiagnostics({currentPosition=null,targetPosition,strategiesTried=[],exactTargetUrl=null,checkpoint=null,courseAnchor=null}={}){
    const missing=[];for(let p=1;p<Number(targetPosition);p++)if(!this.state?.hasTerminal?.(p))missing.push(p);
    return {
      currentPosition:currentPosition??null,targetPosition:Number(targetPosition),total:this.total,
      exactTargetUrl:Boolean(exactTargetUrl),nearestCheckpoint:checkpoint?{position:checkpoint.position}:null,
      courseAnchor:courseAnchor?{available:true,position:courseAnchor.position}:{available:false,position:null},
      navigationIndexEntries:this.navigationIndex?.entries?.().length||0,
      repairPositions:[...this.repairPositions].sort((a,b)=>a-b),missingPositions:missing,
      strategiesTried:[...strategiesTried],
    };
  }

  async inspectRepositionPage({expectedPosition=null,strategy=null,indexedPosition=null}={}){
    const lesson=await this.browser.inspectLesson(this.workPage);
    this.assertRepositionIdentity(lesson,{expectedPosition,strategy});
    await this.rememberNavigation(lesson);
    if(expectedPosition!=null && Number(lesson.currentPosition)!==Number(expectedPosition)){
      if(indexedPosition!=null)await this.navigationIndex?.invalidate?.(indexedPosition,{reason:'POSITION_MISMATCH',observedPosition:lesson.currentPosition});
      return {stale:true,lesson};
    }
    await this.state.setWorkPage(lesson.pageUrl||this.workPage.url);
    return {stale:false,lesson};
  }

  async openRepositionReference({position,url,strategy}={}){
    await this.repositionLog(`opening ${strategy}`,{position});
    this.workPage=await this.browser.navigateExact(this.workPage,url);
    return await this.inspectRepositionPage({expectedPosition:position,strategy,indexedPosition:position});
  }

  async ensurePageAt(position,{lessonUrl=null}={}){
    const target=Number(position);if(!Number.isInteger(target)||target<1||target>this.total)throw new RunnerError(`Posição de reposicionamento inválida: ${position}.`,{code:'RANGE_INVALID'});
    const strategiesTried=[];let explicitAllowed=Boolean(lessonUrl);let exactIndexAllowed=true;let current=null;
    const budget=Math.max(6,(this.navigationIndex?.entries?.().length||0)+6);
    for(let iteration=0;iteration<budget;iteration++){
      current=await this.browser.inspectLesson(this.workPage);
      this.assertRepositionIdentity(current,{strategy:'CURRENT_PAGE'});await this.rememberNavigation(current);
      const indexExact=exactIndexAllowed?this.navigationIndex?.get(target):null;
      const stateExact=this.state.get(target)?.lessonUrl||null;
      const exactTargetUrl=explicitAllowed&&lessonUrl?lessonUrl:(indexExact||stateExact||null);
      const exactSource=explicitAllowed&&lessonUrl?'EXPLICIT':(indexExact?'INDEX':(stateExact?'STATE':null));
      const checkpoint=this.findNearestKnownCheckpoint(target);
      const courseAnchor=this.navigationIndex?.anchor?.()||null;
      const plan=this.navigationPlanner.plan({currentPosition:current.currentPosition,targetPosition:target,total:this.total,exactTargetUrl,checkpoint,courseAnchor});
      strategiesTried.push(plan.strategy);await this.repositionLog(`current=${current.currentPosition} target=${target} strategy=${plan.strategy}`);

      if(plan.strategy==='ALREADY_AT_TARGET'){
        await this.state.setWorkPage(current.pageUrl||this.workPage.url);return current;
      }
      if(plan.strategy==='EXACT_URL'){
        this.workPage=await this.browser.navigateExact(this.workPage,plan.url);
        const observed=await this.inspectRepositionPage({expectedPosition:target,strategy:'EXACT_URL',indexedPosition:exactSource==='INDEX'?target:null});
        if(!observed.stale)return observed.lesson;
        await this.repositionLog('exact target URL is stale; replanning',{expected:target,observed:observed.lesson.currentPosition,source:exactSource});
        if(exactSource==='EXPLICIT')explicitAllowed=false;
        if(exactSource==='INDEX')exactIndexAllowed=false;
        if(exactSource==='STATE')explicitAllowed=false;
        continue;
      }
      if(plan.strategy==='WALK_FROM_CURRENT'){
        return await this.walkForwardConfirmed(plan.fromPosition,target);
      }
      if(plan.strategy==='WALK_FROM_CHECKPOINT'){
        const opened=await this.openRepositionReference({position:plan.checkpoint.position,url:plan.checkpoint.url,strategy:'CHECKPOINT'});
        if(opened.stale){await this.repositionLog('checkpoint is stale; replanning',{expected:plan.checkpoint.position,observed:opened.lesson.currentPosition});continue;}
        return await this.walkForwardConfirmed(plan.checkpoint.position,target);
      }
      if(plan.strategy==='WALK_FROM_COURSE_ANCHOR'){
        const opened=await this.openRepositionReference({position:plan.anchor.position,url:plan.anchor.url,strategy:'COURSE_ANCHOR'});
        if(opened.stale){await this.repositionLog('course anchor is stale; replanning',{expected:plan.anchor.position,observed:opened.lesson.currentPosition});continue;}
        return await this.walkForwardConfirmed(plan.anchor.position,target);
      }
      const details=this.repositionDiagnostics({currentPosition:current.currentPosition,targetPosition:target,strategiesTried,exactTargetUrl,checkpoint,courseAnchor});
      throw new RunnerError(`Nenhum caminho de reposicionamento comprovável para ${current.currentPosition} → ${target}.`,{code:'POSITION_REPOSITION_NO_SAFE_PATH',details});
    }
    const checkpoint=this.findNearestKnownCheckpoint(target),courseAnchor=this.navigationIndex?.anchor?.()||null;
    throw new RunnerError(`Budget de reposicionamento esgotado para target ${target}.`,{code:'POSITION_REPOSITION_NO_SAFE_PATH',details:this.repositionDiagnostics({currentPosition:current?.currentPosition??null,targetPosition:target,strategiesTried,checkpoint,courseAnchor})});
  }

  shouldWaitForMedia(lesson){
    if(isSafeDownloadMedia(lesson))return false;
    return Boolean(typeof this.browser.waitForMediaReady==='function'||lesson?.hasVideoElement||lesson?.hasTrustedPlayerIframe||lesson?.hasUntrustedIframe||lesson?.mediaNotReady);
  }

  assertLessonIdentity(lesson,position,{context='MEDIA'}={}){
    if(!lesson)throw new RunnerError('A inspeção da aula não retornou metadata.',{code:'LESSON_INSPECT_FAILED',details:{position,context}});
    if(Number(lesson.currentPosition)!==Number(position))throw new RunnerError(`Posição observada ${lesson.currentPosition}, esperada ${position}.`,{code:'POSITION_MISMATCH',details:{position,observed:lesson.currentPosition,context}});
    if(!sameCourse(lesson.courseName,this.courseName))throw new RunnerError(`Página mudou para outro curso: ${lesson.courseName}`,{code:'COURSE_IDENTITY_MISMATCH',details:{position,context}});
    if(Number(lesson.totalPositions)!==Number(this.total))throw new RunnerError(`TOTAL mudou de ${this.total} para ${lesson.totalPositions}.`,{code:'TOTAL_CHANGED',details:{position,context}});
    return lesson;
  }

  async waitForProvenMedia(initialLesson,{position,force=false}={}){
    let lesson=this.assertLessonIdentity(initialLesson,position,{context:'MEDIA_READY_INITIAL'});
    if(isSafeDownloadMedia(lesson))return lesson;
    if(!force&&!this.shouldWaitForMedia(lesson))return lesson;

    if(typeof this.browser.waitForMediaReady==='function'){
      const supplied=await this.browser.waitForMediaReady(this.workPage,{position,timeoutMs:this.limits.mediaReadyTimeoutMs,pollMs:this.limits.mediaReadyPollMs});
      if(supplied){lesson=this.assertLessonIdentity(supplied,position,{context:'MEDIA_READY_BROWSER'});if(isSafeDownloadMedia(lesson))return lesson;}
    }

    const timeout=Math.max(0,Number(this.limits.mediaReadyTimeoutMs)||0);
    const poll=Math.max(1,Number(this.limits.mediaReadyPollMs)||250);
    const deadline=Date.now()+timeout;
    while(Date.now()<deadline){
      await this.sleepFn(Math.min(poll,Math.max(1,deadline-Date.now())));
      lesson=this.assertLessonIdentity(await this.browser.inspectLesson(this.workPage),position,{context:'MEDIA_READY_POLL'});
      if(isSafeDownloadMedia(lesson))return lesson;
    }
    return {...lesson,mediaNotReady:true};
  }

  async refreshMediaForPosition(position,lesson,{failureCode='UNKNOWN'}={}){
    const previousMediaUrl=lesson?.videoUrl||null;
    this.runtimeStats.recordMediaRefresh();
    await this.logger.log('RECOVERY','Refreshing same lesson media',{position,failureCode});
    const refreshedPage=await this.browser.refreshSameLesson(this.workPage);
    if(!refreshedPage)return null;
    this.workPage=refreshedPage;
    let refreshed=this.assertLessonIdentity(await this.browser.inspectLesson(this.workPage),position,{context:'MEDIA_REFRESH'});
    refreshed=await this.waitForProvenMedia(refreshed,{position,force:true});
    if(!isSafeDownloadMedia(refreshed)||!refreshed.videoUrl)return null;
    if(previousMediaUrl){
      const correlation=correlateMediaObjects(previousMediaUrl,refreshed.videoUrl);
      if(correlation.comparable&&!correlation.sameObject)throw new RunnerError('Refresh de mídia apontou para outro objeto de vídeo.',{code:'MEDIA_REFRESH_OBJECT_CHANGED',details:{position,previousObjectFingerprint:correlation.networkObjectFingerprint,refreshedObjectFingerprint:correlation.liveObjectFingerprint}});
    }
    return refreshed;
  }

  async processPosition(position){
    let existing=this.state.get(position); const repair=this.repairPositions.has(position);
    if(existing && RETRYABLE_FAILURE_STATUSES.has(existing.status))existing=null;
    if(existing && !repair){await this.logger.log(`LESSON ${position}/${this.total}`,'Already terminal; skipping',{status:existing.status});return {status:existing.status,skipped:true,page:this.workPage,lesson:null,outputFile:existing.outputFile||null,validation:existing.validation||null};}
    let lesson=this.assertLessonIdentity(await this.ensurePageAt(position),position,{context:'PROCESS_POSITION'});
    lesson=await this.waitForProvenMedia(lesson,{position});
    this.assertLessonIdentity(lesson,position,{context:'PROCESS_MEDIA_READY'});
    await this.rememberNavigation(lesson);
    await this.logger.log(`LESSON ${position}/${this.total}`,'Inspecting',{lesson:lesson.lessonTitle,module:lesson.moduleName,mediaType:lesson.mediaType,mediaSourceConfidence:lesson.mediaSourceConfidence||null});

    let paths=this.downloader.buildPaths({root:this.outputRoot,courseName:this.courseName,moduleName:lesson.moduleName,modulePath:lesson.modulePath,lessonTitle:lesson.lessonTitle,position,total:this.total});
    if(repair && existing?.outputFile){const parsed=path.parse(existing.outputFile);paths={...paths,moduleDir:parsed.dir,baseName:parsed.name,template:path.join(parsed.dir,`${parsed.name}.%(ext)s`) };}
    else {
      const inFlight=this.state.getInFlight(position);
      if(inFlight?.relativeOutputBase){
        const base=this.state.resolveInFlightBase(inFlight);
        const parsed=path.parse(base);
        paths={...paths,moduleDir:parsed.dir,baseName:parsed.base,template:path.join(parsed.dir,`${parsed.base}.%(ext)s`)};
      }
    }
    let attempts=0, status, outputFile=null, validation=null, downloadFailure=null, verifyFailureCode=null;

    if(lesson.drmDetected && (!lesson.videoUrl || ['HLS','DASH'].includes(lesson.mediaType))){status='DRM_PROTECTED';await this.logger.log(`LESSON ${position}/${this.total}`,'DRM marker detected; no bypass attempted');}
    else if(!isSafeDownloadMedia(lesson)) {
      if(this.shouldWaitForMedia(lesson)||lesson.videoUrl){
        status='MEDIA_NOT_READY';verifyFailureCode='MEDIA_NOT_READY';
        await this.state.appendError({scope:'MEDIA',position,status,message:'A página da aula carregou, mas nenhuma mídia comprovada ficou pronta dentro da janela segura.',mediaType:lesson.mediaType||'NONE',mediaSourceConfidence:lesson.mediaSourceConfidence||'UNTRUSTED',mediaDiagnostics:this.browser.mediaDiagnostics?.(this.workPage)||null});
      }else{
        status=lesson.hasMaterialsLinks?'NO_VIDEO':'MEDIA_NOT_FOUND';
      }
      await this.logger.log(`LESSON ${position}/${this.total}`,'No proven downloadable lesson media found',{status,mediaType:lesson.mediaType||'NONE'});
    }
    else {
      await fs.mkdir(paths.moduleDir,{recursive:true});
      if(!repair && !this.state.getInFlight(position)){
        await this.state.setInFlight({position,lessonTitle:lesson.lessonTitle,moduleName:lesson.moduleName,modulePath:lesson.modulePath,lessonTitle:lesson.lessonTitle,lessonUrl:lesson.pageUrl||this.workPage.url,relativeOutputBase:path.relative(this.state.courseDir,path.join(paths.moduleDir,paths.baseName))});
      }
      let existingFile=await this.downloader.findExistingFinal(paths.moduleDir,paths.baseName);
      if(existingFile){
        try{validation=await this.downloader.validateVideo(existingFile,{signal:this.shutdown.signal});status='ALREADY_PRESENT';outputFile=existingFile;await this.logger.log('VERIFY','Existing file valid',{position,duration:validation.duration});}
        catch(error){
          let quarantine;
          if(typeof this.downloader.quarantineCorrupt==='function') quarantine=await this.downloader.quarantineCorrupt(existingFile);
          else {quarantine=`${existingFile}.corrupt-${Date.now()}`;try{await fs.rename(existingFile,quarantine);}catch(renameError){throw new RunnerError(`Falha ao isolar arquivo corrompido: ${existingFile}`,{code:'CORRUPT_FILE_QUARANTINE_FAILED',cause:renameError});}}
          await this.state.appendError({scope:'VERIFY',position,status:'CORRUPT_EXISTING_FILE',failureCode:error?.code||null,message:String(error?.message||error),quarantine});
          existingFile=null;
        }
      }
      if(!status){
        let lastProgressBucket=-1;
        const executeDownload=async({cleanStart=false}={})=>{attempts++;return await this.downloader.download({mediaUrl:lesson.videoUrl,refererUrl:lesson.pageUrl||this.workPage.url,paths,signal:this.shutdown.signal,cleanStart,onProgress:p=>{this.runtimeStats.recordDownloadProgress({speed:p.speedText});const bucket=Math.floor((p.percent||0)/5);if(bucket!==lastProgressBucket){lastProgressBucket=bucket;this.progressSink?.(`[DOWNLOAD ${position}/${this.total}] ${Number(p.percent||0).toFixed(1)}%${p.speedText?` @ ${p.speedText}`:''}${p.eta?` ETA ${p.eta}`:''}`);}}});};
        let refreshAttempts=0;let cleanStart=false;
        while(!status){
          const dl=await executeDownload({cleanStart});cleanStart=false;
          if(!dl.ok){
            downloadFailure=dl;verifyFailureCode=null;
            if(shouldRefreshSignedMedia(dl,lesson)&&refreshAttempts<this.limits.mediaRefreshRetries){
              refreshAttempts++;
              const refreshed=await this.refreshMediaForPosition(position,lesson,{failureCode:dl.failureCode||dl.kind});
              if(refreshed){lesson=refreshed;continue;}
            }
            status=dl.kind==='DRM'?'DRM_PROTECTED':'DOWNLOAD_FAILED';
            await this.state.appendError({scope:'DOWNLOAD',position,status,message:`yt-dlp: ${dl.kind}`,failureCode:dl.failureCode||null,exitCode:dl.code??null,diagnosticTail:dl.diagnosticTail||null,mediaDiagnostics:this.browser.mediaDiagnostics?.(this.workPage)||null});
            await this.logger.log('DOWNLOAD','Download failed',{position,status,failureCode:dl.failureCode||null,diagnosticTail:dl.diagnosticTail||null});
            break;
          }

          downloadFailure=null;outputFile=dl.finalPath;
          try{
            validation=await this.downloader.validateVideo(outputFile,{signal:this.shutdown.signal});status='DOWNLOADED';verifyFailureCode=null;
            await this.logger.log('VERIFY',`ffprobe OK — ${Math.round(validation.duration)}s`,{position,size:validation.size,codec:validation.codec});
          }catch(error){
            verifyFailureCode=String(error?.code||'VERIFY_FAILED');
            let quarantine=null;try{quarantine=await this.downloader.quarantineCorrupt(outputFile);}catch{}
            await this.state.appendError({scope:'VERIFY',position,status:'VERIFY_FAILED',failureCode:verifyFailureCode,message:String(error?.message||error),outputFile,quarantine,mediaDiagnostics:this.browser.mediaDiagnostics?.(this.workPage)||null});
            outputFile=null;validation=null;
            if(lesson.isSignedDirectMp4&&lesson.mediaType==='DIRECT_MP4'&&refreshAttempts<this.limits.mediaRefreshRetries){
              refreshAttempts++;
              const refreshed=await this.refreshMediaForPosition(position,lesson,{failureCode:verifyFailureCode});
              if(refreshed){lesson=refreshed;cleanStart=true;continue;}
            }
            status='VERIFY_FAILED';
          }
        }
      }
    }

    if(RETRYABLE_FAILURE_STATUSES.has(status)){
      const failureCode=downloadFailure?.failureCode||verifyFailureCode||null;
      await this.state.clearInFlight(position);
      await this.state.setWorkPage(lesson.pageUrl||this.workPage.url);
      await this.logger.log('RETRYABLE',`Position ${position} remains pending`,{status,failureCode});
      return {status,skipped:false,retryable:true,retryError:{code:status,failureCode},failureCode,page:this.workPage,lesson,outputFile:null,validation:null};
    }

    if(repair && existing){
      if(status==='DOWNLOADED' || status==='ALREADY_PRESENT'){
        this.repairPositions.delete(position); await this.state.appendError({scope:'STATE',position,status:'FILE_REPAIRED',message:'Arquivo restaurado e validado; manifesto original preservado.'});
      } else {
        throw new RunnerError(`Reparo da posição ${position} falhou com ${status}.`,{code:'REPAIR_FAILED'});
      }
    } else {
      await this.state.commit({position,lessonTitle:lesson.lessonTitle,moduleName:lesson.moduleName,modulePath:lesson.modulePath,lessonUrl:lesson.pageUrl||this.workPage.url,status,outputFile,attempts,validation});
    }
    await this.logger.log('COMMIT',`Position ${position} saved`,{status});
    return {status,skipped:false,page:this.workPage,lesson,outputFile,validation};
  }

  async navigateSequential(fromPosition,toPosition){
    if(toPosition!==fromPosition+1)return await this.ensurePageAt(toPosition);
    let lastError=null;
    for(let attempt=0;attempt<=this.limits.navigationRetries;attempt++){
      try{
        let next;
        if(typeof this.browser.navigateNext==='function'){
          const moved=await this.browser.navigateNext(this.workPage,{fromPosition,target:toPosition});this.workPage=moved.page||this.workPage;next=moved.lesson;
        }else{
          await this.browser.clickNext(this.workPage);next=await this.browser.waitForPosition(this.workPage,toPosition,{timeoutMs:this.limits.transitionTimeoutMs,pollMs:this.limits.transitionPollMs});
        }
        await this.state.setWorkPage(next.pageUrl||this.workPage.url);
        await this.rememberNavigation(next);
        await this.logger.log('NAV',`${fromPosition} → ${toPosition} confirmed`);
        return next;
      }catch(error){
        lastError=error;
        if(error?.code==='POSITION_SKIP' || error?.code==='POSITION_REGRESSION' || error?.code==='NEXT_TRANSITION_FAILED')break;
        if(isTargetClosedError(error)){
          const recovered=await this.browser.recoverWorkingPage({workPageUrl:this.state.state?.workPageUrl,forceReconnect:true});
          if(recovered){this.workPage=recovered;await this.logger.log('RECOVERY','Browser/page target closed during navigation; recovered working page',{from:fromPosition,to:toPosition});}
        }
        if(attempt<this.limits.navigationRetries)await this.logger.log('RECOVERY','Navigation did not advance; retrying once',{from:fromPosition,to:toPosition});
      }
    }
    await this.state.appendError({scope:'NAV',position:fromPosition,status:lastError?.code||'NAVIGATION_FAILED',message:String(lastError?.message||lastError)});
    throw lastError;
  }

  async recoverSharedBrowserInfrastructure({position,lessonUrl=null,cause=null}={}){
    const targetUrl=lessonUrl||this.state?.get(position)?.lessonUrl||this.state?.state?.workPageUrl||null;
    await this.logger.log('RECOVERY','Shared browser/page unavailable; attempting bounded recovery',{position,causeCode:cause?.code||null});
    try{
      const recovered=await this.browser.recoverWorkingPage({workPageUrl:targetUrl,forceReconnect:true});
      if(!recovered)throw new RunnerError('Browser/page recovery returned no working page.',{code:'PAGE_RECOVERY_FAILED'});
      this.workPage=recovered;
      let observed=await this.browser.inspectLesson(this.workPage);
      this.assertRepositionIdentity(observed,{expectedPosition:position,strategy:'SHARED_BROWSER_RECOVERY'});
      if(Number(observed.currentPosition)!==Number(position) && targetUrl && typeof this.browser.navigateExact==='function'){
        this.workPage=await this.browser.navigateExact(this.workPage,targetUrl);
        observed=await this.browser.inspectLesson(this.workPage);
        this.assertRepositionIdentity(observed,{expectedPosition:position,strategy:'SHARED_BROWSER_RECOVERY_EXACT'});
      }
      if(Number(observed.currentPosition)!==Number(position))throw new RunnerError(`Recuperação observou ${observed.currentPosition}, esperada ${position}.`,{code:'POSITION_MISMATCH',details:{position,observed:observed.currentPosition,context:'SHARED_BROWSER_RECOVERY'}});
      await this.state.setWorkPage(observed.pageUrl||this.workPage.url);
      await this.rememberNavigation(observed);
      await this.logger.log('RECOVERY','Shared browser/page recovery validated',{position,recoveredPageId:this.workPage?.id||null});
      return observed;
    }catch(recoveryError){
      await this.logger.log('RECOVERY','Shared browser/page recovery exhausted',{position,originalCode:cause?.code||null,recoveryCode:recoveryError?.code||null});
      throw new RunnerError('Não foi possível recuperar a infraestrutura compartilhada do navegador.',{code:'BROWSER_RECOVERY_EXHAUSTED',cause:recoveryError,details:{position,originalCode:cause?.code||null,recoveryCode:recoveryError?.code||null}});
    }
  }

  async runRange({start,end,resume=true,finalAudit=false}={}){
    await this.boot({resume,requireDownloader:true});
    const rawStart=start==null?1:Number(start); const rawEnd=end==null?this.total:Number(end);
    if(!Number.isInteger(rawStart)||!Number.isInteger(rawEnd))throw new RunnerError(`Intervalo deve usar posições inteiras: ${start}..${end}.`,{code:'RANGE_INVALID'});
    const lo=Math.max(1,rawStart); const hi=Math.min(this.total,rawEnd);
    if(lo>hi)throw new RunnerError(`Intervalo inválido ${lo}..${hi}.`,{code:'RANGE_INVALID'});

    this.schedulerCheckpoint=new DurableSchedulerCheckpoint({filePath:this.state.schedulerPath,logger:this.logger});
    this.shutdown.onCheckpoint=async()=>{if(this.scheduler&&this.schedulerCheckpoint)await this.schedulerCheckpoint.save(this.scheduler.snapshot()).catch(()=>{});};
    this.shutdown.onLog=line=>this.progressSink?.(line);
    this.shutdown.onForce=async()=>{await this.browserSession?.disconnect?.().catch(()=>{});};
    if(this.enableSignalHandlers)this.shutdown.install();
    const checkpoint=resume?await this.schedulerCheckpoint.load():null;
    const donePositions=[...this.state.manifestIndex.keys()];
    this.scheduler=this.schedulerFactory({total:this.total,start:lo,end:hi});
    this.scheduler.reconcile({donePositions,repairPositions:[...this.repairPositions],checkpoint});
    await this.schedulerCheckpoint.save(this.scheduler.snapshot());
    const counts=this.scheduler.statusCounts();
    await this.logger.log('SCHED',`READY=${counts.READY} RETRY=${counts.RETRY_LATER} IN_FLIGHT=${counts.IN_FLIGHT} DONE=${counts.DONE}`);

    let previousPosition=null; const retryableFailureMap=new Map(); const blocked=[];let stopped=false;let firstTask=true;
    while(true){
      if(this.shutdown.stopRequested){stopped=true;break;}
      const claimed=this.scheduler.claimNext();
      if(!claimed.task){
        if(claimed.waitMs==null)break;
        await this.schedulerCheckpoint.save(this.scheduler.snapshot());
        await this.sleepFn(Math.min(claimed.waitMs,this.limits.retryMaxDelayMs));
        continue;
      }
      const task=claimed.task; const position=task.position;
      await this.schedulerCheckpoint.save(this.scheduler.snapshot());
      if(!firstTask)await this.autoThrottle.wait();firstTask=false;
      const attemptStarted=Date.now();
      try{
        if(previousPosition!=null && position===previousPosition+1)await this.navigateSequential(previousPosition,position);
        else await this.ensurePageAt(position,{lessonUrl:task.lessonUrl});
        if(this.shutdown.stopRequested){this.scheduler.release(position,{lessonUrl:task.lessonUrl,lastError:{code:'STOP_REQUESTED'}});stopped=true;await this.schedulerCheckpoint.save(this.scheduler.snapshot());break;}
        let preview=null;try{preview=await this.browser.inspectLesson(this.workPage);}catch{}
        this.runtimeStats.beginLesson(position,preview?.lessonTitle||null);this.progressSink?.(`[${position}/${this.total}] Processing${preview?.lessonTitle?` - ${preview.lessonTitle}`:''}`);
        const processed=await this.processPosition(position);
        const lessonUrl=processed?.lesson?.pageUrl||this.state.state?.workPageUrl||task.lessonUrl||null;
        this.scheduler.updateLessonUrl(position,lessonUrl);
        if(processed?.retryable){
          const decision=this.retryPolicy.decide({attempt:task.attempts,error:processed.retryError||{code:processed.status}});
          retryableFailureMap.set(position,{position,status:processed.status,...(processed.failureCode?{failureCode:processed.failureCode}:{})});this.runtimeStats.recordFailure();this.autoThrottle.recordFailure({status:processed.status==='DOWNLOAD_FAILED'?500:null});
          if(decision.retry){
            this.runtimeStats.recordRetry();
            const retryCause=processed.failureCode||processed.status;
            this.scheduler.requeue(position,{delayMs:decision.delayMs,priorityPenalty:decision.priorityPenalty,lastError:{code:retryCause,status:processed.status,failureCode:processed.failureCode||null},lessonUrl});
            await this.reportRetry({position,decision,code:processed.status,status:processed.status,failureCode:processed.failureCode||null});
          }else{
            this.scheduler.markBlocked(position,{lastError:{code:processed.status,failureCode:processed.failureCode||null},lessonUrl});blocked.push({position,status:processed.status,...(processed.failureCode?{failureCode:processed.failureCode}:{})});
            await this.debugSnapshots?.capture?.({position,pageRef:this.workPage,error:Object.assign(new Error(processed.status),{code:processed.status}),metadata:{courseName:this.courseName,total:this.total,attempts:task.attempts,mediaDiagnostics:this.browser.mediaDiagnostics?.(this.workPage)||null},networkEvents:this.browser.networkSnapshot?.(this.workPage)||[]});
            await this.reportRetry({position,decision,code:processed.status,status:processed.status,failureCode:processed.failureCode||null});
          }
        }else{
          retryableFailureMap.delete(position);
          this.scheduler.markDone(position,{lessonUrl});
          const healthy=!['DRM_PROTECTED'].includes(processed?.status);const bytes=processed?.validation?.size||0;this.runtimeStats.finishLesson({status:processed?.status,healthy,bytes});this.autoThrottle.recordSuccess({latencyMs:Date.now()-attemptStarted});
        }
        this.runtimeStats.setRetryPending(this.scheduler.statusCounts().RETRY_LATER);this.progressSink?.(this.runtimeStats.render());
        previousPosition=position;
      }catch(error){
        if(this.shutdown.forceRequested||error?.code==='PROCESS_ABORTED'){const lessonUrl=this.state.state?.workPageUrl||task.lessonUrl||null;try{this.scheduler.release(position,{lessonUrl,lastError:{code:'FORCE_STOP'}});}catch{}await this.schedulerCheckpoint.save(this.scheduler.snapshot());stopped=true;break;}
        await this.debugSnapshots?.capture?.({position,pageRef:this.workPage,error,metadata:{courseName:this.courseName,total:this.total,scheduler:this.scheduler.statusCounts()},networkEvents:this.browser.networkSnapshot?.(this.workPage)||[]});
        const lessonUrl=this.state.state?.workPageUrl||task.lessonUrl||null;
        if(isTargetClosedError(error)){
          try{
            await this.recoverSharedBrowserInfrastructure({position,lessonUrl,cause:error});
            this.runtimeStats.recordFailure();this.runtimeStats.recordRetry();
            this.scheduler.requeue(position,{delayMs:0,priorityPenalty:0,lastError:{code:'PAGE_RECOVERED',original:safeError(error)},lessonUrl});
            await this.state.appendError({scope:'SCHED',position,status:'RECOVERED',message:'Infraestrutura compartilhada do navegador recuperada; posição será repetida.',code:error?.code||'PAGE_CLOSED'});
            previousPosition=null;
          }catch(recoveryError){
            try{this.scheduler.release(position,{lessonUrl,lastError:safeError(recoveryError)});}catch{}
            await this.schedulerCheckpoint.save(this.scheduler.snapshot());
            await this.state.appendError({scope:'SCHED',position,status:'BROWSER_RECOVERY_EXHAUSTED',message:String(recoveryError?.message||recoveryError),code:recoveryError?.code||'BROWSER_RECOVERY_EXHAUSTED',originalCode:error?.code||null});
            throw recoveryError;
          }
        }else{
          const decision=this.retryPolicy.decide({attempt:task.attempts,error});
          if(decision.retry){
            this.runtimeStats.recordFailure();this.runtimeStats.recordRetry();this.autoThrottle.recordFailure({status:error?.status||null});
            this.scheduler.requeue(position,{delayMs:decision.delayMs,priorityPenalty:decision.priorityPenalty,lastError:safeError(error),lessonUrl});
            const networkCode=error?.details?.networkCode||null;
            await this.state.appendError({scope:'SCHED',position,status:'RETRY_LATER',message:String(error?.message||error),code:error?.code||null,networkCode,attempt:decision.attempt,maxAttempts:decision.maxAttempts,delayMs:decision.delayMs});
            await this.reportRetry({position,decision,code:error?.code||null,networkCode,message:error?.message||null});
            previousPosition=null;
          }else{
            this.scheduler.markBlocked(position,{lastError:safeError(error),lessonUrl});
            await this.schedulerCheckpoint.save(this.scheduler.snapshot());
            await this.state.appendError({scope:'SCHED',position,status:'BLOCKED',message:String(error?.message||error),code:error?.code||null,networkCode:error?.details?.networkCode||null,attempt:decision.attempt,maxAttempts:decision.maxAttempts});
            throw error;
          }
        }
      }
      await this.schedulerCheckpoint.save(this.scheduler.snapshot());
    }

    const retryableFailures=[...retryableFailureMap.values()].sort((a,b)=>a.position-b.position);
    const failuresByCause=failureSummary(retryableFailures);
    const audit=await this.state.audit({validator:f=>this.downloader.validateVideo(f)});
    const pending=this.scheduler.pending();this.runtimeStats.setRetryPending(this.scheduler.statusCounts().RETRY_LATER);
    if(stopped){await this.schedulerCheckpoint.save(this.scheduler.snapshot());return{ok:false,status:'STOPPED',course:this.courseName,range:{start:lo,end:hi},audit,scheduler:this.scheduler.statusCounts(),stats:this.runtimeStats.snapshot(),workPageUrl:this.state.state?.workPageUrl||null};}
    if(finalAudit){
      await this.logger.log('AUDIT','Final coverage audit',{...audit,schedulerPending:pending.map(t=>({position:t.position,status:t.status}))});
      if(!audit.coverageComplete)throw new RunnerError(`Cobertura incompleta: faltam ${audit.missingPositions.join(', ')}`,{code:'AUDIT_INCOMPLETE',details:{...audit,retryableFailures,failureSummary:failuresByCause,blocked,schedulerPending:pending}});
      if(!audit.healthyComplete)throw new RunnerError('Curso contém falhas não resolvidas.',{code:'AUDIT_UNHEALTHY',details:{...audit,retryableFailures,failureSummary:failuresByCause,blocked,schedulerPending:pending}});
      if(audit.invalidFilePositions.length)throw new RunnerError(`Arquivos inconsistentes: ${audit.invalidFilePositions.join(', ')}`,{code:'AUDIT_FILE_INCONSISTENCY',details:audit});
      await this.state.markComplete(audit);await this.schedulerCheckpoint.clear();
    }
    const rangeOk=pending.length===0 && audit.missingPositions.filter(p=>p>=lo&&p<=hi).length===0;
    return {ok:finalAudit?true:rangeOk,status:finalAudit?'COMPLETE':(rangeOk?'RANGE_COMPLETE':'RANGE_PARTIAL'),course:this.courseName,range:{start:lo,end:hi},retryableFailures,failureSummary:failuresByCause,blocked,scheduler:this.scheduler.statusCounts(),stats:this.runtimeStats.snapshot(),audit,courseRoot:this.state.courseDir,workPageUrl:this.state.state?.workPageUrl||null};
  }

  async diagnoseReposition({target,resume=true}={}){
    await this.boot({resume,requireDownloader:false});
    const targetPosition=Number(target);if(!Number.isInteger(targetPosition)||targetPosition<1||targetPosition>this.total)throw new RunnerError(`Target inválido: ${target}.`,{code:'RANGE_INVALID'});
    const current=await this.browser.inspectLesson(this.workPage);this.assertRepositionIdentity(current,{strategy:'DIAGNOSE'});await this.rememberNavigation(current);
    const exactTargetUrl=this.navigationIndex?.get(targetPosition)||this.state.get(targetPosition)?.lessonUrl||null;
    const checkpoint=this.findNearestKnownCheckpoint(targetPosition);const courseAnchor=this.navigationIndex?.anchor?.()||null;
    const plan=this.navigationPlanner.plan({currentPosition:current.currentPosition,targetPosition,total:this.total,exactTargetUrl,checkpoint,courseAnchor});
    return{ok:true,status:'REPOSITION_DIAGNOSIS',course:this.courseName,total:this.total,currentPosition:current.currentPosition,targetPosition,plan,navigationIndexEntries:this.navigationIndex?.entries?.().length||0,courseAnchorAvailable:Boolean(courseAnchor),repairPositions:[...this.repairPositions].sort((a,b)=>a-b)};
  }

  async runCurrent({resume=true}={}){
    const lesson=await this.boot({resume,requireDownloader:true}); const position=lesson.currentPosition;
    if(!position)throw new RunnerError('Posição atual não identificada.',{code:'CURRENT_POSITION_MISSING'});
    if(this.enableSignalHandlers)this.shutdown.install();this.runtimeStats.beginLesson(position,lesson.lessonTitle);this.progressSink?.(`[${position}/${this.total}] Processing - ${lesson.lessonTitle}`);
    const result=await this.processPosition(position);if(!result.retryable)this.runtimeStats.finishLesson({status:result.status,healthy:result.status!=='DRM_PROTECTED',bytes:result.validation?.size||0});
    const audit=await this.state.audit({validator:f=>this.downloader.validateVideo(f)});return {ok:!result.retryable,status:result.status,course:this.courseName,position,total:this.total,outputFile:result.outputFile||null,stats:this.runtimeStats.snapshot(),audit,workPageUrl:this.state.state?.workPageUrl||null};
  }

  async probe(){
    await this.browser.connect();
    try{
      const chosen=await this.browser.chooseWorkingPage(); const lesson=chosen.lesson||await this.browser.inspectLesson(chosen.page);
      return {ok:true,status:'PROBE_OK',workingPage:{id:chosen.page.id,url:chosen.page.url,title:chosen.page.title,clonedBecauseOwnership:chosen.cloned},lesson:{...lesson,videoUrl:undefined},videoUrlAvailable:Boolean(lesson.videoUrl),mediaDiagnostics:this.browser.mediaDiagnostics?.(chosen.page)||null,capabilities:this.browser.capabilities};
    } finally { await this.browser.cleanupCreatedPages?.(); await this.browser.close(); }
  }

  async runCourse({resume=true}={}){return await this.runRange({start:1,end:Number.MAX_SAFE_INTEGER,resume,finalAudit:true});}

  async dispose({cleanupPages=false}={}){
    this.shutdown?.uninstall?.();
    if(this.state) await this.state.releaseRunLock?.().catch(()=>{});
    if(cleanupPages)await this.browser.cleanupCreatedPages?.();
    await this.browser.close?.();
  }
}

export async function probeCurrentLesson(options={}){const r=new XCursosCourseRunner(options);try{return await r.probe();}finally{await r.dispose({cleanupPages:true});}}
export async function diagnoseReposition(options={}){const r=new XCursosCourseRunner(options);try{return await r.diagnoseReposition({target:options.target,resume:options.resume??true});}finally{await r.dispose({cleanupPages:true});}}
export async function downloadCurrentLesson(options={}){const r=new XCursosCourseRunner(options);try{return await r.runCurrent({resume:options.resume??true});}finally{await r.dispose({cleanupPages:true});}}
export async function downloadRange(options={}){const r=new XCursosCourseRunner(options);try{return await r.runRange({start:options.start,end:options.end,resume:options.resume??true,finalAudit:false});}finally{await r.dispose({cleanupPages:true});}}
export async function downloadCourse(options={}){
  const r=new XCursosCourseRunner(options);
  try{return await r.runCourse({resume:options.resume??true});}
  catch(error){
    let audit=null;
    try{
      if(r.state){
        const validator=r.downloader?.ffprobePath?(f=>r.downloader.validateVideo(f)):null;
        audit=await r.state.audit({validator});
      }
    }catch{}
    return {
      ok:false,
      status:'BLOCKED',
      course:r.courseName||r.state?.state?.courseName||null,
      total:r.total||r.state?.state?.totalPositions||null,
      state:r.state?.state?{
        lastCommittedPosition:r.state.state.lastCommittedPosition??null,
        lastContiguousCommittedPosition:r.state.state.lastContiguousCommittedPosition??r.state.state.lastCommittedPosition??null,
        currentTarget:r.state.state.currentTarget??null,
        workPageUrl:r.state.state.workPageUrl??null,
        status:r.state.state.status??null,
      }:null,
      audit,
      failureSummary:Array.isArray(error?.details?.failureSummary)?sanitizeForPersistence(error.details.failureSummary):[],
      retryableFailures:Array.isArray(error?.details?.retryableFailures)?sanitizeForPersistence(error.details.retryableFailures):[],
      blocked:Array.isArray(error?.details?.blocked)?sanitizeForPersistence(error.details.blocked):[],
      error:safeError(error),
      details:sanitizeForPersistence(error?.details||null),
    };
  }finally{await r.dispose({cleanupPages:true});}
}
export { summarizeAudit };