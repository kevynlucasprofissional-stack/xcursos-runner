import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { FILE_BACKED_STATUSES, LESSON_SKIP_POLICIES, RETRYABLE_FAILURE_STATUSES, TERMINAL_STATUSES } from './constants.mjs';
import { RunnerError } from './errors.mjs';
import { atomicWriteJson, nowIso, readJsonIfExists, safePersistUrl, sanitizeForPersistence, sanitizeSegment } from './utils.mjs';

async function exists(p){try{await fs.access(p);return true;}catch{return false;}}
function isPlainObject(value){return Boolean(value && typeof value==='object' && !Array.isArray(value));}
function sameCourseName(a,b){return String(a||'').trim().toLocaleLowerCase()===String(b||'').trim().toLocaleLowerCase();}
function processAlive(pid){
  if(!Number.isInteger(pid)||pid<=0)return false;
  try{process.kill(pid,0);return true;}catch(error){return error?.code==='EPERM';}
}
function inside(parent, child){
  const rel=path.relative(parent,child);
  return rel==='' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function expandSkipPolicyPositions(policy,total){
  const out=[];
  for(const range of Array.isArray(policy?.ranges)?policy.ranges:[]){
    const start=Math.max(1,Number(range?.start)||0);const end=Math.min(Number(total)||0,Number(range?.end)||0);
    for(let p=start;p<=end;p++)out.push(p);
  }
  return [...new Set(out)].sort((a,b)=>a-b);
}

async function rewriteJsonlAtomic(filePath, records){
  await fs.mkdir(path.dirname(filePath),{recursive:true});
  const tmp=`${filePath}.tmp-${process.pid}-${Date.now()}`;
  const text=records.length?`${records.map(r=>JSON.stringify(r)).join('\n')}\n`:'';
  const handle=await fs.open(tmp,'w');
  try{await handle.writeFile(text,'utf8');await handle.sync();}finally{await handle.close();}
  await fs.rename(tmp,filePath);
}

async function appendJsonlDurable(filePath, record){
  await fs.mkdir(path.dirname(filePath),{recursive:true});
  const handle=await fs.open(filePath,'a');
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`,'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readJsonl(filePath, { tolerateTrailingPartial = true, repairTrailingPartial = false } = {}) {
  let text; try{text=await fs.readFile(filePath,'utf8');}catch(error){if(error?.code==='ENOENT')return [];throw error;}
  const lines=text.split(/\r?\n/); const records=[];
  for(let i=0;i<lines.length;i++){
    const line=lines[i].trim(); if(!line)continue;
    try{records.push(JSON.parse(line));}
    catch(error){
      const isLastNonEmpty=lines.slice(i+1).every(x=>!x.trim());
      if(tolerateTrailingPartial && isLastNonEmpty){
        if(repairTrailingPartial){
          const repaired=records.length?`${records.map(r=>JSON.stringify(r)).join('\n')}\n`:'';
          await fs.writeFile(filePath,repaired,'utf8');
        }
        break;
      }
      throw new RunnerError(`JSONL corrompido em ${path.basename(filePath)} linha ${i+1}.`,{code:'STATE_JSONL_CORRUPT',cause:error});
    }
  }
  return records;
}

export function indexManifest(records, total = null) {
  const map=new Map(); const duplicates=[]; const invalid=[];
  for(const rec of records){
    const pos=Number(rec?.position);
    if(!Number.isInteger(pos)||pos<1||(total&&pos>total)||!TERMINAL_STATUSES.has(rec?.status)){invalid.push(rec);continue;}
    if(map.has(pos)){duplicates.push(pos);continue;}
    map.set(pos,rec);
  }
  return { map, duplicates:[...new Set(duplicates)], invalid };
}

export function summarizeAudit({ total, manifestRecords, invalidFilePositions = [] }) {
  const {map,duplicates,invalid}=indexManifest(manifestRecords,total);
  const missing=[]; for(let i=1;i<=total;i++)if(!map.has(i))missing.push(i);
  const counts={downloaded:0,alreadyPresent:0,noVideo:0,drmProtected:0,skipped:0,downloadFailed:0,verifyFailed:0,mediaNotFound:0};
  const key={DOWNLOADED:'downloaded',ALREADY_PRESENT:'alreadyPresent',NO_VIDEO:'noVideo',DRM_PROTECTED:'drmProtected',SKIPPED:'skipped',DOWNLOAD_FAILED:'downloadFailed',VERIFY_FAILED:'verifyFailed',MEDIA_NOT_FOUND:'mediaNotFound'};
  for(const rec of map.values())if(key[rec.status])counts[key[rec.status]]++;
  return {
    total,
    processed:map.size,
    ...counts,
    missingPositions:missing,
    duplicatePositions:duplicates,
    invalidManifestRecords:invalid.length,
    invalidFilePositions:[...new Set(invalidFilePositions)].sort((a,b)=>a-b),
    coverageComplete:missing.length===0 && duplicates.length===0 && invalid.length===0,
    healthyComplete:missing.length===0 && duplicates.length===0 && invalid.length===0 && invalidFilePositions.length===0 && counts.downloadFailed===0 && counts.verifyFailed===0 && counts.mediaNotFound===0 && counts.drmProtected===0,
  };
}

export class StateStore {
  constructor({ outputRoot, courseName, totalPositions, logger = null }={}) {
    this.outputRoot=outputRoot; this.courseName=courseName; this.totalPositions=totalPositions; this.logger=logger;
    this.courseDir=path.join(outputRoot,sanitizeSegment(courseName,'Curso XCursos',90));
    this.metaDir=path.join(this.courseDir,'_xcursos-runner');
    this.statePath=path.join(this.metaDir,'state.json');
    this.manifestPath=path.join(this.metaDir,'manifest.jsonl');
    this.errorsPath=path.join(this.metaDir,'errors.jsonl');
    this.logPath=path.join(this.metaDir,'runner.log');
    this.lockPath=path.join(this.metaDir,'run.lock');
    this.identityPath=path.join(this.metaDir,'course.identity.json');
    this.schedulerPath=path.join(this.metaDir,'scheduler.checkpoint.json');
    this.navigationPath=path.join(this.metaDir,'lesson-navigation-index.json');
    this.state=null; this.manifestRecords=[]; this.manifestIndex=new Map(); this.lockToken=null;
  }

  async acquireRunLock({ staleAfterMs=24*60*60*1000 }={}) {
    if(this.lockToken)return;
    await fs.mkdir(this.metaDir,{recursive:true});
    const token=crypto.randomUUID();
    const payload={version:1,token,pid:process.pid,hostname:os.hostname(),startedAt:nowIso()};
    const tryCreate=async()=>{
      const handle=await fs.open(this.lockPath,'wx');
      try{await handle.writeFile(`${JSON.stringify(payload)}\n`,'utf8');}finally{await handle.close();}
      this.lockToken=token;
    };
    try{await tryCreate();return;}
    catch(error){if(error?.code!=='EEXIST')throw error;}

    let existing=null, stat=null;
    try{existing=JSON.parse(await fs.readFile(this.lockPath,'utf8'));}catch{}
    try{stat=await fs.stat(this.lockPath);}catch{}
    const ageMs=stat?Date.now()-stat.mtimeMs:0;
    if(!existing && ageMs < staleAfterMs){
      throw new RunnerError('run.lock existe, mas está ilegível e ainda não é antigo o suficiente para ser removido com segurança.',{code:'RUN_LOCK_CORRUPT'});
    }
    const sameHost=existing?.hostname===os.hostname();
    const active=sameHost && processAlive(Number(existing?.pid));
    if(active || (existing && !sameHost && ageMs < staleAfterMs)){
      throw new RunnerError(`Já existe uma execução ativa para este curso (pid ${existing?.pid ?? 'desconhecido'}).`,{code:'RUN_ALREADY_ACTIVE',details:{pid:existing?.pid??null,hostname:existing?.hostname??null,startedAt:existing?.startedAt??null}});
    }
    await fs.rm(this.lockPath,{force:true});
    await tryCreate();
  }

  async releaseRunLock() {
    if(!this.lockToken)return;
    try{
      const existing=JSON.parse(await fs.readFile(this.lockPath,'utf8'));
      if(existing?.token===this.lockToken)await fs.rm(this.lockPath,{force:true});
    }catch(error){if(error?.code!=='ENOENT')await this.logger?.log?.('STATE','Failed to release run lock',{error:String(error?.message||error)});}
    this.lockToken=null;
  }

  async rotateFreshMetadata(){
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    for(const file of [this.statePath,this.manifestPath,this.errorsPath,this.logPath,this.schedulerPath]){
      try{await fs.rename(file,`${file}.previous-${stamp}`);}catch(error){if(error?.code!=='ENOENT')throw error;}
    }
  }

  async ensureCourseIdentity(){
    let identity=null;
    try { identity=await readJsonIfExists(this.identityPath); }
    catch(error){ throw new RunnerError('Identidade persistente da pasta do curso está corrompida.',{code:'COURSE_IDENTITY_CORRUPT',cause:error}); }
    if(identity!=null){
      if(!isPlainObject(identity) || !identity.courseName)throw new RunnerError('Identidade persistente da pasta do curso é inválida.',{code:'COURSE_IDENTITY_CORRUPT'});
      if(!sameCourseName(identity.courseName,this.courseName))throw new RunnerError('A pasta sanitizada já pertence a outro curso.',{code:'MANIFEST_COURSE_MISMATCH',details:{expected:this.courseName,found:[identity.courseName],identityPath:this.identityPath}});
      return identity;
    }

    // Migração segura de instalações anteriores: antes de criar a identidade, prove que
    // metadados legados existentes não pertencem a outro curso. Isso ocorre ANTES de resume=false rotacionar arquivos.
    const legacyManifest=await readJsonl(this.manifestPath,{tolerateTrailingPartial:true,repairTrailingPartial:false});
    const mismatched=legacyManifest.filter(rec=>rec?.courseName && !sameCourseName(rec.courseName,this.courseName));
    if(mismatched.length)throw new RunnerError('Manifesto existente pertence a outro curso que colide no mesmo nome de pasta sanitizado.',{code:'MANIFEST_COURSE_MISMATCH',details:{expected:this.courseName,found:[...new Set(mismatched.map(x=>x.courseName))]}});
    try {
      const legacyState=await readJsonIfExists(this.statePath);
      if(isPlainObject(legacyState) && legacyState.courseName && !sameCourseName(legacyState.courseName,this.courseName)){
        throw new RunnerError('state.json existente pertence a outro curso que colide na mesma pasta sanitizada.',{code:'STATE_COURSE_MISMATCH',details:{expected:this.courseName,found:legacyState.courseName}});
      }
    } catch(error){
      if(error instanceof RunnerError)throw error;
      // state.json corrompido será tratado pelo fluxo normal de recuperação depois; não bloqueia a identidade se o manifesto não contradiz.
    }
    identity={version:1,courseName:this.courseName,createdAt:nowIso()};
    await atomicWriteJson(this.identityPath,identity);
    return identity;
  }

  validateManifestCourse(){
    const mismatched=this.manifestRecords.filter(rec=>rec?.courseName && !sameCourseName(rec.courseName,this.courseName));
    if(mismatched.length)throw new RunnerError('Manifesto existente pertence a outro curso que colide no mesmo nome de pasta sanitizado.',{code:'MANIFEST_COURSE_MISMATCH',details:{expected:this.courseName,found:[...new Set(mismatched.map(x=>x.courseName))]}});
  }

  validateInFlight(value){
    if(value==null)return null;
    if(!isPlainObject(value) || !Number.isInteger(Number(value.position)))return null;
    const position=Number(value.position);
    if(position<1 || position>this.totalPositions)return null;
    let relativeOutputBase=value.relativeOutputBase?String(value.relativeOutputBase):null;
    if(relativeOutputBase){
      const absolute=path.resolve(this.courseDir,relativeOutputBase);
      if(path.isAbsolute(relativeOutputBase) || !inside(this.courseDir,absolute))relativeOutputBase=null;
    }
    const modulePath=(Array.isArray(value.modulePath)?value.modulePath:[]).map(x=>String(x||'').trim()).filter(Boolean);
    const moduleName=modulePath.at(-1)||(value.moduleName?String(value.moduleName):null);
    return {
      position,
      lessonTitle:String(value.lessonTitle||'Aula'),
      moduleName,
      modulePath:modulePath.length?modulePath:(moduleName?[moduleName]:[]),
      lessonUrl:safePersistUrl(value.lessonUrl),
      relativeOutputBase,
      startedAt:value.startedAt||nowIso(),
    };
  }

  async reopenRetryableFailures(){
    const reopened=this.manifestRecords.filter(rec=>RETRYABLE_FAILURE_STATUSES.has(rec?.status));
    if(!reopened.length)return [];
    const positions=[];
    for(const rec of reopened){
      positions.push(Number(rec.position));
      await this.appendError({scope:'STATE',position:Number(rec.position),status:'RETRYABLE_FAILURE_REOPENED',previousStatus:rec.status,message:'Falha transitória removida do manifesto para nova tentativa.'});
    }
    this.manifestRecords=this.manifestRecords.filter(rec=>!RETRYABLE_FAILURE_STATUSES.has(rec?.status));
    await rewriteJsonlAtomic(this.manifestPath,this.manifestRecords);
    return positions.sort((a,b)=>a-b);
  }

  matchingSkipPolicies(){
    return LESSON_SKIP_POLICIES.filter(policy=>sameCourseName(policy?.courseName,this.courseName) && (!policy?.totalPositions || Number(policy.totalPositions)===Number(this.totalPositions)));
  }

  async applyConfiguredSkips(){
    const policies=this.matchingSkipPolicies();if(!policies.length)return[];
    const present=new Set(this.manifestRecords.map(rec=>Number(rec?.position)).filter(Number.isInteger));const inserted=[];
    for(const policy of policies){
      for(const position of expandSkipPolicyPositions(policy,this.totalPositions)){
        if(present.has(position))continue;
        const record=sanitizeForPersistence({
          position,courseName:this.courseName,lessonTitle:'Ignorado por política',moduleName:null,modulePath:[],lessonUrl:null,status:'SKIPPED',outputFile:null,attempts:0,
          validation:{skipPolicyId:policy.id||null,skipReason:policy.reason||'CONFIGURED_SKIP',skipLabel:policy.label||null},timestamp:nowIso(),
        });
        await appendJsonlDurable(this.manifestPath,record);this.manifestRecords.push(record);present.add(position);inserted.push(position);
      }
    }
    if(inserted.length)await this.logger?.log?.('SKIP','Configured lesson positions marked SKIPPED',{course:this.courseName,positions:inserted});
    return inserted;
  }

  async initialize({ resume=true, workPageUrl=null }={}) {
    await fs.mkdir(this.metaDir,{recursive:true});
    await this.ensureCourseIdentity();
    if(!resume)await this.rotateFreshMetadata();
    this.manifestRecords=await readJsonl(this.manifestPath,{repairTrailingPartial:true});
    this.validateManifestCourse();
    if(resume)await this.reopenRetryableFailures();
    await this.applyConfiguredSkips();
    const indexed=indexManifest(this.manifestRecords,this.totalPositions);
    if(indexed.duplicates.length)throw new RunnerError(`Manifesto contém posições duplicadas: ${indexed.duplicates.join(', ')}`,{code:'MANIFEST_DUPLICATES'});
    if(indexed.invalid.length)throw new RunnerError('Manifesto contém posições inválidas.',{code:'MANIFEST_INVALID_POSITION'});
    this.manifestIndex=indexed.map;
    let state=null;
    if(resume){
      try{
        state=await readJsonIfExists(this.statePath);
        if(state!=null && !isPlainObject(state))throw new RunnerError('state.json não contém um objeto JSON válido.',{code:'STATE_SHAPE_INVALID'});
      }catch(error){
        const backup=`${this.statePath}.corrupt-${Date.now()}`; try{await fs.rename(this.statePath,backup);}catch{}
        await this.appendError({scope:'STATE',status:'STATE_CORRUPT_RECOVERED',message:String(error?.message||error),backup});
        state=null;
      }
    }
    const lastCommitted=this.highestContinuousCommitted();
    const firstMissing=this.firstMissingPosition();
    if(!state || !resume){
      state={version:2,courseName:this.courseName,courseRoot:this.courseDir,totalPositions:this.totalPositions,lastCommittedPosition:lastCommitted,lastContiguousCommittedPosition:lastCommitted,currentTarget:firstMissing,status:'RUNNING',workPageUrl:safePersistUrl(workPageUrl),inFlight:null,startedAt:nowIso(),updatedAt:nowIso()};
    } else {
      if(state.courseName && !sameCourseName(state.courseName,this.courseName))throw new RunnerError('state.json pertence a outro curso.',{code:'STATE_COURSE_MISMATCH'});
      if(state.totalPositions && Number(state.totalPositions)!==Number(this.totalPositions))throw new RunnerError(`TOTAL mudou de ${state.totalPositions} para ${this.totalPositions}.`,{code:'STATE_TOTAL_MISMATCH'});
      let inFlight=this.validateInFlight(state.inFlight);
      if(inFlight && this.manifestIndex.has(inFlight.position))inFlight=null;
      state={...state,version:2,courseName:this.courseName,courseRoot:this.courseDir,totalPositions:this.totalPositions,lastCommittedPosition:lastCommitted,lastContiguousCommittedPosition:lastCommitted,currentTarget:firstMissing,status:'RUNNING',workPageUrl:safePersistUrl(state.workPageUrl||workPageUrl),inFlight,updatedAt:nowIso()};
    }
    this.state=state; await atomicWriteJson(this.statePath,state); return state;
  }

  highestContinuousCommitted(){let n=0;for(let i=1;i<=this.totalPositions;i++){if(this.manifestIndex.has(i))n=i;else break;}return n;}
  firstMissingPosition({start=1,end=this.totalPositions}={}){for(let i=Math.max(1,start);i<=Math.min(end,this.totalPositions);i++)if(!this.manifestIndex.has(i))return i;return null;}
  hasTerminal(position){const r=this.manifestIndex.get(position);return Boolean(r&&TERMINAL_STATUSES.has(r.status));}
  get(position){return this.manifestIndex.get(position)||null;}
  getInFlight(position=null){const f=this.validateInFlight(this.state?.inFlight);return f && (position==null || f.position===Number(position))?f:null;}

  async update(patch){this.state={...this.state,...sanitizeForPersistence(patch),updatedAt:nowIso()};await atomicWriteJson(this.statePath,this.state);return this.state;}
  async setWorkPage(url){return await this.update({workPageUrl:safePersistUrl(url)});}

  async setInFlight(entry){
    const normalized=this.validateInFlight({...entry,startedAt:entry?.startedAt||nowIso()});
    if(!normalized)throw new RunnerError('Checkpoint in-flight inválido.',{code:'INFLIGHT_INVALID'});
    return await this.update({inFlight:normalized,currentTarget:normalized.position});
  }
  async clearInFlight(position=null){
    const current=this.getInFlight();
    if(!current || (position!=null && current.position!==Number(position)))return this.state;
    return await this.update({inFlight:null});
  }
  resolveInFlightBase(inFlight){
    const f=this.validateInFlight(inFlight); if(!f?.relativeOutputBase)return null;
    const absolute=path.resolve(this.courseDir,f.relativeOutputBase);
    if(!inside(this.courseDir,absolute))throw new RunnerError('Checkpoint in-flight aponta para fora da pasta do curso.',{code:'INFLIGHT_PATH_UNSAFE'});
    return absolute;
  }

  async appendError(record){
    await fs.mkdir(this.metaDir,{recursive:true});
    const safe=sanitizeForPersistence({timestamp:nowIso(),...record});
    await fs.appendFile(this.errorsPath,`${JSON.stringify(safe)}\n`,'utf8'); return safe;
  }

  async commit(entry){
    const position=Number(entry.position);
    if(!Number.isInteger(position)||position<1||position>this.totalPositions)throw new RunnerError(`Posição inválida para commit: ${entry.position}`,{code:'COMMIT_POSITION_INVALID'});
    if(!TERMINAL_STATUSES.has(entry.status))throw new RunnerError(`Status não terminal: ${entry.status}`,{code:'COMMIT_STATUS_INVALID'});
    if(RETRYABLE_FAILURE_STATUSES.has(entry.status))throw new RunnerError(`Falha retryable não pode virar commit de progresso: ${entry.status}`,{code:'COMMIT_RETRYABLE_STATUS'});
    if(this.manifestIndex.has(position))return {record:this.manifestIndex.get(position),alreadyCommitted:true};
    const record=sanitizeForPersistence({
      position,
      courseName:this.courseName,
      lessonTitle:entry.lessonTitle||'Aula',
      moduleName:entry.moduleName||null,
      modulePath:(Array.isArray(entry.modulePath)?entry.modulePath:[]).map(x=>String(x||'').trim()).filter(Boolean),
      lessonUrl:safePersistUrl(entry.lessonUrl),
      status:entry.status,
      outputFile:entry.outputFile||null,
      attempts:Number(entry.attempts||0),
      validation:entry.validation||null,
      timestamp:nowIso(),
    });
    await appendJsonlDurable(this.manifestPath,record);
    this.manifestRecords.push(record);this.manifestIndex.set(position,record);
    const last=this.highestContinuousCommitted(); const next=this.firstMissingPosition();
    const clearFlight=this.getInFlight(position)?null:this.state?.inFlight||null;
    await this.update({lastCommittedPosition:last,lastContiguousCommittedPosition:last,currentTarget:next,status:next==null?'AUDITING':'RUNNING',workPageUrl:record.lessonUrl||this.state?.workPageUrl||null,inFlight:clearFlight});
    return {record,alreadyCommitted:false};
  }

  async verifyFileBackedEntries(validator){
    const invalid=[];
    for(const [position,rec] of this.manifestIndex){
      if(!FILE_BACKED_STATUSES.has(rec.status))continue;
      if(!rec.outputFile || !(await exists(rec.outputFile))){invalid.push(position);continue;}
      try{await validator(rec.outputFile);}catch{invalid.push(position);}
    }
    return invalid.sort((a,b)=>a-b);
  }

  async audit({validator=null}={}){
    const invalidFilePositions=validator?await this.verifyFileBackedEntries(validator):[];
    return summarizeAudit({total:this.totalPositions,manifestRecords:this.manifestRecords,invalidFilePositions});
  }

  async markComplete(audit){
    if(!audit.coverageComplete)throw new RunnerError('Auditoria não cobre todas as posições; COMPLETE recusado.',{code:'AUDIT_INCOMPLETE'});
    if(!audit.healthyComplete)throw new RunnerError('Auditoria contém falhas não resolvidas; COMPLETE recusado.',{code:'AUDIT_UNHEALTHY',details:audit});
    if(audit.invalidFilePositions?.length)throw new RunnerError(`Arquivos inválidos nas posições ${audit.invalidFilePositions.join(', ')}.`,{code:'AUDIT_FILE_INCONSISTENCY'});
    await this.update({status:'COMPLETE',currentTarget:null,inFlight:null,completedAt:nowIso(),audit});
  }
}

export async function discoverRecentState(outputRoot) {
  let dirs=[]; try{dirs=await fs.readdir(outputRoot,{withFileTypes:true});}catch{return null;}
  const candidates=[];
  for(const d of dirs.filter(x=>x.isDirectory())){
    const statePath=path.join(outputRoot,d.name,'_xcursos-runner','state.json');
    try{const state=JSON.parse(await fs.readFile(statePath,'utf8'));const stat=await fs.stat(statePath);if(isPlainObject(state)&&state?.workPageUrl&&state?.status!=='COMPLETE')candidates.push({state,statePath,mtime:stat.mtimeMs});}catch{}
  }
  candidates.sort((a,b)=>b.mtime-a.mtime); return candidates[0]||null;
}