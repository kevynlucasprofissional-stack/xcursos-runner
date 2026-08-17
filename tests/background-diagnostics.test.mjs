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

test('CLI diagnostics records background launch mode and worker PID', async()=>{
  const captured={};
  const lifecycle=await startCliDiagnostics({
    outputRoot:process.cwd(),command:'download',processRef:process,
    env:{...process.env,XCURSOS_LAUNCH_MODE:'background'},
    diagnosticsFactory:async()=>fakeDiagnostics(captured),livenessFactory:async()=>null,
    recoveryFn:async()=>({active:[],recovered:[]}),retentionFn:async()=>null,
  });
  try{
    assert.equal(captured.context.launchMode,'background');
    assert.equal(captured.context.workerPid,process.pid);
    assert.equal(captured.context.launcherPid,null);
  }finally{lifecycle.uninstallFatal();}
});

test('CLI diagnostics defaults launch mode to foreground', async()=>{
  const captured={};
  const lifecycle=await startCliDiagnostics({
    outputRoot:process.cwd(),command:'status',processRef:process,
    env:{...process.env,XCURSOS_LAUNCH_MODE:undefined},
    diagnosticsFactory:async()=>fakeDiagnostics(captured),livenessFactory:async()=>null,
    recoveryFn:async()=>({active:[],recovered:[]}),retentionFn:async()=>null,
  });
  try{assert.equal(captured.context.launchMode,'foreground');}
  finally{lifecycle.uninstallFatal();}
});
