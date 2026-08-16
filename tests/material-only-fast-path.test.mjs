import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXcursosLessonHtml, isMaterialOnlyLesson } from '../src/parser.mjs';
import { XCursosCourseRunner } from '../src/runner.mjs';

const base='<h2>Curso Teste</h2><h1>Conteúdo</h1><span>1 / 5</span>';
const material='<a href="/api/materials/download?lessonId=x&index=0">Baixar PDF</a>';

function runnerForFastPath(){
  let inspections=0,sleeps=0;
  const browser={async inspectLesson(){inspections++;throw new Error('material-only fast path must not poll inspectLesson');}};
  const runner=new XCursosCourseRunner({browser,downloader:{},sleepFn:async()=>{sleeps++;}});
  runner.courseName='Curso Teste';runner.total=5;runner.workPage={url:'https://www.xcursos.com/curso/c/aula/1'};
  return{runner,get inspections(){return inspections;},get sleeps(){return sleeps;}};
}

test('material-only page is detected structurally even with an analytics iframe',()=>{
  const html=`${base}${material}<iframe src="https://www.googletagmanager.com/ns.html?id=GTM-X"></iframe>`;
  const lesson=parseXcursosLessonHtml(html,'https://www.xcursos.com/curso/c/aula/1');
  assert.equal(lesson.hasMaterialsLinks,true);assert.equal(lesson.materialOnly,true);assert.equal(lesson.hasUntrustedIframe,false);assert.equal(lesson.hasNonAnalyticsIframe,false);assert.equal(isMaterialOnlyLesson(lesson),true);
});

test('video-only page is never material-only',()=>{
  const lesson=parseXcursosLessonHtml(`${base}<video src="https://cdn.example/a.mp4"></video>`,'https://www.xcursos.com/curso/c/aula/1');
  assert.equal(lesson.hasMaterialsLinks,false);assert.equal(lesson.materialOnly,false);assert.equal(lesson.mediaType,'DIRECT_MP4');
});

test('video plus materials keeps the normal video path',()=>{
  const lesson=parseXcursosLessonHtml(`${base}${material}<video src="https://cdn.example/a.mp4"></video>`,'https://www.xcursos.com/curso/c/aula/1');
  assert.equal(lesson.hasMaterialsLinks,true);assert.equal(lesson.materialOnly,false);assert.equal(lesson.mediaType,'DIRECT_MP4');assert.equal(lesson.hasVideoElement,true);
});

test('empty page is not guessed to be material-only',()=>{
  const lesson=parseXcursosLessonHtml(base,'https://www.xcursos.com/curso/c/aula/1');
  assert.equal(lesson.hasMaterialsLinks,false);assert.equal(lesson.materialOnly,false);assert.equal(lesson.mediaType,'NONE');
});

test('materials plus an unexpected non-analytics iframe remains conservative and does not fast-path',()=>{
  const lesson=parseXcursosLessonHtml(`${base}${material}<iframe src="https://unknown-player.example/embed/123"></iframe>`,'https://www.xcursos.com/curso/c/aula/1');
  assert.equal(lesson.hasMaterialsLinks,true);assert.equal(lesson.hasNonAnalyticsIframe,true);assert.equal(lesson.hasUntrustedIframe,true);assert.equal(lesson.materialOnly,false);
});

test('materials plus native video download button is not material-only even before a player URL appears',()=>{
  const lesson=parseXcursosLessonHtml(`${base}${material}<a href="/api/video/download?lessonId=video-1">Baixar aula</a>`,'https://www.xcursos.com/curso/c/aula/1');
  assert.equal(lesson.nativeDownloadAvailable,true);assert.equal(lesson.materialOnly,false);
});

test('material-only metadata returns immediately from media readiness without polling or sleeping',async()=>{
  const lesson=parseXcursosLessonHtml(`${base}${material}<iframe src="https://www.googletagmanager.com/ns.html?id=GTM-X"></iframe>`,'https://www.xcursos.com/curso/c/aula/1');
  const state=runnerForFastPath();
  assert.equal(state.runner.shouldWaitForMedia(lesson),false);
  const result=await state.runner.waitForProvenMedia(lesson,{position:1});
  assert.equal(result.materialOnly,true);assert.equal(state.inspections,0);assert.equal(state.sleeps,0);
});
