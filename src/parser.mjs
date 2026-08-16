import { MATERIALS_PATH, VIDEO_DOWNLOAD_PATH, XCURSOS_ORIGIN } from './constants.mjs';
import { decodeHtmlEntities, redactUrl, stripTags } from './utils.mjs';

const TRUSTED_PLAYER_HOSTS = [
  'player.vimeo.com','vimeo.com','www.youtube.com','youtube.com','www.youtube-nocookie.com','youtube-nocookie.com',
  'fast.wistia.net','fast.wistia.com','wistia.com','www.loom.com','loom.com','player.hotmart.com',
];
const ANALYTICS_HOST_RE = /(?:^|\.)(?:googletagmanager\.com|google-analytics\.com|doubleclick\.net|googlesyndication\.com|facebook\.net|connect\.facebook\.net)$/i;

function attr(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i');
  const m = String(tag || '').match(re);
  return m ? decodeHtmlEntities(m[1]) : null;
}

function tagTexts(html, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  return [...String(html).matchAll(re)].map(m => stripTags(m[1])).filter(Boolean);
}

function hostOf(url=''){
  try{return new URL(String(url)).hostname.toLowerCase();}catch{return '';}
}

export function isTrustedPlayerIframeUrl(url=''){
  const host=hostOf(url);if(!host||ANALYTICS_HOST_RE.test(host))return false;
  return TRUSTED_PLAYER_HOSTS.some(allowed=>host===allowed||host.endsWith(`.${allowed}`));
}

export function mediaSourceConfidence({videoUrl=null,mediaType='NONE'}={}){
  if(!/^https?:/i.test(String(videoUrl||'')))return 'UNTRUSTED';
  if(['DIRECT_MP4','HLS','DASH'].includes(mediaType))return 'PROVEN';
  if(mediaType==='EXTERNAL_IFRAME'&&isTrustedPlayerIframeUrl(videoUrl))return 'SUPPORTED_IFRAME';
  return 'UNTRUSTED';
}

export function isSafeDownloadMedia(meta={}){
  return mediaSourceConfidence(meta)!=='UNTRUSTED';
}

export function normalizeModulePath(modulePath=[],moduleName=null){
  const raw=Array.isArray(modulePath)?modulePath:[];const out=[];
  for(const value of raw){const text=String(value||'').trim();if(text&&out.at(-1)!==text)out.push(text);}
  const fallback=String(moduleName||'').trim();if(!out.length&&fallback)out.push(fallback);return out;
}

export function normalizeNativeDownloadUrl(rawUrl='',pageUrl=''){
  if(!rawUrl)return null;
  try{
    const url=new URL(decodeHtmlEntities(String(rawUrl)),pageUrl||XCURSOS_ORIGIN);
    if(url.origin!==XCURSOS_ORIGIN||url.pathname!==VIDEO_DOWNLOAD_PATH||!url.searchParams.get('lessonId'))return null;
    return url.toString();
  }catch{return null;}
}

export function extractNativeDownloadUrl(html='',pageUrl=''){
  for(const anchor of String(html).match(/<a\b[^>]*>/gi)||[]){
    const href=attr(anchor,'href');const normalized=normalizeNativeDownloadUrl(href,pageUrl);
    if(normalized)return normalized;
  }
  return null;
}

export function parseCounter(text = '') {
  const candidates = [];
  for (const re of [
    /(?:^|\s)(\d{1,5})\s*\/\s*(\d{1,5})(?!:)(?=\s|$)/g,
    /(?:^|\s)(\d{1,5})\s+de\s+(\d{1,5})(?=\s|$)/gi,
  ]) {
    for (const m of String(text).matchAll(re)) {
      const current = Number(m[1]); const total = Number(m[2]);
      if (current >= 1 && total >= current && total > 1) candidates.push({ current, total });
    }
  }
  if (!candidates.length) return null;
  const maxTotal=Math.max(...candidates.map(x=>x.total));
  const relevant=candidates.filter(x=>x.total===maxTotal);
  const counts=new Map();
  for(const item of relevant){const key=`${item.current}/${item.total}`;counts.set(key,(counts.get(key)||0)+1);}
  const ranked=[...counts.entries()].map(([key,count])=>{const [current,total]=key.split('/').map(Number);return{current,total,count};}).sort((a,b)=>b.count-a.count||a.current-b.current);
  if(ranked.length>1 && ranked[0].count===ranked[1].count)return null;
  return {current:ranked[0].current,total:ranked[0].total};
}

function classifyMediaUrl(url, source = 'unknown') {
  if (!url || String(url).includes(MATERIALS_PATH)) return null;
  const value = decodeHtmlEntities(url);
  if(source==='iframe'&&!isTrustedPlayerIframeUrl(value))return null;
  let type = 'UNKNOWN';
  if (/\.mp4(?:[?#]|$)/i.test(value)) type = 'DIRECT_MP4';
  else if (/\.m3u8(?:[?#]|$)/i.test(value)) type = 'HLS';
  else if (/\.mpd(?:[?#]|$)/i.test(value)) type = 'DASH';
  else if (source === 'iframe') type = 'EXTERNAL_IFRAME';
  return { url: value, type, source, redacted: redactUrl(value) };
}

export function extractMedia(html = '') {
  const value = String(html);
  const candidates = [];
  for (const video of value.match(/<video\b[^>]*>/gi) || []) {
    const src = attr(video, 'src');
    const c = classifyMediaUrl(src, 'video.src'); if (c) candidates.push(c);
  }
  for (const source of value.match(/<source\b[^>]*>/gi) || []) {
    const src = attr(source, 'src');
    const c = classifyMediaUrl(src, 'source.src'); if (c) candidates.push(c);
  }
  for (const iframe of value.match(/<iframe\b[^>]*>/gi) || []) {
    const src = attr(iframe, 'src');
    const c = classifyMediaUrl(src, 'iframe'); if (c) candidates.push(c);
  }
  const priority = { DIRECT_MP4: 5, HLS: 4, DASH: 3, EXTERNAL_IFRAME: 2, UNKNOWN: 1 };
  candidates.sort((a, b) => (priority[b.type] || 0) - (priority[a.type] || 0));
  return candidates[0] || null;
}

function detectDrm(html = '') {
  const s = String(html);
  return /com\.widevine\.alpha|playready|fairplay|widevine|drm[_-]?protected|license(?:Url|_url)\s*[:=]/i.test(s);
}

function chooseCourseName(html) {
  const h2s = tagTexts(html, 'h2');
  const candidates = h2s.filter(t =>
    !/^assistir aula/i.test(t) &&
    !/^\d+\.?\s*(?:aulas?|arquivos?)/i.test(t) &&
    t.length >= 4
  );
  return candidates[0] || null;
}

function chooseModuleName(html, lessonTitle) {
  const h1Index = String(html).search(/<h1\b/i);
  if (h1Index < 0) return null;
  const before = String(html).slice(Math.max(0, h1Index - 3500), h1Index);
  const ps = tagTexts(before, 'p').reverse();
  const pCandidate = ps.find(t => /^\d+\.\s+.+/.test(t) && t !== lessonTitle);
  if (pCandidate) return pCandidate;
  const text = stripTags(before);
  const chunks = text.split(/(?=\d+\.\s)/).map(x => x.trim()).filter(Boolean);
  const m = chunks.at(-1)?.match(/(\d+\.\s[^|•]{1,120})$/)?.[1];
  return m?.trim() || null;
}

export function parseXcursosLessonHtml(html, pageUrl = '') {
  if (!html || typeof html !== 'string') throw new Error('HTML vazio ou inválido.');
  const value=String(html);const bodyText = stripTags(value);
  const h1s = tagTexts(value, 'h1');
  const lessonTitle = h1s[0] || null;
  const counter = parseCounter(bodyText);
  const media = extractMedia(value);
  const nativeDownloadUrl=extractNativeDownloadUrl(value,pageUrl);
  const courseName = chooseCourseName(value);
  const moduleName = chooseModuleName(value, lessonTitle);
  const pageTitle = tagTexts(value, 'title')[0] || null;
  const videoTags=value.match(/<video\b[^>]*>/gi)||[];
  const iframeUrls=(value.match(/<iframe\b[^>]*>/gi)||[]).map(x=>attr(x,'src')).filter(Boolean);
  const hasTrustedPlayerIframe=iframeUrls.some(isTrustedPlayerIframeUrl);
  const hasUntrustedIframe=iframeUrls.some(x=>!isTrustedPlayerIframeUrl(x));
  const result={
    site: 'xcursos',pageUrl,pageTitle,courseName: courseName || 'Curso XCursos',lessonTitle: lessonTitle || 'Aula',moduleName,modulePath:normalizeModulePath([],moduleName),
    currentPosition: counter?.current ?? null,totalPositions: counter?.total ?? null,
    videoUrl: media?.url || null,videoUrlRedacted: media?.redacted || null,mediaType: media?.type || 'NONE',mediaSource: media?.source || null,
    nativeDownloadUrl,nativeDownloadAvailable:Boolean(nativeDownloadUrl),
    isSignedDirectMp4: Boolean(media?.type === 'DIRECT_MP4' && /[?&]X-Amz-/i.test(media.url)),
    hasMaterialsLinks: value.includes(MATERIALS_PATH),drmDetected: detectDrm(value),
    hasVideoElement:videoTags.length>0,hasTrustedPlayerIframe,hasUntrustedIframe,
  };
  return {...result,mediaSourceConfidence:mediaSourceConfidence(result)};
}

export function normalizeLiveLessonMeta(meta = {}, page = {}) {
  const direct = classifyMediaUrl(meta.videoUrl || meta.currentSrc || null, meta.mediaSource || 'live');
  const iframe = direct?null:classifyMediaUrl(meta.iframeUrl || null,'iframe');
  const media=direct||iframe;
  const current = Number(meta.currentPosition); const total = Number(meta.totalPositions);
  const hasTrustedPlayerIframe=Boolean(meta.hasTrustedPlayerIframe||(meta.iframeUrl&&isTrustedPlayerIframeUrl(meta.iframeUrl)));
  const hasUntrustedIframe=Boolean(meta.hasUntrustedIframe||(meta.iframeUrl&&!isTrustedPlayerIframeUrl(meta.iframeUrl)));
  const modulePath=normalizeModulePath(meta.modulePath,meta.moduleName);
  const pageUrl=meta.pageUrl || page.url || '';
  const nativeDownloadUrl=normalizeNativeDownloadUrl(meta.nativeDownloadUrl||null,pageUrl);
  const result={
    site: 'xcursos',pageUrl,pageTitle: meta.pageTitle || page.title || null,
    courseName: String(meta.courseName || '').trim() || 'Curso XCursos',lessonTitle: String(meta.lessonTitle || '').trim() || 'Aula',moduleName:modulePath.at(-1)||String(meta.moduleName || '').trim()||null,modulePath,
    currentPosition: Number.isFinite(current) && current > 0 ? current : null,totalPositions: Number.isFinite(total) && total > 1 ? total : null,
    videoUrl: media?.url || null,videoUrlRedacted: media?.redacted || null,mediaType: media?.type || 'NONE',mediaSource: media?.source || null,
    nativeDownloadUrl,nativeDownloadAvailable:Boolean(nativeDownloadUrl),
    isSignedDirectMp4: Boolean(media?.type === 'DIRECT_MP4' && /[?&]X-Amz-/i.test(media.url)),
    hasMaterialsLinks: Boolean(meta.hasMaterialsLinks),drmDetected: Boolean(meta.drmDetected),
    hasVideoElement:Boolean(meta.hasVideoElement),hasTrustedPlayerIframe,hasUntrustedIframe,
  };
  return {...result,mediaSourceConfidence:mediaSourceConfidence(result)};
}
