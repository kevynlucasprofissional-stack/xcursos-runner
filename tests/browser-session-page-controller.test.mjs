import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSession, findConnectedPageByUrl } from '../src/browser-session.mjs';
import { safePageContent } from '../src/safe-page-content.mjs';
import { classifyNavigation, RedirectAuthObserver } from '../src/redirect-auth-observer.mjs';
import { PageController } from '../src/page-controller.mjs';

class Context{constructor(pages=[]){this._pages=pages;}pages(){return this._pages;}setDefaultTimeout(){}setDefaultNavigationTimeout(){}async newPage(){const p=new Page();this._pages.push(p);return p;}}
class Browser{constructor(context){this.context=context;this.connected=true;this.handlers={};}contexts(){return[this.context];}isConnected(){return this.connected;}on(n,fn){this.handlers[n]=fn;}async close(){this.connected=false;}}
class Locator{async waitFor(){}async innerText(){return '';}}
class Page{constructor(url='https://www.xcursos.com/curso/c/aula/1'){this._url=url;this.closed=false;this.events=new Map();}url(){return this._url;}isClosed(){return this.closed;}locator(){return new Locator();}async title(){return 'Assistir Aula | XCURSOS';}async content(){return '<html><body><h1>A</h1><div>1 / 2</div></body></html>';}async waitForFunction(){}on(n,fn){this.events.set(n,fn);}off(n,fn){if(this.events.get(n)===fn)this.events.delete(n);}mainFrame(){return this;}async evaluate(){return{videoUrl:null,iframeUrl:null,pageUrl:this._url,pageTitle:'Assistir Aula | XCURSOS'};}getByRole(){return{filter(){return this;},async count(){return 0;}};}getByText(){return{filter(){return this;},async count(){return 0;}};}}

function loader(context,capture={}){return async()=>({chromium:{async connectOverCDP(endpoint){capture.endpoint=endpoint;capture.browser=new Browser(context);return capture.browser;}}});}

test('BrowserSession owns CDP lifecycle and knows nothing about XCursos semantics',async()=>{
  const context=new Context([new Page()]);const capture={};const session=new BrowserSession({playwrightLoader:loader(context,capture)});
  await session.connect();assert.equal(session.isConnected(),true);assert.equal((await session.getPages()).length,1);assert.equal('inspectLesson' in session,false);assert.equal('clickNext' in session,false);
  capture.browser.connected=false;await session.reconnect();assert.equal(session.isConnected(),true);await session.disconnect();assert.equal(session.isConnected(),false);
});

test('active CDP page can be resolved by exact lesson URL only while session is connected',async()=>{
  const page=new Page('https://www.xcursos.com/curso/c/aula/123');const context=new Context([page]);const session=new BrowserSession({playwrightLoader:loader(context)});
  assert.equal(await findConnectedPageByUrl(page.url()),null);
  await session.connect();assert.equal(await findConnectedPageByUrl(page.url()),page);assert.equal(await findConnectedPageByUrl('https://www.xcursos.com/curso/c/aula/999'),null);
  await session.disconnect();assert.equal(await findConnectedPageByUrl(page.url()),null);
});

test('PageController owns lesson semantics over an injected BrowserSession',async()=>{
  const context=new Context([new Page()]);const session=new BrowserSession({playwrightLoader:loader(context)});const controller=new PageController({session});
  const chosen=await controller.chooseWorkingPage();assert.equal(chosen.lesson.currentPosition,1);assert.equal(chosen.lesson.totalPositions,2);assert.equal(chosen.page.health,'HEALTHY');await controller.close();
});

test('safePageContent retries transient failures then succeeds',async()=>{
  let calls=0;const page={isClosed:()=>false,async content(){calls++;if(calls<3)throw new Error('Execution context was destroyed');return '<html><body>ok</body></html>';}};
  const html=await safePageContent(page,{maxAttempts:3,delayMs:0,sleepFn:async()=>{}});assert.match(html,/ok/);assert.equal(calls,3);
});

test('safePageContent does not retry a closed page',async()=>{
  let calls=0;const page={isClosed:()=>true,async content(){calls++;return '<html></html>';}};
  await assert.rejects(()=>safePageContent(page,{maxAttempts:5,delayMs:0,sleepFn:async()=>{}}),e=>e.code==='PAGE_CLOSED');assert.equal(calls,0);
});

test('safePageContent rejects empty/unexpected HTML explicitly',async()=>{
  await assert.rejects(()=>safePageContent({isClosed:()=>false,content:async()=>''}),e=>e.code==='PAGE_CONTENT_EMPTY');
  await assert.rejects(()=>safePageContent({isClosed:()=>false,content:async()=>'<div>x</div>'}),e=>e.code==='PAGE_CONTENT_UNEXPECTED');
});

test('Redirect/Auth classifier distinguishes lesson, login, home and Cloudflare',()=>{
  assert.equal(classifyNavigation({url:'https://www.xcursos.com/curso/c/aula/1'}),'LESSON');
  assert.equal(classifyNavigation({url:'https://www.xcursos.com/login'}),'AUTH_REQUIRED');
  assert.equal(classifyNavigation({url:'https://www.xcursos.com/curso/c'}),'LESSON_REDIRECTED');
  assert.equal(classifyNavigation({url:'https://www.xcursos.com/',title:'Just a moment...'}),'CLOUDFLARE_REQUIRED');
});

test('Redirect/Auth observer preserves a sanitized redirect chain',async()=>{
  const page=new Page('https://www.xcursos.com/login');const observer=new RedirectAuthObserver();observer.attach(page);
  const first={url:()=> 'https://www.xcursos.com/curso/c/aula/1?token=SECRET',resourceType:()=> 'document',redirectedFrom:()=>null};
  const second={url:()=> 'https://www.xcursos.com/login',resourceType:()=> 'document',redirectedFrom:()=>first};
  page.events.get('request')(second);const h=observer.history(page);assert.equal(h.length,1);assert.equal(JSON.stringify(h).includes('SECRET'),false);
  await assert.rejects(()=>observer.assertLesson(page),e=>e.code==='AUTH_REQUIRED');observer.detach(page);assert.equal(page.events.has('request'),false);
});

test('PageController close detaches network/auth listeners from persistent external Chrome pages',async()=>{
  const page=new Page();const context=new Context([page]);const session=new BrowserSession({playwrightLoader:loader(context)});const controller=new PageController({session});await controller.pages();assert.equal(page.events.size,0);await controller.chooseWorkingPage();assert.ok(page.events.size>0);await controller.close();assert.equal(page.events.size,0);
});
