import { LESSON_URL_RE, XCURSOS_HOME_URL, DEFAULT_LIMITS } from './constants.mjs';
import { BrowserAutomationError, TransitionError } from './errors.mjs';
import { parseCounter, parseXcursosLessonHtml, normalizeLiveLessonMeta, isSafeDownloadMedia } from './parser.mjs';
import { sleep } from './utils.mjs';
import { BrowserSession, isTargetClosedError } from './browser-session.mjs';
import { safePageContent } from './safe-page-content.mjs';
import { RedirectAuthObserver } from './redirect-auth-observer.mjs';
import { NetworkMediaObserver, correlateMediaObjects } from './network-media-observer.mjs';
import { AdaptiveLocator } from './adaptive-locator.mjs';
import { ActionabilityProbe, isPlaywrightTimeoutError } from './actionability-probe.mjs';

const TRANSIENT_NAVIGATION_NETWORK_CODES=new Set([
  'ERR_NETWORK_ACCESS_DENIED','ERR_NETWORK_CHANGED','ERR_INTERNET_DISCONNECTED','ERR_CONNECTION_RESET','ERR_CONNECTION_ABORTED','ERR_CONNECTION_CLOSED','ERR_CONNECTION_REFUSED','ERR_TIMED_OUT','ERR_NAME_NOT_RESOLVED','ERR_ADDRESS_UNREACHABLE','ERR_PROXY_CONNECTION_FAILED','ERR_TUNNEL_CONNECTION_FAILED','ERR_TEMPORARILY_THROTTLED','ERR_HTTP2_PROTOCOL_ERROR','ERR_QUIC_PROTOCOL_ERROR','ERR_SOCKET_NOT_CONNECTED',
]);
const PERMANENT_NAVIGATION_NETWORK_CODES=new Set([
  'ERR_INVALID_URL','ERR_UNKNOWN_URL_SCHEME','ERR_DISALLOWED_URL_SCHEME','ERR_UNSAFE_PORT','ERR_BLOCKED_BY_CLIENT','ERR_BLOCKED_BY_ADMINISTRATOR',
]);

export function isLessonUrl(url=''){return LESSON_URL_RE.test(String(url));}
export function navigationNetworkCode(error){return String(error?.message||error||'').match(/\bnet::(ERR_[A-Z0-9_]+)\b/i)?.[1]?.toUpperCase()||null;}
export function classifyNavigationNetworkError(error){
  const networkCode=navigationNetworkCode(error);if(!networkCode)return{networkCode:null,kind:null};
  if(TRANSIENT_NAVIGATION_NETWORK_CODES.has(networkCode))return{networkCode,kind:'TRANSIENT'};
  if(PERMANENT_NAVIGATION_NETWORK_CODES.has(networkCode)||/^ERR_(?:CERT|SSL)_/.test(networkCode))return{networkCode,kind:'PERMANENT'};
  return{networkCode,kind:'UNKNOWN'};
}
function pageClosed(page){try{return page?.isClosed?.()===true;}catch{return false;}}

export class PageRef {
  constructor(page,id){this.handle=page;this.id=id;this._title='';this.health='HEALTHY';}
  get url(){try{return this.handle.url();}catch{return '';}}
  get title(){return this._title||'';}
}

export class PageController {
  constructor({session,logger=null,limits={},authObserver=null,networkObserver=null,adaptiveLocator=null,actionabilityProbe=null,debugSnapshots=null}={}){
    if(!session)throw new BrowserAutomationError('BrowserSession é obrigatório.',{code:'BROWSER_SESSION_REQUIRED'});
    this.session=session;this.logger=logger;this.limits={...DEFAULT_LIMITS,...limits};
    this.authObserver=authObserver||new RedirectAuthObserver({logger});
    this.networkObserver=networkObserver||new NetworkMediaObserver({logger});this.adaptiveLocator=adaptiveLocator||new AdaptiveLocator();this.actionabilityProbe=actionabilityProbe||new ActionabilityProbe({trialTimeoutMs:this.limits.actionabilityTrialTimeoutMs});this.debugSnapshots=debugSnapshots||null;
    this.refs=new WeakMap();this.trackedPages=new Set();this.mediaDiagnosticsByPage=new WeakMap();this.lessonInspectionCache=new WeakMap();this.nextId=1;this.pinnedRef=null;this.pinnedTargetId=null;this.pinnedUrl=null;
    this.capabilities={...session.capabilities,pageController:true};
  }

  ref(page,{observe=false}={}){
    if(!page)return null;let r=this.refs.get(page);if(!r){r=new PageRef(page,this.nextId++);this.refs.set(page,r);}if(observe)this.observeRef(r);return r;
  }
  observeRef(ref){const page=ref?.handle;if(!page||this.trackedPages.has(page))return ref;this.trackedPages.add(page);this.authObserver.attach(page);this.networkObserver?.attach?.(page);return ref;}
  detachRef(ref){const page=ref?.handle;if(!page||!this.trackedPages.has(page))return;this.authObserver?.detach?.(page);this.networkObserver?.detach?.(page);this.trackedPages.delete(page);this.lessonInspectionCache.delete(page);}
  async pinWorkingPage(ref){
    if(!ref?.handle)throw new BrowserAutomationError('Página de trabalho ausente para pin.',{code:'WORK_PAGE_MISSING'});
    if(this.pinnedRef?.handle&&this.pinnedRef.handle!==ref.handle)this.detachRef(this.pinnedRef);
    this.observeRef(ref);this.pinnedRef=ref;this.pinnedUrl=ref.url||this.pinnedUrl||null;const target=await this.session.getTargetId?.(ref.handle);if(target)this.pinnedTargetId=target;return ref;
  }
  mark(ref,health){if(ref)ref.health=health;return ref;}
  invalidateInspection(ref){const page=ref?.handle;if(page)this.lessonInspectionCache.delete(page);}
  async connect(opts={}){const r=await this.session.connect(opts);this.capabilities={...r,pageController:true};return this.capabilities;}
  async close(){for(const page of this.trackedPages){this.authObserver?.detach?.(page);this.networkObserver?.detach?.(page);}this.trackedPages.clear();this.pinnedRef=null;this.pinnedTargetId=null;this.pinnedUrl=null;await this.session.disconnect();this.refs=new WeakMap();this.mediaDiagnosticsByPage=new WeakMap();this.lessonInspectionCache=new WeakMap();}
  async cleanupCreatedPages(){}

  async pages(){const pages=await this.session.getPages();return pages.map(p=>this.ref(p));}

  async ensurePage(url=null){
    await this.connect();const refs=await this.pages();
    let ref=refs.find(r=>url&&r.url===url)||refs.find(r=>isLessonUrl(r.url))||refs.find(r=>r.url&&r.url!=='about:blank')||refs[0];
    if(!ref)ref=this.ref(await this.session.newPage());
    if(url&&ref.url!==url)ref=await this.navigateExact(ref,url);
    return ref;
  }

  async chooseWorkingPage({preferredUrl=null}={}){
    await this.connect();const refs=await this.pages();let page=refs.find(r=>isLessonUrl(r.url));
    if(preferredUrl){
      if(!isLessonUrl(preferredUrl))throw new BrowserAutomationError('URL preferida não é uma videoaula XCursos válida.',{code:'LESSON_URL_INVALID',details:{url:preferredUrl}});
      page=refs.find(r=>r.url===preferredUrl)||await this.ensurePage(preferredUrl);
    }
    if(!page)throw new BrowserAutomationError('Nenhuma aula XCursos está aberta no Chrome dedicado. Abra uma videoaula e tente novamente.',{code:'XC_PAGE_NOT_FOUND'});
    page=await this.pinWorkingPage(page);const lesson=await this.inspectLesson(page);return{page,lesson,cloned:false};
  }

  async recoverRef(ref,{url=null,navigateIfMissing=true}={}){
    const stable=url||ref?.url||this.pinnedUrl||null;const targetId=this.pinnedTargetId||await this.session.getTargetId?.(ref?.handle);this.invalidateInspection(ref);this.mark(ref,'STALE');
    await this.logger?.log('PAGE','Recovering pinned work page',{url:stable,targetPinned:Boolean(targetId)});
    try{
      this.mark(ref,'RECOVERING');await this.session.reconnect();const handles=await this.session.getPages();let recovered=null;
      if(targetId){
        let exact=null;if(typeof this.session.findPageByTargetId==='function')exact=await this.session.findPageByTargetId(targetId,{pages:handles});
        else if(typeof this.session.getTargetId==='function'){for(const handle of handles){if(await this.session.getTargetId(handle)===targetId){exact=handle;break;}}}
        if(exact)recovered=this.ref(exact);
      }
      if(!recovered&&stable){const matches=handles.filter(p=>{try{return p.url()===stable;}catch{return false;}});if(matches.length===1)recovered=this.ref(matches[0]);else if(matches.length>1)throw new BrowserAutomationError('Há múltiplas abas com a mesma aula e o target pinado não pôde ser recuperado.',{code:'PAGE_RECOVERY_AMBIGUOUS',details:{url:stable,matches:matches.length}});}
      if(!recovered&&stable){const blank=handles.find(p=>{try{return p.url()==='about:blank';}catch{return false;}});recovered=this.ref(blank||await this.session.newPage());if(navigateIfMissing)recovered=await this.navigateExact(recovered,stable);}
      if(!recovered)throw new BrowserAutomationError('Nenhuma página de aula pôde ser recuperada.',{code:'PAGE_RECOVERY_FAILED'});
      recovered=await this.pinWorkingPage(recovered);this.mark(recovered,'HEALTHY');return recovered;
    }catch(error){this.mark(ref,'DEAD');throw error;}
  }

  async navigateExact(ref,url){
    if(!isLessonUrl(url))throw new BrowserAutomationError('Tentativa de navegar para URL que não é aula XCursos válida.',{code:'NAV_EXACT_INVALID_URL',details:{url}});
    if(!ref?.handle||pageClosed(ref.handle))ref=await this.recoverRef(ref,{url});
    const maxNetworkRecoveryAttempts=Math.min(2,Math.max(1,Math.trunc(Number(this.limits.navigationRetries)||1)));let recoveryAttempts=0;
    while(true){
      try{
        ref=await this.pinWorkingPage(ref);this.invalidateInspection(ref);this.networkObserver?.beginGeneration?.(ref.handle,{reason:'navigate-exact',lessonUrl:url});
        await ref.handle.goto(url,{waitUntil:'domcontentloaded',timeout:this.limits.navigationTimeoutMs});
        await this.authObserver.assertLesson(ref.handle,{requestedUrl:url});
        await this.waitForLessonShell(ref);ref._title=await ref.handle.title().catch(()=>ref._title);this.mark(ref,'HEALTHY');return ref;
      }catch(error){
        if(error?.code)throw error;
        if(isTargetClosedError(error))return await this.recoverRef(ref,{url});
        const network=classifyNavigationNetworkError(error);
        if(network.kind==='TRANSIENT'){
          if(recoveryAttempts<maxNetworkRecoveryAttempts){
            recoveryAttempts++;
            await this.logger?.log('RECOVERY','Transient navigation network error; reconnecting CDP/page before retry',{networkCode:network.networkCode,recoveryAttempt:recoveryAttempts,maxRecoveryAttempts:maxNetworkRecoveryAttempts});
            try{ref=await this.recoverRef(ref,{url:null,navigateIfMissing:false});}
            catch(recoveryError){throw new BrowserAutomationError(`Falha transitória de navegação e recovery CDP falhou: ${network.networkCode}`,{code:'NAV_NETWORK_ERROR',cause:recoveryError,details:{url,networkCode:network.networkCode,recoveryAttempts,recoveryFailure:String(recoveryError?.code||recoveryError?.message||recoveryError)}});}
            await sleep(Math.min(1000,250*(2**(recoveryAttempts-1))));
            continue;
          }
          throw new BrowserAutomationError(`Falha transitória de navegação após recovery limitado: ${network.networkCode}`,{code:'NAV_NETWORK_ERROR',cause:error,details:{url,networkCode:network.networkCode,recoveryAttempts}});
        }
        if(network.kind==='PERMANENT')throw new BrowserAutomationError(`Falha de navegação não recuperável automaticamente: ${network.networkCode}`,{code:'NAV_NETWORK_PERMANENT',cause:error,details:{url,networkCode:network.networkCode}});
        if(network.kind==='UNKNOWN')throw new BrowserAutomationError(`Falha de rede de navegação não classificada: ${network.networkCode}`,{code:'NAV_NETWORK_UNKNOWN',cause:error,details:{url,networkCode:network.networkCode}});
        throw new BrowserAutomationError(`Falha ao navegar para aula: ${String(error?.message||error)}`,{code:'NAV_EXACT_FAILED',cause:error,details:{url}});
      }
    }
  }

  async waitForLessonShell(ref){
    if(!ref?.handle||pageClosed(ref.handle))throw new BrowserAutomationError('Página fechada enquanto aguardava a aula.',{code:'PAGE_CLOSED'});
    const page=ref.handle;await page.locator('body').waitFor({state:'attached',timeout:this.limits.inspectTimeoutMs});
    await page.waitForFunction(()=>document.body&&/\d+\s*(?:\/|de)\s*\d+/.test(document.body.innerText||''),null,{timeout:this.limits.inspectTimeoutMs}).catch(()=>{});
    await this.authObserver.assertLesson(page,{requestedUrl:ref.url});
  }

  async inspectLesson(ref){
    if(!ref?.handle||pageClosed(ref.handle))throw new BrowserAutomationError('A página Playwright não está mais disponível.',{code:'PAGE_CLOSED'});
    await this.authObserver.assertLesson(ref.handle,{requestedUrl:ref.url});
    const cached=this.lessonInspectionCache.get(ref.handle);const ttl=Math.max(0,Number(this.limits.inspectionCacheTtlMs)||0);
    if(ttl>0&&cached?.url===ref.url&&(Date.now()-cached.at)<=ttl)return cached.result;
    try{
      await this.waitForLessonShell(ref);
      const [html,live,title]=await Promise.all([
        safePageContent(ref.handle,{maxAttempts:3}),
        ref.handle.evaluate(()=>{
          const visible=e=>{const s=getComputedStyle(e);const r=e.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0;};
          const videos=[...document.querySelectorAll('video')];const ordered=[...videos.filter(visible),...videos.filter(v=>!visible(v))];let videoUrl=null;
          for(const v of ordered){const candidates=[v.currentSrc,v.src,...[...v.querySelectorAll('source[src]')].map(s=>s.src)].filter(Boolean);const direct=candidates.find(u=>/^https?:/i.test(u)&&/\.(?:mp4|m3u8|mpd)(?:[?#]|$)/i.test(u));const http=candidates.find(u=>/^https?:/i.test(u));if(candidates.length){videoUrl=direct||http||candidates[0];break;}}
          const iframeUrl=[...document.querySelectorAll('iframe[src]')].map(x=>x.src).find(Boolean)||null;
          let modulePath=[];const asides=[...document.querySelectorAll('aside')];const sidebar=asides.find(visible)||asides[0]||null;
          if(sidebar){
            const durationRe=/\b\d{1,3}:\d{2}(?::\d{2})?\b/;const buttons=[...sidebar.querySelectorAll('button')];
            const activeButton=buttons.find(b=>{const text=b.innerText||'';if(!durationRe.test(text))return false;const aria=b.getAttribute('aria-current')||b.getAttribute('aria-selected');const state=b.getAttribute('data-state');const cls=String(b.className||'');const p=b.querySelector('p');const pClasses=String(p?.className||'').split(/\s+/);return aria==='true'||aria==='page'||state==='active'||cls.includes('bg-white/[0.06]')||pClasses.includes('text-white');});
            if(activeButton){const root=activeButton.closest('aside');const inner=[];let node=activeButton.parentElement;while(node&&node!==root){if(node.tagName==='DIV'){const first=[...node.children][0];if(first?.tagName==='BUTTON'&&/(?:\b\d+\s+aulas?\b|\b\d+\s+arquivos?\b)/i.test(first.innerText||'')){const label=(first.querySelector('p')?.innerText||'').trim();if(label&&inner.at(-1)!==label)inner.push(label);}}node=node.parentElement;}modulePath=inner.reverse();}
          }
          return{videoUrl,iframeUrl,modulePath,pageUrl:location.href,pageTitle:document.title};
        }),
        ref.handle.title(),
      ]);
      ref._title=title;const parsed=parseXcursosLessonHtml(html,ref.url);
      const network=this.networkObserver?.best?.(ref.handle)||null;
      const networkUsable=network?.url&&/^https?:/i.test(network.url)&&network.status>=200&&network.status<400;
      const liveUsable=/^https?:/i.test(String(live.videoUrl||''));
      const parsedUsable=/^https?:/i.test(String(parsed.videoUrl||''));
      const currentDomUrl=liveUsable?live.videoUrl:(parsedUsable?parsed.videoUrl:null);
      const correlation=correlateMediaObjects(network?.url||null,currentDomUrl);
      const networkMatchesCurrent=networkUsable&&(!currentDomUrl||!correlation.comparable||correlation.sameObject);
      const videoUrl=networkMatchesCurrent?network.url:(currentDomUrl||null);
      const mediaSource=networkMatchesCurrent?'network.response':(liveUsable?'live':parsed.mediaSource);
      if(networkUsable&&currentDomUrl&&correlation.comparable&&!correlation.sameObject){
        await this.logger?.log('MEDIA','Ignoring network media candidate from a different media object',{generation:this.networkObserver?.currentGeneration?.(ref.handle)??null,networkObjectFingerprint:correlation.networkObjectFingerprint,liveObjectFingerprint:correlation.liveObjectFingerprint});
      }
      const result=normalizeLiveLessonMeta({...parsed,...live,videoUrl,mediaSource,pageUrl:ref.url,pageTitle:title},{url:ref.url,title});
      this.mediaDiagnosticsByPage.set(ref.handle,{
        generation:this.networkObserver?.currentGeneration?.(ref.handle)??null,
        generationInfo:this.networkObserver?.generationInfo?.(ref.handle)||null,
        selectedSource:mediaSource||null,
        selectedObjectFingerprint:mediaSource==='network.response'?correlation.networkObjectFingerprint:(correlation.liveObjectFingerprint||null),
        networkStatus:network?.status??null,networkType:network?.type||null,networkObjectFingerprint:correlation.networkObjectFingerprint,
        liveObjectFingerprint:correlation.liveObjectFingerprint,correlation,
      });
      if(isSafeDownloadMedia(result))this.lessonInspectionCache.set(ref.handle,{url:ref.url,at:Date.now(),result});else this.lessonInspectionCache.delete(ref.handle);
      this.mark(ref,'HEALTHY');return result;
    }catch(error){
      if(error?.code)throw error;
      if(isTargetClosedError(error)){this.invalidateInspection(ref);this.mark(ref,'STALE');throw new BrowserAutomationError(String(error?.message||error),{code:'PAGE_CLOSED',cause:error});}
      throw new BrowserAutomationError(`Falha ao inspecionar aula via Playwright/CDP: ${String(error?.message||error)}`,{code:'LESSON_INSPECT_FAILED',cause:error,details:{url:ref.url}});
    }
  }

  async inspectPosition(ref){
    try{const text=await ref.handle.evaluate(()=>document.body?.innerText||'');return parseCounter(text);}
    catch(error){if(isTargetClosedError(error))throw new BrowserAutomationError(String(error?.message||error),{code:'PAGE_CLOSED',cause:error});throw new BrowserAutomationError(`Falha ao observar posição: ${String(error?.message||error)}`,{code:'POSITION_OBSERVATION_FAILED',cause:error});}
  }

  async inspectPositionForAction(ref,{attempts=3}={}){
    let last=null;const count=Math.max(1,Number(attempts)||1);
    for(let i=0;i<count;i++){last=await this.inspectPosition(ref);if(Number.isInteger(last?.current))return last;if(i<count-1)await sleep(Math.min(250,Math.max(1,this.limits.transitionPollMs)));}
    return last;
  }

  async findNextLocator(ref){
    const page=ref?.handle;
    if(!page)throw new BrowserAutomationError('Página ausente ao localizar Próxima.',{code:'PAGE_CLOSED'});
    const options=[
      {locator:page.getByRole('button',{name:/^Próxima$/i}).filter({visible:true}),method:'deterministic-button'},
      {locator:page.getByRole('link',{name:/^Próxima$/i}).filter({visible:true}),method:'deterministic-link'},
      {locator:page.getByText(/^Próxima$/i,{exact:true}).filter({visible:true}),method:'deterministic-text'},
    ];
    for(const option of options){let count=0;try{count=await option.locator.count();}catch{}if(count>0)return{locator:option.locator.first(),method:option.method,candidate:null};}
    if(this.adaptiveLocator?.findNext){const adaptive=await this.adaptiveLocator.findNext(page);if(adaptive)return{locator:adaptive.locator,method:'adaptive',candidate:adaptive.candidate||adaptive};}
    throw new TransitionError('Botão Próxima não foi encontrado/visível.',{kind:'NEXT_NOT_FOUND'});
  }

  async clickNext(ref){
    const found=await this.findNextLocator(ref);
    try{await found.locator.click({timeout:this.limits.transitionTimeoutMs});return{method:found.method,candidate:found.candidate};}
    catch(error){
      if(isTargetClosedError(error))throw new BrowserAutomationError(String(error?.message||error),{code:'PAGE_CLOSED',cause:error});
      if(isPlaywrightTimeoutError(error))throw new TransitionError('Próxima não ficou actionable dentro do timeout.',{kind:'NEXT_ACTIONABILITY_TIMEOUT',cause:error,details:{target:'Próxima',strategy:'normal-click',locatorMethod:found.method}});
      throw error;
    }
  }

  async observeNextTransition(ref,{fromPosition,target,timeoutMs}={}){
    const from=Number(fromPosition),to=Number(target);const waitMs=Math.max(0,Number(timeoutMs)||0);const deadline=Date.now()+waitMs;let last=null;
    do{
      const counter=await this.inspectPosition(ref);last=counter;const observed=counter?.current;
      if(observed===to){const lesson=await this.inspectLesson(ref);return{changed:true,lesson,counter};}
      if(Number.isInteger(observed)){
        if(observed>to)throw new TransitionError(`Navegação saltou para ${observed}; esperado ${to}.`,{kind:'POSITION_SKIP',details:{from,target:to,observed}});
        if(observed<from)throw new TransitionError(`Navegação regrediu para ${observed}; origem ${from}.`,{kind:'POSITION_REGRESSION',details:{from,target:to,observed}});
      }
      if(Date.now()>=deadline)break;
      await sleep(Math.min(this.limits.transitionPollMs,Math.max(1,deadline-Date.now())));
    }while(Date.now()<=deadline);
    return{changed:false,lesson:null,counter:last};
  }

  async captureNextActionabilityDiagnostic(ref,{position,probe,probeAfterNeutralize=null,strategy='normal-click',result='NEXT_ACTIONABILITY_TIMEOUT',error=null,locatorMethod=null}={}){
    try{
      await this.debugSnapshots?.capture?.({position,pageRef:ref,error:error||Object.assign(new Error(result),{code:result}),metadata:{target:'Próxima',strategy,result,locatorMethod,actionability:probe,actionabilityAfterNeutralize:probeAfterNeutralize},networkEvents:this.networkSnapshot(ref)});
    }catch{}
  }

  async navigateNext(ref,{fromPosition,target=Number(fromPosition)+1,postActionObservationMs=null,postDispatchObservationMs=null}={}){
    const from=Number(fromPosition),to=Number(target);const observeAfterNormal=postActionObservationMs==null?this.limits.nextPostActionObservationMs:Number(postActionObservationMs);const observeAfterDispatch=postDispatchObservationMs==null?this.limits.transitionTimeoutMs:Number(postDispatchObservationMs);
    if(!Number.isInteger(from)||!Number.isInteger(to)||to!==from+1)throw new TransitionError('navigateNext exige uma transição adjacente N → N+1.',{kind:'NEXT_TARGET_INVALID',details:{fromPosition,target}});
    const before=await this.inspectPositionForAction(ref);
    if(!Number.isInteger(before?.current))throw new TransitionError(`Posição antes de Próxima não pôde ser observada com confiança; esperada ${from}.`,{kind:'POSITION_UNOBSERVABLE',details:{from,target:to,observed:null}});
    if(before.current!==from)throw new TransitionError(`Posição antes de Próxima é ${before.current}, esperada ${from}.`,{kind:before.current>from?'POSITION_SKIP':'POSITION_REGRESSION',details:{from,target:to,observed:before.current}});
    this.invalidateInspection(ref);this.networkObserver?.beginGeneration?.(ref.handle,{reason:'next',lessonUrl:null});
    let found=await this.findNextLocator(ref);let probe=await this.actionabilityProbe.probe(found.locator);let probeAfterNeutralize=null;let cleanupMotion=null;let motionNeutralized=false;
    try{
      if(this.actionabilityProbe.shouldNeutralize(probe)){
        const cleanup=await this.actionabilityProbe.neutralize(found.locator);const after=await this.actionabilityProbe.probe(found.locator);
        const improved=(probe.stable===false&&after.stable===true)||(probe.geometryMotion===true&&after.geometryMotion===false)||(probe.trial?.passed===false&&after.trial?.passed===true);
        if(improved){cleanupMotion=cleanup;motionNeutralized=true;probeAfterNeutralize=after;await this.logger?.log('NAV','Motion neutralization improved Próxima actionability',{position:from});}
        else{await cleanup();await this.logger?.log('NAV','Motion neutralization did not improve Próxima; discarded',{position:from});}
      }

      let normalFailure=null;
      try{await found.locator.click({timeout:this.limits.transitionTimeoutMs});}
      catch(error){
        if(isTargetClosedError(error)){
          try{
            ref=await this.recoverRef(ref,{url:ref?.url||null});
            const recoveredObservation=await this.observeNextTransition(ref,{fromPosition:from,target:to,timeoutMs:observeAfterNormal});
            if(recoveredObservation.changed)return{page:ref,lesson:recoveredObservation.lesson,method:'normal-click-target-closed-but-transitioned',probe,probeAfterNeutralize,motionNeutralized};
            normalFailure=new TransitionError('A página fechou durante o click em Próxima; após recovery a posição permaneceu inalterada.',{kind:'NEXT_ACTION_INTERRUPTED',cause:error,details:{target:'Próxima',strategy:'normal-click',locatorMethod:found.method}});
            await this.logger?.log('NAV','Normal Próxima click lost page; recovered at same position before fallback',{position:from,target:to});
          }catch(recoveryError){
            if(recoveryError?.code==='POSITION_SKIP'||recoveryError?.code==='POSITION_REGRESSION')throw recoveryError;
            throw new TransitionError('A página fechou durante o click em Próxima e a posição não pôde ser confirmada com segurança.',{kind:'NEXT_TRANSITION_FAILED',cause:recoveryError,details:{from,target:to,strategy:'normal-click-target-closed',originalError:String(error?.message||error)}});
          }
        }else{
          if(!isPlaywrightTimeoutError(error))throw error;
          normalFailure=new TransitionError('Próxima não ficou actionable dentro do timeout.',{kind:'NEXT_ACTIONABILITY_TIMEOUT',cause:error,details:{target:'Próxima',strategy:'normal-click',locatorMethod:found.method,actionability:probe,actionabilityAfterNeutralize:probeAfterNeutralize}});
          await this.captureNextActionabilityDiagnostic(ref,{position:from,probe,probeAfterNeutralize,strategy:'normal-click',result:'NEXT_ACTIONABILITY_TIMEOUT',error:normalFailure,locatorMethod:found.method});
          await this.logger?.log('NAV','Normal Próxima click hit actionability timeout; observing position before fallback',{position:from,target:to,motionNeutralized});
        }
      }

      const afterNormal=await this.observeNextTransition(ref,{fromPosition:from,target:to,timeoutMs:normalFailure?observeAfterNormal:this.limits.transitionTimeoutMs});
      if(afterNormal.changed)return{page:ref,lesson:afterNormal.lesson,method:normalFailure?.code==='NEXT_ACTION_INTERRUPTED'?'normal-click-target-closed-but-transitioned':(normalFailure?'normal-click-timeout-but-transitioned':'normal-click'),probe,probeAfterNeutralize,motionNeutralized};
      if(!normalFailure)throw new TransitionError(`Clique em Próxima foi executado, mas a posição permaneceu em ${from}.`,{kind:'NEXT_TRANSITION_FAILED',details:{from,target:to,strategy:'normal-click'}});
      const effectiveProbe=probeAfterNeutralize||probe;
      if(effectiveProbe?.enabled===false||effectiveProbe?.ariaDisabled===true)throw new TransitionError('Próxima está explicitamente desabilitada; dispatchEvent não será usado para atravessar o estado da UI.',{kind:'NEXT_TRANSITION_FAILED',details:{from,target:to,strategy:'dispatch-event-blocked',reason:'disabled'}});

      try{
        await found.locator.dispatchEvent('click');
      }catch(error){
        if(!isTargetClosedError(error))throw error;
        try{
          ref=await this.recoverRef(ref,{url:ref?.url||null});
          const recoveredObservation=await this.observeNextTransition(ref,{fromPosition:from,target:to,timeoutMs:observeAfterDispatch});
          if(recoveredObservation.changed)return{page:ref,lesson:recoveredObservation.lesson,method:'dispatch-event-target-closed-but-transitioned',probe,probeAfterNeutralize,motionNeutralized};
          throw new TransitionError('dispatchEvent perdeu a página e, após recovery, a posição permaneceu inalterada.',{kind:'NEXT_TRANSITION_FAILED',cause:error,details:{from,target:to,strategy:'dispatch-event-target-closed'}});
        }catch(recoveryError){
          if(recoveryError?.code==='POSITION_SKIP'||recoveryError?.code==='POSITION_REGRESSION'||recoveryError?.code==='NEXT_TRANSITION_FAILED')throw recoveryError;
          throw new TransitionError('dispatchEvent perdeu a página e a posição não pôde ser confirmada com segurança.',{kind:'NEXT_TRANSITION_FAILED',cause:recoveryError,details:{from,target:to,strategy:'dispatch-event-target-closed',originalError:String(error?.message||error)}});
        }
      }
      await this.logger?.log('NAV','dispatchEvent(click) fallback sent only after position remained unchanged',{position:from,target:to});
      const afterDispatch=await this.observeNextTransition(ref,{fromPosition:from,target:to,timeoutMs:observeAfterDispatch});
      if(afterDispatch.changed)return{page:ref,lesson:afterDispatch.lesson,method:'dispatch-event',probe,probeAfterNeutralize,motionNeutralized};

      const recovered=await this.recoverRef(ref,{url:ref?.url||null});const finalObservation=await this.observeNextTransition(recovered,{fromPosition:from,target:to,timeoutMs:Math.min(this.limits.nextRecoveryObservationMs,this.limits.transitionTimeoutMs)});
      if(finalObservation.changed)return{page:recovered,lesson:finalObservation.lesson,method:'dispatch-event-recovered',probe,probeAfterNeutralize,motionNeutralized};
      throw new TransitionError(`Próxima permaneceu em ${from} após click normal, observação, dispatchEvent e recovery limitado.`,{kind:'NEXT_TRANSITION_FAILED',details:{from,target:to,strategy:'dispatch-event',firstActionFailure:normalFailure?.details||null}});
    }finally{if(cleanupMotion)await cleanupMotion();}
  }

  async waitForPosition(ref,target,{timeoutMs=this.limits.transitionTimeoutMs,pollMs=this.limits.transitionPollMs}={}){
    const deadline=Date.now()+timeoutMs;let last=null;
    while(Date.now()<=deadline){const counter=await this.inspectPosition(ref);last=counter;if(counter?.current===target)return await this.inspectLesson(ref);if(counter?.current!=null){if(counter.current>target)throw new TransitionError(`Navegação saltou para ${counter.current}; esperado ${target}.`,{kind:'POSITION_SKIP',details:{target,observed:counter.current}});if(counter.current<target-1)throw new TransitionError(`Navegação regrediu para ${counter.current}; esperado ${target}.`,{kind:'POSITION_REGRESSION',details:{target,observed:counter.current}});}await sleep(pollMs);}
    throw new TransitionError(`Posição não mudou para ${target} dentro do timeout.`,{kind:'POSITION_STUCK',details:{target,observed:last?.current??null}});
  }

  async refreshSameLesson(ref){
    const originalUrl=ref?.url||null;
    try{
      if(!ref?.handle||pageClosed(ref.handle))throw new Error('Target page, context or browser has been closed');
      ref=await this.pinWorkingPage(ref);this.invalidateInspection(ref);this.networkObserver?.beginGeneration?.(ref.handle,{reason:'refresh',lessonUrl:originalUrl});
      await ref.handle.reload({waitUntil:'domcontentloaded',timeout:this.limits.navigationTimeoutMs});await this.authObserver.assertLesson(ref.handle,{requestedUrl:originalUrl});await this.waitForLessonShell(ref);return ref;
    }catch(error){
      if(isTargetClosedError(error)&&originalUrl&&isLessonUrl(originalUrl)){const recovered=await this.recoverRef(ref,{url:originalUrl});return await this.navigateExact(recovered,originalUrl);}
      if(error?.code)throw error;
      throw new BrowserAutomationError(`Reload falhou: ${String(error?.message||error)}`,{code:'LESSON_REFRESH_FAILED',cause:error,details:{url:originalUrl}});
    }
  }

  async goToPosition(){throw new BrowserAutomationError('Reposicionamento arbitrário pela sidebar está desabilitado: a ordem DOM não é uma fonte comprovada da posição global.',{code:'POSITION_REPOSITION_UNAVAILABLE'});}

  async recoverWorkingPage({workPageUrl=null,forceReconnect=false}={}){
    try{if(forceReconnect)await this.session.reconnect();const refs=await this.pages();const exact=workPageUrl?refs.find(r=>r.url===workPageUrl):null;if(exact)return exact;if(workPageUrl)return await this.ensurePage(workPageUrl);return refs.find(r=>isLessonUrl(r.url))||null;}
    catch(error){await this.logger?.log('PAGE','Could not recover working page',{error:String(error?.message||error)});return null;}
  }

  networkSnapshot(ref){return this.networkObserver?.snapshot?.(ref?.handle)||[];}
  mediaDiagnostics(ref){return this.mediaDiagnosticsByPage.get(ref?.handle)||null;}
  redirectHistory(ref){return this.authObserver?.history?.(ref?.handle)||[];}

  async openInteractive(url=XCURSOS_HOME_URL){await this.connect();let ref=(await this.pages()).find(r=>r.url&&r.url!=='about:blank')||await this.ensurePage();if(ref.url!==url){this.invalidateInspection(ref);await ref.handle.goto(url,{waitUntil:'domcontentloaded',timeout:this.limits.navigationTimeoutMs});}try{await ref.handle.bringToFront();}catch{}return ref;}
  async findOpenLessonPage(){const refs=await this.pages();const lessons=refs.filter(r=>isLessonUrl(r.url));return lessons.length?lessons.at(-1):null;}
}

export { isTargetClosedError } from './browser-session.mjs';