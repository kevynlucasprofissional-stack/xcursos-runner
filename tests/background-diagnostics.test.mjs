import test from 'node:test';
import assert from 'node:assert/strict';
import { startCliDiagnostics } from '../src/cli-diagnostics.mjs';

function fakeDiagnostics(captured){
  return {
    runId:'background-test',runDir:null,
    async start({context}){captured.context=context;},
    async phase(){},addArtifact(){},reference(){return{};},
  };
}

test('CLI diagnostics records background launch mode, worker PID and session correlation', async()=>{
  const captured={};
  const lifecycle=await startCliDiagnostics({
    outputRoot:process.cwd(),command:'download',processRef:process,
    env:{...process.env,XCURSOS_LAUNCH_MODE:'background',XCURSOS_BACKGROUND_SESSION_ID:'session-abc',XCURSOS_LAUNCHER_PID:'4321'},
    diagnosticsFactory:async()=>fakeDiagnostics(captured),livenessFactory:async()=>null,
    recoveryFn:async()=>({active:[],recovered:[]}),retentionFn:async()=>null,
  });
  try{
    assert.equal(captured.context.launchMode,'background');
    assert.equal(captured.context.workerPid,process.pid);
    assert.equal(captured.context.launcherPid,4321);
    assert.equal(captured.context.backgroundSessionId,'session-abc');
  }finally{lifecycle.uninstallFatal();}
});

test('CLI diagnostics defaults launch mode to foreground without background session identity', async()=>{
  const captured={};
  const lifecycle=await startCliDiagnostics({
    outputRoot:process.cwd(),command:'status',processRef:process,
    env:{...process.env,XCURSOS_LAUNCH_MODE:undefined,XCURSOS_BACKGROUND_SESSION_ID:undefined,XCURSOS_LAUNCHER_PID:undefined},
    diagnosticsFactory:async()=>fakeDiagnostics(captured),livenessFactory:async()=>null,
    recoveryFn:async()=>({active:[],recovered:[]}),retentionFn:async()=>null,
  });
  try{
    assert.equal(captured.context.launchMode,'foreground');
    assert.equal(captured.context.backgroundSessionId,null);
  }finally{lifecycle.uninstallFatal();}
});