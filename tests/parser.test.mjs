import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parseCounter, parseXcursosLessonHtml } from '../src/parser.mjs';

const realHtml=await fs.readFile(new URL('../test-fixtures/xcursos-real.htm',import.meta.url),'utf8');

test('M2 regression: real XCursos fixture',()=>{const r=parseXcursosLessonHtml(realHtml,'https://www.xcursos.com/fixture');assert.equal(r.courseName,'VENDA TODO SANTO DIA 2026 - LEANDRO LADEIRA');assert.equal(r.lessonTitle,'Visão Geral');assert.equal(r.moduleName,'1. Visão Geral');assert.equal(r.currentPosition,5);assert.equal(r.totalPositions,198);assert.equal(r.mediaType,'DIRECT_MP4');assert.equal(r.isSignedDirectMp4,true);assert.equal(r.hasMaterialsLinks,true);assert.ok(r.videoUrl.includes('&'));assert.ok(!r.videoUrl.includes('&amp;'));});

test('counter variants',()=>{assert.deepEqual(parseCounter(' 5 / 198 '),{current:5,total:198});assert.deepEqual(parseCounter('5/198'),{current:5,total:198});assert.deepEqual(parseCounter('5 de 198'),{current:5,total:198});});

test('source[src] and HTML entities',()=>{const h='<h2>Course</h2><h1>A</h1><span>1 / 2</span><video><source src="https://cdn/a.mp4?x=1&amp;y=2"></video>';const r=parseXcursosLessonHtml(h);assert.equal(r.mediaType,'DIRECT_MP4');assert.equal(r.videoUrl,'https://cdn/a.mp4?x=1&y=2');});

test('HLS, DASH and iframe fallbacks',()=>{assert.equal(parseXcursosLessonHtml('<h2>C</h2><h1>A</h1>1/2<video src="x.m3u8"></video>').mediaType,'HLS');assert.equal(parseXcursosLessonHtml('<h2>C</h2><h1>A</h1>1/2<source src="x.mpd">').mediaType,'DASH');assert.equal(parseXcursosLessonHtml('<h2>C</h2><h1>A</h1>1/2<iframe src="https://vimeo.com/1"></iframe>').mediaType,'EXTERNAL_IFRAME');});

test('materials are never media',()=>{const r=parseXcursosLessonHtml('<h2>C</h2><h1>A</h1><span>1/2</span><a href="/api/materials/download?lessonId=x">PDF</a>');assert.equal(r.videoUrl,null);assert.equal(r.mediaType,'NONE');assert.equal(r.hasMaterialsLinks,true);assert.equal(r.nativeDownloadAvailable,false);});

test('native lesson download is detected independently from materials',()=>{
  const h='<h2>C</h2><h1>A</h1><span>1/2</span><a href="/api/materials/download?lessonId=x&index=0">PDF</a><a href="https://www.xcursos.com/api/video/download?lessonId=lesson-123">Baixar aula</a><video src="https://cdn/x.mp4"></video>';
  const r=parseXcursosLessonHtml(h,'https://www.xcursos.com/curso/c/aula/a');
  assert.equal(r.nativeDownloadAvailable,true);
  assert.equal(r.nativeDownloadUrl,'https://www.xcursos.com/api/video/download?lessonId=lesson-123');
  assert.equal(r.hasMaterialsLinks,true);
  assert.equal(r.mediaType,'DIRECT_MP4');
});

test('native lesson download rejects cross-origin and malformed lookalikes',()=>{
  const cross=parseXcursosLessonHtml('<h2>C</h2><h1>A</h1>1/2<a href="https://evil.example/api/video/download?lessonId=x">Baixar aula</a>','https://www.xcursos.com/curso/c/aula/a');
  const missingId=parseXcursosLessonHtml('<h2>C</h2><h1>A</h1>1/2<a href="/api/video/download">Baixar aula</a>','https://www.xcursos.com/curso/c/aula/a');
  assert.equal(cross.nativeDownloadAvailable,false);
  assert.equal(missingId.nativeDownloadAvailable,false);
});

test('direct media wins over iframe',()=>{const r=parseXcursosLessonHtml('<h2>C</h2><h1>A</h1>1/2<iframe src="https://x/embed"></iframe><video src="https://cdn/x.mp4"></video>');assert.equal(r.mediaType,'DIRECT_MP4');});

test('duplicate desktop/mobile counters do not double progress',()=>{const r=parseXcursosLessonHtml('<h2>C</h2><h1>A</h1><div>5 / 198</div><div>5 / 198</div><video src="x.mp4"></video>');assert.equal(r.currentPosition,5);assert.equal(r.totalPositions,198);});

test('module and counter may be absent without crashing',()=>{const r=parseXcursosLessonHtml('<h2>Course</h2><h1>Lesson</h1><video src="x.mp4"></video>');assert.equal(r.moduleName,null);assert.equal(r.currentPosition,null);assert.equal(r.courseName,'Course');});

test('generic title is not used as course',()=>{const r=parseXcursosLessonHtml('<title>Assistir Aula | XCURSOS</title><h1>Lesson</h1>1/2');assert.equal(r.courseName,'Curso XCursos');assert.equal(r.pageTitle,'Assistir Aula | XCURSOS');});

test('real fixture proves sidebar button index is NOT the global position source',()=>{const aside=realHtml.slice(realHtml.indexOf('<aside'),realHtml.indexOf('</aside>')+8);const circlePlay=(aside.match(/lucide-circle-play/g)||[]).length;const parsed=parseXcursosLessonHtml(realHtml);assert.equal(parsed.totalPositions,198);assert.ok(circlePlay>0);assert.notEqual(circlePlay,parsed.totalPositions);});

test('conflicting duplicated global counters use majority and refuse an ambiguous tie',()=>{
  assert.deepEqual(parseCounter('5 / 198 x 5/198 y 6 de 198'),{current:5,total:198});
  assert.equal(parseCounter('5 / 198 x 6/198'),null);
});
