import { DEFAULT_LIMITS } from './constants.mjs';
import { BrowserAutomationError } from './errors.mjs';
import { assertLocalCdpEndpoint } from './chrome-launcher.mjs';

const ACTIVE_CONTEXTS=new Set();
function contextClosed(context){try{return context?.isClosed?.()===true;}catch{return false;}}
function browserConnected(browser){try{return browser?.isConnected?.()!==false;}catch{return false;}}
export function isTargetClosedError(error){
  if(String(error?.code||'')==='PAGE_CLOSED')return true;
  return /(?:Target page, context or browser has been closed|target.*closed|page.*closed|browser.*closed|browser has been disconnected|connection closed|session closed)/i.test(String(error?.message||error||''));
}

export async function findConnectedPageByUrl(url=''){
  const target=String(url||'');if(!target)return null;
  for(const context of [...ACTIVE_CONTEXTS]){
    if(contextClosed(context)){ACTIVE_CONTEXTS.delete(context);continue;}
    let pages=[];try{pages=context.pages?.()||[];}catch{continue;}
    for(const page of pages){
      try{if(page?.isClosed?.()!==true&&page.url?.()===target)return page;}catch{}
    }
  }
  return null;
}

export class BrowserSession {
  constructor({cdpEndpoint='http://127.0.0.1:9222',logger=null,limits={},playwrightLoader=null,runtimeStats=null}={}){
    this.cdpEndpoint=assertLocalCdpEndpoint(cdpEndpoint);
    this.logger=logger;this.runtimeStats=runtimeStats;
    this.limits={...DEFAULT_LIMITS,...limits};
    this.playwrightLoader=playwrightLoader || (async()=>{try{return await import('playwright-core');}catch{return await import('playwright');}});
    this.browser=null;this.context=null;this.chromium=null;this.connected=false;this.reconnects=0;
    this.capabilities={engine:'playwright-cdp',persistentProfile:true,externalChrome:true,mcp:false,cdpEndpoint:this.cdpEndpoint};
  }

  invalidate(){if(this.context)ACTIVE_CONTEXTS.delete(this.context);this.browser=null;this.context=null;this.connected=false;}
  isConnected(){return Boolean(this.connected&&this.context&&!contextClosed(this.context)&&browserConnected(this.browser));}

  async connect({force=false}={}){
    if(!force&&this.isConnected())return this.capabilities;
    if(force||!this.isConnected())this.invalidate();
    let mod;
    try{mod=await this.playwrightLoader();}catch(error){throw new BrowserAutomationError('playwright-core não está instalado. Execute o instalador ou `npm install`.',{code:'PLAYWRIGHT_NOT_INSTALLED',cause:error});}
    this.chromium=mod.chromium;
    if(!this.chromium?.connectOverCDP)throw new BrowserAutomationError('Playwright não expôs chromium.connectOverCDP.',{code:'PLAYWRIGHT_INVALID'});
    try{
      const browser=await this.chromium.connectOverCDP(this.cdpEndpoint,{timeout:this.limits.browserLaunchTimeoutMs,isLocal:true,noDefaults:true});
      const context=browser.contexts?.()[0]||null;
      if(!context)throw new Error('Chrome não expôs o contexto padrão via CDP.');
      this.browser=browser;this.context=context;this.connected=true;ACTIVE_CONTEXTS.add(context);
      browser.on?.('disconnected',()=>{if(this.browser===browser)this.invalidate();});
      context.setDefaultTimeout?.(this.limits.inspectTimeoutMs);
      context.setDefaultNavigationTimeout?.(this.limits.navigationTimeoutMs);
      await this.logger?.log('SESSION','CDP connected',{endpoint:this.cdpEndpoint});
      return this.capabilities;
    }catch(error){
      this.invalidate();
      const msg=String(error?.message||error);
      const code=/ECONNREFUSED|connect.*refused|json\/version|DevTools server|timeout/i.test(msg)?'CDP_NOT_RUNNING':'CDP_CONNECT_FAILED';
      throw new BrowserAutomationError(code==='CDP_NOT_RUNNING'?`Chrome XCursos não está disponível em ${this.cdpEndpoint}. Execute \`xcursos browser\` ou \`xcursos login\` primeiro.`:`Falha ao conectar Playwright ao Chrome via CDP: ${msg}`,{code,cause:error,details:{endpoint:this.cdpEndpoint}});
    }
  }

  async reconnect(){
    this.reconnects++;this.runtimeStats?.recordBrowserReconnect?.();
    await this.logger?.log('SESSION','CDP disconnected; reconnecting',{attempt:this.reconnects});
    return await this.connect({force:true});
  }

  async getContext({recover=true}={}){
    try{await this.connect();return this.context;}
    catch(error){if(recover&&isTargetClosedError(error)){await this.reconnect();return this.context;}throw error;}
  }

  async getPages({recover=true}={}){
    let lastError=null;
    for(let attempt=0;attempt<(recover?2:1);attempt++){
      try{
        const context=await this.getContext({recover:false});
        return context.pages().filter(p=>{try{return p.isClosed?.()!==true;}catch{return true;}});
      }catch(error){
        lastError=error;
        if(attempt===0&&recover&&isTargetClosedError(error)){await this.reconnect();continue;}
        throw error;
      }
    }
    throw lastError;
  }

  async newPage(){const context=await this.getContext();return await context.newPage();}

  async getTargetId(page){
    if(!page)return null;let cdp=null;
    try{
      const context=await this.getContext({recover:false});
      if(typeof context?.newCDPSession!=='function')return page?.targetId||null;
      cdp=await context.newCDPSession(page);
      const info=await cdp.send('Target.getTargetInfo');
      return info?.targetInfo?.targetId||null;
    }catch{return page?.targetId||null;}
    finally{if(cdp?.detach)try{await cdp.detach();}catch{}}
  }

  async findPageByTargetId(targetId,{pages=null}={}){
    if(!targetId)return null;const candidates=pages||await this.getPages();
    for(const page of candidates)if(await this.getTargetId(page)===targetId)return page;
    return null;
  }

  async recoverSession(){await this.reconnect();return {context:this.context,pages:await this.getPages({recover:false})};}

  async disconnect(){
    const browser=this.browser;
    this.invalidate();
    if(browser)await browser.close().catch(()=>{});
    await this.logger?.log('SESSION','CDP disconnected');
  }
}
