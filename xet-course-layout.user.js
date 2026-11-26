// ==UserScript==
// @name         小鹅通课程页布局重构
// @namespace    https://github.com/StreetCornelia/xet-plus
// @version      0.3.17
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

/**
 * @typedef {Object} CatalogSection
 * @property {string} rid 站点 resource_id
 * @property {string} title 课时标题
 * @property {number} type 资源类型（3 视频，4 直播）
 * @property {number} duration 时长（秒）
 * @property {number} status 学习状态
 * @property {number} progress 学习进度（0-100）
 * @property {number} unlock 解锁状态
 * @property {boolean} isTry 是否试看
 * @property {string} jumpUrl 站点跳转地址
 */

/**
 * @typedef {Object} CatalogChapter
 * @property {string} id
 * @property {string} title
 * @property {boolean} [error]
 * @property {CatalogSection[]} sections
 */

/**
 * @typedef {Object} CatalogGroup
 * @property {string} label
 * @property {CatalogChapter[]} chapters
 * @property {boolean} [series]
 */

/**
 * @typedef {Object} PlaybackPrefsData
 * @property {number} [volume]
 * @property {boolean} [muted]
 * @property {number} [rate]
 * @property {string} [playmode]
 * @property {number} [updated]
 */

/**
 * @typedef {Object} PlayerVm
 * @property {any} [player]
 * @property {string} [resourceId]
 * @property {any} [loopVideoForPackage]
 * @property {number} [playModeType]
 * @property {number} [playMode]
 * @property {any} [$funcTool]
 * @property {Function} [initVideo]
 * @property {Function} [initLoop]
 * @property {Function} [changeNextVideoEvent]
 */

/**
 * @typedef {Object} BaseVm
 * @property {any} [$router]
 * @property {Function} [initCourseCoreData]
 */

/**
 * @typedef {Object} VideoTarget
 * @property {string} [url]
 * @property {string} [jump_url]
 */

(function () {
  'use strict';

  const Config = {
    STYLE_ID: 'xet-layout-style',
    STYLE_VERSION: '0.3.17',
    PREFS_KEY: 'xet-playback-prefs-v1',
    CATALOG_API: '/xe.course.business_go.avoidlogin.e_course.resource_catalog_list.get/1.0.0',
    SUB_CATALOG_API: '/xe.course.business_go.avoidlogin.e_course.sub.course.list/1.0.0',
    CHAPTER_STATE_KEY: 'xet-playlist-chapters-v1',
    CATALOG_TTL: 10 * 60 * 1000,
    APPLY_DELAY: 1200,
    APPLY_RETRY: 200,
    APPLY_MAX_RETRIES: 8,
    FULL_CLASSES: [
      'xgplayer-is-css-fullscreen',
      'xgplayer-is-cssfullscreen',
      'xgplayer-is-fullscreen',
      'xgplayer-page-fullscreen'
    ]
  };
  Config.FULL_SEL = Config.FULL_CLASSES.map((name) => '.' + name).join(',');

  // ==== 00. Pure helpers ====

  function requestResize() {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    });
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

  function formatDuration(total) {
    const seconds = Math.max(0, Math.floor(Number(total) || 0));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
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

  function isEditableNode(node) {
    if (!(node instanceof HTMLElement)) return false;
    if (node.isContentEditable) return true;
    return !!node.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]'
    );
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

  // ==== 01. PageContext ====

  /** 纯读取页面与播放器状态，不持有可变状态。 */
  class PageContext {
    /** @param {typeof Config} config */
    constructor(config) {
      this.config = config;
    }

    isPlaybackPage() {
      return /\/course_pc_detail\/video\/[^/]*v_[A-Za-z0-9]+/.test(location.pathname);
    }

    getPlayerRoot() {
      return (
        document.querySelector('#pc_course_fe_basic_video') ||
        document.querySelector('.xgplayer') ||
        document.querySelector('video')?.closest('.xgplayer')
      );
    }

    /** @param {HTMLVideoElement | null} [preferred] */
    getActiveVideo(preferred = null) {
      if (preferred && preferred.isConnected) return preferred;
      return this.getPlayerRoot()?.querySelector('video') || null;
    }

    isWebFullscreen() {
      const root = this.getPlayerRoot();
      if (!root) return false;
      const rect = root.getBoundingClientRect();
      const style = getComputedStyle(root);
      const coversViewport =
        Math.abs(rect.width - window.innerWidth) <= 2 && Math.abs(rect.height - window.innerHeight) <= 2;
      if (!coversViewport) return false;
      return style.position === 'fixed' || root.matches(this.config.FULL_SEL);
    }

    isNativeFullscreen() {
      return !!document.fullscreenElement;
    }

    getCourseId() {
      try {
        return new URL(location.href).searchParams.get('product_id') || '';
      } catch (_) {
        return '';
      }
    }

    getCourseAppId() {
      return location.hostname.split('.')[0] || '';
    }

    getCurrentResourceId() {
      const match = location.pathname.match(/\/course_pc_detail\/video\/(v_[A-Za-z0-9]+)/);
      return match ? match[1] : '';
    }

    isVideoLessonUrl(url) {
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
  }

  // ==== 02. LayoutChrome ====

  /** 样式注入、body 命名空间类与全屏状态类。 */
  class LayoutChrome {
    /**
     * @param {PageContext} ctx
     * @param {typeof Config} config
     */
    constructor(ctx, config) {
      this.ctx = ctx;
      this.config = config;
      this.lastWide = false;
      this.lastNative = false;
    }

    ensure() {
      this.injectStyle();
      this.ensureBodyClass();
    }

    injectStyle() {
      const existing = document.getElementById(this.config.STYLE_ID);
      if (existing && existing.dataset.version === this.config.STYLE_VERSION) return;
      if (existing) existing.remove();
      const style = document.createElement('style');
      style.id = this.config.STYLE_ID;
      style.dataset.version = this.config.STYLE_VERSION;
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

    ensureBodyClass() {
      if (!document.body || !this.ctx.isPlaybackPage()) return false;
      if (!document.body.classList.contains('xet-rebuild')) document.body.classList.add('xet-rebuild');
      return true;
    }

    sync() {
      const wide = this.ctx.isWebFullscreen();
      const native = this.ctx.isNativeFullscreen();
      const wideChanged = wide !== this.lastWide;
      this.lastWide = wide;
      this.lastNative = native;

      document.documentElement.classList.toggle('xet-fs-wide', wide);
      if (document.body) document.body.classList.toggle('xet-fs-wide', wide);
      document.documentElement.classList.toggle('xet-native-full', native);
      if (document.body) document.body.classList.toggle('xet-native-full', native);

      if (wideChanged) requestResize();
    }

    updateLabels() {
      const web = this.ctx.isWebFullscreen();
      const native = this.ctx.isNativeFullscreen();
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

    remove() {
      document.documentElement.classList.remove('xet-rebuild', 'xet-fs-wide', 'xet-native-full');
      if (document.body) {
        document.body.classList.remove('xet-rebuild', 'xet-fs-wide', 'xet-native-full');
      }
      document.getElementById(this.config.STYLE_ID)?.remove();
    }
  }

  // ==== 03. PlayerBridge ====

  /** 站点 Vue / XGPlayer 内部接口桥接。 */
  class PlayerBridge {
    /**
     * @param {PageContext} ctx
     */
    constructor(ctx) {
      this.ctx = ctx;
      this.videoResourceIds = new WeakMap();
      this.onRestoreWide = null;
    }

    getVideoResourceId(video) {
      return this.videoResourceIds.get(video);
    }

    setVideoResourceId(video, rid) {
      this.videoResourceIds.set(video, rid);
    }

    /**
     * @param {URL} target
     * @param {boolean} updateRoute
     */
    async refreshVideoPlayer(target, updateRoute) {
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

      const wasWide = this.ctx.isWebFullscreen();

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

      if (wasWide && !this.ctx.isWebFullscreen()) this.onRestoreWide?.();
    }
  }

  // ==== 04. PlaybackPrefs ====

  /** 音量 / 静音 / 倍速 / 播放形式记忆与视频事件。 */
  class PlaybackPrefs {
    /**
     * @param {{ ctx: PageContext, bridge: PlayerBridge, config: typeof Config }} deps
     */
    constructor({ ctx, bridge, config }) {
      this.ctx = ctx;
      this.bridge = bridge;
      this.config = config;

      this.applyToken = 0;
      this.applyTimer = 0;
      this.applyRetryTimer = 0;
      this.applying = false;
      this.repairDone = false;
      this.repairTimer = 0;
      this.volumeGestureUntil = 0;
      this.rateGestureUntil = 0;
      this.startupUntil = 0;
      this.startupRepairCount = 0;
      this.playRestoreDone = false;
      this.watchedVideo = null;
      this.watchedTitle = null;
      this.titleObserver = null;
      this.srcObserver = null;
      this.lastTitleText = '';
      this.onEnded = null;
    }

    readPlaybackPrefs() {
      try {
        const raw = localStorage.getItem(this.config.PREFS_KEY);
        const value = raw ? JSON.parse(raw) : null;
        return value && typeof value === 'object' ? value : {};
      } catch (_) {
        return {};
      }
    }

    savePlaybackPrefs(patch) {
      try {
        const next = { ...this.readPlaybackPrefs(), ...patch, updated: Date.now() };
        localStorage.setItem(this.config.PREFS_KEY, JSON.stringify(next));
      } catch (_) {}
    }

    notePreferenceGesture = (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const until = Date.now() + 3000;
      if (target.closest('.xgplayer-volume')) {
        this.volumeGestureUntil = until;
        this.startupUntil = 0;
      }
      if (target.closest('.xgplayer-playbackrate')) this.rateGestureUntil = until;
    };

    onVolumeChange = () => {
      if (this.applying) return;
      const now = Date.now();
      if (now > this.volumeGestureUntil) {
        if (now < this.startupUntil && this.startupRepairCount < 3) {
          this.startupRepairCount += 1;
          this.armApply();
        }
        return;
      }
      const video = this.ctx.getActiveVideo(this.watchedVideo);
      if (!video) return;
      this.savePlaybackPrefs({ volume: video.volume, muted: !!video.muted });
    };

    onRateChange = () => {
      if (this.applying) return;
      if (Date.now() > this.rateGestureUntil) return;
      const video = this.ctx.getActiveVideo(this.watchedVideo);
      if (!video) return;
      const rate = normalizeRate(video.playbackRate);
      if (rate !== null) this.savePlaybackPrefs({ rate });
    };

    onPlaymodeClick = (event) => {
      if (this.applying) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const option = target.closest('.xgplayer-playmode .option-item');
      if (!option) return;
      const mode = normalizePlaymode(option.getAttribute('playmodetype') || option.getAttribute('showtext'));
      if (mode) this.savePlaybackPrefs({ playmode: mode });
    };

    finishApply(token) {
      if (token !== this.applyToken) return;
      setTimeout(() => {
        if (token === this.applyToken) this.applying = false;
      }, 1000);
    }

    applyPlaybackPrefs(token, attempt) {
      if (token !== this.applyToken) return;
      const video = this.ctx.getActiveVideo(this.watchedVideo);
      if (!video) {
        if (attempt < this.config.APPLY_MAX_RETRIES) {
          clearTimeout(this.applyRetryTimer);
          this.applyRetryTimer = setTimeout(() => this.applyPlaybackPrefs(token, attempt + 1), this.config.APPLY_RETRY);
        } else {
          this.finishApply(token);
        }
        return;
      }

      const prefs = this.readPlaybackPrefs();
      const hasAny = prefs.volume != null || prefs.rate != null || prefs.playmode != null;
      if (!hasAny) {
        this.finishApply(token);
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

      if (missing && attempt < this.config.APPLY_MAX_RETRIES) {
        clearTimeout(this.applyRetryTimer);
        this.applyRetryTimer = setTimeout(() => this.applyPlaybackPrefs(token, attempt + 1), this.config.APPLY_RETRY);
        return;
      }

      if (!this.repairDone) {
        this.repairDone = true;
        clearTimeout(this.repairTimer);
        this.repairTimer = setTimeout(() => {
          if (token === this.applyToken) this.applyPlaybackPrefs(token, 0);
        }, 1400);
        return;
      }

      this.finishApply(token);
    }

    armApply() {
      if (!this.ctx.isPlaybackPage() || !this.ctx.getActiveVideo(this.watchedVideo)) return;
      const token = ++this.applyToken;
      this.applying = true;
      this.repairDone = false;
      clearTimeout(this.applyTimer);
      clearTimeout(this.applyRetryTimer);
      clearTimeout(this.repairTimer);
      this.applyTimer = setTimeout(() => this.applyPlaybackPrefs(token, 0), this.config.APPLY_DELAY);
    }

    onVideoLoaded = () => {
      this.startupUntil = Date.now() + 15000;
      this.startupRepairCount = 0;
      this.playRestoreDone = false;
      this.armApply();
    };

    onVideoPlaying = () => {
      if (this.playRestoreDone) return;
      this.playRestoreDone = true;
      this.startupUntil = Date.now() + 15000;
      this.startupRepairCount = 0;
      if (Date.now() <= this.volumeGestureUntil) return;
      this.armApply();
    };

    handleEnded = (event) => {
      this.onEnded?.(event);
    };

    watchVideo() {
      const video = this.ctx.getPlayerRoot()?.querySelector('video');
      if (!video || video === this.watchedVideo) return;

      if (this.watchedVideo) {
        const previous = this.watchedVideo;
        previous.removeEventListener('loadedmetadata', this.onVideoLoaded);
        previous.removeEventListener('loadstart', this.onVideoLoaded);
        previous.removeEventListener('emptied', this.onVideoLoaded);
        previous.removeEventListener('playing', this.onVideoPlaying);
        previous.removeEventListener('ended', this.handleEnded);
        previous.removeEventListener('volumechange', this.onVolumeChange);
        previous.removeEventListener('ratechange', this.onRateChange);
      }

      this.watchedVideo = video;
      this.bridge.setVideoResourceId(video, this.ctx.getCurrentResourceId());
      this.startupUntil = Date.now() + 15000;
      this.startupRepairCount = 0;
      this.playRestoreDone = false;
      video.addEventListener('loadedmetadata', this.onVideoLoaded);
      video.addEventListener('loadstart', this.onVideoLoaded);
      video.addEventListener('emptied', this.onVideoLoaded);
      video.addEventListener('playing', this.onVideoPlaying);
      video.addEventListener('ended', this.handleEnded);
      video.addEventListener('volumechange', this.onVolumeChange);
      video.addEventListener('ratechange', this.onRateChange);

      if (this.srcObserver) this.srcObserver.disconnect();
      this.srcObserver = new MutationObserver(() => this.armApply());
      this.srcObserver.observe(video, { attributes: true, attributeFilter: ['src'] });

      if (video.readyState >= 1) this.armApply();
    }

    watchTitle() {
      const title = document.querySelector('.video-title__font');
      if (!title) return;
      const text = (title.textContent || '').trim();

      if (title !== this.watchedTitle) {
        this.watchedTitle = title;
        if (this.titleObserver) this.titleObserver.disconnect();
        this.titleObserver = new MutationObserver(() => {
          const next = (title.textContent || '').trim();
          if (next && next !== this.lastTitleText) {
            this.lastTitleText = next;
            this.armApply();
          }
        });
        this.titleObserver.observe(title, { childList: true, subtree: true, characterData: true });
      }

      if (text && this.lastTitleText && text !== this.lastTitleText) {
        this.lastTitleText = text;
        this.armApply();
      } else if (text && !this.lastTitleText) {
        this.lastTitleText = text;
      }
    }

    isContinuous(playerVm) {
      const mode =
        Number(playerVm?.playModeType ?? playerVm?.playMode) ||
        Number(this.readPlaybackPrefs().playmode) ||
        0;
      return mode === 3;
    }

    stop() {
      clearTimeout(this.applyTimer);
      clearTimeout(this.applyRetryTimer);
      clearTimeout(this.repairTimer);
      ++this.applyToken;
      this.applying = false;
      this.repairDone = false;
      this.lastTitleText = '';
      if (this.titleObserver) this.titleObserver.disconnect();
      if (this.srcObserver) this.srcObserver.disconnect();
      if (this.watchedVideo) {
        const video = this.watchedVideo;
        video.removeEventListener('loadedmetadata', this.onVideoLoaded);
        video.removeEventListener('loadstart', this.onVideoLoaded);
        video.removeEventListener('emptied', this.onVideoLoaded);
        video.removeEventListener('volumechange', this.onVolumeChange);
        video.removeEventListener('ratechange', this.onRateChange);
        video.removeEventListener('ended', this.handleEnded);
        this.watchedVideo = null;
      }
      this.watchedTitle = null;
    }
  }

  // ==== 05. ChapterStateStore ====

  /** 按课程记忆章节展开状态。 */
  class ChapterStateStore {
    /**
     * @param {PageContext} ctx
     * @param {typeof Config} config
     */
    constructor(ctx, config) {
      this.ctx = ctx;
      this.config = config;
      this.overrides = new Map();
      this.courseId = '';
    }

    ensure(courseId = this.ctx.getCourseId()) {
      if (this.courseId === courseId) return;
      this.courseId = courseId;
      this.overrides = new Map();
      if (!courseId) return;

      try {
        const raw = JSON.parse(localStorage.getItem(`${this.config.CHAPTER_STATE_KEY}:${courseId}`) || 'null');
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          for (const [id, value] of Object.entries(raw)) {
            if (typeof value === 'boolean') this.overrides.set(id, value);
          }
        }
      } catch (_) {}
    }

    save() {
      if (!this.courseId) return;
      try {
        const raw = {};
        for (const [id, value] of this.overrides) raw[id] = value;
        localStorage.setItem(`${this.config.CHAPTER_STATE_KEY}:${this.courseId}`, JSON.stringify(raw));
      } catch (_) {}
    }

    isExpanded(chapterId, currentChapterId) {
      if (this.overrides.has(chapterId)) return this.overrides.get(chapterId);
      return !!currentChapterId && chapterId === currentChapterId;
    }

    set(id, value) {
      this.overrides.set(id, value);
    }

    reset() {
      this.overrides = new Map();
      this.courseId = '';
    }
  }

  // ==== 06. CatalogService ====

  /** 课程目录 API、缓存、树结构与查询。 */
  class CatalogService {
    /**
     * @param {{ ctx: PageContext, config: typeof Config }} deps
     */
    constructor({ ctx, config }) {
      this.ctx = ctx;
      this.config = config;
      this.tree = null;
      this.courseId = '';
      this.fetchedAt = 0;
      this.promise = null;
      this.onLoaded = null;
    }

    async catalogRequest(biz) {
      const courseId = this.ctx.getCourseId();
      const appId = this.ctx.getCourseAppId();
      if (!courseId || !appId) throw new Error('缺少课程信息');

      const response = await fetch(this.config.CATALOG_API, {
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

    async subCourseRequest() {
      const courseId = this.ctx.getCourseId();
      const appId = this.ctx.getCourseAppId();
      if (!courseId || !appId) return [];

      const response = await fetch(this.config.SUB_CATALOG_API, {
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

    load(force) {
      const courseId = this.ctx.getCourseId();
      if (!courseId) return Promise.resolve(null);
      if (!force && this.tree && this.courseId === courseId) return Promise.resolve(this.tree);
      if (this.promise) return this.promise;

      this.promise = (async () => {
        const cacheKey = `xet-catalog-v4:${courseId}`;

        if (!force) {
          try {
            const cached = JSON.parse(sessionStorage.getItem(cacheKey) || 'null');
            if (cached && cached.ts && Date.now() - cached.ts < this.config.CATALOG_TTL && Array.isArray(cached.groups)) {
              this.tree = cached.groups;
              this.courseId = courseId;
              this.fetchedAt = cached.ts;
              this.onLoaded?.();
              return this.tree;
            }
          } catch (_) {}
        }

        const [top, rawSeries] = await Promise.all([
          this.catalogRequest({}),
          this.subCourseRequest().catch(() => [])
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
            const list = await this.catalogRequest({ p_id: chapter.chapter_id });
            childMap.set(String(chapter.chapter_id), { list });
          } catch (_) {
            childMap.set(String(chapter.chapter_id), { list: [], error: true });
          }
        });

        this.tree = buildCatalogTree(top, childMap, seriesEntries);
        this.courseId = courseId;
        this.fetchedAt = Date.now();
        this.onLoaded?.();

        const hasError = [...childMap.values()].some((entry) => entry.error);
        if (!hasError) {
          try {
            sessionStorage.setItem(cacheKey, JSON.stringify({ ts: this.fetchedAt, groups: this.tree }));
          } catch (_) {}
        }

        return this.tree;
      })().finally(() => {
        this.promise = null;
      });

      return this.promise;
    }

    async fetchChapterSections(chapterId) {
      const list = await this.catalogRequest({ p_id: chapterId });
      return list.map(normalizeSection).filter((section) => section.rid && section.title);
    }

    allSections() {
      const sections = [];
      for (const group of this.tree || []) {
        for (const chapter of group.chapters || []) {
          for (const section of chapter.sections || []) sections.push(section);
        }
      }
      return sections;
    }

    seriesGroups() {
      return (this.tree || []).filter(
        (group) =>
          group.series &&
          (group.chapters || []).some(
            (chapter) => (chapter.sections || []).length > 0 || chapter.error
          )
      );
    }

    usesSeriesTabs() {
      return this.seriesGroups().length > 1;
    }

    displayGroups() {
      const seriesGroups = this.seriesGroups();
      return seriesGroups.length ? seriesGroups : this.tree || [];
    }

    findGroupIndexForRid(groups, rid) {
      if (!rid) return -1;
      return groups.findIndex((group) =>
        (group.chapters || []).some((chapter) =>
          (chapter.sections || []).some((section) => section.rid === rid)
        )
      );
    }

    findSection(rid) {
      return this.allSections().find((section) => section.rid === rid) || null;
    }

    findChapter(rid) {
      if (!rid) return null;
      for (const group of this.tree || []) {
        for (const chapter of group.chapters || []) {
          if ((chapter.sections || []).some((section) => section.rid === rid)) return chapter;
        }
      }
      return null;
    }

    findCurrentChapterId(rid) {
      return this.findChapter(rid)?.id || '';
    }

    /**
     * 合并本地播放进度，返回受影响章节。
     * @returns {CatalogChapter | null}
     */
    applyProgress(rid, { ended, currentTime, duration }) {
      const section = this.findSection(rid);
      const chapter = this.findChapter(rid);
      if (!section || !chapter) return null;

      if (ended) {
        section.status = 2;
        section.progress = 100;
      } else if (Number.isFinite(duration) && duration > 0) {
        const progress = Math.min(100, Math.max(0, Math.round((currentTime / duration) * 100)));
        if (progress > 0) {
          if (section.status !== 2) section.status = 1;
          section.progress = Math.max(Number(section.progress) || 0, progress);
        }
      }
      return chapter;
    }

    /** 用服务端章节数据替换，保留本地已完成状态与更高进度。 */
    replaceChapterSections(chapter, sections) {
      const previous = new Map((chapter.sections || []).map((section) => [section.rid, section]));
      for (const section of sections) {
        const old = previous.get(section.rid);
        if (!old) continue;
        if (old.status === 2) {
          section.status = 2;
          section.progress = 100;
        } else if (section.status !== 2) {
          section.progress = Math.max(Number(section.progress) || 0, Number(old.progress) || 0);
        }
      }
      chapter.sections = sections;
      chapter.error = false;
    }

    sectionUrl(section) {
      if (section.type === 3 || /^v_/.test(section.rid)) {
        const courseId = this.ctx.getCourseId();
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

    reset() {
      this.tree = null;
      this.courseId = '';
      this.fetchedAt = 0;
      this.promise = null;
    }
  }

  // ==== 07. StatusSync ====

  /** 当前进度即时合并、30 秒刷新当前章节、切课后刷新。 */
  class StatusSync {
    /**
     * @param {{ ctx: PageContext, catalog: CatalogService, playlist: PlaylistView, prefs: PlaybackPrefs }} deps
     */
    constructor({ ctx, catalog, playlist, prefs }) {
      this.ctx = ctx;
      this.catalog = catalog;
      this.playlist = playlist;
      this.prefs = prefs;
      this.timer = 0;
      this.busy = false;
      this.lastRefreshAt = 0;
      this.isSwitching = null;
    }

    capture(completed = false, ridOverride = '', videoOverride = null) {
      if (!this.catalog.tree || !this.ctx.isPlaybackPage()) return;
      const rid = ridOverride || this.ctx.getCurrentResourceId();
      const video = videoOverride || this.ctx.getActiveVideo(this.prefs.watchedVideo);
      if (!rid || !video) return;

      const ended = completed || video.ended;
      const chapter = this.catalog.applyProgress(rid, {
        ended,
        currentTime: video.currentTime,
        duration: Number(video.duration)
      });
      if (chapter) this.playlist.updateChapter(chapter);
    }

    async refreshCurrentChapter(force = false) {
      if (!this.ctx.isPlaybackPage() || !this.catalog.tree || this.busy) return;
      const now = Date.now();
      if (!force && now - this.lastRefreshAt < 25000) return;

      const rid = this.ctx.getCurrentResourceId();
      const chapter = this.catalog.findChapter(rid);
      if (!chapter || !chapter.id) return;

      this.busy = true;
      this.lastRefreshAt = now;
      try {
        const sections = await this.catalog.fetchChapterSections(chapter.id);
        if (!this.catalog.tree) return;
        if (!sections.length) return;
        this.catalog.replaceChapterSections(chapter, sections);
        this.playlist.updateChapter(chapter);
      } catch (_) {
      } finally {
        this.busy = false;
      }
    }

    start() {
      if (this.timer) return;
      this.timer = setInterval(() => {
        if (!this.ctx.isPlaybackPage() || document.hidden) return;
        this.capture();
        this.refreshCurrentChapter();
      }, 30000);
    }

    stop() {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = 0;
      }
      this.busy = false;
      this.lastRefreshAt = 0;
    }

    schedulePostSwitch() {
      setTimeout(() => {
        if (!this.ctx.isPlaybackPage() || this.isSwitching?.()) return;
        this.capture();
        this.refreshCurrentChapter(true);
      }, 1500);
    }
  }

  // ==== 08. PlaylistView ====

  /** 控制条选集按钮、目录面板、搜索、系列 tab、折叠、定位与行渲染。 */
  class PlaylistView {
    /**
     * @param {{ ctx: PageContext, catalog: CatalogService, chapterState: ChapterStateStore }} deps
     */
    constructor({ ctx, catalog, chapterState }) {
      this.ctx = ctx;
      this.catalog = catalog;
      this.chapterState = chapterState;

      this.button = null;
      this.panel = null;
      this.isOpen = false;
      this.search = '';
      this.scrollTop = 0;
      this.restoreScroll = false;
      this.activeRid = '';
      this.currentChapterId = '';
      this.seriesIndex = -1;
      this.hoverOpenTimer = 0;
      this.hoverCloseTimer = 0;

      this.onLessonSelect = null;
      this.onOpenRefresh = null;
    }

    ensureControl() {
      const root = this.ctx.getPlayerRoot();
      if (!root) return;
      const grid = root.querySelector('.xg-right-grid');
      if (!grid) return;

      if (this.button && this.button.isConnected && grid.contains(this.button)) return;

      const existing = grid.querySelector('.xgplayer-playlist');
      if (existing) {
        this.button = existing;
        this.bindHover(existing);
        return;
      }

      const button = document.createElement('xg-icon');
      button.className = 'xg-options-icon xgplayer-playlist show';
      button.setAttribute('role', 'button');
      button.setAttribute('tabindex', '0');
      button.setAttribute('aria-label', '选集');
      button.innerHTML =
        '<div class="xgplayer-icon btn-text"><span class="icon-text">选集</span></div>';
      button.addEventListener('click', this.onButtonClick, true);
      button.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        this.toggle();
      });
      this.bindHover(button);

      const rate = grid.querySelector('.xgplayer-playbackrate');
      if (rate) rate.insertAdjacentElement('afterend', button);
      else grid.appendChild(button);

      this.button = button;
    }

    bindHover(element) {
      if (!element || element.dataset.xetHoverBound) return;
      element.dataset.xetHoverBound = '1';
      element.addEventListener('mouseenter', this.scheduleOpen);
      element.addEventListener('mouseleave', this.scheduleClose);
    }

    ensurePanel() {
      const root = this.ctx.getPlayerRoot();
      if (!root) return null;
      if (this.panel && this.panel.isConnected && this.panel.parentElement === root) return this.panel;

      if (this.panel) this.panel.remove();

      const panel = document.createElement('div');
      panel.className = 'xet-playlist-panel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', '选集');
      panel.hidden = !this.isOpen;
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
        this.setAllChapters(false);
      });
      panel.querySelector('.xet-pl-expand-all').addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.setAllChapters(true);
      });
      panel.querySelector('.xet-pl-locate').addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.locateCurrentLesson();
      });
      panel.querySelector('.xet-pl-close').addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.closePlaylist();
      });
      const searchInput = panel.querySelector('.xet-pl-search');
      searchInput.value = this.search;
      searchInput.addEventListener('input', (event) => {
        this.search = String(event.target.value || '').trim().toLowerCase();
        this.applyFilter();
      });
      const body = panel.querySelector('.xet-pl-body');
      body.addEventListener('click', this.onBodyClick);
      body.addEventListener(
        'scroll',
        () => {
          this.updateLocateButton();
          setTimeout(() => this.updateLocateButton(), 80);
        },
        { passive: true }
      );
      body.addEventListener(
        'wheel',
        () => setTimeout(() => this.updateLocateButton(), 80),
        { passive: true }
      );
      window.addEventListener('resize', this.updateLocateButton, { passive: true });

      panel.addEventListener('mouseenter', this.cancelClose);
      panel.addEventListener('mouseleave', this.scheduleClose);
      panel.addEventListener('mousedown', (event) => event.stopPropagation());
      panel.addEventListener('touchstart', (event) => event.stopPropagation(), { passive: true });
      panel.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });

      root.appendChild(panel);
      this.panel = panel;
      if (this.isOpen && this.catalog.tree) this.render();
      return panel;
    }

    onButtonClick = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.openPlaylist();
    };

    closePlaylist() {
      clearTimeout(this.hoverOpenTimer);
      clearTimeout(this.hoverCloseTimer);
      this.isOpen = false;
      if (this.panel) {
        const body = this.panel.querySelector('.xet-pl-body');
        if (body) this.scrollTop = body.scrollTop;
        if (this.panel.contains(document.activeElement)) document.activeElement.blur();
        this.panel.hidden = true;
      }
      if (this.button) this.button.classList.remove('active');
    }

    openPlaylist() {
      clearTimeout(this.hoverOpenTimer);
      clearTimeout(this.hoverCloseTimer);
      if (this.isOpen) return;

      const panel = this.ensurePanel();
      if (!panel) return;

      this.isOpen = true;
      this.restoreScroll = !!this.search;
      panel.hidden = false;
      if (this.button) this.button.classList.add('active');

      if (this.catalog.tree) {
        this.render();
        this.onOpenRefresh?.();
        return;
      }

      this.renderMessage('正在加载课程目录…');
      this.catalog
        .load()
        .then(() => {
          if (this.isOpen) {
            this.render();
            this.onOpenRefresh?.();
          }
        })
        .catch((error) => {
          if (this.isOpen) this.renderError(error);
        });
    }

    toggle() {
      if (this.isOpen) this.closePlaylist();
      else this.openPlaylist();
    }

    scheduleOpen = () => {
      clearTimeout(this.hoverCloseTimer);
      if (this.isOpen) return;
      clearTimeout(this.hoverOpenTimer);
      this.hoverOpenTimer = setTimeout(() => {
        if (!this.isOpen) this.openPlaylist();
      }, 100);
    };

    scheduleClose = () => {
      clearTimeout(this.hoverOpenTimer);
      clearTimeout(this.hoverCloseTimer);
      this.hoverCloseTimer = setTimeout(() => {
        if (!this.isOpen) return;
        this.closePlaylist();
      }, 250);
    };

    cancelClose = () => {
      clearTimeout(this.hoverCloseTimer);
    };

    clearSeriesTabs() {
      if (!this.panel) return;
      this.panel.classList.remove('has-series');
      const tabs = this.panel.querySelector('.xet-pl-series-tabs');
      if (tabs) {
        tabs.hidden = true;
        tabs.replaceChildren();
      }
    }

    renderMessage(message) {
      if (!this.panel) return;
      const body = this.panel.querySelector('.xet-pl-body');
      if (!body) return;
      this.clearSeriesTabs();
      const element = document.createElement('div');
      element.className = 'xet-pl-message';
      element.textContent = message;
      body.replaceChildren(element);
    }

    renderError(error) {
      if (!this.panel) return;
      const body = this.panel.querySelector('.xet-pl-body');
      if (!body) return;
      this.clearSeriesTabs();

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
        this.renderMessage('正在加载课程目录…');
        this.catalog
          .load(true)
          .then(() => {
            if (this.isOpen) this.render();
          })
          .catch((nextError) => {
            if (this.isOpen) this.renderError(nextError);
          });
      });

      wrap.append(text, detail, retry);
      body.replaceChildren(wrap);
    }

    setAllChapters(expanded) {
      this.chapterState.ensure(this.ctx.getCourseId());
      if (!this.catalog.tree || !this.panel) return;

      this.search = '';
      const searchInput = this.panel.querySelector('.xet-pl-search');
      if (searchInput) searchInput.value = '';

      for (const group of this.catalog.tree) {
        for (const chapter of group.chapters) {
          if (chapter.id) this.chapterState.set(chapter.id, expanded);
        }
      }

      this.chapterState.save();
      this.applyFilter();
    }

    playlistRowMeta(section, activeRid) {
      const parts = [];
      if (section.rid === activeRid) parts.push('当前');
      if (section.type === 3) {
        if (section.duration) parts.push(formatDuration(section.duration));
      } else if (section.type === 4) {
        parts.push('直播');
      }
      if (section.status === 2) parts.push('已学完');
      else if (section.progress > 0) parts.push(`${Math.round(section.progress)}%`);
      if (section.unlock === 0 && !section.isTry) parts.push('未解锁');
      return parts.join(' · ');
    }

    decoratePlaylistRow(row, section, activeRid) {
      const current = section.rid === activeRid;
      row.classList.toggle('current', current);
      if (current) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
      row.classList.toggle('done', section.status === 2);
      row.classList.toggle('locked', section.unlock === 0 && !section.isTry);

      const meta = row.querySelector('.xet-pl-item-meta');
      if (meta) meta.textContent = this.playlistRowMeta(section, activeRid);
    }

    createPlaylistRow(chapter, section, activeRid) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'xet-pl-item';
      row.dataset.rid = section.rid;
      row.dataset.number = getSectionNumber(section.title);
      row.dataset.search = String(section.title || '').toLowerCase();
      row.title = section.title;

      const title = document.createElement('span');
      title.className = 'xet-pl-item-title';
      title.textContent = section.title;

      const meta = document.createElement('span');
      meta.className = 'xet-pl-item-meta';

      row.append(title, meta);
      this.decoratePlaylistRow(row, section, activeRid);
      return row;
    }

    getChapterCountInfo(chapter) {
      const total = chapter.sections.length;
      const done = chapter.sections.filter((section) => section.status === 2).length;
      const learning = chapter.sections.filter(
        (section) => section.status !== 2 && (section.status === 1 || section.progress > 0)
      ).length;
      const parts = [`${total} 节`];
      if (done) parts.push(`已学完 ${done}`);
      if (learning) parts.push(`学习中 ${learning}`);
      return {
        text: parts.join(' · '),
        title: `共 ${total} 节，已学完 ${done} 节，学习中 ${learning} 节`
      };
    }

    setChapterCountElement(amount, chapter) {
      if (!amount) return;
      if (chapter.error) {
        amount.textContent = '加载失败';
        amount.removeAttribute('title');
        return;
      }
      const info = this.getChapterCountInfo(chapter);
      amount.textContent = info.text;
      amount.title = info.title;
    }

    updateChapter(chapter) {
      if (!this.panel || !chapter) return;
      const body = this.panel.querySelector('.xet-pl-body');
      if (!body) return;

      const chapterElements = [...body.querySelectorAll('.xet-pl-chapter')];
      let chapterElement = chapter.id
        ? chapterElements.find((element) => element.dataset.chapterId === chapter.id)
        : null;

      if (!chapterElement) {
        const rids = new Set(chapter.sections.map((section) => section.rid));
        chapterElement =
          chapterElements.find((element) =>
            [...element.querySelectorAll('.xet-pl-item')].some((row) => rids.has(row.dataset.rid))
          ) || null;
      }
      if (!chapterElement) return;

      this.setChapterCountElement(chapterElement.querySelector('.xet-pl-chapter-count'), chapter);
      const activeRid = this.ctx.getCurrentResourceId();
      for (const row of chapterElement.querySelectorAll('.xet-pl-item')) {
        const section = chapter.sections.find((item) => item.rid === row.dataset.rid);
        if (section) this.decoratePlaylistRow(row, section, activeRid);
      }
      this.applyFilter();
    }

    cleanSeriesLabel(label) {
      return String(label || '')
        .replace(/^=+\s*/, '')
        .replace(/\s*=+$/, '')
        .trim();
    }

    selectSeriesTab(index) {
      const groups = this.catalog.displayGroups();
      if (!this.catalog.usesSeriesTabs() || !Number.isInteger(index) || index < 0 || index >= groups.length) return;
      if (index === this.seriesIndex) return;

      this.seriesIndex = index;
      this.restoreScroll = false;
      const body = this.panel?.querySelector('.xet-pl-body');
      if (body) body.scrollTop = 0;
      this.render({ lockSize: false });
      requestAnimationFrame(() => {
        this.panel?.querySelector('.xet-pl-series-tab.active')?.focus({ preventScroll: true });
      });
    }

    renderSeriesTabs(groups, enabled) {
      if (!this.panel) return;
      const tabs = this.panel.querySelector('.xet-pl-series-tabs');
      if (!tabs) return;

      this.panel.classList.toggle('has-series', enabled);
      tabs.hidden = !enabled;
      if (!enabled) {
        tabs.replaceChildren();
        return;
      }

      const fragment = document.createDocumentFragment();
      groups.forEach((group, index) => {
        const label = this.cleanSeriesLabel(group.label) || '未命名系列';
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'xet-pl-series-tab';
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', index === this.seriesIndex ? 'true' : 'false');
        tab.tabIndex = index === this.seriesIndex ? 0 : -1;
        tab.textContent = label;
        tab.title = label;
        tab.classList.toggle('active', index === this.seriesIndex);

        tab.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.selectSeriesTab(index);
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

    render({ lockSize = true } = {}) {
      if (!this.panel || !this.catalog.tree) return;
      const body = this.panel.querySelector('.xet-pl-body');
      const count = this.panel.querySelector('.xet-pl-count');
      if (!body) return;

      const activeRid = this.ctx.getCurrentResourceId();
      this.chapterState.ensure(this.ctx.getCourseId());
      this.activeRid = activeRid;
      this.currentChapterId = this.catalog.findCurrentChapterId(activeRid);
      const groups = this.catalog.displayGroups();
      const tabsEnabled = this.catalog.usesSeriesTabs();
      const currentGroupIndex = this.catalog.findGroupIndexForRid(groups, activeRid);

      if (this.seriesIndex < 0 || this.seriesIndex >= groups.length) {
        this.seriesIndex = currentGroupIndex >= 0 ? currentGroupIndex : 0;
      }

      this.renderSeriesTabs(groups, tabsEnabled);
      const visibleGroups = tabsEnabled ? [groups[this.seriesIndex]] : groups;
      const fragment = document.createDocumentFragment();
      let total = 0;

      for (const group of visibleGroups) {
        if (!tabsEnabled && group.label) {
          const label = document.createElement('div');
          label.className = 'xet-pl-group';
          label.textContent = this.cleanSeriesLabel(group.label);
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
            this.setChapterCountElement(amount, chapter);
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
              items.appendChild(this.createPlaylistRow(chapter, section, activeRid));
            }
          }

          wrap.appendChild(items);
          fragment.appendChild(wrap);
        }
      }

      if (count) count.textContent = `${total} 节`;
      body.replaceChildren(fragment);
      if (lockSize) this.lockPlaylistSize();
      this.applyFilter();
      requestAnimationFrame(() => {
        if (this.restoreScroll) {
          this.restoreScroll = false;
          body.scrollTop = this.scrollTop;
        } else {
          this.scrollPlaylistToCurrent();
        }
        this.updateLocateButton();
      });
    }

    lockPlaylistSize() {
      if (!this.panel || this.panel.hidden) return;
      // Measure with every chapter expanded, then keep the panel size while searching.
      this.panel.style.width = '';
      this.panel.style.height = '';
      const width = Math.ceil(this.panel.getBoundingClientRect().width);
      if (width > 0) this.panel.style.width = `${width}px`;
      const height = Math.ceil(this.panel.getBoundingClientRect().height);
      if (height > 0) this.panel.style.height = `${height}px`;
    }

    applyFilter() {
      if (!this.panel) return;
      const body = this.panel.querySelector('.xet-pl-body');
      if (!body) return;
      const query = this.search;
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
          node.classList.toggle('collapsed', !this.chapterState.isExpanded(chapterId, this.currentChapterId));
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
        empty.textContent = this.catalog.usesSeriesTabs() ? '当前系列没有匹配的课时' : '没有匹配的课时';
      } else if (empty) {
        empty.remove();
      }
      this.updateLocateButton();
    }

    updateLocateButton = () => {
      if (!this.panel) return;
      const button = this.panel.querySelector('.xet-pl-locate');
      const body = this.panel.querySelector('.xet-pl-body');
      if (!button || !body) return;

      let show = false;
      if (!this.panel.hidden) {
        const groups = this.catalog.displayGroups();
        const currentGroupIndex = this.catalog.findGroupIndexForRid(groups, this.ctx.getCurrentResourceId());
        const currentInOtherTab =
          this.catalog.usesSeriesTabs() && currentGroupIndex >= 0 && currentGroupIndex !== this.seriesIndex;

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
    };

    locateCurrentLesson() {
      if (!this.panel) return;

      const groups = this.catalog.displayGroups();
      const currentGroupIndex = this.catalog.findGroupIndexForRid(groups, this.ctx.getCurrentResourceId());
      if (this.catalog.usesSeriesTabs() && currentGroupIndex >= 0 && currentGroupIndex !== this.seriesIndex) {
        this.seriesIndex = currentGroupIndex;
        this.restoreScroll = false;
        if (this.search) {
          this.search = '';
          const input = this.panel.querySelector('.xet-pl-search');
          if (input) input.value = '';
        }
        this.render({ lockSize: false });
      }

      const body = this.panel.querySelector('.xet-pl-body');
      const row = body?.querySelector('.xet-pl-item.current');
      if (!body || !row) return;

      const input = this.panel.querySelector('.xet-pl-search');
      if (this.search) {
        this.search = '';
        if (input) input.value = '';
      }

      const chapter = row.closest('.xet-pl-chapter');
      if (chapter) {
        chapter.hidden = false;
        chapter.classList.remove('collapsed');
        const id = chapter.dataset.chapterId || '';
        if (id) {
          this.chapterState.set(id, true);
          this.chapterState.save();
        }
      }

      this.applyFilter();
      if (chapter) {
        chapter.hidden = false;
        chapter.classList.remove('collapsed');
      }
      row.hidden = false;

      const finish = () => {
        this.scrollPlaylistToCurrent();
        this.updateLocateButton();
      };
      requestAnimationFrame(finish);
      setTimeout(finish, 80);
    }

    scrollPlaylistToCurrent() {
      if (!this.panel) return;
      const body = this.panel.querySelector('.xet-pl-body');
      const row = body?.querySelector('.xet-pl-item.current');
      if (!body || !row) return;
      const chapter = row.closest('.xet-pl-chapter');
      if (row.hidden || (chapter && (chapter.hidden || chapter.classList.contains('collapsed')))) return;
      body.scrollTop = Math.max(0, row.offsetTop - body.clientHeight / 2 + row.offsetHeight / 2);
    }

    updateCurrent() {
      if (!this.catalog.tree) return;
      const rid = this.ctx.getCurrentResourceId();
      if (rid === this.activeRid) return;
      this.activeRid = rid;

      const groups = this.catalog.displayGroups();
      const groupIndex = this.catalog.findGroupIndexForRid(groups, rid);
      if (groupIndex >= 0) this.seriesIndex = groupIndex;

      if (this.isOpen) this.render({ lockSize: false });
    }

    resetSeriesIndex() {
      this.seriesIndex = -1;
    }

    openPlaylistItem(rid) {
      if (!rid) return;
      if (rid === this.ctx.getCurrentResourceId()) {
        this.closePlaylist();
        return;
      }

      const section = this.catalog.findSection(rid);
      if (!section) return;
      const url = this.catalog.sectionUrl(section);
      if (!url) return;

      if (section.type === 4 || /\/v4\/course\/alive\//.test(url)) {
        window.open(url, '_blank', 'noopener');
        return;
      }

      if (this.ctx.isVideoLessonUrl(url)) {
        this.onLessonSelect?.(url);
        return;
      }

      this.closePlaylist();
      location.assign(url);
    }

    onBodyClick = (event) => {
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
          this.chapterState.set(id, !collapsed);
          this.chapterState.save();
        }
        this.updateLocateButton();
        return;
      }

      const row = target.closest('.xet-pl-item');
      if (!row) return;
      event.preventDefault();
      event.stopPropagation();
      this.openPlaylistItem(row.dataset.rid || '');
    };

    onKeydown = (event) => {
      if (!this.isOpen) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.closePlaylist();
        return;
      }

      const tab =
        this.panel && event.target instanceof Element
          ? event.target.closest('.xet-pl-series-tab')
          : null;
      if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        const tabs = [...this.panel.querySelectorAll('.xet-pl-series-tab')];
        const index = tabs.indexOf(tab);
        if (index >= 0) {
          event.preventDefault();
          let next = index;
          if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
          else if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
          else if (event.key === 'Home') next = 0;
          else if (event.key === 'End') next = tabs.length - 1;
          this.selectSeriesTab(next);
          event.stopImmediatePropagation();
          return;
        }
      }

      if (this.panel && event.target instanceof Node && this.panel.contains(event.target)) {
        event.stopImmediatePropagation();
      }
    };

    onOutsideClick = (event) => {
      if (!this.isOpen) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (this.panel && this.panel.contains(target)) return;
      if (this.button && this.button.contains(target)) return;
      this.closePlaylist();
    };

    unmount() {
      this.closePlaylist();
      this.button?.remove();
      this.panel?.remove();
      this.button = null;
      this.panel = null;
      this.activeRid = '';
      this.seriesIndex = -1;
      this.search = '';
      this.currentChapterId = '';
    }
  }

  // ==== 09. SeamlessNavigator ====

  /** 无刷新切课、站点下一节补丁、结束/连续播放与 history。 */
  class SeamlessNavigator {
    /**
     * @param {{
     *   ctx: PageContext,
     *   bridge: PlayerBridge,
     *   prefs: PlaybackPrefs,
     *   catalog: CatalogService,
     *   playlist: PlaylistView,
     *   status: StatusSync
     * }} deps
     */
    constructor({ ctx, bridge, prefs, catalog, playlist, status }) {
      this.ctx = ctx;
      this.bridge = bridge;
      this.prefs = prefs;
      this.catalog = catalog;
      this.playlist = playlist;
      this.status = status;

      this.switching = false;
      this.activeLessonPath = location.pathname;
      this.suppressUntil = 0;
      this.originalJumpTargetUrl = new WeakMap();
      this.originalChangeNextVideoEvent = new WeakMap();
      this.onRefresh = null;
    }

    isSwitching() {
      return this.switching;
    }

    async switchLesson(url) {
      if (!this.ctx.isVideoLessonUrl(url)) {
        location.assign(url);
        return;
      }
      if (this.switching) return;

      const target = new URL(url, location.origin);
      if (target.href === location.href) return;
      this.status.capture();
      this.switching = true;
      this.playlist.closePlaylist();
      try {
        await this.bridge.refreshVideoPlayer(target, true);
        this.activeLessonPath = target.pathname;
        this.playlist.updateCurrent();
        this.prefs.armApply();
        this.onRefresh?.();
        requestResize();
        this.status.schedulePostSwitch();
      } catch (error) {
        console.warn('[xet] 无刷新切课失败，已回退到整页跳转。', error);
        location.assign(target.href);
      } finally {
        this.switching = false;
      }
    }

    onHistoryLessonSwitch() {
      requestAnimationFrame(async () => {
        if (!this.ctx.isPlaybackPage() || this.switching) return;
        if (location.pathname === this.activeLessonPath) return;
        if (!this.ctx.isVideoLessonUrl(location.href)) {
          this.activeLessonPath = location.pathname;
          return;
        }

        const target = new URL(location.href);
        this.status.capture();
        this.switching = true;
        try {
          await this.bridge.refreshVideoPlayer(target, false);
          this.activeLessonPath = target.pathname;
          this.playlist.updateCurrent();
          this.prefs.armApply();
          this.onRefresh?.();
          requestResize();
          this.status.schedulePostSwitch();
        } catch (error) {
          console.warn('[xet] 浏览器前进/后退切课失败，已刷新页面。', error);
          location.reload();
        } finally {
          this.switching = false;
        }
      });
    }

    videoTargetToUrl(target) {
      const raw = typeof target === 'string' ? target : target?.url || target?.jump_url || '';
      if (!raw) return '';
      let parsed;
      try {
        parsed = new URL(raw, location.origin);
      } catch (_) {
        return '';
      }
      if (parsed.origin !== location.origin) return '';
      if (this.ctx.isVideoLessonUrl(parsed.href)) {
        return parsed.pathname.split('/').pop() === this.ctx.getCurrentResourceId() ? '' : parsed.href;
      }
      const rid = parsed.pathname.match(/\/p\/course\/video\/([^/?#]+)/)?.[1];
      return rid && rid !== this.ctx.getCurrentResourceId() ? this.catalog.sectionUrl({ rid, type: 3 }) : '';
    }

    getNextCatalogVideoUrl() {
      if (!this.catalog.tree) return '';
      const rid = this.ctx.getCurrentResourceId();
      if (!rid) return '';

      const sections = this.catalog.allSections();
      const index = sections.findIndex((section) => section.rid === rid);
      if (index < 0) return '';

      const next = sections[index + 1];
      if (!next || (next.type !== 3 && !/^v_/.test(next.rid))) return '';
      return this.catalog.sectionUrl(next);
    }

    nextVideoUrlFor(target) {
      const direct = this.videoTargetToUrl(target);
      if (direct) return direct;
      if (Date.now() < this.suppressUntil) return '';
      if (!this.catalog.tree) this.catalog.load().catch(() => {});
      return this.getNextCatalogVideoUrl();
    }

    isSuppressed() {
      return Date.now() < this.suppressUntil;
    }

    markEndedGuard() {
      if (this.ctx.getActiveVideo(this.prefs.watchedVideo)?.ended) this.suppressUntil = Date.now() + 10000;
    }

    async onVideoEnded(event) {
      const video =
        event?.currentTarget instanceof HTMLVideoElement ? event.currentTarget : this.ctx.getActiveVideo(this.prefs.watchedVideo);
      const rid =
        (video && this.bridge.getVideoResourceId(video)) || this.ctx.getCurrentResourceId();
      const playerVm = document.querySelector('.video-content-header')?.__vue__;
      const continuous = this.prefs.isContinuous(playerVm);
      this.status.capture(true, rid, video);
      if (!continuous || this.switching || this.ctx.getCurrentResourceId() !== rid) return;

      // Give the site's own completion report a moment before replacing the player.
      await new Promise((resolve) => setTimeout(resolve, 600));
      if (this.switching || this.ctx.getCurrentResourceId() !== rid) return;

      let next = this.videoTargetToUrl(playerVm?.loopVideoForPackage?.next);
      if (!next) {
        if (!this.catalog.tree) {
          try {
            await this.catalog.load();
          } catch (_) {}
        }
        if (this.switching || this.ctx.getCurrentResourceId() !== rid) return;
        next = this.getNextCatalogVideoUrl();
      }
      if (!next || this.switching) return;

      this.suppressUntil = Date.now() + 10000;
      this.switchLesson(next);
    }

    patchNativeNextNavigation() {
      const playerVm = document.querySelector('.video-content-header')?.__vue__;
      if (!playerVm) return;

      const nav = this;
      const funcTool = playerVm.$funcTool;
      if (
        funcTool &&
        typeof funcTool.jumpTargetUrl === 'function' &&
        !funcTool.jumpTargetUrl.__xetPatched
      ) {
        if (!this.originalJumpTargetUrl.has(funcTool)) {
          this.originalJumpTargetUrl.set(funcTool, funcTool.jumpTargetUrl);
        }
        const original = this.originalJumpTargetUrl.get(funcTool);
        const patched = function (target, ...args) {
          try {
            let url = nav.videoTargetToUrl(target);
            if (!url && nav.prefs.isContinuous(playerVm) && !nav.isSuppressed()) {
              if (!nav.catalog.tree) nav.catalog.load().catch(() => {});
              url = nav.getNextCatalogVideoUrl();
            }
            if (url) {
              nav.markEndedGuard();
              nav.switchLesson(url);
              return;
            }
            if (nav.prefs.isContinuous(playerVm) && nav.isSuppressed()) return;
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
        if (!this.originalChangeNextVideoEvent.has(playerVm)) {
          this.originalChangeNextVideoEvent.set(playerVm, playerVm.changeNextVideoEvent);
        }
        const original = this.originalChangeNextVideoEvent.get(playerVm);
        const patched = async function (...args) {
          try {
            if (!nav.prefs.isContinuous(this)) {
              return original.apply(this, args);
            }

            if (
              this.isPrdPackage &&
              !this.loopVideoForPackage?.next &&
              typeof this.initLoop === 'function'
            ) {
              await this.initLoop();
            }

            const nextTarget = this.loopVideoForPackage?.next;
            let url = nav.nextVideoUrlFor(nextTarget);
            if (!url && !nav.catalog.tree && !nav.isSuppressed()) {
              try {
                await nav.catalog.load();
              } catch (_) {}
              url = nav.getNextCatalogVideoUrl();
            }
            if (url) {
              nav.markEndedGuard();
              nav.switchLesson(url);
              return;
            }
            if (nav.isSuppressed()) return;
          } catch (_) {}
          return original.apply(this, args);
        };
        patched.__xetPatched = true;
        try {
          playerVm.changeNextVideoEvent = patched;
        } catch (_) {}
      }
    }
  }

  // ==== 10. FullscreenController ====

  /** 普通 / 网页宽屏 / 原生全屏状态机与首次默认宽屏。 */
  class FullscreenController {
    /**
     * @param {{ ctx: PageContext, config: typeof Config }} deps
     */
    constructor({ ctx, config }) {
      this.ctx = ctx;
      this.config = config;
      this.bypass = false;
      this.exiting = false;
      this.restoring = false;
      this.stateBeforeNative = null;
      this.initialWideDone = false;
      this.wideRetryTimer = 0;
      this.wideRetryCount = 0;
      this.onRefresh = null;
    }

    clickSiteControl(selector) {
      const control = document.querySelector(selector);
      if (!control) return false;
      this.bypass = true;
      const icon = control.querySelector('.xgplayer-icon') || control;
      icon.click();
      this.bypass = false;
      return true;
    }

    scheduleRefresh() {
      for (const delay of [80, 360, 700]) {
        setTimeout(() => {
          if (this.ctx.isPlaybackPage()) this.onRefresh?.();
        }, delay);
      }
    }

    enterWebFullscreen() {
      const entered = this.clickSiteControl('.xgplayer-cssfullscreen .xgplayer-icon, .xgplayer-cssfullscreen');
      this.scheduleRefresh();
      return entered;
    }

    enterWebFullscreenWhenReady() {
      clearTimeout(this.wideRetryTimer);
      this.wideRetryCount = 0;

      const tick = () => {
        const root = this.ctx.getPlayerRoot();
        if (
          !this.ctx.isPlaybackPage() ||
          this.ctx.isWebFullscreen() ||
          this.ctx.isNativeFullscreen() ||
          (root && root.matches(this.config.FULL_SEL))
        ) {
          return;
        }
        if (this.enterWebFullscreen()) return;
        if (++this.wideRetryCount > 20) return;
        this.wideRetryTimer = setTimeout(tick, 250);
      };

      tick();
    }

    scheduleInitialWideMode() {
      if (this.initialWideDone || !this.ctx.isPlaybackPage()) return;
      const root = this.ctx.getPlayerRoot();
      if (!root?.querySelector('video')) return;
      if (this.ctx.isWebFullscreen() || this.ctx.isNativeFullscreen() || root.matches(this.config.FULL_SEL)) {
        this.initialWideDone = true;
        return;
      }
      this.initialWideDone = true;
      this.enterWebFullscreenWhenReady();
    }

    removeFullscreenClasses(root) {
      document.querySelectorAll(this.config.FULL_SEL).forEach((el) => el.classList.remove(...this.config.FULL_CLASSES));
      [document.documentElement, document.body].forEach((el) => el.classList.remove(...this.config.FULL_CLASSES));
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

    exitWebFullscreen() {
      if (this.exiting) return;
      this.exiting = true;

      const root = this.ctx.getPlayerRoot();
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
          cancelable: true
        });
        document.dispatchEvent(event);
        window.dispatchEvent(event);
      }

      setTimeout(() => {
        if (this.ctx.isWebFullscreen()) this.removeFullscreenClasses(root);
        this.exiting = false;
        this.onRefresh?.();
        requestResize();
      }, 180);
      this.scheduleRefresh();
    }

    exitNativeAndRestore() {
      if (!this.ctx.isNativeFullscreen()) return;
      const prev = this.stateBeforeNative || (this.ctx.isWebFullscreen() ? 'wide' : 'normal');
      this.stateBeforeNative = null;
      this.restoring = true;

      const done = () => {
        setTimeout(() => {
          if (prev === 'wide' && !this.ctx.isWebFullscreen()) this.enterWebFullscreen();
          else if (prev === 'normal' && this.ctx.isWebFullscreen()) this.exitWebFullscreen();
          this.restoring = false;
          requestResize();
        }, 200);
      };

      const result = document.exitFullscreen?.();
      if (result && typeof result.then === 'function') result.then(done, done);
      else done();
    }

    switchNativeToWeb() {
      if (!this.ctx.isNativeFullscreen()) return;
      this.stateBeforeNative = null;
      this.restoring = true;

      const done = () => {
        setTimeout(() => {
          if (!this.ctx.isWebFullscreen()) this.enterWebFullscreen();
          this.restoring = false;
          requestResize();
        }, 200);
      };

      const result = document.exitFullscreen?.();
      if (result && typeof result.then === 'function') result.then(done, done);
      else done();
    }

    onControlClick = (event) => {
      const target = event.target;
      if (!(target instanceof Element) || this.bypass) return;

      const webControl = target.closest('.xgplayer-cssfullscreen');
      const nativeControl = target.closest('.xgplayer-fullscreen');
      if (!webControl && !nativeControl) return;

      const native = this.ctx.isNativeFullscreen();
      const web = this.ctx.isWebFullscreen();

      if (webControl) {
        if (native) {
          event.preventDefault();
          event.stopImmediatePropagation();
          this.switchNativeToWeb();
        } else if (web) {
          event.preventDefault();
          event.stopImmediatePropagation();
          this.exitWebFullscreen();
        } else {
          event.preventDefault();
          event.stopImmediatePropagation();
          this.enterWebFullscreen();
        }
        return;
      }

      if (native) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.exitNativeAndRestore();
      } else {
        this.stateBeforeNative = web ? 'wide' : 'normal';
        this.scheduleRefresh();
        setTimeout(() => {
          if (!this.ctx.isNativeFullscreen()) this.stateBeforeNative = null;
        }, 1500);
      }
    };

    onFullscreenChange = () => {
      if (!this.ctx.isNativeFullscreen() && !this.restoring) {
        const prev = this.stateBeforeNative;
        this.stateBeforeNative = null;
        if (prev === 'wide' && !this.ctx.isWebFullscreen()) this.enterWebFullscreen();
        else if (prev === 'normal' && this.ctx.isWebFullscreen()) this.exitWebFullscreen();
      }
      this.onRefresh?.();
      requestResize();
    };

    onGlobalKeydown = (event) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = String(event.key || '').toLowerCase();
      if (key !== 'f' && event.code !== 'KeyF') return;

      const target = event.target;
      if (isEditableNode(target)) return;
      if (isEditableNode(document.activeElement)) return;
      if (!this.ctx.isPlaybackPage() || !this.ctx.getPlayerRoot() || this.ctx.isNativeFullscreen()) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      if (this.ctx.isWebFullscreen()) this.exitWebFullscreen();
      else this.enterWebFullscreen();
    };

    stop() {
      clearTimeout(this.wideRetryTimer);
      this.wideRetryTimer = 0;
      this.wideRetryCount = 0;
      this.initialWideDone = false;
    }
  }

  // ==== 11. ClickGuards ====

  /** 视频点击/双击与控制条点击抑制、暂停状态恢复。 */
  class ClickGuards {
    /**
     * @param {{ ctx: PageContext, fullscreen: FullscreenController }} deps
     */
    constructor({ ctx, fullscreen }) {
      this.ctx = ctx;
      this.fullscreen = fullscreen;
      this.preClickPaused = null;
      this.clickResetTimer = 0;
      this.pendingClick = null;
      this.bypassClick = false;
      this.onRefresh = null;
    }

    isPlayerSurface(target) {
      const root = this.ctx.getPlayerRoot();
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

    isVideoSurface(target) {
      if (!(target instanceof Element)) return false;
      const root = this.ctx.getPlayerRoot();
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

    onSurfaceClick = (event) => {
      if (this.bypassClick) return;
      if (!this.isVideoSurface(event.target)) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      if (this.pendingClick) {
        clearTimeout(this.pendingClick.timer);
        this.pendingClick = null;
        return;
      }

      const target = event.target;
      const init = {
        bubbles: true,
        cancelable: true,
        detail: 1,
        button: 0,
        clientX: event.clientX,
        clientY: event.clientY
      };
      const timer = setTimeout(() => {
        const current = target.isConnected ? target : this.ctx.getPlayerRoot();
        this.pendingClick = null;
        if (!current) return;
        this.bypassClick = true;
        current.dispatchEvent(new MouseEvent('click', init));
        this.bypassClick = false;
      }, 200);
      this.pendingClick = { target, timer };
    };

    recordClickState = (event) => {
      if (!this.isPlayerSurface(event.target)) return;
      const video = this.ctx.getPlayerRoot()?.querySelector('video');
      if (!video) return;
      if (this.preClickPaused === null) this.preClickPaused = video.paused;
      clearTimeout(this.clickResetTimer);
      this.clickResetTimer = setTimeout(() => {
        this.preClickPaused = null;
      }, 450);
    };

    restorePlayState(video, wantPaused) {
      if (!video || wantPaused === null) return;
      if (video.paused === wantPaused) return;
      if (wantPaused) {
        video.pause();
      } else {
        const result = video.play();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      }
    }

    onDblClick = (event) => {
      const root = this.ctx.getPlayerRoot();
      if (!root || !(event.target instanceof Node) || !root.contains(event.target)) return;
      if (
        event.target instanceof Element &&
        event.target.closest('xg-controls, .xgplayer-controls, .basic-xgplayer-controls, .xet-playlist-panel')
      ) {
        return;
      }
      if (this.ctx.isNativeFullscreen()) return;

      if (this.pendingClick) {
        clearTimeout(this.pendingClick.timer);
        this.pendingClick = null;
      }

      const video = root.querySelector('video');
      const wantPaused = this.preClickPaused;
      this.preClickPaused = null;
      clearTimeout(this.clickResetTimer);
      this.restorePlayState(video, wantPaused);

      event.preventDefault();
      event.stopImmediatePropagation();
      if (this.ctx.isWebFullscreen()) this.fullscreen.exitWebFullscreen();
      else this.fullscreen.enterWebFullscreen();
      if (wantPaused !== null) {
        [150, 350, 600].forEach((delay) => {
          setTimeout(() => this.restorePlayState(video, wantPaused), delay);
        });
      }
      setTimeout(() => this.onRefresh?.(), 80);
      setTimeout(() => this.onRefresh?.(), 360);
      setTimeout(() => this.onRefresh?.(), 700);
    };
  }

  // ==== 12. App ====

  /** 组合根：全局监听、observer、页面进入/退出与刷新调度。 */
  class App {
    constructor() {
      this.ctx = new PageContext(Config);
      this.chrome = new LayoutChrome(this.ctx, Config);
      this.bridge = new PlayerBridge(this.ctx);
      this.prefs = new PlaybackPrefs({ ctx: this.ctx, bridge: this.bridge, config: Config });
      this.chapterState = new ChapterStateStore(this.ctx, Config);
      this.catalog = new CatalogService({ ctx: this.ctx, config: Config });
      this.playlist = new PlaylistView({
        ctx: this.ctx,
        catalog: this.catalog,
        chapterState: this.chapterState
      });
      this.status = new StatusSync({
        ctx: this.ctx,
        catalog: this.catalog,
        playlist: this.playlist,
        prefs: this.prefs
      });
      this.navigator = new SeamlessNavigator({
        ctx: this.ctx,
        bridge: this.bridge,
        prefs: this.prefs,
        catalog: this.catalog,
        playlist: this.playlist,
        status: this.status
      });
      this.fullscreen = new FullscreenController({ ctx: this.ctx, config: Config });
      this.guards = new ClickGuards({ ctx: this.ctx, fullscreen: this.fullscreen });

      this.prefs.onEnded = (event) => this.navigator.onVideoEnded(event);
      this.bridge.onRestoreWide = () => this.fullscreen.enterWebFullscreenWhenReady();
      this.catalog.onLoaded = () => this.playlist.resetSeriesIndex();
      this.playlist.onLessonSelect = (url) => this.navigator.switchLesson(url);
      this.playlist.onOpenRefresh = () => this.status.refreshCurrentChapter();
      this.status.isSwitching = () => this.navigator.isSwitching();
      this.navigator.onRefresh = () => this.scheduleUpdate();
      this.fullscreen.onRefresh = () => this.refresh();
      this.guards.onRefresh = () => this.refresh();

      this.pageActive = null;
      this.observedRoot = null;
      this.resizeObserver = null;
      this.observedPlayerBox = null;
      this.updateTimer = 0;
      this.resizeTimer = 0;
      this.historyPatched = false;
      this.playlistPrefetchTimer = 0;
      this.catalogPrefetchDone = false;
      this.watchedDocTitle = null;
      this.docTitleObserver = null;

      this.rootObserver = new MutationObserver(() => this.scheduleUpdate());
      this.bodyObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== 1) continue;
            if (
              node.matches?.('#pc_course_fe_basic_video, .xgplayer, video') ||
              node.querySelector?.('#pc_course_fe_basic_video, .xgplayer, video')
            ) {
              this.scheduleUpdate();
              return;
            }
          }
        }
      });
    }

    refresh() {
      if (!this.ctx.isPlaybackPage()) return;
      const root = this.ctx.getPlayerRoot();
      if (!root) return;
      this.chrome.ensure();
      this.chrome.sync();
      this.chrome.updateLabels();
      this.prefs.watchVideo();
      this.prefs.watchTitle();
      this.watchDocumentTitle();
      this.navigator.patchNativeNextNavigation();
      this.playlist.ensureControl();
      this.playlist.updateCurrent();
      if (this.playlist.isOpen) this.playlist.ensurePanel();
      this.scheduleCatalogPrefetch();
      this.fullscreen.scheduleInitialWideMode();
      this.status.start();
    }

    scheduleUpdate() {
      clearTimeout(this.updateTimer);
      this.updateTimer = setTimeout(() => this.refresh(), 80);
    }

    watchDocumentTitle() {
      const title = document.querySelector('title');
      if (!title || title === this.watchedDocTitle) return;
      this.watchedDocTitle = title;
      if (this.docTitleObserver) this.docTitleObserver.disconnect();
      this.docTitleObserver = new MutationObserver(() => {
        this.syncPageGate();
        if (this.ctx.isPlaybackPage()) {
          this.prefs.armApply();
          this.playlist.updateCurrent();
        }
      });
      this.docTitleObserver.observe(title, { childList: true, subtree: true, characterData: true });
    }

    syncPageGate() {
      const next = this.ctx.isPlaybackPage();
      if (next === this.pageActive) return;
      this.pageActive = next;
      if (next) this.enter();
      else this.leave();
    }

    enter() {
      document.documentElement.classList.add('xet-rebuild');
      this.chrome.ensureBodyClass();
      this.chrome.injectStyle();
      this.refresh();
    }

    leave() {
      this.playlist.unmount();
      this.catalog.reset();
      this.chapterState.reset();
      clearTimeout(this.playlistPrefetchTimer);
      this.playlistPrefetchTimer = 0;
      this.catalogPrefetchDone = false;
      this.fullscreen.stop();
      this.status.stop();
      this.chrome.remove();
      this.prefs.stop();
      if (this.docTitleObserver) this.docTitleObserver.disconnect();
      this.watchedDocTitle = null;
    }

    patchHistory() {
      if (this.historyPatched) return;
      this.historyPatched = true;

      const app = this;
      for (const name of ['pushState', 'replaceState']) {
        const original = history[name];
        history[name] = function (...args) {
          const result = original.apply(this, args);
          app.syncPageGate();
          app.prefs.armApply();
          app.playlist.updateCurrent();
          return result;
        };
      }

      window.addEventListener('popstate', () => {
        this.syncPageGate();
        this.prefs.armApply();
        this.playlist.updateCurrent();
      });
      window.addEventListener('popstate', () => this.navigator.onHistoryLessonSwitch());
    }

    scheduleCatalogPrefetch() {
      if (this.catalogPrefetchDone || this.playlistPrefetchTimer) return;
      this.playlistPrefetchTimer = setTimeout(() => {
        this.playlistPrefetchTimer = 0;
        this.catalogPrefetchDone = true;
        if (!this.ctx.isPlaybackPage() || !this.ctx.getPlayerRoot()) return;
        this.catalog.load().catch(() => {});
      }, 2500);
    }

    observePlayer(root) {
      if (root === this.observedRoot) return;
      this.observedRoot = root;
      this.rootObserver.disconnect();
      this.rootObserver.observe(root, { attributes: true, attributeFilter: ['class'] });

      const box = root.closest('.video-player');
      if (box && box !== this.observedPlayerBox) {
        this.observedPlayerBox = box;
        this.resizeObserver.disconnect();
        this.resizeObserver.observe(box);
      }
    }

    boot() {
      this.patchHistory();
      this.syncPageGate();

      if (this.pageActive && !document.body) {
        const bodyWait = new MutationObserver(() => {
          if (!document.body) return;
          bodyWait.disconnect();
          this.chrome.ensureBodyClass();
          this.refresh();
        });
        bodyWait.observe(document.documentElement, { childList: true });
      }

      document.addEventListener('click', this.fullscreen.onControlClick, true);
      document.addEventListener('click', this.playlist.onOutsideClick, true);
      document.addEventListener('pointerdown', this.prefs.notePreferenceGesture, true);
      document.addEventListener('click', this.prefs.notePreferenceGesture, true);
      document.addEventListener('keydown', this.prefs.notePreferenceGesture, true);
      document.addEventListener('wheel', this.prefs.notePreferenceGesture, { capture: true, passive: true });
      window.addEventListener('keydown', this.fullscreen.onGlobalKeydown, true);
      window.addEventListener('keydown', this.playlist.onKeydown, true);
      window.addEventListener('mousedown', this.guards.recordClickState, true);
      window.addEventListener('click', this.guards.onSurfaceClick, true);
      window.addEventListener('click', this.guards.recordClickState, true);
      window.addEventListener('click', this.prefs.onPlaymodeClick, true);
      window.addEventListener('dblclick', this.guards.onDblClick, true);
      document.addEventListener('fullscreenchange', this.fullscreen.onFullscreenChange);
      document.addEventListener('webkitfullscreenchange', this.fullscreen.onFullscreenChange);
      window.addEventListener('resize', () => this.refresh(), { passive: true });

      this.resizeObserver = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width || 0;
        if (!width || this.ctx.isWebFullscreen()) return;
        clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(requestResize, 120);
      });

      this.bodyObserver.observe(document.documentElement, { childList: true, subtree: true });
      document.addEventListener('DOMContentLoaded', () => this.refresh(), { once: true });
      window.addEventListener('load', () => this.refresh(), { once: true });

      this.refresh();
      setTimeout(() => this.refresh(), 300);
      setTimeout(() => this.refresh(), 1000);

      const root = this.ctx.getPlayerRoot();
      if (root) {
        this.observePlayer(root);
        requestResize();
      }
    }
  }

  new App().boot();
})();
