// ==UserScript==
// @name         小鹅通课程页布局重构
// @namespace    https://github.com/StreetCornelia/xet-plus
// @version      0.3.14
// @description  重构课程页：16:9 播放器、默认网页宽屏、播放参数记忆、多系列选集 tab、无刷新切课
// @author       Dash
// @match        https://*.pc.xiaoe-tech.com/p/t_pc/course_pc_detail/video/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=xiaoeknow.com
// @run-at       document-start
// @grant        none
// @license      MIT
// @homepageURL  https://github.com/StreetCornelia/xet-plus
// @supportURL   https://github.com/StreetCornelia/xet-plus/issues
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const STYLE_ID = 'xet-layout-style';
  const STYLE_VERSION = '0.3.14';
  const PREFS_KEY = 'xet-playback-prefs-v1';
  const CATALOG_API = '/xe.course.business_go.avoidlogin.e_course.resource_catalog_list.get/1.0.0';
  const SUB_CATALOG_API = '/xe.course.business_go.avoidlogin.e_course.sub.course.list/1.0.0';
  const CHAPTER_STATE_KEY = 'xet-playlist-chapters-v1';
  const CATALOG_TTL = 10 * 60 * 1000;
  const APPLY_DELAY = 1200;
  const APPLY_RETRY = 200;
  const APPLY_MAX_RETRIES = 8;
  const FULL_CLASSES = [
    'xgplayer-is-css-fullscreen',
    'xgplayer-is-cssfullscreen',
    'xgplayer-is-fullscreen',
    'xgplayer-page-fullscreen',
  ];
  const FULL_SEL = FULL_CLASSES.map((c) => '.' + c).join(',');

  let bypass = false;
  let exiting = false;
  let restoring = false;
  let stateBeforeNative = null;
  let lastWide = false;
  let lastNative = false;
  let initialWideDone = false;
  let wideRetryTimer = 0;
  let wideRetryCount = 0;
  let observedRoot = null;
  let resizeObserver = null;
  let observedPlayerBox = null;
  let updateTimer = 0;
  let resizeTimer = 0;
  let preClickPaused = null;
  let clickResetTimer = 0;
  let pendingClick = null;
  let bypassClick = false;
  let watchedVideo = null;
  let watchedTitle = null;
  let watchedDocTitle = null;
  let lastTitleText = '';
  let titleObserver = null;
  let docTitleObserver = null;
  let srcObserver = null;
  let historyPatched = false;
  let repairDone = false;
  let repairTimer = 0;
  let applyToken = 0;
  let applyTimer = 0;
  let applyRetryTimer = 0;
  let applying = false;
  let volumeGestureUntil = 0;
  let rateGestureUntil = 0;
  let startupUntil = 0;
  let startupRepairCount = 0;
  let playRestoreDone = false;
  let pageActive = null;
  let catalogTree = null;
  let catalogCourseId = '';
  let catalogFetchedAt = 0;
  let catalogPromise = null;
  let playlistButton = null;
  let playlistPanel = null;
  let playlistOpen = false;
  let playlistSearch = '';
  let playlistScrollTop = 0;
  let playlistRestoreScroll = false;
  let playlistActiveRid = '';
  let playlistCurrentChapterId = '';
  let playlistSeriesIndex = -1;
  let playlistPrefetchTimer = 0;
  let catalogPrefetchDone = false;
  let chapterOverrides = new Map();
  let chapterStateCourseId = '';
  let hoverOpenTimer = 0;
  let hoverCloseTimer = 0;
  let seamlessSwitching = false;
  let activeLessonPath = location.pathname;
  const originalJumpTargetUrl = new WeakMap();
  const originalChangeNextVideoEvent = new WeakMap();

  function isPlaybackPage() {
    return /\/course_pc_detail\/video\/[^/]*v_[A-Za-z0-9]+/.test(location.pathname);
  }

  function getPlayerRoot() {
    return (
      document.querySelector('#pc_course_fe_basic_video') ||
      document.querySelector('.xgplayer') ||
      document.querySelector('video')?.closest('.xgplayer')
    );
  }

  function isWebFullscreen() {
    const root = getPlayerRoot();
    if (!root) return false;
    const rect = root.getBoundingClientRect();
    const style = getComputedStyle(root);
    const coversViewport =
      Math.abs(rect.width - window.innerWidth) <= 2 && Math.abs(rect.height - window.innerHeight) <= 2;
    if (!coversViewport) return false;
    return style.position === 'fixed' || root.matches(FULL_SEL);
  }

  function isNativeFullscreen() {
    return !!document.fullscreenElement;
  }

  function injectStyle() {
    const existing = document.getElementById(STYLE_ID);
    if (existing && existing.dataset.version === STYLE_VERSION) return;
    if (existing) existing.remove();
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.dataset.version = STYLE_VERSION;
    style.textContent = `
      body.xet-rebuild {
        --xet-max-w: 1200px;
        --xet-gutter: 24px;
        --xet-rail-w: 0px;
      }

      body.xet-rebuild .content_header,
      body.xet-rebuild .course-player-box,
      body.xet-rebuild .video-content-header {
        height: auto !important;
      }

      body.xet-rebuild .video-player:not(.xgplayer-is-css-fullscreen):not(.xgplayer-is-cssfullscreen):not(.xgplayer-is-fullscreen):not(.xgplayer-page-fullscreen) {
        width: min(var(--xet-max-w), calc(100% - var(--xet-gutter) - var(--xet-gutter) - var(--xet-rail-w))) !important;
        max-width: none !important;
        margin: 12px auto 0 !important;
        height: auto !important;
        aspect-ratio: 16 / 9;
      }

      body.xet-rebuild .video-player:not(.xgplayer-is-css-fullscreen):not(.xgplayer-is-cssfullscreen):not(.xgplayer-is-fullscreen):not(.xgplayer-page-fullscreen)
        > #pc_course_fe_basic_video:not(.xgplayer-is-css-fullscreen):not(.xgplayer-is-cssfullscreen):not(.xgplayer-is-fullscreen):not(.xgplayer-page-fullscreen) {
        width: 100% !important;
        height: 100% !important;
      }

      body.xet-rebuild .video-player xg-poster,
      body.xet-rebuild .video-player .xgplayer-poster {
        width: 100% !important;
        height: 100% !important;
        left: 0 !important;
        top: 0 !important;
        right: auto !important;
        bottom: auto !important;
        margin: 0 !important;
        transform: none !important;
        background-size: cover !important;
        background-position: center !important;
      }

      body.xet-rebuild .video-title {
        width: min(var(--xet-max-w), calc(100% - var(--xet-gutter) - var(--xet-gutter) - var(--xet-rail-w))) !important;
        height: auto !important;
        margin: 8px auto 0 !important;
        padding-top: 8px !important;
      }

      body.xet-rebuild .video-title .intro-right-box {
        display: none !important;
      }

      body.xet-rebuild .video-title__font,
      body.xet-rebuild .video-title__font > div {
        width: 100% !important;
        max-width: 100% !important;
        height: auto !important;
        white-space: normal !important;
        overflow: visible !important;
        text-overflow: clip !important;
      }

      body.xet-rebuild .video-title__font {
        flex: 1 1 auto !important;
        min-width: 0 !important;
      }

      body.xet-rebuild .content_header {
        margin-bottom: 0 !important;
      }

      body.xet-rebuild .video-content-header {
        padding: 0 !important;
      }

      body.xet-rebuild .main_content {
        display: none !important;
      }

      body.xet-rebuild.xet-fs-wide .navbar-wrapper,
      body.xet-rebuild.xet-fs-wide .footer-content {
        display: none !important;
      }

      body.xet-rebuild .xgplayer-back {
        display: none !important;
      }

      body.xet-rebuild.xet-fs-wide .xgplayer-cssfullscreen,
      body.xet-rebuild.xet-fs-wide .xgplayer-fullscreen,
      body.xet-rebuild.xet-native-full .xgplayer-cssfullscreen,
      body.xet-rebuild.xet-native-full .xgplayer-fullscreen {
        display: block !important;
      }

      body.xet-rebuild .xg-right-grid .xgplayer-playlist {
        order: 4;
        display: flex !important;
        align-items: center;
        width: auto !important;
        min-width: 34px;
        height: 40px;
        margin-left: 32px;
        cursor: pointer;
        color: rgba(255, 255, 255, 0.8);
      }

      body.xet-rebuild .xg-right-grid .xgplayer-playlist:hover,
      body.xet-rebuild .xg-right-grid .xgplayer-playlist.active {
        color: #fff;
      }

      body.xet-rebuild .xg-right-grid .xgplayer-playlist .xgplayer-icon {
        width: auto !important;
        min-width: 26px;
        padding: 0 4px;
        overflow: visible !important;
        font-size: 13px;
        line-height: 40px;
        white-space: nowrap;
      }

      body.xet-rebuild .xg-right-grid .xgplayer-playlist .icon-text {
        font-size: 13px;
        line-height: 40px;
        white-space: nowrap;
      }

      body.xet-rebuild .xet-playlist-panel {
        position: absolute;
        right: 12px;
        bottom: 72px;
        z-index: 50;
        width: max-content;
        max-width: min(50vw, calc(100% - 24px));
        max-height: calc(100% - 84px);
        display: flex;
        flex-direction: column;
        background: rgba(18, 22, 30, 0.97);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 10px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
        color: #e8edf5;
        font-family: inherit;
        font-size: 13px;
        line-height: 1.4;
        overflow: hidden;
        animation: xet-pl-in 0.12s ease-out;
      }

      body.xet-rebuild .xet-playlist-panel[hidden] {
        display: none !important;
      }

      body.xet-rebuild .xet-playlist-panel [hidden] {
        display: none !important;
      }

      body.xet-rebuild .xet-playlist-panel,
      body.xet-rebuild .xet-playlist-panel *,
      body.xet-rebuild .xet-playlist-panel *::before,
      body.xet-rebuild .xet-playlist-panel *::after {
        box-sizing: border-box;
      }

      @keyframes xet-pl-in {
        from {
          opacity: 0;
          transform: translateY(6px);
        }
        to {
          opacity: 1;
          transform: none;
        }
      }

      body.xet-rebuild .xet-pl-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px 8px;
      }

      body.xet-rebuild .xet-pl-title {
        font-size: 14px;
        font-weight: 600;
        color: #fff;
      }

      body.xet-rebuild .xet-pl-count {
        font-size: 11px;
        color: rgba(255, 255, 255, 0.45);
      }

      body.xet-rebuild .xet-pl-actions {
        display: flex;
        align-items: center;
        gap: 2px;
        margin-left: auto;
      }

      body.xet-rebuild .xet-pl-action {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        padding: 0;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: rgba(255, 255, 255, 0.55);
        cursor: pointer;
      }

      body.xet-rebuild .xet-pl-action:hover {
        background: rgba(255, 255, 255, 0.08);
        color: #fff;
      }

      body.xet-rebuild .xet-pl-locate.is-hidden {
        visibility: hidden;
        pointer-events: none;
      }

      body.xet-rebuild .xet-pl-action svg {
        width: 14px;
        height: 14px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.8;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      body.xet-rebuild .xet-pl-close {
        position: relative;
        width: 26px;
        height: 26px;
        padding: 0;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: rgba(255, 255, 255, 0.55);
        font-size: 20px;
        line-height: 1;
        cursor: pointer;
      }

      body.xet-rebuild .xet-pl-action::after,
      body.xet-rebuild .xet-pl-close::after {
        content: attr(data-tip);
        position: absolute;
        top: calc(100% + 6px);
        left: 50%;
        z-index: 5;
        padding: 3px 7px;
        border-radius: 4px;
        background: rgba(4, 8, 14, 0.94);
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
        color: #dfe8f4;
        font-size: 11px;
        font-weight: 400;
        line-height: 1.35;
        white-space: nowrap;
        pointer-events: none;
        opacity: 0;
        visibility: hidden;
        transform: translate(-50%, -2px);
        transition: opacity 0.12s ease, transform 0.12s ease;
      }

      body.xet-rebuild .xet-pl-action:hover::after,
      body.xet-rebuild .xet-pl-action:focus-visible::after,
      body.xet-rebuild .xet-pl-close:hover::after,
      body.xet-rebuild .xet-pl-close:focus-visible::after {
        opacity: 1;
        visibility: visible;
        transform: translate(-50%, 0);
      }

      body.xet-rebuild .xet-pl-close:hover {
        background: rgba(255, 255, 255, 0.08);
        color: #fff;
      }

      body.xet-rebuild .xet-pl-search-wrap {
        padding: 0 12px 8px;
      }

      body.xet-rebuild .xet-pl-search {
        box-sizing: border-box;
        width: 100%;
        padding: 7px 9px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.06);
        color: #fff;
        font-family: inherit;
        font-size: 12px;
        outline: none;
      }

      body.xet-rebuild .xet-pl-search::placeholder {
        color: rgba(255, 255, 255, 0.35);
      }

      body.xet-rebuild .xet-pl-search:focus {
        border-color: #4aa8ff;
      }

      body.xet-rebuild .xet-playlist-panel.has-series {
        min-width: 320px;
      }

      body.xet-rebuild .xet-pl-series-tabs {
        display: flex;
        flex: 0 0 auto;
        gap: 4px;
        padding: 0 12px 8px;
        overflow-x: auto;
        overflow-y: hidden;
        scrollbar-width: none;
      }

      body.xet-rebuild .xet-pl-series-tabs::-webkit-scrollbar {
        display: none;
      }

      body.xet-rebuild .xet-pl-series-tab {
        flex: 0 0 auto;
        max-width: 220px;
        padding: 5px 10px;
        border: 1px solid transparent;
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.055);
        color: rgba(255, 255, 255, 0.62);
        font-family: inherit;
        font-size: 12px;
        line-height: 1.35;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        cursor: pointer;
      }

      body.xet-rebuild .xet-pl-series-tab:hover {
        background: rgba(255, 255, 255, 0.09);
        color: #fff;
      }

      body.xet-rebuild .xet-pl-series-tab.active {
        border-color: rgba(74, 168, 255, 0.46);
        background: rgba(74, 168, 255, 0.17);
        color: #fff;
      }

      body.xet-rebuild .xet-pl-body {
        position: relative;
        flex: 1 1 auto;
        overflow-y: auto;
        overflow-x: hidden;
        padding: 2px 0 8px;
      }

      body.xet-rebuild .xet-pl-body::-webkit-scrollbar {
        width: 6px;
      }

      body.xet-rebuild .xet-pl-body::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.18);
        border-radius: 3px;
      }

      body.xet-rebuild .xet-pl-group {
        padding: 9px 14px 4px;
        font-size: 11px;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.42);
      }

      body.xet-rebuild .xet-pl-chapter {
        margin: 0 6px;
      }

      body.xet-rebuild .xet-pl-chapter-head {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 7px 8px;
        border: 0;
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.035);
        color: rgba(255, 255, 255, 0.82);
        font-family: inherit;
        font-size: 12px;
        text-align: left;
        cursor: pointer;
      }

      body.xet-rebuild .xet-pl-chapter-head:hover {
        background: rgba(255, 255, 255, 0.07);
      }

      body.xet-rebuild .xet-pl-chapter-title {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }

      body.xet-rebuild .xet-pl-chapter-count {
        flex: 0 0 auto;
        font-size: 11px;
        color: rgba(255, 255, 255, 0.4);
        white-space: nowrap;
      }

      body.xet-rebuild .xet-pl-chevron {
        flex: 0 0 auto;
        font-size: 10px;
        color: rgba(255, 255, 255, 0.4);
        transition: transform 0.12s;
      }

      body.xet-rebuild .xet-pl-chapter.collapsed .xet-pl-chevron {
        transform: rotate(-90deg);
      }

      body.xet-rebuild .xet-pl-chapter.collapsed .xet-pl-items {
        display: none;
      }

      body.xet-rebuild .xet-pl-items {
        padding: 2px 0 4px;
      }

      body.xet-rebuild .xet-pl-item {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        padding: 6px 8px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: #dbe3ee;
        font-family: inherit;
        font-size: 12.5px;
        text-align: left;
        cursor: pointer;
      }

      body.xet-rebuild .xet-pl-item:hover {
        background: rgba(255, 255, 255, 0.07);
      }

      body.xet-rebuild .xet-pl-item.current {
        background: rgba(74, 168, 255, 0.16);
        color: #8ec5ff;
        box-shadow: inset 2px 0 0 #4aa8ff;
      }

      body.xet-rebuild .xet-pl-item-title {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }

      body.xet-rebuild .xet-pl-item-title mark,
      body.xet-rebuild .xet-pl-chapter-title mark {
        background: rgba(74, 168, 255, 0.24);
        color: #cfe7ff;
        border-radius: 2px;
      }

      body.xet-rebuild .xet-pl-item-meta {
        flex: 0 0 auto;
        font-size: 11px;
        color: rgba(255, 255, 255, 0.42);
        white-space: nowrap;
      }

      body.xet-rebuild .xet-pl-item.current .xet-pl-item-meta {
        color: #8ec5ff;
      }

      body.xet-rebuild .xet-pl-item.done .xet-pl-item-meta {
        color: #6fcf97;
      }

      body.xet-rebuild .xet-pl-item.locked {
        opacity: 0.55;
      }

      body.xet-rebuild .xet-pl-message {
        padding: 26px 16px;
        text-align: center;
        color: rgba(255, 255, 255, 0.55);
        font-size: 12px;
        line-height: 1.7;
      }

      body.xet-rebuild .xet-pl-empty {
        padding: 26px 16px;
        text-align: center;
        color: rgba(255, 255, 255, 0.45);
        font-size: 12px;
      }

      body.xet-rebuild .xet-pl-retry {
        margin-top: 10px;
        padding: 5px 12px;
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.06);
        color: #fff;
        font-family: inherit;
        font-size: 12px;
        cursor: pointer;
      }

      body.xet-rebuild .xet-pl-retry:hover {
        background: rgba(255, 255, 255, 0.12);
      }

      body.xet-rebuild .xet-pl-chapter-error {
        padding: 6px 8px;
        font-size: 11px;
        color: #e0a0a0;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function setLabel(el, label) {
    if (!el) return;
    if (el.title !== label) el.title = label;
    if (el.getAttribute('aria-label') !== label) el.setAttribute('aria-label', label);
    if (el.getAttribute('data-title') !== label) el.setAttribute('data-title', label);

    for (const node of el.querySelectorAll('*')) {
      const text = (node.textContent || '').trim();
      if (
        text === '网页全屏' ||
        text === '恢复宽屏' ||
        text === '进入全屏' ||
        text === '退出全屏' ||
        text === '进入网页全屏' ||
        text === '恢复上一个状态'
      ) {
        if (node.children.length === 0 && node.textContent !== label) node.textContent = label;
      }
    }
  }

  function requestResize() {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    });
  }

  function getActiveVideo() {
    if (watchedVideo && watchedVideo.isConnected) return watchedVideo;
    return getPlayerRoot()?.querySelector('video') || null;
  }

  function normalizeVolume(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.min(1, Math.max(0, n));
  }

  function normalizeRate(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0.25 || n > 4) return null;
    return n;
  }

  function normalizePlaymode(value) {
    const s = String(value ?? '');
    return /^[123]$/.test(s) ? s : '';
  }

  function readPlaybackPrefs() {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      const value = raw ? JSON.parse(raw) : null;
      return value && typeof value === 'object' ? value : {};
    } catch (_) {
      return {};
    }
  }

  function savePlaybackPrefs(patch) {
    try {
      const next = { ...readPlaybackPrefs(), ...patch, updated: Date.now() };
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch (_) {}
  }

  function notePreferenceGesture(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const until = Date.now() + 3000;
    if (target.closest('.xgplayer-volume')) {
      volumeGestureUntil = until;
      startupUntil = 0;
    }
    if (target.closest('.xgplayer-playbackrate')) rateGestureUntil = until;
  }

  function onVolumeChange() {
    if (applying) return;
    const now = Date.now();
    if (now > volumeGestureUntil) {
      if (now < startupUntil && startupRepairCount < 3) {
        startupRepairCount += 1;
        armApply();
      }
      return;
    }
    const video = getActiveVideo();
    if (!video) return;
    savePlaybackPrefs({ volume: video.volume, muted: !!video.muted });
  }

  function onRateChange() {
    if (applying) return;
    if (Date.now() > rateGestureUntil) return;
    const video = getActiveVideo();
    if (!video) return;
    const rate = normalizeRate(video.playbackRate);
    if (rate !== null) savePlaybackPrefs({ rate });
  }

  function onPlaymodeClick(event) {
    if (applying) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const option = target.closest('.xgplayer-playmode .option-item');
    if (!option) return;
    const mode = normalizePlaymode(option.getAttribute('playmodetype') || option.getAttribute('showtext'));
    if (mode) savePlaybackPrefs({ playmode: mode });
  }

  function finishApply(token) {
    if (token !== applyToken) return;
    setTimeout(() => {
      if (token === applyToken) applying = false;
    }, 1000);
  }

  function applyPlaybackPrefs(token, attempt) {
    if (token !== applyToken) return;
    const video = getActiveVideo();
    if (!video) {
      if (attempt < APPLY_MAX_RETRIES) {
        clearTimeout(applyRetryTimer);
        applyRetryTimer = setTimeout(() => applyPlaybackPrefs(token, attempt + 1), APPLY_RETRY);
      } else {
        finishApply(token);
      }
      return;
    }

    const prefs = readPlaybackPrefs();
    const hasAny = prefs.volume != null || prefs.rate != null || prefs.playmode != null;
    if (!hasAny) {
      finishApply(token);
      return;
    }

    let missing = false;

    const volume = normalizeVolume(prefs.volume);
    if (volume !== null) {
      if (Math.abs(video.volume - volume) > 0.001) video.volume = volume;
      if (typeof prefs.muted === 'boolean' && video.muted !== prefs.muted) {
        video.muted = prefs.muted;
      }
    }

    const rate = normalizeRate(prefs.rate);
    if (rate !== null) {
      const option = document.querySelector(`.xgplayer-playbackrate .option-item[rate="${rate}"]`);
      if (option) {
        if (!option.classList.contains('selected')) option.click();
        if (Math.abs(video.playbackRate - rate) > 0.01) video.playbackRate = rate;
      } else {
        missing = true;
        if (Math.abs(video.playbackRate - rate) > 0.01) video.playbackRate = rate;
      }
    }

    const mode = normalizePlaymode(prefs.playmode);
    if (mode) {
      const option = document.querySelector(`.xgplayer-playmode .option-item[playmodetype="${mode}"]`);
      if (option) {
        if (!option.classList.contains('selected')) option.click();
      } else {
        missing = true;
      }
    }

    if (missing && attempt < APPLY_MAX_RETRIES) {
      clearTimeout(applyRetryTimer);
      applyRetryTimer = setTimeout(() => applyPlaybackPrefs(token, attempt + 1), APPLY_RETRY);
      return;
    }

    if (!repairDone) {
      repairDone = true;
      clearTimeout(repairTimer);
      repairTimer = setTimeout(() => {
        if (token === applyToken) applyPlaybackPrefs(token, 0);
      }, 1400);
      return;
    }

    finishApply(token);
  }

  function armApply() {
    if (!isPlaybackPage() || !getActiveVideo()) return;
    const token = ++applyToken;
    applying = true;
    repairDone = false;
    clearTimeout(applyTimer);
    clearTimeout(applyRetryTimer);
    clearTimeout(repairTimer);
    applyTimer = setTimeout(() => applyPlaybackPrefs(token, 0), APPLY_DELAY);
  }

  function onVideoLoaded() {
    startupUntil = Date.now() + 15000;
    startupRepairCount = 0;
    playRestoreDone = false;
    armApply();
  }

  function onVideoPlaying() {
    if (playRestoreDone) return;
    playRestoreDone = true;
    startupUntil = Date.now() + 15000;
    startupRepairCount = 0;
    if (Date.now() <= volumeGestureUntil) return;
    armApply();
  }

  function watchVideo() {
    const video = getPlayerRoot()?.querySelector('video');
    if (!video || video === watchedVideo) return;

    if (watchedVideo) {
      watchedVideo.removeEventListener('loadedmetadata', onVideoLoaded);
      watchedVideo.removeEventListener('loadstart', onVideoLoaded);
      watchedVideo.removeEventListener('emptied', onVideoLoaded);
      watchedVideo.removeEventListener('playing', onVideoPlaying);
      watchedVideo.removeEventListener('volumechange', onVolumeChange);
      watchedVideo.removeEventListener('ratechange', onRateChange);
    }

    watchedVideo = video;
    startupUntil = Date.now() + 15000;
    startupRepairCount = 0;
    playRestoreDone = false;
    video.addEventListener('loadedmetadata', onVideoLoaded);
    video.addEventListener('loadstart', onVideoLoaded);
    video.addEventListener('emptied', onVideoLoaded);
    video.addEventListener('playing', onVideoPlaying);
    video.addEventListener('volumechange', onVolumeChange);
    video.addEventListener('ratechange', onRateChange);

    if (srcObserver) srcObserver.disconnect();
    srcObserver = new MutationObserver(() => armApply());
    srcObserver.observe(video, { attributes: true, attributeFilter: ['src'] });

    if (video.readyState >= 1) armApply();
  }

  function watchTitle() {
    const title = document.querySelector('.video-title__font');
    if (!title) return;
    const text = (title.textContent || '').trim();

    if (title !== watchedTitle) {
      watchedTitle = title;
      if (titleObserver) titleObserver.disconnect();
      titleObserver = new MutationObserver(() => {
        const next = (title.textContent || '').trim();
        if (next && next !== lastTitleText) {
          lastTitleText = next;
          armApply();
        }
      });
      titleObserver.observe(title, { childList: true, subtree: true, characterData: true });
    }

    if (text && lastTitleText && text !== lastTitleText) {
      lastTitleText = text;
      armApply();
    } else if (text && !lastTitleText) {
      lastTitleText = text;
    }
  }

  function watchDocumentTitle() {
    const title = document.querySelector('title');
    if (!title || title === watchedDocTitle) return;
    watchedDocTitle = title;
    if (docTitleObserver) docTitleObserver.disconnect();
    docTitleObserver = new MutationObserver(() => {
      syncPageGate();
      if (isPlaybackPage()) {
        armApply();
        updatePlaylistCurrent();
      }
    });
    docTitleObserver.observe(title, { childList: true, subtree: true, characterData: true });
  }

  function getCourseId() {
    try {
      return new URL(location.href).searchParams.get('product_id') || '';
    } catch (_) {
      return '';
    }
  }

  function getCourseAppId() {
    return location.hostname.split('.')[0] || '';
  }

  function getCurrentResourceId() {
    const match = location.pathname.match(/\/course_pc_detail\/video\/(v_[A-Za-z0-9]+)/);
    return match ? match[1] : '';
  }

  function isVideoLessonUrl(url) {
    try {
      const parsed = new URL(url, location.origin);
      return (
        parsed.origin === location.origin &&
        /\/p\/t_pc\/course_pc_detail\/video\/v_[A-Za-z0-9]+/.test(parsed.pathname)
      );
    } catch (_) {
      return false;
    }
  }

  function waitForCondition(predicate, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const check = () => {
        let value = null;
        try {
          value = predicate();
        } catch (_) {}
        if (value) {
          resolve(value);
          return;
        }
        if (Date.now() - startedAt >= timeout) {
          reject(new Error('等待播放器初始化超时'));
          return;
        }
        requestAnimationFrame(check);
      };
      check();
    });
  }

  function invalidateVueComputed(component) {
    Object.values(component?._computedWatchers || {}).forEach((watcher) => {
      watcher.dirty = true;
    });
  }

  function resetPlayerState(playerVm) {
    playerVm.captionList = [];
    playerVm.routeListObj = {};
    playerVm.hasRouteList = false;
    playerVm.storageRoute = '';
    playerVm.playTime = 0;
    playerVm.isFirstReport = true;
    playerVm.videoUrls = [];
    playerVm.loopVideoForPackage = null;
  }

  async function refreshVideoPlayer(target, updateRoute) {
    const baseVm = document.querySelector('.course_base_layout')?.__vue__;
    const playerVm = document.querySelector('.video-content-header')?.__vue__;
    const router = baseVm?.$router;

    if (
      !baseVm ||
      !playerVm ||
      !router ||
      typeof baseVm.initCourseCoreData !== 'function' ||
      typeof playerVm.initVideo !== 'function'
    ) {
      throw new Error('未找到站点播放器局部刷新接口');
    }

    const wasWide = isWebFullscreen();

    try {
      playerVm.player?.pause?.();
      playerVm.player?.destroy?.();
    } catch (_) {}
    playerVm.player = null;

    if (updateRoute) {
      const route = `${target.pathname}${target.search}${target.hash}`;
      const navigation = router.push(route);
      if (navigation && typeof navigation.then === 'function') await navigation;
    }

    invalidateVueComputed(baseVm);
    invalidateVueComputed(playerVm);
    await baseVm.initCourseCoreData();
    invalidateVueComputed(baseVm);
    invalidateVueComputed(playerVm);

    resetPlayerState(playerVm);
    if (typeof playerVm.getVideoExchangeRouteList === 'function') {
      await playerVm.getVideoExchangeRouteList();
    }
    if (typeof playerVm.initCaptionsList === 'function') {
      await playerVm.initCaptionsList();
    }
    playerVm.initQuizz?.();
    playerVm.initVideo();

    const targetId = target.pathname.split('/').pop();
    await waitForCondition(
      () =>
        playerVm.player &&
        playerVm.resourceId === targetId &&
        document.querySelector('#pc_course_fe_basic_video video')
    );

    if (wasWide && !isWebFullscreen()) enterWebFullscreenWhenReady();
  }

  async function switchLessonSeamlessly(url) {
    if (!isVideoLessonUrl(url)) {
      location.assign(url);
      return;
    }
    if (seamlessSwitching) return;

    const target = new URL(url, location.origin);
    if (target.href === location.href) return;
    seamlessSwitching = true;
    closePlaylist();
    try {
      await refreshVideoPlayer(target, true);
      activeLessonPath = target.pathname;
      updatePlaylistCurrent();
      armApply();
      scheduleUpdate();
      requestResize();
    } catch (error) {
      console.warn('[xet] 无刷新切课失败，已回退到整页跳转。', error);
      location.assign(target.href);
    } finally {
      seamlessSwitching = false;
    }
  }

  function onHistoryLessonSwitch() {
    requestAnimationFrame(async () => {
      if (!isPlaybackPage() || seamlessSwitching) return;
      if (location.pathname === activeLessonPath) return;
      if (!isVideoLessonUrl(location.href)) {
        activeLessonPath = location.pathname;
        return;
      }

      const target = new URL(location.href);
      seamlessSwitching = true;
      try {
        await refreshVideoPlayer(target, false);
        activeLessonPath = target.pathname;
        updatePlaylistCurrent();
        armApply();
        scheduleUpdate();
        requestResize();
      } catch (error) {
        console.warn('[xet] 浏览器前进/后退切课失败，已刷新页面。', error);
        location.reload();
      } finally {
        seamlessSwitching = false;
      }
    });
  }

  function videoTargetToUrl(target) {
    const raw = typeof target === 'string' ? target : target?.url || target?.jump_url || '';
    if (!raw) return '';
    let parsed;
    try {
      parsed = new URL(raw, location.origin);
    } catch (_) {
      return '';
    }
    if (parsed.origin !== location.origin) return '';
    if (isVideoLessonUrl(parsed.href)) {
      return parsed.pathname.split('/').pop() === getCurrentResourceId() ? '' : parsed.href;
    }
    const rid = parsed.pathname.match(/\/p\/course\/video\/([^/?#]+)/)?.[1];
    return rid && rid !== getCurrentResourceId() ? sectionUrl({ rid, type: 3 }) : '';
  }

  function patchNativeNextNavigation() {
    const playerVm = document.querySelector('.video-content-header')?.__vue__;
    if (!playerVm) return;

    const funcTool = playerVm.$funcTool;
    if (
      funcTool &&
      typeof funcTool.jumpTargetUrl === 'function' &&
      !funcTool.jumpTargetUrl.__xetPatched
    ) {
      if (!originalJumpTargetUrl.has(funcTool)) {
        originalJumpTargetUrl.set(funcTool, funcTool.jumpTargetUrl);
      }
      const original = originalJumpTargetUrl.get(funcTool);
      const patched = function (target, ...args) {
        try {
          const url = videoTargetToUrl(target);
          if (url) {
            switchLessonSeamlessly(url);
            return;
          }
        } catch (_) {}
        return original.call(this, target, ...args);
      };
      patched.__xetPatched = true;
      try {
        funcTool.jumpTargetUrl = patched;
      } catch (_) {}
    }

    if (
      typeof playerVm.changeNextVideoEvent === 'function' &&
      !playerVm.changeNextVideoEvent.__xetPatched
    ) {
      if (!originalChangeNextVideoEvent.has(playerVm)) {
        originalChangeNextVideoEvent.set(playerVm, playerVm.changeNextVideoEvent);
      }
      const original = originalChangeNextVideoEvent.get(playerVm);
      const patched = async function (...args) {
        try {
          if (
            this.isPrdPackage &&
            !this.loopVideoForPackage?.next &&
            typeof this.initLoop === 'function'
          ) {
            await this.initLoop();
          }
          const url = videoTargetToUrl(this.loopVideoForPackage?.next);
          if (url) {
            switchLessonSeamlessly(url);
            return;
          }
        } catch (_) {}
        return original.apply(this, args);
      };
      patched.__xetPatched = true;
      try {
        playerVm.changeNextVideoEvent = patched;
      } catch (_) {}
    }
  }

  function normalizeSection(section) {
    return {
      rid: String(section.resource_id || ''),
      title: String(section.resource_title || section.chapter_title || '').trim(),
      type: Number(section.resource_type) || 0,
      duration: Math.max(0, Number(section.video_length) || 0),
      status: Number(section.study_status) || 0,
      progress: Math.max(0, Math.min(100, Number(section.learn_progress) || 0)),
      unlock: Number(section.unlock_state),
      isTry: Number(section.is_try) === 1,
      jumpUrl: String(section.jump_url || '')
    };
  }

  function makeCatalogChapter(item, childMap) {
    const entry = childMap.get(String(item.chapter_id));
    const list = entry ? entry.list : Array.isArray(item.children) ? item.children : [];
    return {
      id: String(item.chapter_id || ''),
      title: String(item.chapter_title || '').trim(),
      error: !!(entry && entry.error),
      sections: list.map(normalizeSection).filter((section) => section.rid && section.title)
    };
  }

  function buildCatalogTree(top, childMap, seriesEntries) {
    const series = Array.isArray(seriesEntries) ? seriesEntries : [];
    const hasSeries = series.length > 0 && top.some((item) => String(item.sub_course_id || ''));

    if (hasSeries) {
      const groups = [];
      const byId = new Map();

      for (const entry of series) {
        const group = { label: entry.title || '未命名系列', chapters: [], series: true };
        byId.set(entry.id, group);
        groups.push(group);
      }

      let fallback = null;

      for (const item of top) {
        const sectionNum = Math.max(0, Number(item.section_num) || 0);
        const type = Number(item.resource_type) || 0;
        let group = byId.get(String(item.sub_course_id || ''));

        if (!group) {
          if (!fallback) {
            fallback = { label: '未分组', chapters: [], series: true };
            groups.push(fallback);
          }
          group = fallback;
        }

        if (type === 0 && !sectionNum) {
          group.chapters.push({
            id: String(item.chapter_id || ''),
            title: String(item.chapter_title || '').trim(),
            sections: []
          });
          continue;
        }

        if (type !== 0 && !sectionNum) {
          group.chapters.push({
            id: String(item.chapter_id || ''),
            title: '',
            sections: [normalizeSection(item)]
          });
          continue;
        }

        group.chapters.push(makeCatalogChapter(item, childMap));
      }

      return groups.filter((group) => group.label || group.chapters.length);
    }

    const groups = [];
    let group = { label: '', chapters: [], series: false };
    groups.push(group);

    for (const item of top) {
      const sectionNum = Math.max(0, Number(item.section_num) || 0);
      const type = Number(item.resource_type) || 0;

      if (type === 0 && !sectionNum) {
        group = { label: String(item.chapter_title || '').trim(), chapters: [], series: false };
        groups.push(group);
        continue;
      }

      if (type !== 0 && !sectionNum) {
        group.chapters.push({
          id: String(item.chapter_id || ''),
          title: '',
          sections: [normalizeSection(item)]
        });
        continue;
      }

      group.chapters.push(makeCatalogChapter(item, childMap));
    }

    return groups.filter((group) => group.label || group.chapters.length);
  }

  async function catalogRequest(biz) {
    const courseId = getCourseId();
    const appId = getCourseAppId();
    if (!courseId || !appId) throw new Error('缺少课程信息');

    const response = await fetch(CATALOG_API, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', app_id: appId },
      body: JSON.stringify({
        bizData: {
          app_id: appId,
          course_id: courseId,
          page: 1,
          page_size: 1000,
          ...biz
        }
      })
    });

    if (!response.ok) throw new Error(`目录请求失败 (${response.status})`);
    const data = await response.json();
    if (!data || data.code !== 0) throw new Error((data && data.msg) || '目录请求失败');
    return (data.data && data.data.list) || [];
  }

  async function subCourseRequest() {
    const courseId = getCourseId();
    const appId = getCourseAppId();
    if (!courseId || !appId) return [];

    const response = await fetch(SUB_CATALOG_API, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', app_id: appId },
      body: JSON.stringify({
        bizData: {
          app_id: appId,
          course_id: courseId,
          page: 1,
          page_size: 1000
        }
      })
    });

    if (!response.ok) throw new Error(`系列请求失败 (${response.status})`);
    const data = await response.json();
    if (!data || data.code !== 0) throw new Error((data && data.msg) || '系列请求失败');

    const payload = data.data;
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.list)) return payload.list;
    return [];
  }

  async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index], index);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
  }

  function loadCatalog(force) {
    const courseId = getCourseId();
    if (!courseId) return Promise.resolve(null);
    if (!force && catalogTree && catalogCourseId === courseId) return Promise.resolve(catalogTree);
    if (catalogPromise) return catalogPromise;

    catalogPromise = (async () => {
      const cacheKey = `xet-catalog-v4:${courseId}`;

      if (!force) {
        try {
          const cached = JSON.parse(sessionStorage.getItem(cacheKey) || 'null');
          if (cached && cached.ts && Date.now() - cached.ts < CATALOG_TTL && Array.isArray(cached.groups)) {
            catalogTree = cached.groups;
            catalogCourseId = courseId;
            catalogFetchedAt = cached.ts;
            playlistSeriesIndex = -1;
            return catalogTree;
          }
        } catch (_) {}
      }

      const [top, rawSeries] = await Promise.all([
        catalogRequest({}),
        subCourseRequest().catch(() => [])
      ]);
      const seriesEntries = rawSeries
        .map((entry, index) => ({
          id: String(entry.sub_course_id || ''),
          title: String(
            entry.chapter_title || entry.sub_course_title || entry.resource_title || entry.title || `系列 ${index + 1}`
          ).trim()
        }))
        .filter((entry) => entry.id);
      const chapters = top.filter(
        (item) =>
          (Number(item.section_num) || 0) > 0 &&
          !(Array.isArray(item.children) && item.children.length)
      );
      const childMap = new Map();

      await mapLimit(chapters, 4, async (chapter) => {
        try {
          const list = await catalogRequest({ p_id: chapter.chapter_id });
          childMap.set(String(chapter.chapter_id), { list });
        } catch (_) {
          childMap.set(String(chapter.chapter_id), { list: [], error: true });
        }
      });

      catalogTree = buildCatalogTree(top, childMap, seriesEntries);
      catalogCourseId = courseId;
      catalogFetchedAt = Date.now();
      playlistSeriesIndex = -1;

      const hasError = [...childMap.values()].some((entry) => entry.error);
      if (!hasError) {
        try {
          sessionStorage.setItem(cacheKey, JSON.stringify({ ts: catalogFetchedAt, groups: catalogTree }));
        } catch (_) {}
      }

      return catalogTree;
    })().finally(() => {
      catalogPromise = null;
    });

    return catalogPromise;
  }

  function formatDuration(total) {
    const seconds = Math.max(0, Math.floor(Number(total) || 0));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function allCatalogSections() {
    const sections = [];
    for (const group of catalogTree || []) {
      for (const chapter of group.chapters || []) {
        for (const section of chapter.sections || []) sections.push(section);
      }
    }
    return sections;
  }

  function seriesCatalogGroups() {
    return (catalogTree || []).filter(
      (group) =>
        group.series &&
        (group.chapters || []).some(
          (chapter) => (chapter.sections || []).length > 0 || chapter.error
        )
    );
  }

  function usesSeriesTabs() {
    return seriesCatalogGroups().length > 1;
  }

  function displayCatalogGroups() {
    const seriesGroups = seriesCatalogGroups();
    return seriesGroups.length ? seriesGroups : catalogTree || [];
  }

  function findGroupIndexForRid(groups, rid) {
    if (!rid) return -1;
    return groups.findIndex((group) =>
      (group.chapters || []).some((chapter) =>
        (chapter.sections || []).some((section) => section.rid === rid)
      )
    );
  }

  function findCatalogSection(rid) {
    return allCatalogSections().find((section) => section.rid === rid) || null;
  }

  function ensureChapterState() {
    const courseId = getCourseId();
    if (chapterStateCourseId === courseId) return;
    chapterStateCourseId = courseId;
    chapterOverrides = new Map();
    if (!courseId) return;

    try {
      const raw = JSON.parse(localStorage.getItem(`${CHAPTER_STATE_KEY}:${courseId}`) || 'null');
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [id, value] of Object.entries(raw)) {
          if (typeof value === 'boolean') chapterOverrides.set(id, value);
        }
      }
    } catch (_) {}
  }

  function saveChapterState() {
    if (!chapterStateCourseId) return;
    try {
      const raw = {};
      for (const [id, value] of chapterOverrides) raw[id] = value;
      localStorage.setItem(`${CHAPTER_STATE_KEY}:${chapterStateCourseId}`, JSON.stringify(raw));
    } catch (_) {}
  }

  function isChapterExpanded(chapterId) {
    if (chapterOverrides.has(chapterId)) return chapterOverrides.get(chapterId);
    return !!playlistCurrentChapterId && chapterId === playlistCurrentChapterId;
  }

  function findCurrentChapterId(rid) {
    if (!rid) return '';
    for (const group of catalogTree || []) {
      for (const chapter of group.chapters || []) {
        if ((chapter.sections || []).some((section) => section.rid === rid)) return chapter.id;
      }
    }
    return '';
  }

  function setAllChapters(expanded) {
    ensureChapterState();
    if (!catalogTree || !playlistPanel) return;

    playlistSearch = '';
    const searchInput = playlistPanel.querySelector('.xet-pl-search');
    if (searchInput) searchInput.value = '';

    for (const group of catalogTree) {
      for (const chapter of group.chapters) {
        if (chapter.id) chapterOverrides.set(chapter.id, expanded);
      }
    }

    saveChapterState();
    applyPlaylistFilter();
  }

  function ensurePlaylistControl() {
    const root = getPlayerRoot();
    if (!root) return;
    const grid = root.querySelector('.xg-right-grid');
    if (!grid) return;

    if (playlistButton && playlistButton.isConnected && grid.contains(playlistButton)) return;

    const existing = grid.querySelector('.xgplayer-playlist');
    if (existing) {
      playlistButton = existing;
      bindPlaylistHover(existing);
      return;
    }

    const button = document.createElement('xg-icon');
    button.className = 'xg-options-icon xgplayer-playlist show';
    button.setAttribute('role', 'button');
    button.setAttribute('tabindex', '0');
    button.setAttribute('aria-label', '选集');
    button.innerHTML =
      '<div class="xgplayer-icon btn-text"><span class="icon-text">选集</span></div>';
    button.addEventListener('click', onPlaylistButtonClick, true);
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      togglePlaylist();
    });
    bindPlaylistHover(button);

    const rate = grid.querySelector('.xgplayer-playbackrate');
    if (rate) rate.insertAdjacentElement('afterend', button);
    else grid.appendChild(button);

    playlistButton = button;
  }

  function bindPlaylistHover(element) {
    if (!element || element.dataset.xetHoverBound) return;
    element.dataset.xetHoverBound = '1';
    element.addEventListener('mouseenter', schedulePlaylistOpen);
    element.addEventListener('mouseleave', schedulePlaylistClose);
  }

  function ensurePlaylistPanel() {
    const root = getPlayerRoot();
    if (!root) return null;
    if (playlistPanel && playlistPanel.isConnected && playlistPanel.parentElement === root) return playlistPanel;

    if (playlistPanel) playlistPanel.remove();

    const panel = document.createElement('div');
    panel.className = 'xet-playlist-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '选集');
    panel.hidden = !playlistOpen;
    // Icons: Lucide (ISC) fold-vertical / unfold-vertical / locate-fixed.
    panel.innerHTML = `
      <div class="xet-pl-head">
        <span class="xet-pl-title">选集</span>
        <span class="xet-pl-count"></span>
        <div class="xet-pl-actions">
          <button class="xet-pl-action xet-pl-locate is-hidden" type="button" aria-label="定位当前课时" data-tip="定位当前课时" aria-hidden="true">
            <svg viewBox="0 0 24 24" aria-hidden="true"><line x1="2" x2="5" y1="12" y2="12"></line><line x1="19" x2="22" y1="12" y2="12"></line><line x1="12" x2="12" y1="2" y2="5"></line><line x1="12" x2="12" y1="19" y2="22"></line><circle cx="12" cy="12" r="7"></circle><circle cx="12" cy="12" r="3"></circle></svg>
          </button>
          <button class="xet-pl-action xet-pl-collapse-all" type="button" aria-label="全部折叠" data-tip="全部折叠">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 12H8"></path><path d="M12 22v-6"></path><path d="M12 8V2"></path><path d="m15 19-3-3-3 3"></path><path d="m15 5-3 3-3-3"></path><path d="M16 12h-2"></path><path d="M22 12h-2"></path><path d="M4 12H2"></path></svg>
          </button>
          <button class="xet-pl-action xet-pl-expand-all" type="button" aria-label="全部展开" data-tip="全部展开">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 12H8"></path><path d="M12 16v6"></path><path d="M12 2v6"></path><path d="M16 12h-2"></path><path d="M22 12h-2"></path><path d="M4 12H2"></path><path d="m9 19 3 3 3-3"></path><path d="m9 5 3-3 3 3"></path></svg>
          </button>
        </div>
        <button class="xet-pl-close" type="button" aria-label="关闭" data-tip="关闭">×</button>
      </div>
      <div class="xet-pl-search-wrap">
        <input class="xet-pl-search" type="search" placeholder="搜索章节、课时或编号" autocomplete="off">
      </div>
      <div class="xet-pl-series-tabs" role="tablist" aria-label="课程系列" hidden></div>
      <div class="xet-pl-body"></div>
    `;

    panel.querySelector('.xet-pl-collapse-all').addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      setAllChapters(false);
    });
    panel.querySelector('.xet-pl-expand-all').addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      setAllChapters(true);
    });
    panel.querySelector('.xet-pl-locate').addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      locateCurrentLesson();
    });
    panel.querySelector('.xet-pl-close').addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closePlaylist();
    });
    const searchInput = panel.querySelector('.xet-pl-search');
    searchInput.value = playlistSearch;
    searchInput.addEventListener('input', (event) => {
      playlistSearch = String(event.target.value || '').trim().toLowerCase();
      applyPlaylistFilter();
    });
    const body = panel.querySelector('.xet-pl-body');
    body.addEventListener('click', onPlaylistBodyClick);
    body.addEventListener(
      'scroll',
      () => {
        updateLocateButton();
        setTimeout(updateLocateButton, 80);
      },
      { passive: true }
    );
    body.addEventListener(
      'wheel',
      () => setTimeout(updateLocateButton, 80),
      { passive: true }
    );
    window.addEventListener('resize', updateLocateButton, { passive: true });

    panel.addEventListener('mouseenter', cancelPlaylistClose);
    panel.addEventListener('mouseleave', schedulePlaylistClose);
    panel.addEventListener('mousedown', (event) => event.stopPropagation());
    panel.addEventListener('touchstart', (event) => event.stopPropagation(), { passive: true });
    panel.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });

    root.appendChild(panel);
    playlistPanel = panel;
    if (playlistOpen && catalogTree) renderPlaylist();
    return panel;
  }

  function onPlaylistButtonClick(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    openPlaylist();
  }

  function closePlaylist() {
    clearTimeout(hoverOpenTimer);
    clearTimeout(hoverCloseTimer);
    playlistOpen = false;
    if (playlistPanel) {
      const body = playlistPanel.querySelector('.xet-pl-body');
      if (body) playlistScrollTop = body.scrollTop;
      if (playlistPanel.contains(document.activeElement)) document.activeElement.blur();
      playlistPanel.hidden = true;
    }
    if (playlistButton) playlistButton.classList.remove('active');
  }

  function openPlaylist() {
    clearTimeout(hoverOpenTimer);
    clearTimeout(hoverCloseTimer);
    if (playlistOpen) return;

    const panel = ensurePlaylistPanel();
    if (!panel) return;

    playlistOpen = true;
    playlistRestoreScroll = !!playlistSearch;
    panel.hidden = false;
    if (playlistButton) playlistButton.classList.add('active');

    if (catalogTree) {
      renderPlaylist();
      return;
    }

    renderPlaylistMessage('正在加载课程目录…');
    loadCatalog()
      .then(() => {
        if (playlistOpen) renderPlaylist();
      })
      .catch((error) => {
        if (playlistOpen) renderPlaylistError(error);
      });
  }

  function togglePlaylist() {
    if (playlistOpen) closePlaylist();
    else openPlaylist();
  }

  function schedulePlaylistOpen() {
    clearTimeout(hoverCloseTimer);
    if (playlistOpen) return;
    clearTimeout(hoverOpenTimer);
    hoverOpenTimer = setTimeout(() => {
      if (!playlistOpen) openPlaylist();
    }, 100);
  }

  function schedulePlaylistClose() {
    clearTimeout(hoverOpenTimer);
    clearTimeout(hoverCloseTimer);
    hoverCloseTimer = setTimeout(() => {
      if (!playlistOpen) return;
      closePlaylist();
    }, 250);
  }

  function cancelPlaylistClose() {
    clearTimeout(hoverCloseTimer);
  }

  function clearSeriesTabs() {
    if (!playlistPanel) return;
    playlistPanel.classList.remove('has-series');
    const tabs = playlistPanel.querySelector('.xet-pl-series-tabs');
    if (tabs) {
      tabs.hidden = true;
      tabs.replaceChildren();
    }
  }

  function renderPlaylistMessage(message) {
    if (!playlistPanel) return;
    const body = playlistPanel.querySelector('.xet-pl-body');
    if (!body) return;
    clearSeriesTabs();
    const element = document.createElement('div');
    element.className = 'xet-pl-message';
    element.textContent = message;
    body.replaceChildren(element);
  }

  function renderPlaylistError(error) {
    if (!playlistPanel) return;
    const body = playlistPanel.querySelector('.xet-pl-body');
    if (!body) return;
    clearSeriesTabs();

    const wrap = document.createElement('div');
    wrap.className = 'xet-pl-message';

    const text = document.createElement('div');
    text.textContent = '目录加载失败';

    const detail = document.createElement('div');
    detail.textContent = (error && error.message) || '请稍后重试';
    detail.style.fontSize = '11px';
    detail.style.color = 'rgba(255, 255, 255, 0.35)';

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'xet-pl-retry';
    retry.textContent = '重试';
    retry.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      renderPlaylistMessage('正在加载课程目录…');
      loadCatalog(true)
        .then(() => {
          if (playlistOpen) renderPlaylist();
        })
        .catch((nextError) => {
          if (playlistOpen) renderPlaylistError(nextError);
        });
    });

    wrap.append(text, detail, retry);
    body.replaceChildren(wrap);
  }

  function getSectionNumber(text) {
    const match = String(text || '')
      .trim()
      .match(/^(\d+(?:[.\-]\d+)*)(?=[.\-、\s:：]|$)/);
    return match ? match[1] : '';
  }

  function canonicalNumber(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    return text
      .split(/[.\-]/)
      .map((part) => String(Number(part)))
      .join('.');
  }

  function highlightMatches(element, query, numeric) {
    if (!element) return;
    const raw = element.textContent || '';
    const highlighted = element.dataset.xetHighlighted === '1';
    if (!query) {
      if (highlighted) {
        element.textContent = raw;
        delete element.dataset.xetHighlighted;
      }
      return;
    }

    const ranges = [];
    if (numeric) {
      const number = getSectionNumber(raw);
      const index = number ? raw.indexOf(number) : -1;
      if (index >= 0) ranges.push([index, index + number.length]);
    } else {
      const lower = raw.toLowerCase();
      const needle = query.toLowerCase();
      let from = 0;
      while (needle) {
        const index = lower.indexOf(needle, from);
        if (index < 0) break;
        ranges.push([index, index + needle.length]);
        from = index + Math.max(1, needle.length);
      }
    }

    if (!ranges.length) {
      if (highlighted) {
        element.textContent = raw;
        delete element.dataset.xetHighlighted;
      }
      return;
    }

    element.textContent = '';
    let cursor = 0;
    for (const [start, end] of ranges) {
      if (start > cursor) element.appendChild(document.createTextNode(raw.slice(cursor, start)));
      const mark = document.createElement('mark');
      mark.textContent = raw.slice(start, end);
      element.appendChild(mark);
      cursor = end;
    }
    if (cursor < raw.length) element.appendChild(document.createTextNode(raw.slice(cursor)));
    element.dataset.xetHighlighted = '1';
  }

  function createPlaylistRow(chapter, section, activeRid) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'xet-pl-item';
    row.dataset.rid = section.rid;
    row.dataset.number = getSectionNumber(section.title);
    row.dataset.search = String(section.title || '').toLowerCase();
    row.title = section.title;

    if (section.rid === activeRid) {
      row.classList.add('current');
      row.setAttribute('aria-current', 'true');
    }
    if (section.status === 2) row.classList.add('done');
    if (section.unlock === 0 && !section.isTry) row.classList.add('locked');

    const title = document.createElement('span');
    title.className = 'xet-pl-item-title';
    title.textContent = section.title;

    const meta = document.createElement('span');
    meta.className = 'xet-pl-item-meta';
    const parts = [];
    if (section.rid === activeRid) parts.push('当前');
    if (section.type === 3) {
      if (section.duration) parts.push(formatDuration(section.duration));
    } else if (section.type === 4) {
      parts.push('直播');
    }
    if (section.status === 2) parts.push('已学完');
    else if (section.progress > 0) parts.push(`${section.progress}%`);
    if (section.unlock === 0 && !section.isTry) parts.push('未解锁');
    meta.textContent = parts.join(' · ');

    row.append(title, meta);
    return row;
  }

  function cleanSeriesLabel(label) {
    return String(label || '')
      .replace(/^=+\s*/, '')
      .replace(/\s*=+$/, '')
      .trim();
  }

  function selectSeriesTab(index) {
    const groups = displayCatalogGroups();
    if (!usesSeriesTabs() || !Number.isInteger(index) || index < 0 || index >= groups.length) return;
    if (index === playlistSeriesIndex) return;

    playlistSeriesIndex = index;
    playlistRestoreScroll = false;
    const body = playlistPanel?.querySelector('.xet-pl-body');
    if (body) body.scrollTop = 0;
    renderPlaylist({ lockSize: false });
    requestAnimationFrame(() => {
      playlistPanel?.querySelector('.xet-pl-series-tab.active')?.focus({ preventScroll: true });
    });
  }

  function renderSeriesTabs(groups, enabled) {
    if (!playlistPanel) return;
    const tabs = playlistPanel.querySelector('.xet-pl-series-tabs');
    if (!tabs) return;

    playlistPanel.classList.toggle('has-series', enabled);
    tabs.hidden = !enabled;
    if (!enabled) {
      tabs.replaceChildren();
      return;
    }

    const fragment = document.createDocumentFragment();
    groups.forEach((group, index) => {
      const label = cleanSeriesLabel(group.label) || '未命名系列';
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'xet-pl-series-tab';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', index === playlistSeriesIndex ? 'true' : 'false');
      tab.tabIndex = index === playlistSeriesIndex ? 0 : -1;
      tab.textContent = label;
      tab.title = label;
      tab.classList.toggle('active', index === playlistSeriesIndex);

      tab.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        selectSeriesTab(index);
      });

      fragment.appendChild(tab);
    });

    tabs.replaceChildren(fragment);
    requestAnimationFrame(() => {
      const active = tabs.querySelector('.xet-pl-series-tab.active');
      if (!active) return;
      const tabsRect = tabs.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      if (activeRect.left < tabsRect.left) {
        tabs.scrollLeft -= tabsRect.left - activeRect.left;
      } else if (activeRect.right > tabsRect.right) {
        tabs.scrollLeft += activeRect.right - tabsRect.right;
      }
    });
  }

  function renderPlaylist({ lockSize = true } = {}) {
    if (!playlistPanel || !catalogTree) return;
    const body = playlistPanel.querySelector('.xet-pl-body');
    const count = playlistPanel.querySelector('.xet-pl-count');
    if (!body) return;

    const activeRid = getCurrentResourceId();
    ensureChapterState();
    playlistActiveRid = activeRid;
    playlistCurrentChapterId = findCurrentChapterId(activeRid);
    const groups = displayCatalogGroups();
    const tabsEnabled = usesSeriesTabs();
    const currentGroupIndex = findGroupIndexForRid(groups, activeRid);

    if (playlistSeriesIndex < 0 || playlistSeriesIndex >= groups.length) {
      playlistSeriesIndex = currentGroupIndex >= 0 ? currentGroupIndex : 0;
    }

    renderSeriesTabs(groups, tabsEnabled);
    const visibleGroups = tabsEnabled ? [groups[playlistSeriesIndex]] : groups;
    const fragment = document.createDocumentFragment();
    let total = 0;

    for (const group of visibleGroups) {
      if (!tabsEnabled && group.label) {
        const label = document.createElement('div');
        label.className = 'xet-pl-group';
        label.textContent = cleanSeriesLabel(group.label);
        fragment.appendChild(label);
      }

      for (const chapter of group.chapters) {
        const wrap = document.createElement('div');
        wrap.className = 'xet-pl-chapter';
        if (chapter.id) wrap.dataset.chapterId = chapter.id;

        if (chapter.title) {
          const head = document.createElement('button');
          head.type = 'button';
          head.className = 'xet-pl-chapter-head';
          const title = document.createElement('span');
          title.className = 'xet-pl-chapter-title';
          title.textContent = chapter.title;
          title.title = chapter.title;
          const amount = document.createElement('span');
          amount.className = 'xet-pl-chapter-count';
          const doneCount = chapter.sections.filter((section) => section.status === 2).length;
          const learningCount = chapter.sections.filter(
            (section) => section.status !== 2 && (section.status === 1 || section.progress > 0)
          ).length;
          const countParts = [`${chapter.sections.length} 节`];
          if (doneCount) countParts.push(`已学完 ${doneCount}`);
          if (learningCount) countParts.push(`学习中 ${learningCount}`);
          amount.textContent = chapter.error ? '加载失败' : countParts.join(' · ');
          if (!chapter.error) {
            amount.title = `共 ${chapter.sections.length} 节，已学完 ${doneCount} 节，学习中 ${learningCount} 节`;
          }
          const chevron = document.createElement('span');
          chevron.className = 'xet-pl-chevron';
          chevron.textContent = '▾';
          head.append(title, amount, chevron);
          wrap.appendChild(head);
        }

        const items = document.createElement('div');
        items.className = 'xet-pl-items';

        if (chapter.error) {
          const error = document.createElement('div');
          error.className = 'xet-pl-chapter-error';
          error.textContent = '该章节目录加载失败';
          items.appendChild(error);
        } else {
          for (const section of chapter.sections) {
            total += 1;
            items.appendChild(createPlaylistRow(chapter, section, activeRid));
          }
        }

        wrap.appendChild(items);
        fragment.appendChild(wrap);
      }
    }

    if (count) count.textContent = `${total} 节`;
    body.replaceChildren(fragment);
    if (lockSize) lockPlaylistSize();
    applyPlaylistFilter();
    requestAnimationFrame(() => {
      if (playlistRestoreScroll) {
        playlistRestoreScroll = false;
        body.scrollTop = playlistScrollTop;
      } else {
        scrollPlaylistToCurrent();
      }
      updateLocateButton();
    });
  }

  function lockPlaylistSize() {
    if (!playlistPanel || playlistPanel.hidden) return;
    // Measure with every chapter expanded, then keep the panel size while searching.
    playlistPanel.style.width = '';
    playlistPanel.style.height = '';
    const width = Math.ceil(playlistPanel.getBoundingClientRect().width);
    if (width > 0) playlistPanel.style.width = `${width}px`;
    const height = Math.ceil(playlistPanel.getBoundingClientRect().height);
    if (height > 0) playlistPanel.style.height = `${height}px`;
  }

  function applyPlaylistFilter() {
    if (!playlistPanel) return;
    const body = playlistPanel.querySelector('.xet-pl-body');
    if (!body) return;
    const query = playlistSearch;
    const numericMatch = query.match(/^(\d+(?:[.\-]\d+)*)[.\-]?$/);
    const numeric = !!numericMatch;
    const numericValue = numeric ? canonicalNumber(numericMatch[1]) : '';
    let groupLabel = null;
    let matchedAny = false;
    for (const node of body.children) {
      if (node.classList.contains('xet-pl-group')) {
        groupLabel = node;
        node.hidden = true;
        continue;
      }
      if (!node.classList.contains('xet-pl-chapter')) continue;

      const rows = [...node.querySelectorAll('.xet-pl-item')];
      const chapterTitleEl = node.querySelector('.xet-pl-chapter-title');
      const chapterTitle = (chapterTitleEl?.textContent || '').toLowerCase();
      const chapterMatch = !numeric && !!query && chapterTitle.includes(query);
      const chapterId = node.dataset.chapterId || '';
      let visible = 0;

      if (chapterTitleEl) highlightMatches(chapterTitleEl, numeric ? '' : query, false);

      for (const row of rows) {
        const match =
          !query ||
          (numeric
            ? canonicalNumber(row.dataset.number) === numericValue
            : (row.dataset.search || '').includes(query));
        row.hidden = !match;
        if (match) {
          visible += 1;
        }
        highlightMatches(row.querySelector('.xet-pl-item-title'), match ? query : '', numeric);
      }

      if (query && visible > 0) {
        node.classList.remove('collapsed');
      } else {
        node.classList.toggle('collapsed', !isChapterExpanded(chapterId));
      }

      const showChapter = visible > 0 || chapterMatch;
      node.hidden = !showChapter;
      if (showChapter) {
        matchedAny = true;
        if (groupLabel) groupLabel.hidden = false;
      }
    }

    let empty = body.querySelector('.xet-pl-empty');
    if (query && !matchedAny) {
      if (!empty) {
        empty = document.createElement('div');
        empty.className = 'xet-pl-empty';
        body.appendChild(empty);
      }
      empty.textContent = usesSeriesTabs() ? '当前系列没有匹配的课时' : '没有匹配的课时';
    } else if (empty) {
      empty.remove();
    }
    updateLocateButton();
  }

  function updateLocateButton() {
    if (!playlistPanel) return;
    const button = playlistPanel.querySelector('.xet-pl-locate');
    const body = playlistPanel.querySelector('.xet-pl-body');
    if (!button || !body) return;

    let show = false;
    if (!playlistPanel.hidden) {
      const groups = displayCatalogGroups();
      const currentGroupIndex = findGroupIndexForRid(groups, getCurrentResourceId());
      const currentInOtherTab =
        usesSeriesTabs() && currentGroupIndex >= 0 && currentGroupIndex !== playlistSeriesIndex;

      if (currentInOtherTab) {
        show = true;
      } else {
        const row = body.querySelector('.xet-pl-item.current');
        if (row) {
          const chapter = row.closest('.xet-pl-chapter');
          const blocked =
            !chapter || chapter.hidden || chapter.classList.contains('collapsed') || row.hidden;
          if (blocked) {
            show = true;
          } else {
            const rowRect = row.getBoundingClientRect();
            const bodyRect = body.getBoundingClientRect();
            show = rowRect.bottom <= bodyRect.top || rowRect.top >= bodyRect.bottom;
          }
        }
      }
    }
    button.classList.toggle('is-hidden', !show);
    button.setAttribute('aria-hidden', show ? 'false' : 'true');
  }

  function locateCurrentLesson() {
    if (!playlistPanel) return;

    const groups = displayCatalogGroups();
    const currentGroupIndex = findGroupIndexForRid(groups, getCurrentResourceId());
    if (usesSeriesTabs() && currentGroupIndex >= 0 && currentGroupIndex !== playlistSeriesIndex) {
      playlistSeriesIndex = currentGroupIndex;
      playlistRestoreScroll = false;
      if (playlistSearch) {
        playlistSearch = '';
        const input = playlistPanel.querySelector('.xet-pl-search');
        if (input) input.value = '';
      }
      renderPlaylist({ lockSize: false });
    }

    const body = playlistPanel.querySelector('.xet-pl-body');
    const row = body?.querySelector('.xet-pl-item.current');
    if (!body || !row) return;

    const input = playlistPanel.querySelector('.xet-pl-search');
    if (playlistSearch) {
      playlistSearch = '';
      if (input) input.value = '';
    }

    const chapter = row.closest('.xet-pl-chapter');
    if (chapter) {
      chapter.hidden = false;
      chapter.classList.remove('collapsed');
      const id = chapter.dataset.chapterId || '';
      if (id) {
        chapterOverrides.set(id, true);
        saveChapterState();
      }
    }

    applyPlaylistFilter();
    if (chapter) {
      chapter.hidden = false;
      chapter.classList.remove('collapsed');
    }
    row.hidden = false;

    const finish = () => {
      scrollPlaylistToCurrent();
      updateLocateButton();
    };
    requestAnimationFrame(finish);
    setTimeout(finish, 80);
  }

  function scrollPlaylistToCurrent() {
    if (!playlistPanel) return;
    const body = playlistPanel.querySelector('.xet-pl-body');
    const row = body?.querySelector('.xet-pl-item.current');
    if (!body || !row) return;
    const chapter = row.closest('.xet-pl-chapter');
    if (row.hidden || (chapter && (chapter.hidden || chapter.classList.contains('collapsed')))) return;
    body.scrollTop = Math.max(0, row.offsetTop - body.clientHeight / 2 + row.offsetHeight / 2);
  }

  function updatePlaylistCurrent() {
    if (!catalogTree) return;
    const rid = getCurrentResourceId();
    if (rid === playlistActiveRid) return;
    playlistActiveRid = rid;

    const groups = displayCatalogGroups();
    const groupIndex = findGroupIndexForRid(groups, rid);
    if (groupIndex >= 0) playlistSeriesIndex = groupIndex;

    if (playlistOpen) renderPlaylist({ lockSize: false });
  }

  function sectionUrl(section) {
    if (section.type === 3 || /^v_/.test(section.rid)) {
      const courseId = getCourseId();
      if (!courseId) return '';
      return `/p/t_pc/course_pc_detail/video/${encodeURIComponent(
        section.rid
      )}?product_id=${encodeURIComponent(courseId)}&auto=1`;
    }
    if (section.jumpUrl) {
      try {
        return new URL(section.jumpUrl, location.origin).href;
      } catch (_) {}
    }
    return '';
  }

  function openPlaylistItem(rid) {
    if (!rid) return;
    if (rid === getCurrentResourceId()) {
      closePlaylist();
      return;
    }

    const section = findCatalogSection(rid);
    if (!section) return;
    const url = sectionUrl(section);
    if (!url) return;

    if (section.type === 4 || /\/v4\/course\/alive\//.test(url)) {
      window.open(url, '_blank', 'noopener');
      return;
    }

    if (isVideoLessonUrl(url)) {
      switchLessonSeamlessly(url);
      return;
    }

    closePlaylist();
    location.assign(url);
  }

  function onPlaylistBodyClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const head = target.closest('.xet-pl-chapter-head');
    if (head) {
      event.preventDefault();
      event.stopPropagation();
      const wrap = head.closest('.xet-pl-chapter');
      if (!wrap) return;
      const collapsed = wrap.classList.toggle('collapsed');
      const id = wrap.dataset.chapterId || '';
      if (id) {
        chapterOverrides.set(id, !collapsed);
        saveChapterState();
      }
      updateLocateButton();
      return;
    }

    const row = target.closest('.xet-pl-item');
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    openPlaylistItem(row.dataset.rid || '');
  }

  function onPlaylistKeydown(event) {
    if (!playlistOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      closePlaylist();
      return;
    }

    const tab =
      playlistPanel && event.target instanceof Element
        ? event.target.closest('.xet-pl-series-tab')
        : null;
    if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      const tabs = [...playlistPanel.querySelectorAll('.xet-pl-series-tab')];
      const index = tabs.indexOf(tab);
      if (index >= 0) {
        event.preventDefault();
        let next = index;
        if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        selectSeriesTab(next);
        event.stopImmediatePropagation();
        return;
      }
    }

    if (playlistPanel && event.target instanceof Node && playlistPanel.contains(event.target)) {
      event.stopImmediatePropagation();
    }
  }

  function isEditableNode(node) {
    if (!(node instanceof HTMLElement)) return false;
    if (node.isContentEditable) return true;
    return !!node.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]'
    );
  }

  function onGlobalKeydown(event) {
    if (event.defaultPrevented || event.repeat || event.isComposing) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = String(event.key || '').toLowerCase();
    if (key !== 'f' && event.code !== 'KeyF') return;

    const target = event.target;
    if (isEditableNode(target)) return;
    if (isEditableNode(document.activeElement)) return;
    if (!isPlaybackPage() || !getPlayerRoot() || isNativeFullscreen()) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    if (isWebFullscreen()) exitWebFullscreen();
    else enterWebFullscreen();
  }

  function onPlaylistOutsideClick(event) {
    if (!playlistOpen) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (playlistPanel && playlistPanel.contains(target)) return;
    if (playlistButton && playlistButton.contains(target)) return;
    closePlaylist();
  }

  function scheduleCatalogPrefetch() {
    if (catalogPrefetchDone || playlistPrefetchTimer) return;
    playlistPrefetchTimer = setTimeout(() => {
      playlistPrefetchTimer = 0;
      catalogPrefetchDone = true;
      if (!isPlaybackPage() || !getPlayerRoot()) return;
      loadCatalog().catch(() => {});
    }, 2500);
  }

  function syncFullscreenState() {
    const wide = isWebFullscreen();
    const native = isNativeFullscreen();
    const wideChanged = wide !== lastWide;
    lastWide = wide;
    lastNative = native;

    document.documentElement.classList.toggle('xet-fs-wide', wide);
    if (document.body) document.body.classList.toggle('xet-fs-wide', wide);
    document.documentElement.classList.toggle('xet-native-full', native);
    if (document.body) document.body.classList.toggle('xet-native-full', native);

    if (wideChanged) requestResize();
  }

  function updateLabels() {
    const web = isWebFullscreen();
    const native = isNativeFullscreen();
    const webLabel = native ? '进入网页全屏' : web ? '恢复宽屏' : '网页全屏';
    const nativeLabel = native ? '恢复上一个状态' : '进入全屏';
    const nativeIcon = document.querySelector('.xgplayer-fullscreen');
    if (nativeIcon) {
      const state = native ? 'full' : 'normal';
      if (nativeIcon.getAttribute('data-state') !== state) nativeIcon.setAttribute('data-state', state);
    }
    setLabel(document.querySelector('.xgplayer-cssfullscreen'), webLabel);
    setLabel(nativeIcon, nativeLabel);
  }

  function updateAll() {
    if (!isPlaybackPage()) return;
    const root = getPlayerRoot();
    if (!root) return;
    injectStyle();
    ensureBodyClass();
    syncFullscreenState();
    updateLabels();
    watchVideo();
    watchTitle();
    watchDocumentTitle();
    patchNativeNextNavigation();
    ensurePlaylistControl();
    updatePlaylistCurrent();
    if (playlistOpen) ensurePlaylistPanel();
    scheduleCatalogPrefetch();
    scheduleInitialWideMode();
  }

  function scheduleUpdate() {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(updateAll, 80);
  }

  function ensureBodyClass() {
    if (!document.body || !isPlaybackPage()) return false;
    if (!document.body.classList.contains('xet-rebuild')) document.body.classList.add('xet-rebuild');
    return true;
  }

  function syncPageGate() {
    const next = isPlaybackPage();
    if (next === pageActive) return;
    pageActive = next;

    if (!next) {
      closePlaylist();
      playlistButton?.remove();
      playlistPanel?.remove();
      playlistButton = null;
      playlistPanel = null;
      catalogTree = null;
      catalogCourseId = '';
      catalogFetchedAt = 0;
      catalogPromise = null;
      playlistActiveRid = '';
      playlistSeriesIndex = -1;
      playlistSearch = '';
      playlistCurrentChapterId = '';
      chapterOverrides = new Map();
      chapterStateCourseId = '';
      clearTimeout(hoverOpenTimer);
      clearTimeout(hoverCloseTimer);
      clearTimeout(playlistPrefetchTimer);
      playlistPrefetchTimer = 0;
      catalogPrefetchDone = false;
      clearTimeout(wideRetryTimer);
      wideRetryTimer = 0;
      wideRetryCount = 0;
      initialWideDone = false;
      document.documentElement.classList.remove('xet-rebuild', 'xet-fs-wide', 'xet-native-full');
      if (document.body) {
        document.body.classList.remove('xet-rebuild', 'xet-fs-wide', 'xet-native-full');
      }
      document.getElementById(STYLE_ID)?.remove();
      clearTimeout(applyTimer);
      clearTimeout(applyRetryTimer);
      clearTimeout(repairTimer);
      ++applyToken;
      applying = false;
      repairDone = false;
      lastTitleText = '';
      if (titleObserver) titleObserver.disconnect();
      if (docTitleObserver) docTitleObserver.disconnect();
      if (srcObserver) srcObserver.disconnect();
      watchedDocTitle = null;
      if (watchedVideo) {
        watchedVideo.removeEventListener('loadedmetadata', onVideoLoaded);
        watchedVideo.removeEventListener('loadstart', onVideoLoaded);
        watchedVideo.removeEventListener('emptied', onVideoLoaded);
        watchedVideo.removeEventListener('volumechange', onVolumeChange);
        watchedVideo.removeEventListener('ratechange', onRateChange);
        watchedVideo = null;
      }
      watchedTitle = null;
      return;
    }

    document.documentElement.classList.add('xet-rebuild');
    ensureBodyClass();
    injectStyle();
    updateAll();
  }

  function patchHistory() {
    if (historyPatched) return;
    historyPatched = true;

    for (const name of ['pushState', 'replaceState']) {
      const original = history[name];
      history[name] = function (...args) {
        const result = original.apply(this, args);
        syncPageGate();
        armApply();
        updatePlaylistCurrent();
        return result;
      };
    }

    window.addEventListener('popstate', () => {
      syncPageGate();
      armApply();
      updatePlaylistCurrent();
    });
    window.addEventListener('popstate', onHistoryLessonSwitch);
  }

  function clickSiteControl(selector) {
    const control = document.querySelector(selector);
    if (!control) return false;
    bypass = true;
    const icon = control.querySelector('.xgplayer-icon') || control;
    icon.click();
    bypass = false;
    return true;
  }

  function scheduleFullscreenRefresh() {
    for (const delay of [80, 360, 700]) {
      setTimeout(() => {
        if (isPlaybackPage()) updateAll();
      }, delay);
    }
  }

  function enterWebFullscreen() {
    const entered = clickSiteControl('.xgplayer-cssfullscreen .xgplayer-icon, .xgplayer-cssfullscreen');
    scheduleFullscreenRefresh();
    return entered;
  }

  function enterWebFullscreenWhenReady() {
    clearTimeout(wideRetryTimer);
    wideRetryCount = 0;

    const tick = () => {
      const root = getPlayerRoot();
      if (
        !isPlaybackPage() ||
        isWebFullscreen() ||
        isNativeFullscreen() ||
        (root && root.matches(FULL_SEL))
      ) {
        return;
      }
      if (enterWebFullscreen()) return;
      if (++wideRetryCount > 20) return;
      wideRetryTimer = setTimeout(tick, 250);
    };

    tick();
  }

  function scheduleInitialWideMode() {
    if (initialWideDone || !isPlaybackPage()) return;
    const root = getPlayerRoot();
    if (!root?.querySelector('video')) return;
    if (isWebFullscreen() || isNativeFullscreen() || root.matches(FULL_SEL)) {
      initialWideDone = true;
      return;
    }
    initialWideDone = true;
    enterWebFullscreenWhenReady();
  }

  function removeFullscreenClasses(root) {
    document.querySelectorAll(FULL_SEL).forEach((el) => el.classList.remove(...FULL_CLASSES));
    [document.documentElement, document.body].forEach((el) => el.classList.remove(...FULL_CLASSES));
    document.querySelectorAll('xg-controls, .xgplayer-controls, .basic-xgplayer-controls').forEach((el) => {
      ['display', 'visibility', 'opacity', 'pointer-events', 'transform', 'bottom'].forEach((prop) =>
        el.style.removeProperty(prop)
      );
    });
    document.querySelectorAll('.xgplayer-back').forEach((el) => el.classList.remove('show'));
    if (root) {
      ['position', 'inset', 'top', 'left', 'right', 'bottom', 'width', 'height', 'z-index', 'background'].forEach(
        (name) => root.style.removeProperty(name)
      );
    }
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
  }

  function exitWebFullscreen() {
    if (exiting) return;
    exiting = true;

    const root = getPlayerRoot();
    const back =
      (root && root.querySelector('.xgplayer-back')) || document.querySelector('.xgplayer-back');

    if (back) {
      const icon = back.querySelector('.xgplayer-icon') || back;
      icon.click();
    } else {
      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        keyCode: 27,
        which: 27,
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(event);
      window.dispatchEvent(event);
    }

    setTimeout(() => {
      if (isWebFullscreen()) removeFullscreenClasses(root);
      exiting = false;
      updateAll();
      requestResize();
    }, 180);
    scheduleFullscreenRefresh();
  }

  function exitNativeAndRestore() {
    if (!isNativeFullscreen()) return;
    const prev = stateBeforeNative || (isWebFullscreen() ? 'wide' : 'normal');
    stateBeforeNative = null;
    restoring = true;

    const done = () => {
      setTimeout(() => {
        if (prev === 'wide' && !isWebFullscreen()) enterWebFullscreen();
        else if (prev === 'normal' && isWebFullscreen()) exitWebFullscreen();
        restoring = false;
        requestResize();
      }, 200);
    };

    const result = document.exitFullscreen?.();
    if (result && typeof result.then === 'function') result.then(done, done);
    else done();
  }

  function switchNativeToWeb() {
    if (!isNativeFullscreen()) return;
    stateBeforeNative = null;
    restoring = true;

    const done = () => {
      setTimeout(() => {
        if (!isWebFullscreen()) enterWebFullscreen();
        restoring = false;
        requestResize();
      }, 200);
    };

    const result = document.exitFullscreen?.();
    if (result && typeof result.then === 'function') result.then(done, done);
    else done();
  }

  function onControlClick(event) {
    const target = event.target;
    if (!(target instanceof Element) || bypass) return;

    const webControl = target.closest('.xgplayer-cssfullscreen');
    const nativeControl = target.closest('.xgplayer-fullscreen');
    if (!webControl && !nativeControl) return;

    const native = isNativeFullscreen();
    const web = isWebFullscreen();

    if (webControl) {
      if (native) {
        event.preventDefault();
        event.stopImmediatePropagation();
        switchNativeToWeb();
      } else if (web) {
        event.preventDefault();
        event.stopImmediatePropagation();
        exitWebFullscreen();
      } else {
        event.preventDefault();
        event.stopImmediatePropagation();
        enterWebFullscreen();
      }
      return;
    }

    if (native) {
      event.preventDefault();
      event.stopImmediatePropagation();
      exitNativeAndRestore();
    } else {
      stateBeforeNative = web ? 'wide' : 'normal';
      scheduleFullscreenRefresh();
      setTimeout(() => {
        if (!isNativeFullscreen()) stateBeforeNative = null;
      }, 1500);
    }
  }

  function isPlayerSurface(target) {
    const root = getPlayerRoot();
    if (!root || !(target instanceof Node) || !root.contains(target)) return false;
    if (
      target instanceof Element &&
      target.closest(
        'xg-controls, .xgplayer-controls, .basic-xgplayer-controls, .xg-options-list, .xet-playlist-panel'
      )
    ) {
      return false;
    }
    return true;
  }

  function isVideoSurface(target) {
    if (!(target instanceof Element)) return false;
    const root = getPlayerRoot();
    if (!root) return false;
    if (
      target.closest(
        'xg-controls, .xgplayer-controls, .basic-xgplayer-controls, .xg-options-list, .xet-playlist-panel, xgplayer-start, .xgplayer-start, xgplayer-error, .xgplayer-error, xgplayer-enter, .xgplayer-enter, a, button, [role="button"]'
      )
    ) {
      return false;
    }
    return target === root || target.tagName === 'VIDEO' || target.classList.contains('xgplayer-video');
  }

  function onSurfaceClick(event) {
    if (bypassClick) return;
    if (!isVideoSurface(event.target)) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    if (pendingClick) {
      clearTimeout(pendingClick.timer);
      pendingClick = null;
      return;
    }

    const target = event.target;
    const init = {
      bubbles: true,
      cancelable: true,
      detail: 1,
      button: 0,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    const timer = setTimeout(() => {
      const current = target.isConnected ? target : getPlayerRoot();
      pendingClick = null;
      if (!current) return;
      bypassClick = true;
      current.dispatchEvent(new MouseEvent('click', init));
      bypassClick = false;
    }, 200);
    pendingClick = { target, timer };
  }

  function recordClickState(event) {
    if (!isPlayerSurface(event.target)) return;
    const video = getPlayerRoot()?.querySelector('video');
    if (!video) return;
    if (preClickPaused === null) preClickPaused = video.paused;
    clearTimeout(clickResetTimer);
    clickResetTimer = setTimeout(() => {
      preClickPaused = null;
    }, 450);
  }

  function restorePlayState(video, wantPaused) {
    if (!video || wantPaused === null) return;
    if (video.paused === wantPaused) return;
    if (wantPaused) {
      video.pause();
    } else {
      const result = video.play();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    }
  }

  function onDblClick(event) {
    const root = getPlayerRoot();
    if (!root || !(event.target instanceof Node) || !root.contains(event.target)) return;
    if (
      event.target instanceof Element &&
      event.target.closest('xg-controls, .xgplayer-controls, .basic-xgplayer-controls, .xet-playlist-panel')
    ) {
      return;
    }
    if (isNativeFullscreen()) return;

    if (pendingClick) {
      clearTimeout(pendingClick.timer);
      pendingClick = null;
    }

    const video = root.querySelector('video');
    const wantPaused = preClickPaused;
    preClickPaused = null;
    clearTimeout(clickResetTimer);
    restorePlayState(video, wantPaused);

    event.preventDefault();
    event.stopImmediatePropagation();
    if (isWebFullscreen()) exitWebFullscreen();
    else enterWebFullscreen();
    if (wantPaused !== null) {
      [150, 350, 600].forEach((delay) => {
        setTimeout(() => restorePlayState(video, wantPaused), delay);
      });
    }
    setTimeout(updateAll, 80);
    setTimeout(updateAll, 360);
    setTimeout(updateAll, 700);
  }

  function onFullscreenChange() {
    if (!isNativeFullscreen() && !restoring) {
      const prev = stateBeforeNative;
      stateBeforeNative = null;
      if (prev === 'wide' && !isWebFullscreen()) enterWebFullscreen();
      else if (prev === 'normal' && isWebFullscreen()) exitWebFullscreen();
    }
    updateAll();
    requestResize();
  }

  function observePlayer(root) {
    if (root === observedRoot) return;
    observedRoot = root;
    rootObserver.disconnect();
    rootObserver.observe(root, { attributes: true, attributeFilter: ['class'] });

    const box = root.closest('.video-player');
    if (box && box !== observedPlayerBox) {
      observedPlayerBox = box;
      resizeObserver.disconnect();
      resizeObserver.observe(box);
    }
  }

  const rootObserver = new MutationObserver(() => scheduleUpdate());

  const bodyObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (
          node.matches?.('#pc_course_fe_basic_video, .xgplayer, video') ||
          node.querySelector?.('#pc_course_fe_basic_video, .xgplayer, video')
        ) {
          scheduleUpdate();
          return;
        }
      }
    }
  });

  function boot() {
    patchHistory();
    syncPageGate();

    if (pageActive && !document.body) {
      const bodyWait = new MutationObserver(() => {
        if (!document.body) return;
        bodyWait.disconnect();
        ensureBodyClass();
        updateAll();
      });
      bodyWait.observe(document.documentElement, { childList: true });
    }

    document.addEventListener('click', onControlClick, true);
    document.addEventListener('click', onPlaylistOutsideClick, true);
    document.addEventListener('pointerdown', notePreferenceGesture, true);
    document.addEventListener('click', notePreferenceGesture, true);
    document.addEventListener('keydown', notePreferenceGesture, true);
    document.addEventListener('wheel', notePreferenceGesture, { capture: true, passive: true });
    window.addEventListener('keydown', onGlobalKeydown, true);
    window.addEventListener('keydown', onPlaylistKeydown, true);
    window.addEventListener('mousedown', recordClickState, true);
    window.addEventListener('click', onSurfaceClick, true);
    window.addEventListener('click', recordClickState, true);
    window.addEventListener('click', onPlaymodeClick, true);
    window.addEventListener('dblclick', onDblClick, true);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    window.addEventListener('resize', updateAll, { passive: true });

    resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width || 0;
      if (!width || isWebFullscreen()) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(requestResize, 120);
    });

    bodyObserver.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', updateAll, { once: true });
    window.addEventListener('load', updateAll, { once: true });

    updateAll();
    setTimeout(updateAll, 300);
    setTimeout(updateAll, 1000);

    const root = getPlayerRoot();
    if (root) {
      observePlayer(root);
      requestResize();
    }
  }

  boot();
})();
