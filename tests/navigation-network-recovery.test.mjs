import test from 'node:test';
import assert from 'node:assert/strict';
import { PageController, classifyNavigationNetworkError, navigationNetworkCode } from '../src/page-controller.mjs';
import { RetryPolicy, RetryClass } from '../src/retry-policy.mjs';

function noOpObserver(){return{attach(){},detach(){},beginGeneration(){},async assertLesson(){}};}
function pageWithGoto(sequence,{initialUrl='https://www.xcursos.com/curso/c/aula/1'}={}){
  let currentUrl=initialUrl;let calls=0;
  return{
    targetId:'target-1',
    isClosed:()=>false,
    url:()=>currentUrl,
    async goto(url){calls++;const step=sequence[Math.min(calls-1,sequence.length-1)];if(step instanceof Error)throw step;if(typeof step==='function')await step();currentUrl=url;return null;},
    locator:()=>({async waitFor(){}}),
    async waitForFunction(){},
    async title(){return 'Assistir Aula | XCURSOS';},
    get calls(){return calls;},
  };
}
class FakeSession{
  constructor(page){this.page=page;this.reconnects=0;this.capabilities={engine:'fake'};}
  async connect(){return this.capabilities;}
  async reconnect(){this.reconnects++;return this.capabilities;}
  async getPages(){return[this.page];}
  async getTargetId(page){return page?.targetId||null;}
  async findPageByTargetId(id){return this.page?.targetId===id?this.page:null;}
  async newPage(){return this.page;}
  async disconnect(){}
}
function controllerFor(page,{navigationRetries=1,logs=[]}={}){
  const session=new FakeSession(page);const observer=noOpObserver();
  const controller=new PageController({session,limits:{navigationRetries,navigationTimeoutMs:50,inspectTimeoutMs:50},authObserver:observer,networkObserver:observer,logger:{async log(event,message,data){logs.push({event,message,data});}}});
  return{controller,session,logs};
}

const netError=code=>new Error(`page.goto: net::${code} at https://www.xcursos.com/curso/c/aula/2`);

test('navigation network classifier does not treat every net::ERR_* as retryable',()=>{
  assert.equal(navigationNetworkCode(netError('ERR_NETWORK_ACCESS_DENIED')),'ERR_NETWORK_ACCESS_DENIED');
  assert.deepEqual(classifyNavigationNetworkError(netError('ERR_NETWORK_ACCESS_DENIED')),{networkCode:'ERR_NETWORK_ACCESS_DENIED',kind:'TRANSIENT'});
  assert.equal(classifyNavigationNetworkError(netError('ERR_CONNECTION_RESET')).kind,'TRANSIENT');
  assert.equal(classifyNavigationNetworkError(netError('ERR_BLOCKED_BY_ADMINISTRATOR')).kind,'PERMANENT');
  assert.equal(classifyNavigationNetworkError(netError('ERR_CERT_AUTHORITY_INVALID')).kind,'PERMANENT');
  assert.equal(classifyNavigationNetworkError(netError('ERR_FUTURE_UNCLASSIFIED')).kind,'UNKNOWN');
  assert.deepEqual(classifyNavigationNetworkError(new Error('plain navigation failure')),{networkCode:null,kind:null});
});

test('ERR_NETWORK_ACCESS_DENIED reconnects CDP/page once and repeats goto successfully',async()=>{
  const page=pageWithGoto([netError('ERR_NETWORK_ACCESS_DENIED'),null]);const state=controllerFor(page,{navigationRetries:1});
  const ref=state.controller.ref(page);const result=await state.controller.navigateExact(ref,'https://www.xcursos.com/curso/c/aula/2');
  assert.equal(result.url,'https://www.xcursos.com/curso/c/aula/2');assert.equal(page.calls,2);assert.equal(state.session.reconnects,1);
  const recovery=state.logs.find(x=>x.event==='RECOVERY'&&x.data?.networkCode==='ERR_NETWORK_ACCESS_DENIED');assert.ok(recovery);assert.equal(recovery.data.recoveryAttempt,1);
});

test('persistent transient navigation error stops local recovery after bounded attempts and remains scheduler-retryable',async()=>{
  const page=pageWithGoto([netError('ERR_NETWORK_ACCESS_DENIED')]);const state=controllerFor(page,{navigationRetries:2});
  await assert.rejects(()=>state.controller.navigateExact(state.controller.ref(page),'https://www.xcursos.com/curso/c/aula/2'),error=>{
    assert.equal(error.code,'NAV_NETWORK_ERROR');assert.equal(error.details.networkCode,'ERR_NETWORK_ACCESS_DENIED');assert.equal(error.details.recoveryAttempts,2);return true;
  });
  assert.equal(page.calls,3);assert.equal(state.session.reconnects,2);
  const policy=new RetryPolicy({maxAttempts:3,randomFn:()=>0});const first=policy.decide({attempt:1,error:{code:'NAV_NETWORK_ERROR'}});const exhausted=policy.decide({attempt:3,error:{code:'NAV_NETWORK_ERROR'}});
  assert.equal(first.classification,RetryClass.TRANSIENT);assert.equal(first.retry,true);assert.equal(exhausted.retry,false);
});

test('permanent navigation network error is not locally retried or scheduler-retried',async()=>{
  const page=pageWithGoto([netError('ERR_BLOCKED_BY_ADMINISTRATOR')]);const state=controllerFor(page,{navigationRetries:2});
  await assert.rejects(()=>state.controller.navigateExact(state.controller.ref(page),'https://www.xcursos.com/curso/c/aula/2'),error=>error.code==='NAV_NETWORK_PERMANENT'&&error.details.networkCode==='ERR_BLOCKED_BY_ADMINISTRATOR');
  assert.equal(page.calls,1);assert.equal(state.session.reconnects,0);
  const decision=new RetryPolicy({maxAttempts:5}).decide({attempt:1,error:{code:'NAV_NETWORK_PERMANENT'}});assert.equal(decision.classification,RetryClass.PERMANENT);assert.equal(decision.retry,false);
});

test('unknown net error is surfaced as unknown instead of entering an infinite retry policy',async()=>{
  const page=pageWithGoto([netError('ERR_FUTURE_UNCLASSIFIED')]);const state=controllerFor(page,{navigationRetries:2});
  await assert.rejects(()=>state.controller.navigateExact(state.controller.ref(page),'https://www.xcursos.com/curso/c/aula/2'),error=>error.code==='NAV_NETWORK_UNKNOWN'&&error.details.networkCode==='ERR_FUTURE_UNCLASSIFIED');
  assert.equal(page.calls,1);assert.equal(state.session.reconnects,0);
  const decision=new RetryPolicy({maxAttempts:5}).decide({attempt:1,error:{code:'NAV_NETWORK_UNKNOWN'}});assert.equal(decision.classification,RetryClass.UNKNOWN);assert.equal(decision.retry,false);
});
