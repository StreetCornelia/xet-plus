// ==UserScript==
// @name         小鹅通课程页布局重构
// @namespace    https://github.com/StreetCornelia/xet-plus
// @version      0.3.10
// @description  重构课程页：16:9 播放器、全屏按钮、播放参数记忆、课程选集面板
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
  const STYLE_VERSION = '0.3.10';
  const PREFS_KEY = 'xet-playback-prefs-v1';
  const CATALOG_API = '/xe.course.business_go.avoidlogin.e_course.resource_catalog_list.get/1.0.0';
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
  let pageActive = null;
  let catalogTree = null;
  let catalogCourseId = '';
  let catalogFetchedAt = 0;
  let catalogPromise = null;
  let playlistButton = null;
  let playlistPanel = null;
  let playlistOpen = false;
  let playlistSearch = '';
  let playlistActiveRid = '';
  let playlistPrefetchTimer = 0;
  let catalogPrefetchDone = false;

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
        width: min(380px, calc(100% - 24px));
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

      body.xet-rebuild .xet-pl-close {
        margin-left: auto;
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

      body.xet-rebuild .xet-pl-body {
        position: relative;
        flex: 1 1 auto;
        overflow-y: auto;
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

  function onVolumeChange() {
    if (applying) return;
    const video = getActiveVideo();
    if (!video) return;
    savePlaybackPrefs({ volume: video.volume, muted: !!video.muted });
  }

  function onRateChange() {
    if (applying) return;
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
    armApply();
  }

  function watchVideo() {
    const video = getPlayerRoot()?.querySelector('video');
    if (!video || video === watchedVideo) return;

    if (watchedVideo) {
      watchedVideo.removeEventListener('loadedmetadata', onVideoLoaded);
      watchedVideo.removeEventListener('loadstart', onVideoLoaded);
      watchedVideo.removeEventListener('emptied', onVideoLoaded);
      watchedVideo.removeEventListener('volumechange', onVolumeChange);
      watchedVideo.removeEventListener('ratechange', onRateChange);
    }

    watchedVideo = video;
    video.addEventListener('loadedmetadata', onVideoLoaded);
    video.addEventListener('loadstart', onVideoLoaded);
    video.addEventListener('emptied', onVideoLoaded);
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

  function buildCatalogTree(top, childMap) {
    const groups = [];
    let group = { label: '', chapters: [] };
    groups.push(group);

    for (const item of top) {
      const sectionNum = Math.max(0, Number(item.section_num) || 0);
      const type = Number(item.resource_type) || 0;

      if (type === 0 && !sectionNum) {
        group = { label: String(item.chapter_title || '').trim(), chapters: [] };
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

      const entry = childMap.get(String(item.chapter_id));
      const list = entry ? entry.list : Array.isArray(item.children) ? item.children : [];
      group.chapters.push({
        id: String(item.chapter_id || ''),
        title: String(item.chapter_title || '').trim(),
        error: !!(entry && entry.error),
        sections: list.map(normalizeSection).filter((section) => section.rid && section.title)
      });
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
      const cacheKey = `xet-catalog-v2:${courseId}`;

      if (!force) {
        try {
          const cached = JSON.parse(sessionStorage.getItem(cacheKey) || 'null');
          if (cached && cached.ts && Date.now() - cached.ts < CATALOG_TTL && Array.isArray(cached.groups)) {
            catalogTree = cached.groups;
            catalogCourseId = courseId;
            catalogFetchedAt = cached.ts;
            return catalogTree;
          }
        } catch (_) {}
      }

      const top = await catalogRequest({});
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

      catalogTree = buildCatalogTree(top, childMap);
      catalogCourseId = courseId;
      catalogFetchedAt = Date.now();

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

  function findCatalogSection(rid) {
    return allCatalogSections().find((section) => section.rid === rid) || null;
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

    const rate = grid.querySelector('.xgplayer-playbackrate');
    if (rate) rate.insertAdjacentElement('afterend', button);
    else grid.appendChild(button);

    playlistButton = button;
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
    panel.innerHTML = `
      <div class="xet-pl-head">
        <span class="xet-pl-title">选集</span>
        <span class="xet-pl-count"></span>
        <button class="xet-pl-close" type="button" aria-label="关闭">×</button>
      </div>
      <div class="xet-pl-search-wrap">
        <input class="xet-pl-search" type="search" placeholder="搜索章节或课时" autocomplete="off">
      </div>
      <div class="xet-pl-body"></div>
    `;

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
    panel.querySelector('.xet-pl-body').addEventListener('click', onPlaylistBodyClick);

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
    togglePlaylist();
  }

  function closePlaylist() {
    playlistOpen = false;
    if (playlistPanel) playlistPanel.hidden = true;
    if (playlistButton) playlistButton.classList.remove('active');
  }

  function togglePlaylist() {
    if (playlistOpen) {
      closePlaylist();
      return;
    }

    const panel = ensurePlaylistPanel();
    if (!panel) return;

    playlistOpen = true;
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

  function renderPlaylistMessage(message) {
    if (!playlistPanel) return;
    const body = playlistPanel.querySelector('.xet-pl-body');
    if (!body) return;
    const element = document.createElement('div');
    element.className = 'xet-pl-message';
    element.textContent = message;
    body.replaceChildren(element);
  }

  function renderPlaylistError(error) {
    if (!playlistPanel) return;
    const body = playlistPanel.querySelector('.xet-pl-body');
    if (!body) return;

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

  function createPlaylistRow(chapter, section, activeRid) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'xet-pl-item';
    row.dataset.rid = section.rid;
    row.dataset.search = `${chapter.title} ${section.title}`.toLowerCase();
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

  function renderPlaylist() {
    if (!playlistPanel || !catalogTree) return;
    const body = playlistPanel.querySelector('.xet-pl-body');
    const count = playlistPanel.querySelector('.xet-pl-count');
    if (!body) return;

    const activeRid = getCurrentResourceId();
    playlistActiveRid = activeRid;
    const fragment = document.createDocumentFragment();
    let total = 0;

    for (const group of catalogTree) {
      if (group.label) {
        const label = document.createElement('div');
        label.className = 'xet-pl-group';
        label.textContent = group.label.replace(/^=+\s*/, '').replace(/\s*=+$/, '');
        fragment.appendChild(label);
      }

      for (const chapter of group.chapters) {
        const wrap = document.createElement('div');
        wrap.className = 'xet-pl-chapter';

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
          amount.textContent = chapter.error ? '加载失败' : String(chapter.sections.length);
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
    applyPlaylistFilter();
    requestAnimationFrame(scrollPlaylistToCurrent);
  }

  function applyPlaylistFilter() {
    if (!playlistPanel) return;
    const body = playlistPanel.querySelector('.xet-pl-body');
    if (!body) return;
    const query = playlistSearch;
    let groupLabel = null;

    for (const node of body.children) {
      if (node.classList.contains('xet-pl-group')) {
        groupLabel = node;
        node.hidden = true;
        continue;
      }
      if (!node.classList.contains('xet-pl-chapter')) continue;

      const rows = [...node.querySelectorAll('.xet-pl-item')];
      const chapterTitle = (node.querySelector('.xet-pl-chapter-title')?.textContent || '').toLowerCase();
      const chapterMatch = !!query && chapterTitle.includes(query);
      let visible = 0;

      for (const row of rows) {
        const match = !query || chapterMatch || (row.dataset.search || '').includes(query);
        row.hidden = !match;
        if (match) visible += 1;
      }

      if (query && visible > 0) node.classList.remove('collapsed');
      node.hidden = visible === 0;
      if (visible > 0 && groupLabel) groupLabel.hidden = false;
    }
  }

  function scrollPlaylistToCurrent() {
    if (!playlistPanel) return;
    const body = playlistPanel.querySelector('.xet-pl-body');
    const row = body?.querySelector('.xet-pl-item.current');
    if (!body || !row) return;
    const chapter = row.closest('.xet-pl-chapter');
    if (chapter) chapter.classList.remove('collapsed');
    body.scrollTop = Math.max(0, row.offsetTop - body.clientHeight / 2 + row.offsetHeight / 2);
  }

  function updatePlaylistCurrent() {
    if (!catalogTree) return;
    const rid = getCurrentResourceId();
    if (rid === playlistActiveRid) return;
    playlistActiveRid = rid;
    if (playlistOpen) renderPlaylist();
  }

  function sectionUrl(section) {
    if (section.jumpUrl) {
      try {
        return new URL(section.jumpUrl, location.origin).href;
      } catch (_) {}
    }
    if (section.type === 3 || /^v_/.test(section.rid)) {
      const courseId = getCourseId();
      if (!courseId) return '';
      return `/p/t_pc/course_pc_detail/video/${encodeURIComponent(
        section.rid
      )}?product_id=${encodeURIComponent(courseId)}&auto=1`;
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

    playlistOpen = false;
    location.assign(url);
  }

  function onPlaylistBodyClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const head = target.closest('.xet-pl-chapter-head');
    if (head) {
      event.preventDefault();
      event.stopPropagation();
      head.closest('.xet-pl-chapter')?.classList.toggle('collapsed');
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
    if (playlistPanel && event.target instanceof Node && playlistPanel.contains(event.target)) {
      event.stopImmediatePropagation();
    }
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
    ensurePlaylistControl();
    updatePlaylistCurrent();
    if (playlistOpen) ensurePlaylistPanel();
    scheduleCatalogPrefetch();
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
      playlistSearch = '';
      clearTimeout(playlistPrefetchTimer);
      playlistPrefetchTimer = 0;
      catalogPrefetchDone = false;
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

  function enterWebFullscreen() {
    return clickSiteControl('.xgplayer-cssfullscreen .xgplayer-icon, .xgplayer-cssfullscreen');
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
        updateAll();
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
        updateAll();
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
        setTimeout(updateAll, 80);
        setTimeout(updateAll, 360);
      }
      return;
    }

    if (native) {
      event.preventDefault();
      event.stopImmediatePropagation();
      exitNativeAndRestore();
    } else {
      stateBeforeNative = web ? 'wide' : 'normal';
      setTimeout(updateAll, 120);
      setTimeout(updateAll, 600);
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
