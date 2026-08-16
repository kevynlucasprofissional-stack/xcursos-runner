export const RetryClass=Object.freeze({
  TRANSIENT:'TRANSIENT',AUTH:'AUTH',STRUCTURAL:'STRUCTURAL',PERMANENT:'PERMANENT',UNKNOWN:'UNKNOWN',
});

const AUTH_CODES=new Set(['AUTH_REQUIRED','CLOUDFLARE_REQUIRED']);
const STRUCTURAL_CODES=new Set(['POSITION_SKIP','POSITION_REGRESSION','COURSE_IDENTITY_MISMATCH','TOTAL_CHANGED','RANGE_INVALID','LESSON_POSITION_MISMATCH','MEDIA_REFRESH_POSITION_CHANGED','MEDIA_REFRESH_OBJECT_CHANGED','POSITION_STUCK','NAVIGATION_FAILED','NEXT_NOT_FOUND','NEXT_TRANSITION_FAILED','POSITION_REPOSITION_NO_SAFE_PATH','NAV_WALK_INVALID','REPOSITION_INSPECTION_EMPTY']);
const PERMANENT_CODES=new Set(['DRM_PROTECTED','DRM_DETECTED','NAV_NETWORK_PERMANENT']);
const TRANSIENT_CODES=new Set([
  'PROCESS_TIMEOUT','PROCESS_ABORTED','DOWNLOAD_FAILED','VERIFY_FAILED','MEDIA_NOT_FOUND','MEDIA_NOT_READY','PAGE_CLOSED',
  'CDP_NOT_RUNNING','CDP_CONNECT_FAILED','BROWSER_DISCONNECTED','LESSON_REFRESH_FAILED','LESSON_REFRESH_RECOVERY_FAILED',
  'LESSON_INSPECT_FAILED','POSITION_OBSERVATION_FAILED','POSITION_UNOBSERVABLE','NAV_NETWORK_ERROR',
  'PAGE_CONTENT_FAILED','NEXT_ACTIONABILITY_TIMEOUT','HTTP_403','HTTP_429','HTTP_5XX','NETWORK_RESET','NETWORK_TIMEOUT','TLS_ERROR','DNS_ERROR','ECONNRESET','ETIMEDOUT','EAI_AGAIN',
]);

function codeOf(error){return String(error?.code||error?.kind||error?.name||'').toUpperCase();}
function statusOf(error,status){const n=Number(status??error?.status??error?.statusCode);return Number.isFinite(n)?n:null;}

export class RetryPolicy {
  constructor({baseDelayMs=500,maxDelayMs=15_000,maxAttempts=3,jitterRatio=0.15,priorityPenalty=10,randomFn=Math.random}={}){
    this.baseDelayMs=Math.max(0,Number(baseDelayMs)||0);
    this.maxDelayMs=Math.max(this.baseDelayMs,Number(maxDelayMs)||this.baseDelayMs);
    this.maxAttempts=Math.max(1,Math.trunc(Number(maxAttempts)||1));
    this.jitterRatio=Math.max(0,Math.min(1,Number(jitterRatio)||0));
    this.priorityPenalty=Math.max(0,Number(priorityPenalty)||0);
    this.randomFn=randomFn;
  }

  classify({error=null,status=null,kind=null}={}){
    const code=String(kind||codeOf(error)||'').toUpperCase();
    const http=statusOf(error,status);
    if(AUTH_CODES.has(code))return RetryClass.AUTH;
    if(STRUCTURAL_CODES.has(code))return RetryClass.STRUCTURAL;
    if(PERMANENT_CODES.has(code))return RetryClass.PERMANENT;
    if(TRANSIENT_CODES.has(code))return RetryClass.TRANSIENT;
    if(http===401)return RetryClass.AUTH;
    if(http===403||http===408||http===409||http===425||http===429||http>=500)return RetryClass.TRANSIENT;
    const message=String(error?.message||error||'');
    if(/target page, context or browser has been closed|browser.*disconnected|connection.*closed|ECONNRESET|ETIMEDOUT|timed out|network reset/i.test(message))return RetryClass.TRANSIENT;
    if(/cloudflare|verify you are human|captcha/i.test(message))return RetryClass.AUTH;
    if(/drm/i.test(message))return RetryClass.PERMANENT;
    return RetryClass.UNKNOWN;
  }

  delayFor(attempt,{retryAfterMs=null}={}){
    const n=Math.max(1,Math.trunc(Number(attempt)||1));
    const exp=Math.min(this.maxDelayMs,this.baseDelayMs*(2**(n-1)));
    const r=Math.max(0,Math.min(1,Number(this.randomFn?.())||0));
    const jitter=exp*this.jitterRatio*r;
    const calculated=Math.min(this.maxDelayMs,Math.round(exp+jitter));
    if(Number.isFinite(Number(retryAfterMs))&&Number(retryAfterMs)>=0)return Math.min(this.maxDelayMs,Math.max(calculated,Math.round(Number(retryAfterMs))));
    return calculated;
  }

  decide({attempt=1,error=null,status=null,kind=null,retryAfterMs=null}={}){
    const classification=this.classify({error,status,kind});
    const n=Math.max(1,Math.trunc(Number(attempt)||1));
    const retry=classification===RetryClass.TRANSIENT && n<this.maxAttempts;
    return {classification,retry,attempt:n,maxAttempts:this.maxAttempts,delayMs:retry?this.delayFor(n,{retryAfterMs}):0,priorityPenalty:retry?this.priorityPenalty:0};
  }
}
