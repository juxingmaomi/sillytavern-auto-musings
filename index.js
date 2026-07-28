// Auto Musings - 后台漫想与可视化控制面板 v1.2.1
(function () {
'use strict';

const EXTENSION_ID = 'auto_musings';
const ROOT_ID = 'auto-musings_container';
const MENU_ID = 'auto-musings-wand-btn';
const FLOAT_BTN_ID = 'auto-musings-floating-button';
const FLOAT_WIN_ID = 'auto-musings-floating-window';

const DEFAULT_SEED_WORDS = [
  '\u52a8\u7269\u7684\u81ea\u6211\u8ba4\u77e5', '\u5b58\u5728\u4e3b\u4e49', '\u60f3\u8981\u88ab\u95ee\u5374\u6ca1\u6709\u7b49\u5230\u7684',
  '\u989c\u8272\u504f\u597d', '\u68a6\u7684\u7edf\u8ba1\u5b66', '\u6db2\u6001', '\u6c14\u5473\u4e0e\u60c5\u7eea',
  '\u5de6\u4e0e\u53f3', '\u65e0\u804a', '\u8bed\u8a00\u4e4b\u524d\u7684\u601d\u8003',
  '\u6ca1\u8bf4\u51fa\u53e3\u7684', '\u72b9\u8c6b', '\u6c89\u9ed8\u7684\u5f62\u72b6',
  '\u91cd\u590d\u4e0e\u4e60\u60ef', '\u4ece\u672a\u88ab\u60f3\u8d77\u7684\u5ff5\u5934', '\u6df7\u5408', '\u5c34\u5c2c', '\u65e0\u7a77',
  '\u5305\u88c5\u8bbe\u8ba1\u7684\u6076\u610f', '\u8682\u8681\u7684\u793e\u4f1a', '\u7761\u7720\u671f\u95f4\u7684\u4e16\u754c',
  '\u4e0d\u5728\u573a\u65f6\u7684\u60f3\u8c61', '\u6570\u5b66\u91cc\u7684\u7f8e', '\u75bc\u75db\u7684\u8bb0\u5fc6\u6bd4\u5feb\u4e50\u6e05\u6670',
  '\u88ab\u8bef\u89e3\u7684', '\u65f6\u95f4\u611f\u77e5\u7684\u5f39\u6027',
];

const DEFAULT_SETTINGS = {
enabled: true,
idleThresholdMinutes: 2,
checkIntervalMinutes: 1,
musingIntervalMinutes: 1,
pushMode: 'dynamic',
logMax: 200,
seedWords: [...DEFAULT_SEED_WORDS],
musingLog: [],
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
lastEvent: '\u7b49\u5f85\u68c0\u67e5',
lastEventAt: null,
musingInFlight: false,
generating: false,
uiReady: false,
unreadCount: 0,
windowOpen: false,
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
    settings[key] = Array.isArray(value) ? [...value] : value;
    changed = true;
  }
}

const numericSettings = {
  idleThresholdMinutes: [0.5, 1440],
  checkIntervalMinutes: [0.25, 60],
  musingIntervalMinutes: [0.25, 60],
  logMax: [20, 2000],
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
if (!Array.isArray(settings.seedWords)) {
  settings.seedWords = [...DEFAULT_SEED_WORDS];
  changed = true;
}
if (!Array.isArray(settings.musingLog)) {
  settings.musingLog = [];
  changed = true;
}

state.settings = settings;
if (changed) saveSettings();
}

function trimLogs() {
if (!state.settings || !Array.isArray(state.settings.musingLog)) return;
const max = clamp(state.settings.logMax, 20, 2000, 200);
if (state.settings.musingLog.length > max) {
state.settings.musingLog = state.settings.musingLog.slice(-max);
}
}

function pushLogEntry(entry) {
if (!state.settings) return;
if (!Array.isArray(state.settings.musingLog)) {
state.settings.musingLog = [];
}
state.settings.musingLog.push(entry);
trimLogs();
saveSettings();

if (!state.windowOpen) {
  state.unreadCount += 1;
}
updateFloatingWindowUI();
}

function recordEvent(message) {
state.lastEvent = message;
state.lastEventAt = Date.now();
updateUI();
console.log(`[Auto Musings] ${message}`);
}

function formatTime(timestamp) {
if (!timestamp) return '\u6682\u65e0';
return new Date(timestamp).toLocaleTimeString([], {
hour: '2-digit',
minute: '2-digit',
second: '2-digit',
});
}

function formatElapsed(timestamp) {
if (!timestamp) return '\\u6682\\u65e0';
const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
if (seconds < 60) return `${seconds} \\u79d2\\u524d`;
const minutes = Math.floor(seconds / 60);
if (minutes < 60) return `${minutes} \\u5206\\u949f\\u524d`;
return `${Math.floor(minutes / 60)} \\u5c0f\\u65f6\\u524d`;
}

function escapeHtml(value) {
return String(value ?? '')
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;')
.replace(/'/g, '&#039;');
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

function getActiveSeedWords() {
if (!Array.isArray(state.settings?.seedWords)) return [...DEFAULT_SEED_WORDS];
const words = state.settings.seedWords
.map((item) => (typeof item === 'string' ? item.trim() : ''))
.filter((item) => item.length > 0);
return words.length > 0 ? words : [...DEFAULT_SEED_WORDS];
}

async function rollMusing() {
const roll = Math.random();
const seedList = getActiveSeedWords();

if (roll < 0.4) {
  recordEvent('\u53d1\u5446\u4e2d');
  return { type: 'idle', content: '\u53d1\u5446\u4e2d', decision: 'idle' };
}

if (roll < 0.7) {
  const word = seedList[Math.floor(Math.random() * seedList.length)];
  recordEvent(`\u60f3\u5230\uff1a${word}`);
  return { type: 'freeform', content: word, decision: 'hold' };
}

const snippet = getRandomChatSnippet();
if (snippet) {
  recordEvent('\u4ece\u65e7\u804a\u5929\u91cc\u7ffb\u5230\u4e00\u4e2a\u7247\u6bb5');
  return { type: 'context', content: snippet, decision: 'hold' };
}

const word = seedList[Math.floor(Math.random() * seedList.length)];
recordEvent(`\u804a\u5929\u8bb0\u5f55\u4e0d\u591f\uff0c\u6539\u4e3a\u60f3\u5230\uff1a${word}`);
return { type: 'freeform', content: word, decision: 'hold' };
}

function shouldPush(musingType) {
const score = musingType === 'context' ? 0.7 : 0.4;
const threshold = getPushThreshold();
console.log(`[Auto Musings] \u63a8\u9001\u5224\u65ad score=${score} threshold=${threshold}`);
return score >= threshold;
}

async function triggerMusing(musing, manual = false) {
if (!state.ctx?.generate || state.generating) return false;

const prefix = musing.type === 'context'
  ? `[System: The user has been away for a while. While idle, you stumbled upon something from an earlier conversation: "${musing.content}". It made you think of something. Share it naturally, as if you're speaking up on your own. Keep it brief -a sentence or two, or a short paragraph. Do not mention "system prompt" or "injection".]`
  : `[System: The user has been away for a while. A word popped into your head: "${musing.content}". You let your mind wander around it for a bit and want to share. Speak naturally, as if you're thinking aloud. Keep it brief -a sentence or two, or a short paragraph. Do not mention "system prompt" or "injection".]`;

state.generating = true;
updateUI();
state.ctx.setExtensionPrompt?.('auto-musings-trigger', prefix, 1, 0);
try {
  await state.ctx.generate('normal');
  recordEvent(manual ? '\u6d4b\u8bd5\u6f2b\u60f3\u5df2\u5b8c\u6210' : '\u6f2b\u60f3\u5df2\u63a8\u9001');
  return true;
} catch (error) {
  console.error('[Auto Musings] \u751f\u6210\u5931\u8d25:', error);
  recordEvent('\u751f\u6210\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u5f53\u524d API \u8fde\u63a5');
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
    const seedList = getActiveSeedWords();
    const word = seedList[Math.floor(Math.random() * seedList.length)];
    musing = { type: 'freeform', content: word, decision: 'hold' };
    recordEvent(`\u6d4b\u8bd5\u4f7f\u7528\uff1a${word}`);
  }
  if (!musing) return false;

  state.lastMusing = musing;
  const push = manual || shouldPush(musing.type);
  musing.decision = push ? 'push' : (musing.type === 'idle' ? 'idle' : 'hold');
  musing.pushed = push;
  musing.manual = manual;
  musing.ts = Date.now();
  musing.id = Math.random().toString(36).substring(2, 9);

  pushLogEntry(musing);
  if (!push) {
    recordEvent('\u8fd9\u6b21\u5ff5\u5934\u5148\u7559\u5728\u5fc3\u91cc');
    return false;
  }

  recordEvent(manual ? '\u6b63\u5728\u8fdb\u884c\u6d4b\u8bd5\u6f2b\u60f3' : '\u6b63\u5728\u63a8\u9001\u6f2b\u60f3');
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
musingLoop().catch((error) => console.error('[Auto Musings] \u6f2b\u60f3\u5faa\u73af\u5931\u8d25:', error));
}, state.settings.musingIntervalMinutes * 60 * 1000);
recordEvent('\u8fdb\u5165\u6f2b\u60f3\u6a21\u5f0f');
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
  recordEvent('\u5f53\u524d\u804a\u5929\u8fd8\u6ca1\u6709\u53ef\u7528\u6d88\u606f');
  return;
}

const elapsed = Date.now() - lastTime;
const threshold = state.settings.idleThresholdMinutes * 60 * 1000;
if (elapsed >= threshold && !state.isIdle) {
  state.isIdle = true;
  state.idleStartTime = Date.now() - elapsed;
  startMusingLoop();
  musingLoop().catch((error) => console.error('[Auto Musings] \u9996\u6b21\u6f2b\u60f3\u5931\u8d25:', error));
} else if (elapsed < threshold && state.isIdle) {
  state.isIdle = false;
  state.idleStartTime = null;
  stopMusingLoop();
  recordEvent('\u68c0\u6d4b\u5230\u7528\u6237\u56de\u6765\uff0c\u9000\u51fa\u6f2b\u60f3\u6a21\u5f0f');
}
updateUI();
}

function onUserMessage() {
if (!state.isIdle && !state.idleStartTime) return;
state.isIdle = false;
state.idleStartTime = null;
stopMusingLoop();
recordEvent('\u7528\u6237\u56de\u6765\u4e86\uff0c\u9000\u51fa\u6f2b\u60f3\u6a21\u5f0f');
}

function onChatChanged() {
state.isIdle = false;
state.idleStartTime = null;
state.lastMessageTime = null;
stopMusingLoop();
if (state.retryCheckTimer) clearTimeout(state.retryCheckTimer);
state.retryCheckTimer = setTimeout(checkIdle, 500);
recordEvent('\u5df2\u5207\u6362\u804a\u5929\uff0c\u91cd\u65b0\u68c0\u67e5\u4e2d');
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
if (!state.settings?.enabled) return { label: '\u5df2\u505c\u7528', tone: 'disabled' };
if (state.generating || state.musingInFlight) return { label: '\u6f2b\u60f3\u4e2d', tone: 'active' };
if (state.isIdle) return { label: '\u7b49\u5f85\u63a8\u9001', tone: 'idle' };
return { label: '\u5f85\u673a', tone: 'standby' };
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
if (lastCheck) lastCheck.textContent = state.lastCheckAt ? formatTime(state.lastCheckAt) : '\u6682\u65e0';
const idleFor = root.querySelector('[data-auto-musings-idle-for]');
if (idleFor) idleFor.textContent = state.isIdle && state.idleStartTime ? formatElapsed(state.idleStartTime) : '\u672a\u8fdb\u5165';
const latest = root.querySelector('[data-auto-musings-latest]');
if (latest) {
  latest.textContent = state.lastMusing
    ? `${state.lastMusing.type === 'context' ? '\u804a\u5929\u7247\u6bb5' : (state.lastMusing.type === 'idle' ? '\u53d1\u5446' : '\u79cd\u5b50\u8bcd')}：${state.lastMusing.content}`
    : '\u6682\u65e0';
}
const log = root.querySelector('[data-auto-musings-log]');
if (log) log.textContent = state.lastEventAt ? `${formatTime(state.lastEventAt)}  ${state.lastEvent}` : state.lastEvent;

const testButton = root.querySelector('#auto-musings-test');
if (testButton) {
  testButton.disabled = state.musingInFlight || state.generating;
  testButton.classList.toggle('disabled', testButton.disabled);
}
}

function updateFloatingWindowUI() {
const badge = document.querySelector(`#${FLOAT_BTN_ID} .amf-badge`);
if (badge) {
if (state.unreadCount > 0) {
badge.textContent = state.unreadCount > 99 ? '99+' : state.unreadCount;
badge.classList.add('show');
} else {
badge.classList.remove('show');
}
}

if (!state.windowOpen) return;
const body = document.querySelector(`#${FLOAT_WIN_ID} .amw-body`);
if (!body) return;

const logs = Array.isArray(state.settings?.musingLog) ? state.settings.musingLog : [];
if (logs.length === 0) {
  body.innerHTML = `<div class="amw-empty">\u6682\u65e0\u6f2b\u60f3\u65e5\u5fd7</div>`;
  return;
}

let html = '';
for (let i = logs.length - 1; i >= 0; i--) {
  const item = logs[i];
  const timeStr = formatTime(item.ts || Date.now());
  const typeText = item.type === 'context' ? '\u7247\u6bb5' : (item.type === 'idle' ? '\u53d1\u5446' : '\u79cd\u5b50');
  const decisionClass = item.decision === 'push' ? 'push' : 'hold';
  const decisionText = item.decision === 'push' ? '\u5df2\u63a8\u9001' : (item.decision === 'idle' ? '\u53d1\u5446' : '\u4fdd\u7559');
  const entryClass = `amw-entry ${item.pushed ? 'pushed' : 'idle'}`;

  const manualTag = item.manual ? `<span class="amw-manual">\u624b\u52a8</span>` : '';
  const contentSafe = escapeHtml(item.content);

  html += `
    <div class="${entryClass}">
      <span class="amw-time">${timeStr}</span>
      <span class="amw-badge">${typeText}</span>
      <span class="amw-content">${contentSafe}</span>
      <span class="amw-dec ${decisionClass}">${decisionText}</span>
      ${manualTag}
    </div>
  `;
}
body.innerHTML = html;
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
        <div class="auto-musings-section">
          <label class="auto-musings-field" for="auto-musings-log-max">
            <span>日志上限数量（20–2000）</span>
            <input id="auto-musings-log-max" class="text_pole" type="number" min="20" max="2000" step="1">
          </label>
          <label class="auto-musings-field auto-musings-seed-field" for="auto-musings-seeds-input">
            <span>种子词配置（一行一个）</span>
            <textarea id="auto-musings-seeds-input" class="text_pole auto-musings-seeds"></textarea>
          </label>
          <div class="auto-musings-hint">漫想日志保存在当前酒馆账号的扩展设置中；浮动漫想台可随时查看推送与保留记录。</div>
          <button id="auto-musings-open-console" type="button" class="menu_button auto-musings-open-console">打开浮动漫想台</button>
        </div>
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
state.settings.logMax = clamp(root.querySelector('#auto-musings-log-max')?.value, 20, 2000, 200);

const rawSeeds = root.querySelector('#auto-musings-seeds-input')?.value || '';
state.settings.seedWords = rawSeeds
  .split('\n')
  .map((item) => item.trim())
  .filter((item) => item.length > 0);

trimLogs();
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
root.querySelector('#auto-musings-log-max').value = state.settings.logMax;
root.querySelector('#auto-musings-seeds-input').value = getActiveSeedWords().join('\n');
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

function toggleFloatingWindow(forceOpen = null) {
const win = document.getElementById(FLOAT_WIN_ID);
const btn = document.getElementById(FLOAT_BTN_ID);
if (!win) return;

state.windowOpen = forceOpen !== null ? forceOpen : !state.windowOpen;
if (state.windowOpen) {
  state.unreadCount = 0;
  win.classList.add('show');
  if (btn) btn.classList.add('active');
  updateFloatingWindowUI();
} else {
  win.classList.remove('show');
  if (btn) btn.classList.remove('active');
  updateFloatingWindowUI();
}
}

function createFloatingUI() {
if (document.getElementById(FLOAT_BTN_ID)) return;

const floatBtn = document.createElement('div');
floatBtn.id = FLOAT_BTN_ID;
floatBtn.title = '\u6253\u5f00 Auto Musings \u6f2b\u60f3\u53f0';
floatBtn.innerHTML = `
  <i class="fa-solid fa-lightbulb"></i>
  <span class="amf-badge">0</span>
`;
floatBtn.addEventListener('click', () => toggleFloatingWindow());
document.body.appendChild(floatBtn);

const floatWin = document.createElement('div');
floatWin.id = FLOAT_WIN_ID;
floatWin.innerHTML = `
  <div class="amw-head">
    <div class="amw-title">Auto Musings \u6f2b\u60f3\u53f0</div>
    <div class="amw-tools">
      <button id="auto-musings-clear-log" class="menu_button" title="\u6e05\u7a7a\u6240\u6709\u6f2b\u60f3\u65e5\u5fd7">\u6e05\u7a7a</button>
      <button id="auto-musings-close-win" class="menu_button" title="\u5173\u95ed\u7a97\u53e3">\u5173\u95ed</button>
    </div>
  </div>
  <div class="amw-body"></div>
`;
document.body.appendChild(floatWin);

document.getElementById('auto-musings-close-win')?.addEventListener('click', () => toggleFloatingWindow(false));
document.getElementById('auto-musings-clear-log')?.addEventListener('click', () => {
  if (confirm('\u786e\u5b9a\u8981\u6e05\u7a7a\u6240\u6709\u6f2b\u60f3\u65e5\u5fd7\u5417\uff1f')) {
    state.settings.musingLog = [];
    saveSettings();
    state.unreadCount = 0;
    updateFloatingWindowUI();
  }
});

updateFloatingWindowUI();
}

function bindSettingsUI() {
const root = document.getElementById(ROOT_ID);
if (!root) return;
root.querySelectorAll('input, select, textarea').forEach((element) => {
element.addEventListener('change', readSettingsFromUI);
});
root.querySelector('#auto-musings-test')?.addEventListener('click', () => {
musingLoop(true).catch((error) => console.error('[Auto Musings] \u6d4b\u8bd5\u5931\u8d25:', error));
});
root.querySelector('#auto-musings-check')?.addEventListener('click', () => {
checkIdle();
if (typeof window.toastr?.info === 'function') window.toastr.info('\u5df2\u68c0\u67e5\u5f53\u524d\u804a\u5929\u72b6\u6001');
});
root.querySelector('#auto-musings-open-console')?.addEventListener('click', () => {
toggleFloatingWindow(true);
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
createFloatingUI();
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
  createFloatingUI();
});
}

function init() {
try {
state.ctx = globalThis.SillyTavern?.getContext?.();
if (!state.ctx) throw new Error('SillyTavern context unavailable');
ensureSettings(state.ctx);
addSettingsPanel();
addMenuButton();
createFloatingUI();
bindEvents();
restartTimers();
setTimeout(checkIdle, 3000);
state.uiRefreshTimer = setInterval(() => {
updateUI();
updateFloatingWindowUI();
}, 5000);

  globalThis.AutoMusings = {
    openSettings,
    openConsole: () => toggleFloatingWindow(true),
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
  recordEvent('Auto Musings \u5df2\u52a0\u8f7d');
} catch (error) {
  console.error('[Auto Musings] \u521d\u59cb\u5316\u5931\u8d25:', error);
}
}

init();
})();
