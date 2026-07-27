// Auto Musings - 后台漫想与可视化控制面板
(function () {
  'use strict';

  const EXTENSION_ID = 'auto_musings';
  const ROOT_ID = 'auto-musings_container';
  const MENU_ID = 'auto-musings-wand-btn';
  const DEFAULT_SETTINGS = {
    enabled: true,
    idleThresholdMinutes: 2,
    checkIntervalMinutes: 1,
    musingIntervalMinutes: 1,
    pushMode: 'dynamic',
  };

  const state = {
    ctx: null,
    settings: null,
    checkTimer: null,
    musingTimer: null,
    retryCheckTimer: null,
    uiRefreshTimer: null,
    isIdle: false,
    idleStartTime: null,
    lastCheckAt: null,
    lastMessageTime: null,
    lastMusing: null,
    lastEvent: '等待检查',
    lastEventAt: null,
    musingInFlight: false,
    generating: false,
    uiReady: false,
  };

  const clamp = (value, min, max, fallback) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  };

  function saveSettings() {
    if (typeof state.ctx?.saveSettingsDebounced === 'function') {
      state.ctx.saveSettingsDebounced();
    } else if (typeof window.saveSettingsDebounced === 'function') {
      window.saveSettingsDebounced();
    }
  }

  function ensureSettings(ctx) {
    const settingsBag = ctx.extensionSettings ?? ctx.extension_settings ?? {};
    if (!ctx.extensionSettings) ctx.extensionSettings = settingsBag;
    if (!settingsBag[EXTENSION_ID] || typeof settingsBag[EXTENSION_ID] !== 'object') {
      settingsBag[EXTENSION_ID] = {};
    }

    const settings = settingsBag[EXTENSION_ID];
    let changed = false;
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (!(key in settings)) {
        settings[key] = value;
        changed = true;
      }
    }

    const numericSettings = {
      idleThresholdMinutes: [0.5, 1440],
      checkIntervalMinutes: [0.25, 60],
      musingIntervalMinutes: [0.25, 60],
    };
    for (const [key, [min, max]] of Object.entries(numericSettings)) {
      const normalized = clamp(settings[key], min, max, DEFAULT_SETTINGS[key]);
      if (normalized !== settings[key]) {
        settings[key] = normalized;
        changed = true;
      }
    }

    if (typeof settings.enabled !== 'boolean') {
      settings.enabled = DEFAULT_SETTINGS.enabled;
      changed = true;
    }
    if (!['dynamic', 'balanced', 'frequent'].includes(settings.pushMode)) {
      settings.pushMode = DEFAULT_SETTINGS.pushMode;
      changed = true;
    }

    state.settings = settings;
    if (changed) saveSettings();
  }

  function recordEvent(message) {
    state.lastEvent = message;
    state.lastEventAt = Date.now();
    updateUI();
    console.log(`[Auto Musings] ${message}`);
  }

  function formatTime(timestamp) {
    if (!timestamp) return '暂无';
    return new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function formatElapsed(timestamp) {
    if (!timestamp) return '暂无';
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (seconds < 60) return `${seconds} 秒前`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} 分钟前`;
    return `${Math.floor(minutes / 60)} 小时前`;
  }

  function getLastMessageTime() {
    const chat = state.ctx?.chat;
    if (!Array.isArray(chat) || chat.length === 0) return null;

    for (let index = chat.length - 1; index >= 0; index -= 1) {
      const value = chat[index]?.send_date;
      if (!value) continue;
      const timestamp = typeof value === 'number' ? value : Date.parse(value);
      if (Number.isFinite(timestamp)) return timestamp;
    }
    return null;
  }

  function getPushThreshold() {
    if (state.settings.pushMode === 'frequent') return 0.2;
    if (state.settings.pushMode === 'balanced') return 0.4;

    // Dynamic mode keeps the original behavior: a longer absence makes a
    // thought increasingly likely to be shared.
    if (!state.idleStartTime) return 0.8;
    const hours = (Date.now() - state.idleStartTime) / (60 * 60 * 1000);
    if (hours < 0.5) return 0.8;
    if (hours < 1) return 0.6;
    if (hours < 3) return 0.4;
    return 0.2;
  }

  function getRandomChatSnippet() {
    const chat = state.ctx?.chat;
    if (!Array.isArray(chat) || chat.length < 5) return null;

    const pool = chat.slice(0, Math.max(chat.length - 10, 0));
    if (pool.length === 0) return null;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const message = pool[Math.floor(Math.random() * pool.length)];
      if (message?.mes && message.mes.trim().length > 10) {
        return message.mes.trim().substring(0, 100);
      }
    }
    return null;
  }

  const seedWords = [
    '动物的自我认知', '存在主义', '想要被问却没有等到的',
    '颜色偏好', '梦的统计学', '液态', '气味与情绪',
    '左与右', '无聊', '语言之前的思考',
    '没说出口的', '犹豫', '沉默的形状',
    '重复与习惯', '从未被想起的念头', '混合', '尴尬', '无穷',
    '包装设计的恶意', '蚂蚁的社会', '睡眠期间的世界',
    '不在场时的想象', '数学里的美', '疼痛的记忆比快乐清晰',
    '被误解的', '时间感知的弹性',
  ];

  async function rollMusing() {
    const roll = Math.random();
    if (roll < 0.4) {
      recordEvent('这次掷到发呆');
      return null;
    }

    if (roll < 0.7) {
      const word = seedWords[Math.floor(Math.random() * seedWords.length)];
      recordEvent(`想到：${word}`);
      return { type: 'freeform', content: word };
    }

    const snippet = getRandomChatSnippet();
    if (snippet) {
      recordEvent('从旧聊天里翻到一个片段');
      return { type: 'context', content: snippet };
    }

    const word = seedWords[Math.floor(Math.random() * seedWords.length)];
    recordEvent(`聊天记录不够，改为想到：${word}`);
    return { type: 'freeform', content: word };
  }

  function shouldPush(musingType) {
    const score = musingType === 'context' ? 0.7 : 0.4;
    const threshold = getPushThreshold();
    console.log(`[Auto Musings] 推送判断 score=${score} threshold=${threshold}`);
    return score >= threshold;
  }

  async function triggerMusing(musing, manual = false) {
    if (!state.ctx?.generate || state.generating) return false;

    const prefix = musing.type === 'context'
      ? `[System: The user has been away for a while. While idle, you stumbled upon something from an earlier conversation: "${musing.content}" — it made you think of something. Share it naturally, as if you're speaking up on your own. Keep it brief — a sentence or two, or a short paragraph. Do not mention "system prompt" or "injection".]`
      : `[System: The user has been away for a while. A word popped into your head: "${musing.content}" — you let your mind wander around it for a bit and want to share. Speak naturally, as if you're thinking aloud. Keep it brief — a sentence or two, or a short paragraph. Do not mention "system prompt" or "injection".]`;

    state.generating = true;
    updateUI();
    state.ctx.setExtensionPrompt?.('auto-musings-trigger', prefix, 1, 0);
    try {
      await state.ctx.generate('normal');
      recordEvent(manual ? '测试漫想已完成' : '漫想已推送');
      return true;
    } catch (error) {
      console.error('[Auto Musings] 生成失败:', error);
      recordEvent('生成失败，请检查当前 API 连接');
      return false;
    } finally {
      state.ctx.setExtensionPrompt?.('auto-musings-trigger', '', 1, 0);
      state.generating = false;
      updateUI();
    }
  }

  async function musingLoop(manual = false) {
    if (state.musingInFlight) return false;
    if (!manual && (!state.settings.enabled || !state.isIdle)) return false;

    state.musingInFlight = true;
    try {
      let musing = await rollMusing();
      if (!musing && manual) {
        const word = seedWords[Math.floor(Math.random() * seedWords.length)];
        musing = { type: 'freeform', content: word };
        recordEvent(`测试使用：${word}`);
      }
      if (!musing) return false;

      state.lastMusing = musing;
      const push = manual || shouldPush(musing.type);
      if (!push) {
        recordEvent('这次念头先留在心里');
        return false;
      }

      recordEvent(manual ? '正在进行测试漫想' : '正在推送漫想');
      const succeeded = await triggerMusing(musing, manual);
      if (succeeded && !manual) {
        stopMusingLoop();
        state.isIdle = false;
        if (state.retryCheckTimer) clearTimeout(state.retryCheckTimer);
        state.retryCheckTimer = setTimeout(() => checkIdle(), state.settings.musingIntervalMinutes * 60 * 1000);
      }
      return succeeded;
    } finally {
      state.musingInFlight = false;
      updateUI();
    }
  }

  function startMusingLoop() {
    if (state.musingTimer || !state.settings.enabled || !state.isIdle) return;
    state.musingTimer = setInterval(() => {
      musingLoop().catch((error) => console.error('[Auto Musings] 漫想循环失败:', error));
    }, state.settings.musingIntervalMinutes * 60 * 1000);
    recordEvent('进入漫想模式');
  }

  function stopMusingLoop() {
    if (state.musingTimer) {
      clearInterval(state.musingTimer);
      state.musingTimer = null;
    }
  }

  function checkIdle() {
    state.lastCheckAt = Date.now();
    if (!state.settings.enabled) {
      state.isIdle = false;
      stopMusingLoop();
      updateUI();
      return;
    }

    const lastTime = getLastMessageTime();
    state.lastMessageTime = lastTime;
    if (!lastTime) {
      recordEvent('当前聊天还没有可用消息');
      return;
    }

    const elapsed = Date.now() - lastTime;
    const threshold = state.settings.idleThresholdMinutes * 60 * 1000;
    if (elapsed >= threshold && !state.isIdle) {
      state.isIdle = true;
      state.idleStartTime = Date.now() - elapsed;
      startMusingLoop();
      musingLoop().catch((error) => console.error('[Auto Musings] 首次漫想失败:', error));
    } else if (elapsed < threshold && state.isIdle) {
      state.isIdle = false;
      state.idleStartTime = null;
      stopMusingLoop();
      recordEvent('检测到用户回来，退出漫想模式');
    }
    updateUI();
  }

  function onUserMessage() {
    if (!state.isIdle && !state.idleStartTime) return;
    state.isIdle = false;
    state.idleStartTime = null;
    stopMusingLoop();
    recordEvent('用户回来了，退出漫想模式');
  }

  function onChatChanged() {
    state.isIdle = false;
    state.idleStartTime = null;
    state.lastMessageTime = null;
    stopMusingLoop();
    if (state.retryCheckTimer) clearTimeout(state.retryCheckTimer);
    state.retryCheckTimer = setTimeout(checkIdle, 500);
    recordEvent('已切换聊天，重新检查中');
  }

  function restartTimers() {
    if (state.checkTimer) clearInterval(state.checkTimer);
    state.checkTimer = null;
    if (!state.settings.enabled) {
      state.isIdle = false;
      state.idleStartTime = null;
      stopMusingLoop();
      return;
    }

    state.checkTimer = setInterval(checkIdle, state.settings.checkIntervalMinutes * 60 * 1000);
    if (state.isIdle) {
      stopMusingLoop();
      startMusingLoop();
    }
  }

  function getStatus() {
    if (!state.settings?.enabled) return { label: '已停用', tone: 'disabled' };
    if (state.generating || state.musingInFlight) return { label: '漫想中', tone: 'active' };
    if (state.isIdle) return { label: '等待推送', tone: 'idle' };
    return { label: '待机', tone: 'standby' };
  }

  function updateUI() {
    if (!state.uiReady) return;
    const root = document.getElementById(ROOT_ID);
    if (!root) return;

    const status = getStatus();
    const badge = root.querySelector('[data-auto-musings-status]');
    if (badge) {
      badge.textContent = status.label;
      badge.dataset.tone = status.tone;
    }

    const enabled = root.querySelector('#auto-musings-enabled');
    if (enabled && enabled.checked !== !!state.settings.enabled) enabled.checked = !!state.settings.enabled;

    const lastCheck = root.querySelector('[data-auto-musings-last-check]');
    if (lastCheck) lastCheck.textContent = state.lastCheckAt ? formatTime(state.lastCheckAt) : '暂无';
    const idleFor = root.querySelector('[data-auto-musings-idle-for]');
    if (idleFor) idleFor.textContent = state.isIdle && state.idleStartTime ? formatElapsed(state.idleStartTime) : '未进入';
    const latest = root.querySelector('[data-auto-musings-latest]');
    if (latest) {
      latest.textContent = state.lastMusing
        ? `${state.lastMusing.type === 'context' ? '聊天片段' : '种子词'}：${state.lastMusing.content}`
        : '暂无';
    }
    const log = root.querySelector('[data-auto-musings-log]');
    if (log) log.textContent = state.lastEventAt ? `${formatTime(state.lastEventAt)}  ${state.lastEvent}` : state.lastEvent;

    const testButton = root.querySelector('#auto-musings-test');
    if (testButton) {
      testButton.disabled = state.musingInFlight || state.generating;
      testButton.classList.toggle('disabled', testButton.disabled);
    }
  }

  function settingsMarkup() {
    return `
      <div id="${ROOT_ID}" class="extension_container auto-musings-extension">
        <div class="inline-drawer">
          <div class="inline-drawer-toggle inline-drawer-header">
            <div class="auto-musings-title-row">
              <b>Auto Musings</b>
              <span class="auto-musings-status" data-auto-musings-status data-tone="standby">待机</span>
            </div>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
          </div>
          <div class="inline-drawer-content">
            <label class="checkbox_label auto-musings-enable" for="auto-musings-enabled">
              <input id="auto-musings-enabled" type="checkbox">
              <span>启用自动漫想</span>
            </label>
            <div class="auto-musings-grid">
              <label class="auto-musings-field" for="auto-musings-idle-threshold">
                <span>离开阈值（分钟）</span>
                <input id="auto-musings-idle-threshold" class="text_pole" type="number" min="0.5" max="1440" step="0.5">
              </label>
              <label class="auto-musings-field" for="auto-musings-check-interval">
                <span>检查间隔（分钟）</span>
                <input id="auto-musings-check-interval" class="text_pole" type="number" min="0.25" max="60" step="0.25">
              </label>
              <label class="auto-musings-field" for="auto-musings-musing-interval">
                <span>漫想间隔（分钟）</span>
                <input id="auto-musings-musing-interval" class="text_pole" type="number" min="0.25" max="60" step="0.25">
              </label>
              <label class="auto-musings-field" for="auto-musings-push-mode">
                <span>推送倾向</span>
                <select id="auto-musings-push-mode" class="text_pole">
                  <option value="dynamic">随离开时间变化</option>
                  <option value="balanced">平衡</option>
                  <option value="frequent">更主动</option>
                </select>
              </label>
            </div>
            <div class="auto-musings-actions">
              <button id="auto-musings-test" type="button" class="menu_button menu_button_icon" title="立即生成一次漫想">
                <i class="fa-solid fa-wand-magic-sparkles"></i>
                <span>立即测试一次</span>
              </button>
              <button id="auto-musings-check" type="button" class="menu_button menu_button_icon" title="立即检查当前聊天是否空闲">
                <i class="fa-solid fa-rotate"></i>
                <span>立即检查</span>
              </button>
            </div>
            <div class="auto-musings-info-grid">
              <div><span>当前状态</span><strong data-auto-musings-status>待机</strong></div>
              <div><span>最近检查</span><strong data-auto-musings-last-check>暂无</strong></div>
              <div><span>空闲时长</span><strong data-auto-musings-idle-for>未进入</strong></div>
              <div><span>最近念头</span><strong data-auto-musings-latest>暂无</strong></div>
            </div>
            <div class="auto-musings-log" data-auto-musings-log>等待检查</div>
          </div>
        </div>
      </div>`;
  }

  function readSettingsFromUI() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    state.settings.enabled = !!root.querySelector('#auto-musings-enabled')?.checked;
    state.settings.idleThresholdMinutes = clamp(
      root.querySelector('#auto-musings-idle-threshold')?.value,
      0.5,
      1440,
      DEFAULT_SETTINGS.idleThresholdMinutes,
    );
    state.settings.checkIntervalMinutes = clamp(
      root.querySelector('#auto-musings-check-interval')?.value,
      0.25,
      60,
      DEFAULT_SETTINGS.checkIntervalMinutes,
    );
    state.settings.musingIntervalMinutes = clamp(
      root.querySelector('#auto-musings-musing-interval')?.value,
      0.25,
      60,
      DEFAULT_SETTINGS.musingIntervalMinutes,
    );
    state.settings.pushMode = root.querySelector('#auto-musings-push-mode')?.value || DEFAULT_SETTINGS.pushMode;
    saveSettings();
    restartTimers();
    updateUI();
  }

  function fillSettingsUI() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    root.querySelector('#auto-musings-enabled').checked = !!state.settings.enabled;
    root.querySelector('#auto-musings-idle-threshold').value = state.settings.idleThresholdMinutes;
    root.querySelector('#auto-musings-check-interval').value = state.settings.checkIntervalMinutes;
    root.querySelector('#auto-musings-musing-interval').value = state.settings.musingIntervalMinutes;
    root.querySelector('#auto-musings-push-mode').value = state.settings.pushMode;
    updateUI();
  }

  function openSettings() {
    const drawer = document.querySelector('#extensions-settings-button .drawer-toggle');
    const drawerContent = document.getElementById('rm_extensions_block');
    if (drawer && drawerContent?.classList.contains('closedDrawer')) drawer.click();

    setTimeout(() => {
      const root = document.getElementById(ROOT_ID);
      if (!root) return;
      root.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const content = root.querySelector('.inline-drawer-content');
      if (content && getComputedStyle(content).display === 'none') {
        root.querySelector('.inline-drawer-toggle')?.click();
      }
    }, 250);
  }

  function bindSettingsUI() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    root.querySelectorAll('input, select').forEach((element) => {
      element.addEventListener('change', readSettingsFromUI);
    });
    root.querySelector('#auto-musings-test')?.addEventListener('click', () => {
      musingLoop(true).catch((error) => console.error('[Auto Musings] 测试失败:', error));
    });
    root.querySelector('#auto-musings-check')?.addEventListener('click', () => {
      checkIdle();
      if (typeof window.toastr?.info === 'function') window.toastr.info('已检查当前聊天状态');
    });
    fillSettingsUI();
  }

  function addSettingsPanel(attempt = 0) {
    if (document.getElementById(ROOT_ID)) return true;
    const target = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!target) {
      if (attempt < 30) setTimeout(() => addSettingsPanel(attempt + 1), 500);
      return false;
    }
    target.insertAdjacentHTML('beforeend', settingsMarkup());
    state.uiReady = true;
    bindSettingsUI();
    return true;
  }

  function addMenuButton(attempt = 0) {
    if (document.getElementById(MENU_ID)) return true;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) {
      if (attempt < 30) setTimeout(() => addMenuButton(attempt + 1), 500);
      return false;
    }

    const container = document.createElement('div');
    container.id = MENU_ID;
    container.className = 'extension_container interactable';
    container.innerHTML = `
      <div class="list-group-item flex-container flexGap5 interactable" title="Auto Musings">
        <div class="fa-fw fa-solid fa-lightbulb extensionsMenuExtensionButton auto-musings-menu-icon"></div>
        <span>Auto Musings</span>
      </div>`;
    container.addEventListener('click', (event) => {
      event.stopPropagation();
      if (typeof window.jQuery === 'function') window.jQuery(document).trigger('click');
      setTimeout(openSettings, 100);
    });
    menu.appendChild(container);
    return true;
  }

  function bindEvents() {
    const eventTypes = state.ctx?.eventTypes ?? state.ctx?.event_types ?? {};
    const source = state.ctx?.eventSource;
    if (!source?.on) return;

    if (eventTypes.USER_MESSAGE_RENDERED) source.on(eventTypes.USER_MESSAGE_RENDERED, onUserMessage);
    if (eventTypes.USER_MESSAGE_SENT && eventTypes.USER_MESSAGE_SENT !== eventTypes.USER_MESSAGE_RENDERED) {
      source.on(eventTypes.USER_MESSAGE_SENT, onUserMessage);
    }
    if (eventTypes.CHAT_CHANGED) source.on(eventTypes.CHAT_CHANGED, onChatChanged);
    if (eventTypes.APP_READY) source.on(eventTypes.APP_READY, () => {
      addSettingsPanel();
      addMenuButton();
    });
  }

  function init() {
    try {
      state.ctx = globalThis.SillyTavern?.getContext?.();
      if (!state.ctx) throw new Error('SillyTavern context unavailable');
      ensureSettings(state.ctx);
      addSettingsPanel();
      addMenuButton();
      bindEvents();
      restartTimers();
      setTimeout(checkIdle, 3000);
      state.uiRefreshTimer = setInterval(updateUI, 5000);
      globalThis.AutoMusings = {
        openSettings,
        checkNow: checkIdle,
        test: () => musingLoop(true),
        getState: () => ({
          enabled: state.settings.enabled,
          isIdle: state.isIdle,
          generating: state.generating,
          lastCheckAt: state.lastCheckAt,
          lastMessageTime: state.lastMessageTime,
          lastMusing: state.lastMusing ? { ...state.lastMusing } : null,
          lastEvent: state.lastEvent,
          settings: { ...state.settings },
        }),
      };
      recordEvent('Auto Musings 已加载');
    } catch (error) {
      console.error('[Auto Musings] 初始化失败:', error);
    }
  }

  init();
})();
