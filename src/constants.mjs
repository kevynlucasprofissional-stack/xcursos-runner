export const XCURSOS_ORIGIN = 'https://www.xcursos.com';
export const XCURSOS_HOME_URL = `${XCURSOS_ORIGIN}/`;
export const MATERIALS_PATH = '/api/materials/download';
export const LESSON_URL_RE = /^https:\/\/www\.xcursos\.com\/curso\/[^/]+\/aula\/[^/?#]+/i;

export const TERMINAL_STATUSES = new Set([
  'DOWNLOADED','ALREADY_PRESENT','NO_VIDEO','DRM_PROTECTED','SKIPPED',
  'DOWNLOAD_FAILED','VERIFY_FAILED','MEDIA_NOT_FOUND','MEDIA_NOT_READY',
]);
export const FILE_BACKED_STATUSES = new Set(['DOWNLOADED','ALREADY_PRESENT']);
export const RETRYABLE_FAILURE_STATUSES = new Set(['DOWNLOAD_FAILED','VERIFY_FAILED','MEDIA_NOT_FOUND','MEDIA_NOT_READY']);

export const LESSON_SKIP_POLICIES = Object.freeze([
  Object.freeze({
    id:'vtsd-2026-audio-ads-106-123',
    courseName:'VENDA TODO SANTO DIA 2026 - LEANDRO LADEIRA',
    totalPositions:198,
    ranges:Object.freeze([Object.freeze({start:106,end:123})]),
    reason:'USER_EXCLUDED_AD_AUDIO_BLOCK',
    label:'Propagandas em áudio',
  }),
]);

export const DEFAULT_LIMITS = Object.freeze({
  browserLaunchTimeoutMs: 30_000,
  navigationTimeoutMs: 30_000,
  inspectTimeoutMs: 30_000,
  transitionTimeoutMs: 20_000,
  transitionPollMs: 500,
  actionabilityTrialTimeoutMs: 1_500,
  nextPostActionObservationMs: 2_000,
  nextRecoveryObservationMs: 750,
  mediaReadyTimeoutMs: 12_000,
  mediaReadyPollMs: 250,
  navigationRetries: 1,
  mediaRefreshRetries: 2,
  downloadRetries: 2,
  retryBaseDelayMs: 100,
  retryMaxDelayMs: 5_000,
  retryJitterRatio: 0.15,
  throttleMinDelayMs: 0,
  throttleMaxDelayMs: 3_000,
  downloadTimeoutMs: 6 * 60 * 60 * 1000,
  ffprobeTimeoutMs: 30_000,
});
