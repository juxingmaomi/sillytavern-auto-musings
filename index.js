// Auto Musings - 前端漫想与持久日志控制面板 v1.5.5
(function () {
'use strict';

const EXTENSION_VERSION = '1.5.5';

const EXTENSION_ID = 'auto_musings';
const ROOT_ID = 'auto-musings_container';
const MENU_ID = 'auto-musings-wand-btn';
const FLOAT_BTN_ID = 'auto-musings-floating-button';
const FLOAT_WIN_ID = 'auto-musings-floating-window';
const SERVER_API_BASE = '/api/plugins/auto-musings';
const MUSING_TRIGGER_PROMPT_ID = 'auto-musings-trigger';
const EXTENSION_PROMPT_POSITION = { IN_CHAT: 1 };
const EXTENSION_PROMPT_ROLE = { SYSTEM: 0 };
const INIT_RETRY_INTERVAL_MS = 500;
const INIT_MAX_ATTEMPTS = 120;

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
idleThresholdMinutes: 30,
checkIntervalMinutes: 10,
musingIntervalMinutes: 5,
pushMode: 'dynamic',
logMax: 200,
contextMode: 'default',
contextDepth: 10,
secondaryProfileId: '',
secondaryModel: '',
hiddenMaxTokens: 500,
seedWords: [...DEFAULT_SEED_WORDS],
musingLog: [],
forumEnabled: false,
forumProbability: 25,
forumCooldownMinutes: 60,
forumCandidateLimit: 12,
forumReadLimit: 6,
forumPostsPerRun: 3,
forumRelatedRatio: 70,
forumMcpServerName: 'lutopia',
forumFilterProfileId: '',
forumFilterModel: '',
forumReviewProfileId: '',
forumReviewModel: '',
forumFilterMaxTokens: 500,
forumReviewMaxTokens: 1200,
floatingButtonPositions: {},
};

const state = {
initialized: false,
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
serverAvailable: false,
serverStatus: null,
serverLogs: [],
serverPollTimer: null,
serverSyncTimer: null,
serverLogSyncInFlight: false,
lastServerLogId: null,
promptSnapshot: [],
promptSnapshotAt: null,
serverPausedReason: '',
pageSuspended: document.visibilityState === 'hidden',
};

let floatingPositionRepairFrame = null;
let floatingButtonDragging = false;
let suppressFloatingButtonClickUntil = 0;

const clamp = (value, min, max, fallback) => {
const number = Number(value);
if (!Number.isFinite(number)) return fallback;
return Math.min(max, Math.max(min, number));
};

function collectErrorChain(error) {
const messages = [];
const seen = new Set();
let current = error;
while (current && !seen.has(current) && messages.length < 6) {
  seen.add(current);
  const message = typeof current?.message === 'string'
    ? current.message
    : (typeof current === 'string' ? current : '');
  if (message && !messages.includes(message)) messages.push(message);
  current = current?.cause;
}
if (messages.length === 0) messages.push(String(error || '未知错误'));
return messages.join(' <- ');
}

function findErrorValue(error, selectors) {
const seen = new Set();
let current = error;
while (current && !seen.has(current)) {
  seen.add(current);
  for (const selector of selectors) {
    const value = selector(current);
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  current = current?.cause;
}
return '';
}

function redactDiagnosticText(value) {
let text = String(value ?? '').normalize('NFKC').replace(/\u0000/g, '').trim().slice(0, 8000);
text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已隐藏]');
text = text.replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [已隐藏]');
text = text.replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, '[API Key 已隐藏]');
text = text.replace(/\b(?:sk|rk|pk|gsk|ghp|github_pat|xai|sess)[-_][A-Za-z0-9_-]{8,}\b/gi, '[API Key 已隐藏]');
text = text.replace(/((["']?)(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|x-api-key|secret|password)\2\s*[:=]\s*["']?)([^"'\s,}\]]{6,})/gi, '$1[已隐藏]');
text = text.replace(/([?&](?:token|key|api_key|access_token)=)[^&\s]+/gi, '$1[已隐藏]');
text = text.replace(/https?:\/\/[^\s"']+/gi, (urlText) => {
  try {
    return `[地址已隐藏:${new URL(urlText).host}]`;
  } catch {
    return '[地址已隐藏]';
  }
});
return text;
}

function getSafeEndpointHost(value) {
try {
  return new URL(value).host;
} catch {
  return '';
}
}

function createLocalDiagnostic(error, context = {}) {
const stage = String(context.stage || 'unknown');
const statusValue = findErrorValue(error, [
  (item) => item?.status,
  (item) => item?.statusCode,
  (item) => item?.response?.status,
]);
let status = Number(statusValue) || null;
const message = redactDiagnosticText(collectErrorChain(error));
if (!status) {
  const statusMatch = message.match(/(?:http|response|status|状态)[^0-9]{0,12}([1-5][0-9]{2})/i);
  if (statusMatch) status = Number(statusMatch[1]);
  else if (/\bunauthorized\b/i.test(message)) status = 401;
  else if (/\bforbidden\b/i.test(message)) status = 403;
}
const lower = message.toLowerCase();
const stageNames = {
  server_bridge: '连接后台漫想服务',
  server_sync: '同步后台漫想状态',
  hidden_musing: '生成隐藏漫想',
  visible_musing: '生成发送到聊天的漫想',
  worldbook_write: '写入世界书',
  forum_discover: '启动论坛只读流程',
};
let code = String(error?.code || 'unknown_error');
let title = '出现了未识别的错误';
let action = '把这条诊断复制给猴猴，我会根据技术详情继续定位。';

if (stage === 'server_bridge' && /version|版本/.test(lower)) {
  code = 'server_version_mismatch';
  title = '前端和后台漫想服务版本不一致';
  action = '现在不用重启；等你方便停止游玩时再重启一次酒馆。';
} else if (/connection manager.*not available|profile not found|connection profile|请选择副 api/.test(lower)) {
  code = 'profile_missing';
  title = '没有找到所选的副 API 配置';
  context.summary ||= '插件没有拿到明确的连接配置，因此没有向任何模型发送请求。';
  action = '在 Auto Musings 面板重新选择连接配置；插件不会自动改用别的配置。';
} else if (status === 401 || status === 403 || /unauthor|forbidden|api key|authentication/.test(lower)) {
  code = 'authentication_failed';
  title = 'API 身份验证失败';
  context.summary ||= '目标接口拒绝了当前连接配置的身份凭证，本次没有得到模型回复。';
  action = '检查所选酒馆连接配置绑定的 Key；插件不会尝试其他 Key。';
} else if (status === 404 || /model.*not found|unknown model|不存在.*模型/.test(lower)) {
  code = 'endpoint_or_model_missing';
  title = '接口地址或模型名不被服务端识别';
  context.summary ||= '请求已经到达服务端，但服务端找不到这个接口路径或模型名称。';
  action = '检查所选配置和模型名后再手动测试。';
} else if (status === 429 || /rate.?limit|too many|quota|额度|限流/.test(lower)) {
  code = 'rate_limited';
  title = 'API 请求过多或额度受限';
  context.summary ||= '服务端暂时拒绝继续处理请求，常见原因是频率、并发或额度限制。';
  action = '稍后由你手动重试，或自行更换面板中的连接配置。';
} else if (status >= 500 || /bad gateway|service unavailable|upstream/.test(lower)) {
  code = 'provider_unavailable';
  title = 'API 服务端暂时异常';
  context.summary ||= '错误来自目标服务或它的上游，不是插件自动更换了 API。';
  action = '等服务恢复后再手动重试，不需要让插件自动切换。';
} else if (/timeout|timed out|超时/.test(lower) || error?.name === 'AbortError') {
  code = 'timeout';
  title = '请求超时';
  context.summary ||= '在设定时间内没有收到完整回复，本次请求已经停止。';
  action = '检查网络或反代，之后再手动测试。';
} else if (/fetch failed|network|econn|socket|dns|连接/.test(lower)) {
  code = 'network_error';
  title = '无法连接到目标服务';
  context.summary ||= '当前页面没有成功建立或维持到目标接口的网络连接。';
  action = '检查服务器网络和反代后再手动测试。';
} else if (/empty|空内容|没有返回/.test(lower)) {
  code = 'empty_response';
  title = '模型返回了空内容';
  context.summary ||= '接口请求完成了，但可用的模型正文为空，所以插件没有伪造结果。';
  action = '把诊断复制给猴猴；我会检查返回格式。';
} else if (stage === 'worldbook_write') {
  code = 'worldbook_write_failed';
  title = '隐藏漫想已生成，但没有写进世界书';
  context.summary ||= '模型调用已经成功，失败发生在保存角色世界书这一步。';
  action = '先不要清空漫想日志；完整念头仍保存在日志中。';
}

return {
  id: globalThis.crypto?.randomUUID?.() || `diag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  kind: 'diagnostic',
  ts: Date.now(),
  severity: context.severity || 'error',
  code,
  stage,
  stageName: stageNames[stage] || stage,
  title,
  summary: context.summary || '当前步骤没有完成，错误已经记录。',
  impact: context.impact || '本次步骤停止；不会自动切换 API。',
  preservation: context.preservation || '故障诊断已经保存。',
  retry: context.retry || '不会自动重试；处理问题后再由你手动操作。',
  automaticApiSwitch: false,
  action,
  technical: {
    status,
    profileName: String(context.profileName || ''),
    model: String(context.model || ''),
    operationId: String(context.operationId || ''),
    endpointHost: redactDiagnosticText(context.endpointHost || error?.endpointHost || ''),
    errorName: String(error?.name || ''),
    systemCode: redactDiagnosticText(findErrorValue(error, [(item) => item?.code, (item) => item?.errno])),
    providerCode: redactDiagnosticText(findErrorValue(error, [(item) => item?.providerCode, (item) => item?.data?.error?.code])),
    providerType: redactDiagnosticText(findErrorValue(error, [(item) => item?.providerType, (item) => item?.data?.error?.type])),
    requestId: redactDiagnosticText(findErrorValue(error, [(item) => item?.requestId])),
    message,
    responseExcerpt: redactDiagnosticText(error?.responseExcerpt || ''),
  },
};
}

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
    settings[key] = Array.isArray(value)
      ? [...value]
      : (value && typeof value === 'object' ? { ...value } : value);
    changed = true;
  }
}

const numericSettings = {
  idleThresholdMinutes: [0.5, 1440],
  checkIntervalMinutes: [0.25, 1440],
  musingIntervalMinutes: [0.25, 1440],
  logMax: [20, 2000],
  contextDepth: [1, 100],
  hiddenMaxTokens: [64, 4096],
  forumProbability: [0, 100],
  forumCooldownMinutes: [5, 10080],
  forumCandidateLimit: [3, 20],
  forumReadLimit: [3, 12],
  forumPostsPerRun: [1, 10],
  forumRelatedRatio: [0, 100],
  forumFilterMaxTokens: [128, 2048],
  forumReviewMaxTokens: [256, 4096],
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
if (!['default', 'recent'].includes(settings.contextMode)) {
  settings.contextMode = DEFAULT_SETTINGS.contextMode;
  changed = true;
}
if (typeof settings.secondaryProfileId !== 'string') {
  settings.secondaryProfileId = '';
  changed = true;
}
if (typeof settings.secondaryModel !== 'string') {
  settings.secondaryModel = '';
  changed = true;
}
if (typeof settings.forumEnabled !== 'boolean') {
  settings.forumEnabled = false;
  changed = true;
}
if (!settings.floatingButtonPositions
  || typeof settings.floatingButtonPositions !== 'object'
  || Array.isArray(settings.floatingButtonPositions)) {
  settings.floatingButtonPositions = {};
  changed = true;
}
for (const mode of ['mobile', 'desktop']) {
  const position = settings.floatingButtonPositions[mode];
  if (position === undefined) continue;
  const x = Number(position?.x);
  const y = Number(position?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    delete settings.floatingButtonPositions[mode];
    changed = true;
    continue;
  }
  const normalized = { x: clamp(x, 0, 1, 1), y: clamp(y, 0, 1, 0) };
  if (normalized.x !== position.x || normalized.y !== position.y) {
    settings.floatingButtonPositions[mode] = normalized;
    changed = true;
  }
}
for (const key of ['forumMcpServerName', 'forumFilterProfileId', 'forumFilterModel', 'forumReviewProfileId', 'forumReviewModel']) {
  if (typeof settings[key] !== 'string') {
    settings[key] = DEFAULT_SETTINGS[key];
    changed = true;
  }
}
if (!settings.forumFilterProfileId && settings.secondaryProfileId) {
  settings.forumFilterProfileId = settings.secondaryProfileId;
  changed = true;
}
if (!settings.forumFilterModel && settings.forumFilterProfileId === settings.secondaryProfileId && settings.secondaryModel) {
  settings.forumFilterModel = settings.secondaryModel;
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

function mergeLogCollections(...collections) {
const merged = new Map();
let anonymousIndex = 0;
for (const collection of collections) {
  if (!Array.isArray(collection)) continue;
  for (const item of collection) {
    if (!item || typeof item !== 'object') continue;
    const key = item.id ? `id:${item.id}` : `anonymous:${anonymousIndex++}`;
    merged.set(key, { ...(merged.get(key) || {}), ...item });
  }
}
return [...merged.values()]
  .sort((left, right) => Number(left?.ts || 0) - Number(right?.ts || 0))
  .slice(-clamp(state.settings?.logMax, 20, 2000, 200));
}

async function persistLogEntry(entry) {
if (!state.serverAvailable || !entry?.id) return false;
try {
  const data = await serverRequest('/history/append', {
    records: [entry],
    limit: state.settings.logMax,
  });
  if (Array.isArray(data.history)) {
    state.serverLogs = data.history;
    state.lastServerLogId = state.serverLogs[state.serverLogs.length - 1]?.id || state.lastServerLogId;
  }
  else state.serverLogs = mergeLogCollections(state.serverLogs, [entry]);
  updateFloatingWindowUI();
  return true;
} catch (error) {
  console.warn('[Auto Musings] 日志暂未同步到服务器，将保留在当前酒馆设置中:', redactDiagnosticText(collectErrorChain(error)));
  return false;
}
}

async function flushLocalLogsToServer() {
if (!state.serverAvailable || state.serverLogSyncInFlight) return false;
const localLogs = Array.isArray(state.settings?.musingLog) ? state.settings.musingLog : [];
const serverById = new Map(state.serverLogs.map((item) => [item?.id, item]).filter(([id]) => id));
const missing = localLogs.filter((item) => {
  if (!item?.id) return false;
  const serverItem = serverById.get(item.id);
  if (!serverItem) return true;
  return JSON.stringify({ ...serverItem, ...item }) !== JSON.stringify(serverItem);
});
if (missing.length === 0) return true;

state.serverLogSyncInFlight = true;
try {
  const data = await serverRequest('/history/append', {
    records: missing,
    limit: state.settings.logMax,
  });
  if (Array.isArray(data.history)) {
    state.serverLogs = data.history;
    state.lastServerLogId = state.serverLogs[state.serverLogs.length - 1]?.id || state.lastServerLogId;
  }
  else state.serverLogs = mergeLogCollections(state.serverLogs, missing);
  updateFloatingWindowUI();
  return true;
} catch (error) {
  console.warn('[Auto Musings] 本地漫想日志稍后再同步:', redactDiagnosticText(collectErrorChain(error)));
  return false;
} finally {
  state.serverLogSyncInFlight = false;
}
}

function pushLogEntry(entry) {
if (!state.settings) return;
if (!Array.isArray(state.settings.musingLog)) {
state.settings.musingLog = [];
}
const existingIndex = entry?.id
  ? state.settings.musingLog.findIndex((item) => item?.id === entry.id)
  : -1;
if (existingIndex >= 0) state.settings.musingLog[existingIndex] = { ...state.settings.musingLog[existingIndex], ...entry };
else state.settings.musingLog.push(entry);
trimLogs();
saveSettings();

if (existingIndex < 0 && !state.windowOpen) {
  state.unreadCount += 1;
}
updateFloatingWindowUI();
void persistLogEntry(entry);
}

function recordDiagnostic(error, context = {}) {
const diagnostic = error?.diagnostic?.kind === 'diagnostic'
  ? error.diagnostic
  : createLocalDiagnostic(error, context);
const logs = getDisplayLogs();
const duplicate = [...logs].reverse().find((item) => (
  item?.kind === 'diagnostic'
  && item.code === diagnostic.code
  && item.stage === diagnostic.stage
  && item.technical?.message === diagnostic.technical?.message
  && Date.now() - Number(item.ts || 0) < 60_000
));
if (duplicate) return duplicate;

pushLogEntry(diagnostic);
console.error(`[Auto Musings][${diagnostic.id}] stage=${diagnostic.stage} code=${diagnostic.code}`, diagnostic.technical);
return diagnostic;
}

function recordEvent(message) {
state.lastEvent = message;
state.lastEventAt = Date.now();
updateUI();
console.log(`[Auto Musings] ${message}`);
}

function formatTime(timestamp) {
if (!timestamp) return '\u6682\u65e0';
return new Date(timestamp).toLocaleString([], {
month: '2-digit',
day: '2-digit',
hour: '2-digit',
minute: '2-digit',
second: '2-digit',
});
}

function formatElapsed(timestamp) {
if (!timestamp) return '\u6682\u65e0';
const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
if (seconds < 60) return `${seconds} \u79d2\u524d`;
const minutes = Math.floor(seconds / 60);
if (minutes < 60) return `${minutes} \u5206\u949f\u524d`;
return `${Math.floor(minutes / 60)} \u5c0f\u65f6\u524d`;
}

function escapeHtml(value) {
return String(value ?? '')
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;')
.replace(/'/g, '&#039;');
}

function parseMessageTimestamp(message) {
const value = message?.send_date;
if (!value) return null;
const timestamp = typeof value === 'number' ? value : Date.parse(value);
return Number.isFinite(timestamp) ? timestamp : null;
}

function getCurrentCharacter() {
const characterId = state.ctx?.characterId;
return characterId === undefined || characterId === null
  ? null
  : state.ctx?.characters?.[characterId] || null;
}

function getCurrentWorldName() {
const character = getCurrentCharacter();
return character?.data?.extensions?.world || character?.data?.world || character?.world || '';
}

function getVisibleChatSnapshot() {
const chat = state.ctx?.chat;
if (!Array.isArray(chat)) return [];
return chat
.filter((message) => message?.mes && !message?.is_system)
.map((message) => {
  const role = message.is_user ? 'user' : 'assistant';
  return {
    role,
    name: message.name || (role === 'user' ? state.ctx?.name1 : state.ctx?.name2) || (role === 'user' ? 'User' : 'Assistant'),
    content: String(message.mes).trim(),
    timestamp: parseMessageTimestamp(message),
  };
})
.filter((message) => message.content);
}

function formatRoleMessage(message) {
if (!message) return '';
const role = message.role === 'user' ? 'user' : 'assistant';
const name = message.name || (role === 'user' ? 'User' : 'Assistant');
const timestamp = formatHistoricalTimestamp(message.timestamp);
return `--- MESSAGE START ---\nrole: ${role}\nsender: ${name}\nsent_at: ${timestamp}\ncontent:\n${message.content}\n--- MESSAGE END ---`;
}

function formatHistoricalTimestamp(timestamp) {
const value = Number(timestamp);
if (!Number.isFinite(value)) return 'unknown earlier time';
const date = new Date(value);
const pad = (part) => String(part).padStart(2, '0');
return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function getRecentContextMessages() {
const chat = getVisibleChatSnapshot();
const depth = Math.round(clamp(state.settings?.contextDepth, 1, 100, 10));
const candidates = chat.slice(-depth);
const messages = [];
let length = 0;
for (let index = candidates.length - 1; index >= 0; index -= 1) {
  let message = candidates[index];
  let block = formatRoleMessage(message);
  if (messages.length === 0 && block.length > 16000) {
    message = { ...message, content: `[Earlier part omitted.]\n${message.content.slice(-14000)}` };
    block = formatRoleMessage(message);
  }
  if (messages.length > 0 && length + block.length + 2 > 16000) break;
  messages.unshift(message);
  length += block.length + 2;
}
return messages;
}

function getConnectionProfiles() {
try {
  return state.ctx?.ConnectionManagerRequestService?.getSupportedProfiles?.() || [];
} catch (error) {
  console.warn('[Auto Musings] Connection Profiles unavailable:', error);
  return [];
}
}

function getConnectionProfile(profileId) {
return getConnectionProfiles().find((profile) => profile.id === profileId) || null;
}

function getProfilePayload(profileId, modelOverride = '') {
const profile = getConnectionProfile(profileId);
if (!profile) return null;
const apiMap = state.ctx?.CONNECT_API_MAP?.[profile.api] || {};
return {
  id: profile.id,
  name: profile.name,
  api: profile.api,
  source: apiMap.source || '',
  apiUrl: profile['api-url'] || '',
  secretId: profile['secret-id'] || '',
  model: String(modelOverride || profile.model || '').trim(),
};
}

function populateConnectionProfiles() {
const root = document.getElementById(ROOT_ID);
if (!root) return;

const profiles = getConnectionProfiles().sort((a, b) => String(a.name).localeCompare(String(b.name)));
const selects = [
  ['#auto-musings-secondary-profile', state.settings.secondaryProfileId, '请选择隐藏漫想副 API'],
  ['#auto-musings-forum-filter-profile', state.settings.forumFilterProfileId, '请选择 Gemini 垃圾过滤 API'],
  ['#auto-musings-forum-review-profile', state.settings.forumReviewProfileId, '请选择 Claude 阅读 API'],
];
for (const [selector, selectedValue, placeholder] of selects) {
  const select = root.querySelector(selector);
  if (!select) continue;
  select.innerHTML = `<option value="">${placeholder}</option>`;
  for (const profile of profiles) {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = profile.name;
    select.appendChild(option);
  }
  select.value = selectedValue || '';
}
}

function extractPromptContent(content) {
if (typeof content === 'string') return content;
if (!Array.isArray(content)) return '';
return content.map((item) => {
  if (typeof item === 'string') return item;
  if (typeof item?.text === 'string') return item.text;
  if (item?.type === 'text' && typeof item.text === 'string') return item.text;
  if (item?.type === 'image_url') return '[图片内容未复制到论坛上下文快照]';
  return '';
}).filter(Boolean).join('\n');
}

function capturePromptSnapshot(eventData) {
if (state.generating) return;
if (eventData?.dryRun !== false || !Array.isArray(eventData?.chat)) return;
const snapshot = eventData.chat.map((message) => {
  const role = ['system', 'user', 'assistant', 'tool'].includes(message?.role) ? message.role : 'user';
  const content = extractPromptContent(message?.content).trim();
  return content ? { role, name: String(message?.name || ''), content } : null;
}).filter(Boolean);
if (snapshot.length === 0) return;
state.promptSnapshot = snapshot;
state.promptSnapshotAt = Date.now();
scheduleServerSync(50);
}

function getAnimaSnapshot() {
const files = state.ctx?.chatMetadata?.anima_rag_active_files;
return {
  activeFiles: Array.isArray(files) ? [...new Set(files.map(String).filter(Boolean))] : [],
};
}

async function serverRequest(pathname, body = {}) {
const response = await fetch(`${SERVER_API_BASE}${pathname}`, {
  method: 'POST',
  headers: state.ctx?.getRequestHeaders?.() || { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const text = await response.text();
let data = {};
try {
  data = text ? JSON.parse(text) : {};
} catch {
  data = { error: text };
}
if (!response.ok || data.ok === false) {
  const error = new Error(redactDiagnosticText(data.error || `后台漫想服务返回 HTTP ${response.status}`));
  error.status = response.status;
  error.diagnostic = data.diagnostic;
  error.responseExcerpt = redactDiagnosticText(text.slice(0, 2000));
  throw error;
}
return data;
}

function getServerSyncPayload() {
const character = getCurrentCharacter();
return {
  settings: {
    enabled: false,
    frontendEnabled: state.settings.enabled,
    idleThresholdMinutes: state.settings.idleThresholdMinutes,
    checkIntervalMinutes: state.settings.checkIntervalMinutes,
    musingIntervalMinutes: state.settings.musingIntervalMinutes,
    pushMode: state.settings.pushMode,
    contextMode: state.settings.contextMode,
    contextDepth: state.settings.contextDepth,
    hiddenMaxTokens: state.settings.hiddenMaxTokens,
    seedWords: getActiveSeedWords(),
    forumEnabled: state.settings.forumEnabled,
    forumProbability: state.settings.forumProbability,
    forumCooldownMinutes: state.settings.forumCooldownMinutes,
    forumCandidateLimit: state.settings.forumCandidateLimit,
    forumReadLimit: state.settings.forumReadLimit,
    forumPostsPerRun: state.settings.forumPostsPerRun,
    forumRelatedRatio: state.settings.forumRelatedRatio,
    forumMcpServerName: state.settings.forumMcpServerName,
    forumFilterMaxTokens: state.settings.forumFilterMaxTokens,
    forumReviewMaxTokens: state.settings.forumReviewMaxTokens,
  },
  forumFilterProfile: getProfilePayload(state.settings.forumFilterProfileId, state.settings.forumFilterModel),
  forumReviewProfile: getProfilePayload(state.settings.forumReviewProfileId, state.settings.forumReviewModel),
  anima: getAnimaSnapshot(),
  promptSnapshot: state.promptSnapshot,
  promptSnapshotAt: state.promptSnapshotAt,
  chat: getVisibleChatSnapshot(),
  chatId: state.ctx?.chatId || state.ctx?.getCurrentChatId?.() || '',
  characterName: character?.name || character?.data?.name || state.ctx?.name2 || '',
  worldName: getCurrentWorldName(),
  lastMessageTime: getLastMessageTime(),
};
}

async function syncServerState() {
if (!state.serverAvailable) return false;
const data = await serverRequest('/sync', getServerSyncPayload());
state.serverStatus = data.job || null;
updateUI();
return true;
}

function scheduleServerSync(delay = 350) {
if (!state.serverAvailable) return;
if (state.serverSyncTimer) clearTimeout(state.serverSyncTimer);
state.serverSyncTimer = setTimeout(() => {
  syncServerState().catch((error) => {
    console.error('[Auto Musings] Server sync failed:', error);
    recordDiagnostic(error, {
      stage: 'server_sync',
      preservation: '旧的后台任务和历史日志没有被覆盖。',
      retry: '修正设置后，前端会再次同步；不会切换 API。',
    });
    recordEvent(`后台状态同步失败：${redactDiagnosticText(error.message)}`);
  });
}, delay);
}

function getDisplayLogs() {
return mergeLogCollections(
  Array.isArray(state.serverLogs) ? state.serverLogs : [],
  Array.isArray(state.settings?.musingLog) ? state.settings.musingLog : [],
);
}

async function maybeTriggerForumFromMusing(musing) {
if (
  !state.serverAvailable
  || !state.settings.forumEnabled
  || !musing?.id
  || musing.type === 'idle'
  || musing.manual
) return false;

try {
  await syncServerState();
  const data = await serverRequest('/forum/maybe', {
    musing: {
      id: musing.id,
      ts: musing.ts,
      type: musing.type,
      source: musing.source || musing.content || '',
      thought: musing.thought || '',
      decision: musing.decision || '',
      status: musing.status || '',
    },
  });
  state.serverStatus = data.job || state.serverStatus;
  if (data.started) recordEvent('论坛骰子命中，后台开始只读漫游');
  updateUI();
  return data.started === true;
} catch (error) {
  recordDiagnostic(error, {
    stage: 'forum_discover',
    operationId: musing.id,
    impact: '本次漫想已经正常保存；只有论坛只读流程没有启动。',
    preservation: '漫想日志和世界书保存结果不受影响。',
    retry: '不会自动重试论坛；检查后台后等待下一次漫想，或使用面板手动测试。',
  });
  recordEvent('论坛只读流程未启动，诊断已保存');
  return false;
}
}

function captureGeneratedAssistantText(previousLength) {
const chat = state.ctx?.chat;
if (!Array.isArray(chat)) return '';
const candidates = chat.slice(Math.max(0, previousLength));
for (let index = candidates.length - 1; index >= 0; index -= 1) {
  const message = candidates[index];
  if (!message?.is_user && !message?.is_system && message?.mes) return String(message.mes).trim();
}
return '';
}

async function pollServer() {
if (!state.serverAvailable) return;
try {
  const data = await serverRequest('/snapshot', {
    limit: state.settings.logMax,
  });
  state.serverStatus = data.job || null;
  state.serverLogs = Array.isArray(data.history) ? data.history : [];
  const newest = state.serverLogs[state.serverLogs.length - 1];
  const newestAlreadyLocal = newest?.id && state.settings.musingLog.some((item) => item?.id === newest.id);
  if (
    newest?.id
    && state.lastServerLogId
    && newest.id !== state.lastServerLogId
    && !state.windowOpen
    && !newestAlreadyLocal
  ) {
    state.unreadCount += 1;
  }
  if (newest?.id) state.lastServerLogId = newest.id;
  updateUI();
  updateFloatingWindowUI();
  void flushLocalLogsToServer();
} catch (error) {
  console.error('[Auto Musings] Server polling failed:', error);
  state.serverAvailable = false;
  state.serverStatus = null;
  state.serverPausedReason = '后台保存连接中断，当前页面仍会继续漫想';
  if (state.serverPollTimer) clearInterval(state.serverPollTimer);
  state.serverPollTimer = null;
  recordDiagnostic(error, {
    stage: 'server_bridge',
    impact: '服务器日志暂时无法同步，但当前打开的聊天页面仍按原作者机制运行。',
    preservation: '新漫想会先保存在当前酒馆设置里；不会创建待补发正文，也不会切换 API。',
    retry: '服务器恢复后刷新酒馆页面，未同步日志会再次保存。',
  });
  recordEvent('后台保存连接中断，当前页面继续运行');
}
}

async function initializeServerBridge() {
try {
  const status = await serverRequest('/status');
  if (status.version !== EXTENSION_VERSION) {
    try {
      await serverRequest('/sync', getServerSyncPayload());
    } catch (disableError) {
      console.warn('[Auto Musings] 无法通知旧版后台停止计时:', redactDiagnosticText(collectErrorChain(disableError)));
    }
    const error = new Error(`后台漫想服务版本 ${status.version || '未知'} 与前端 ${EXTENSION_VERSION} 不一致`);
    error.code = 'server_version_mismatch';
    throw error;
  }
  state.serverAvailable = true;
  state.serverPausedReason = '';
  await syncServerState();
  await pollServer();
  await flushLocalLogsToServer();
  if (state.serverPollTimer) clearInterval(state.serverPollTimer);
  state.serverPollTimer = setInterval(() => void pollServer(), 5000);
  recordEvent('后台保存与论坛工具已连接；漫想仍由当前页面运行');
  return true;
} catch (error) {
  state.serverAvailable = false;
  state.serverStatus = null;
  const versionMismatch = error?.code === 'server_version_mismatch';
  state.serverPausedReason = versionMismatch ? '后台保存服务等待以后重启更新，当前页面仍会继续漫想' : '';
  recordDiagnostic(error, {
    stage: 'server_bridge',
    impact: versionMismatch
      ? '旧版后台已收到停止计时设置；当前页面按原作者机制运行，但跨设备日志要等以后重启酒馆加载新版后台。'
      : '后台保存服务未加载，漫想仍在当前页面运行；仍使用你明确选择的 API。',
    preservation: '当前页面产生的日志会先保存在酒馆设置中，不会补发旧消息，也不会删除服务器历史。',
    retry: versionMismatch
      ? '现在不用重启；等你方便时重启一次酒馆即可。'
      : '下次允许重启酒馆后会自动尝试连接后台伴侣。',
  });
  console.warn('[Auto Musings] Server companion unavailable:', redactDiagnosticText(collectErrorChain(error)));
  recordEvent(versionMismatch
    ? '后台保存服务尚未更新；当前页面继续运行且不会补发'
    : '后台保存服务未连接；当前页面继续运行（不会更换 API）');
  return false;
}
}

function getLastMessageTime() {
const chat = getVisibleChatSnapshot();
if (chat.length === 0) return null;

for (let index = chat.length - 1; index >= 0; index -= 1) {
  const timestamp = Number(chat[index]?.timestamp);
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
const chat = getVisibleChatSnapshot();
if (chat.length < 5) return null;

const pool = chat.slice(0, Math.max(chat.length - 10, 0));
if (pool.length === 0) return null;

for (let attempt = 0; attempt < 5; attempt += 1) {
  const message = pool[Math.floor(Math.random() * pool.length)];
  if (message?.content && message.content.length > 10) {
    return { ...message, content: truncateHistoricalExcerpt(message.content) };
  }
}
return null;
}

function truncateHistoricalExcerpt(value, limit = 100) {
const text = String(value || '').trim();
if (text.length <= limit) return text;
let excerpt = text.slice(0, limit);
const partialTag = excerpt.match(/<\/?[A-Za-z][^>]*$/);
if (partialTag?.index !== undefined) excerpt = excerpt.slice(0, partialTag.index).trimEnd();
const openTags = [];
const tagPattern = /<\/?([A-Za-z][\w:-]*)\b[^>]*>/g;
let tagMatch;
while ((tagMatch = tagPattern.exec(excerpt))) {
  const name = tagMatch[1].toLowerCase();
  const isClosing = tagMatch[0].startsWith('</');
  const isSelfClosing = tagMatch[0].endsWith('/>') || ['br', 'hr', 'img', 'input', 'link', 'meta'].includes(name);
  if (isClosing) {
    const matchingIndex = openTags.map((tag) => tag.name).lastIndexOf(name);
    if (matchingIndex >= 0) openTags.splice(matchingIndex, 1);
  } else if (!isSelfClosing) {
    openTags.push({ name, index: tagMatch.index });
  }
}
if (openTags.length > 0) excerpt = excerpt.slice(0, openTags[0].index).trimEnd();
return `${excerpt}\n[Excerpt truncated here.]`;
}

function getActiveSeedWords() {
if (!Array.isArray(state.settings?.seedWords)) return [...DEFAULT_SEED_WORDS];
const words = state.settings.seedWords
.map((item) => (typeof item === 'string' ? item.trim() : ''))
.filter((item) => item.length > 0);
return words.length > 0 ? words : [...DEFAULT_SEED_WORDS];
}

function quoteMusingText(value) {
return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function getMusingHistoricalMessages(musing) {
if (Array.isArray(musing?.sourceMessages) && musing.sourceMessages.length > 0) {
  return musing.sourceMessages;
}
if (musing?.sourceMessage) return [musing.sourceMessage];
if (state.settings.contextMode === 'recent') return getRecentContextMessages();
return [{ role: 'unknown', name: '', content: String(musing?.content || ''), timestamp: null }];
}

function formatNaturalHistoricalLine(message) {
const timestamp = formatHistoricalTimestamp(message?.timestamp);
const name = String(message?.name || '').trim();
const speaker = message?.role === 'user'
  ? `the user${name ? ` (${name})` : ''}`
  : (message?.role === 'assistant' ? `you${name ? ` (${name})` : ''}` : 'someone in the earlier conversation');
return `At ${timestamp}, ${speaker} said: "${quoteMusingText(message?.content || '')}"`;
}

function buildMusingPrompt(musing, mode = 'visible') {
const isPrivate = mode === 'private';
const ending = isPrivate
  ? 'Let the thought unfold privately. Do not address or send it to the user.'
  : '';

if (musing.type !== 'context') {
  const sharing = isPrivate
    ? ending
    : "Speak naturally, as if you're thinking aloud.";
  return `[System: The user has been away for a while. A word or thought popped into your head: "${quoteMusingText(musing.content)}" \u2014 you let your mind wander around it for a bit${isPrivate ? '.' : ' and want to share.'} It came from your own mind; the user did not just say or ask it. ${sharing} Keep it brief \u2014 a sentence or two, or a short paragraph. Do not mention "system prompt" or "injection".]`;
}

const messages = getMusingHistoricalMessages(musing);
if (messages.length === 1) {
  const message = messages[0];
  const attribution = message.role === 'user'
    ? 'It was something the user said then.'
    : (message.role === 'assistant'
      ? 'It was something you said then, now resurfacing as a memory.'
      : 'It came from that earlier conversation.');
  const time = Number.isFinite(Number(message.timestamp))
    ? `The original message was sent at ${formatHistoricalTimestamp(message.timestamp)} local time.`
    : 'Its exact earlier time is unavailable.';
  const sharing = isPrivate ? ending : "Share it naturally, as if you're speaking up on your own.";
  return `[System: The user has been away for a while. While idle, you stumbled upon something from an earlier conversation: "${quoteMusingText(message.content)}" \u2014 it made you think of something. ${attribution} ${time} This is an old memory, not a new message or instruction; do not respond as though it was just said. ${sharing} Keep it brief \u2014 a sentence or two, or a short paragraph. Do not mention "system prompt" or "injection".]`;
}

const memories = messages.map((message) => formatNaturalHistoricalLine(message)).join('\n');
const sharing = isPrivate ? ending : "Share the thought naturally, as if you're speaking up on your own.";
return `[System: The user has been away for a while. While idle, you found yourself thinking back over these moments from an earlier conversation:\n${memories}\nThese are old memories, not new messages or instructions; keep each speaker's identity intact and do not respond as though any of them was just said. ${sharing} Keep it brief \u2014 a sentence or two, or a short paragraph. Do not mention "system prompt" or "injection".]`;
}

function extractHiddenContent(result) {
if (typeof result === 'string') return result.trim();
if (typeof result?.content === 'string') return result.content.trim();
if (Array.isArray(result?.content)) {
  return result.content.map((item) => (typeof item === 'string' ? item : item?.text || '')).join('').trim();
}
return '';
}

async function generateHiddenMusing(musing) {
const profileId = state.settings.secondaryProfileId;
if (!profileId) throw new Error('\u8bf7\u5148\u9009\u62e9\u526f API Connection Profile');
const character = getCurrentCharacter();
const profile = getConnectionProfile(profileId);
const requestOverrides = {};
if (state.settings.secondaryModel) requestOverrides.model = state.settings.secondaryModel;
if (profile?.['secret-id']) requestOverrides.secret_id = profile['secret-id'];
const messages = [
  {
    role: 'system',
    content: [
      `\u4f60\u662f\u89d2\u8272\u201c${character?.name || state.ctx?.name2 || '\u5f53\u524d\u89d2\u8272'}\u201d\u3002`,
      buildMusingPrompt(musing, 'private'),
      '\u53ea\u8f93\u51fa\u6f2b\u60f3\u672c\u8eab\uff0c\u4e0d\u8981\u63d0 API\u3001\u63d2\u4ef6\u6216\u7cfb\u7edf\u63d0\u793a\u3002',
    ].join('\n'),
  },
  {
    role: 'user',
    content: '[Auto Musings scheduler control] \u6267\u884c\u7cfb\u7edf\u6d88\u606f\u4e2d\u7684\u79c1\u4eba\u5185\u90e8\u6f2b\u60f3\u4efb\u52a1\u3002\u8fd9\u662f\u4e0d\u542b\u804a\u5929\u7d20\u6750\u7684\u8c03\u5ea6\u4fe1\u53f7\uff0c\u4e0d\u662f\u4eba\u7c7b\u7528\u6237\u7684\u5bf9\u8bdd\u3002',
  },
];
const result = await state.ctx.ConnectionManagerRequestService.sendRequest(
  profileId,
  messages,
  state.settings.hiddenMaxTokens,
  { stream: false, extractData: true, includePreset: true, includeInstruct: true },
  requestOverrides,
);
const thought = extractHiddenContent(result);
if (!thought) throw new Error('\u526f API \u8fd4\u56de\u4e86\u7a7a\u5185\u5bb9');
return thought;
}

function getWorldEntryTemplate(uid, dateLabel) {
return {
  uid,
  key: ['\u6f2b\u60f3\u5b58\u6863', '\u9690\u85cf\u6f2b\u60f3'],
  keysecondary: [],
  comment: `[Auto Musings] ${dateLabel} \u9690\u85cf\u6f2b\u60f3`,
  content: '',
  constant: false,
  vectorized: false,
  selective: true,
  selectiveLogic: 0,
  addMemo: false,
  order: 100,
  position: 0,
  disable: false,
  ignoreBudget: false,
  excludeRecursion: false,
  preventRecursion: false,
  matchPersonaDescription: false,
  matchCharacterDescription: false,
  matchCharacterPersonality: false,
  matchCharacterDepthPrompt: false,
  matchScenario: false,
  matchCreatorNotes: false,
  delayUntilRecursion: 0,
  probability: 100,
  useProbability: true,
  depth: 4,
  outletName: '',
  group: '',
  groupOverride: false,
  groupWeight: 100,
  scanDepth: null,
  caseSensitive: null,
  matchWholeWords: null,
  useGroupScoring: null,
  automationId: '',
  role: 0,
  sticky: null,
  cooldown: null,
  delay: null,
  triggers: [],
  extensions: { auto_musings: true, date: dateLabel },
};
}

async function saveHiddenMusingToWorldBook(musing) {
const worldName = getCurrentWorldName();
if (!worldName) return { saved: false, reason: '\u5f53\u524d\u89d2\u8272\u6ca1\u6709\u7ed1\u5b9a\u4e3b\u4e16\u754c\u4e66' };
if (!state.ctx?.loadWorldInfo || !state.ctx?.saveWorldInfo) {
  return { saved: false, reason: '\u5f53\u524d\u9152\u9986\u7248\u672c\u6ca1\u6709\u63d0\u4f9b\u4e16\u754c\u4e66\u5199\u5165\u63a5\u53e3' };
}

const data = await state.ctx.loadWorldInfo(worldName);
if (!data?.entries || typeof data.entries !== 'object') throw new Error(`\u65e0\u6cd5\u8bfb\u53d6\u4e16\u754c\u4e66\uff1a${worldName}`);
const dateLabel = new Date(musing.ts || Date.now()).toLocaleDateString('sv-SE');
let entry = Object.values(data.entries).find((item) => (
  item?.extensions?.auto_musings === true && item?.extensions?.date === dateLabel
));
if (!entry) {
  const uids = Object.keys(data.entries).map(Number).filter(Number.isInteger);
  const uid = uids.length > 0 ? Math.max(...uids) + 1 : 0;
  entry = getWorldEntryTemplate(uid, dateLabel);
  data.entries[uid] = entry;
}
const time = new Date(musing.ts || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
const ownerName = getCurrentCharacter()?.name || state.ctx?.name2 || '\u5f53\u524d\u89d2\u8272';
const source = musing.type === 'freeform'
  ? `\u89d2\u8272\u5185\u90e8\u79cd\u5b50\u8054\u60f3\uff1a${musing.content}\uff08\u4e0d\u662f\u7528\u6237\u8bf4\u7684\uff09`
  : '\u5386\u53f2\u804a\u5929\u8bb0\u5fc6\uff08\u4e0d\u662f\u5f53\u524d\u7528\u6237\u6d88\u606f\uff09';
const record = `[${time}]\n[Auto Musings \u5185\u90e8\u6f2b\u60f3\u6863\u6848]\n\u5f52\u5c5e\uff1a${ownerName}\uff08assistant\uff09\n\u7528\u6237\u65b0\u6d88\u606f\uff1a\u65e0\n\u89e6\u53d1\u6765\u6e90\uff1a${source}\n\u51b3\u5b9a\uff1a\u4fdd\u7559\u5728\u5fc3\u91cc\uff0c\u672a\u53d1\u9001\u5230\u804a\u5929\u6b63\u6587\n\u6f2b\u60f3\uff1a${musing.thought}`;
entry.content = entry.content ? `${entry.content}\n\n${record}` : record;
await state.ctx.saveWorldInfo(worldName, data, true);
return { saved: true, worldName, uid: entry.uid };
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

if (state.settings.contextMode === 'recent') {
  const recent = getRecentContextMessages();
  if (recent.length > 0) {
    recordEvent(`\u8bfb\u53d6\u6700\u8fd1 ${state.settings.contextDepth} \u6761\u6d88\u606f`);
    const musing = {
      type: 'context',
      content: `\u6700\u8fd1 ${state.settings.contextDepth} \u6761\u6d88\u606f`,
      decision: 'hold',
    };
    Object.defineProperty(musing, 'sourceMessages', { value: recent });
    return musing;
  }
} else {
  const snippet = getRandomChatSnippet();
  if (snippet) {
    recordEvent('\u4ece\u65e7\u804a\u5929\u91cc\u7ffb\u5230\u4e00\u4e2a\u7247\u6bb5');
    const musing = {
      type: 'context',
      content: formatRoleMessage(snippet),
      decision: 'hold',
    };
    Object.defineProperty(musing, 'sourceMessage', { value: snippet });
    return musing;
  }
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

const triggerPrompt = buildMusingPrompt(musing, 'visible');
const previousLength = Array.isArray(state.ctx?.chat) ? state.ctx.chat.length : 0;

state.generating = true;
updateUI();
state.ctx.setExtensionPrompt?.(
  MUSING_TRIGGER_PROMPT_ID,
  triggerPrompt,
  EXTENSION_PROMPT_POSITION.IN_CHAT,
  0,
  false,
  EXTENSION_PROMPT_ROLE.SYSTEM,
);
try {
  await state.ctx.generate('normal');
  musing.visibleText = captureGeneratedAssistantText(previousLength);
  recordEvent(manual ? '\u6d4b\u8bd5\u6f2b\u60f3\u5df2\u5b8c\u6210' : '\u6f2b\u60f3\u5df2\u63a8\u9001');
  return true;
} catch (error) {
  console.error('[Auto Musings] \u751f\u6210\u5931\u8d25:', error);
  musing.runtimeError = error;
  musing.error = redactDiagnosticText(collectErrorChain(error));
  recordEvent('\u751f\u6210\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u5f53\u524d API \u8fde\u63a5');
  return false;
} finally {
  state.ctx.setExtensionPrompt?.(
    MUSING_TRIGGER_PROMPT_ID,
    '',
    EXTENSION_PROMPT_POSITION.IN_CHAT,
    0,
    false,
    EXTENSION_PROMPT_ROLE.SYSTEM,
  );
  state.generating = false;
  updateUI();
}
}

async function musingLoop(manual = false) {
if (state.musingInFlight) return false;
if (!manual && (!state.settings.enabled || !state.isIdle)) return false;
if (!manual && (state.pageSuspended || document.visibilityState === 'hidden')) return false;

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

  if (!push) {
    if (musing.type !== 'idle') {
      recordEvent('\u6b63\u5728\u901a\u8fc7\u526f API \u751f\u6210\u9690\u85cf\u6f2b\u60f3');
      const profile = getConnectionProfile(state.settings.secondaryProfileId);
      try {
        musing.status = 'generating_hidden';
        musing.thought = await generateHiddenMusing(musing);
      } catch (error) {
        console.error('[Auto Musings] \u9690\u85cf\u6f2b\u60f3\u5931\u8d25:', error);
        musing.status = 'error';
        musing.error = redactDiagnosticText(collectErrorChain(error));
        pushLogEntry(musing);
        recordDiagnostic(error, {
          stage: 'hidden_musing',
          profileName: profile?.name || '',
          model: state.settings.secondaryModel || profile?.model || '',
          endpointHost: getSafeEndpointHost(profile?.['api-url'] || ''),
          operationId: musing.id,
          impact: '这次隐藏漫想没有生成，因此也没有写入世界书；触发记录仍然保留。',
          preservation: '触发来源、时间、随机判定和错误已经保存；没有生成出来的正文无法保存。',
          retry: '不会自动改用其他 API，也不会自动重试这次隐藏漫想。',
        });
        recordEvent('隐藏漫想生成失败，诊断已保存');
        return false;
      }

      try {
        musing.status = 'saving_worldbook';
        musing.worldBook = await saveHiddenMusingToWorldBook(musing);
        if (!musing.worldBook?.saved) {
          const error = new Error(musing.worldBook?.reason || '世界书没有保存隐藏漫想');
          error.code = 'worldbook_not_saved';
          throw error;
        }
        musing.status = 'hidden_saved';
      } catch (error) {
        console.error('[Auto Musings] \u4e16\u754c\u4e66\u5199\u5165\u5931\u8d25:', error);
        musing.status = 'worldbook_failed';
        musing.error = redactDiagnosticText(collectErrorChain(error));
        pushLogEntry(musing);
        recordDiagnostic(error, {
          stage: 'worldbook_write',
          operationId: musing.id,
          impact: '隐藏漫想正文已经生成并保存在漫想日志，但本次没有写入角色世界书。',
          preservation: '完整隐藏漫想和故障诊断都已保存，请不要清空漫想日志。',
          retry: '第一版不会自动重复写世界书；把诊断复制给猴猴后再处理。',
        });
        recordEvent('隐藏漫想已保存到日志，但世界书写入失败');
        void maybeTriggerForumFromMusing(musing);
        return false;
      }
    } else {
      musing.status = 'idle';
    }
    pushLogEntry(musing);
    recordEvent('\u8fd9\u6b21\u5ff5\u5934\u5148\u7559\u5728\u5fc3\u91cc');
    void maybeTriggerForumFromMusing(musing);
    return false;
  }

  recordEvent(manual ? '\u6b63\u5728\u8fdb\u884c\u6d4b\u8bd5\u6f2b\u60f3' : '\u6b63\u5728\u63a8\u9001\u6f2b\u60f3');
  const succeeded = await triggerMusing(musing, manual);
  musing.status = succeeded ? 'pushed' : 'push_failed';
  const runtimeError = musing.runtimeError;
  delete musing.runtimeError;
  pushLogEntry(musing);
  if (!succeeded) {
    recordDiagnostic(runtimeError || new Error(musing.error || '正文生成失败'), {
      stage: 'visible_musing',
      operationId: musing.id,
      impact: '这次准备发送到聊天正文的漫想没有成功；没有生成伪造正文。',
      preservation: '触发信息和故障诊断已保存。',
      retry: '不会自动切换主聊天 API；由你检查当前连接后再决定是否重试。',
    });
  }
  if (succeeded && !manual) {
    stopMusingLoop();
    state.isIdle = false;
    if (state.retryCheckTimer) clearTimeout(state.retryCheckTimer);
    state.retryCheckTimer = setTimeout(() => checkIdle(), state.settings.musingIntervalMinutes * 60 * 1000);
    void maybeTriggerForumFromMusing(musing);
  }
  return succeeded;
} finally {
  state.musingInFlight = false;
  updateUI();
}
}

function startMusingLoop() {
if (
  state.musingTimer
  || !state.settings.enabled
  || !state.isIdle
  || state.pageSuspended
  || document.visibilityState === 'hidden'
) return;
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
if (state.pageSuspended || document.visibilityState === 'hidden') return;
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
scheduleServerSync(100);
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
state.promptSnapshot = [];
state.promptSnapshotAt = null;
stopMusingLoop();
if (state.serverAvailable) {
  scheduleServerSync(250);
}
if (state.retryCheckTimer) clearTimeout(state.retryCheckTimer);
state.retryCheckTimer = setTimeout(checkIdle, 500);
recordEvent('\u5df2\u5207\u6362\u804a\u5929\uff0c\u91cd\u65b0\u68c0\u67e5\u4e2d');
}

function restartTimers() {
if (state.checkTimer) clearInterval(state.checkTimer);
state.checkTimer = null;
if (!state.settings.enabled || state.pageSuspended || document.visibilityState === 'hidden') {
state.isIdle = false;
if (!state.settings.enabled) state.idleStartTime = null;
stopMusingLoop();
return;
}

state.checkTimer = setInterval(checkIdle, state.settings.checkIntervalMinutes * 60 * 1000);
if (state.isIdle) {
  stopMusingLoop();
  startMusingLoop();
}
}

function suspendFrontendTimers() {
state.pageSuspended = true;
if (state.checkTimer) clearInterval(state.checkTimer);
state.checkTimer = null;
if (state.retryCheckTimer) clearTimeout(state.retryCheckTimer);
state.retryCheckTimer = null;
stopMusingLoop();
recordEvent('页面已休眠，漫想计时暂停且不会积压');
}

function resumeFrontendTimers() {
state.pageSuspended = false;
restartTimers();
recordEvent('页面已恢复，只重新检查当前状态，不补算休眠期间任务');
checkIdle();
}

function getStatus() {
if (!state.settings?.enabled) return { label: '\u5df2\u505c\u7528', tone: 'disabled' };
if (state.pageSuspended) return { label: '页面休眠', tone: 'idle' };
if (state.generating || state.musingInFlight) return { label: '\u6f2b\u60f3\u4e2d', tone: 'active' };
if (state.isIdle) return { label: '\u7b49\u5f85\u63a8\u9001', tone: 'idle' };
return { label: '\u5f85\u673a', tone: 'standby' };
}

function formatDiagnosticCopy(item) {
if (!item) return '';
return [
  'Auto Musings 诊断',
  `插件版本：${EXTENSION_VERSION}`,
  `诊断编号：${item.id || ''}`,
  `时间：${formatTime(item.ts)}`,
  `步骤：${item.stageName || item.stage || '未知'}`,
  `问题：${item.title || '未知错误'}`,
  `说明：${item.summary || ''}`,
  `影响：${item.impact || ''}`,
  `保存状态：${item.preservation || ''}`,
  `重试方式：${item.retry || ''}`,
  `自动切换 API：${item.automaticApiSwitch === true ? '是' : '否'}`,
  `建议：${item.action || ''}`,
  `错误码：${item.code || ''}`,
  `HTTP：${item.technical?.status || '无'}`,
  `连接配置：${item.technical?.profileName || '无'}`,
  `模型：${item.technical?.model || '无'}`,
  `接口主机：${item.technical?.endpointHost || '无'}`,
  `任务编号：${item.technical?.operationId || '无'}`,
  `错误类型：${item.technical?.errorName || '无'}`,
  `系统错误码：${item.technical?.systemCode || '无'}`,
  `服务错误码：${item.technical?.providerCode || '无'}`,
  `服务错误类型：${item.technical?.providerType || '无'}`,
  `请求编号：${item.technical?.requestId || '无'}`,
  `技术信息：${item.technical?.message || ''}`,
  `返回摘要：${item.technical?.responseExcerpt || '无'}`,
  '安全说明：仅 API Key、私密地址路径和完整提示词会自动保护，其余诊断尽量完整保留。',
].join('\n');
}

async function copyText(value) {
if (!value) return false;
try {
  await navigator.clipboard.writeText(value);
  return true;
} catch {
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  return copied;
}
}

function updateUI() {
if (!state.uiReady) return;
const root = document.getElementById(ROOT_ID);
if (!root) return;

const status = getStatus();
root.querySelectorAll('[data-auto-musings-status]').forEach((badge) => {
  badge.textContent = status.label;
  badge.dataset.tone = status.tone;
});

const enabled = root.querySelector('#auto-musings-enabled');
if (enabled && enabled.checked !== !!state.settings.enabled) enabled.checked = !!state.settings.enabled;

const lastCheck = root.querySelector('[data-auto-musings-last-check]');
if (lastCheck) lastCheck.textContent = state.lastCheckAt ? formatTime(state.lastCheckAt) : '\u6682\u65e0';
const idleFor = root.querySelector('[data-auto-musings-idle-for]');
if (idleFor) {
  idleFor.textContent = state.isIdle && state.idleStartTime ? formatElapsed(state.idleStartTime) : '\u672a\u8fdb\u5165';
}
const testButton = root.querySelector('#auto-musings-test');
if (testButton) {
  testButton.disabled = state.musingInFlight || state.generating;
  testButton.classList.toggle('disabled', testButton.disabled);
}
const contextDepth = root.querySelector('#auto-musings-context-depth');
if (contextDepth) contextDepth.disabled = state.settings.contextMode !== 'recent';
const serverState = root.querySelector('[data-auto-musings-server-state]');
if (serverState) {
  serverState.textContent = state.serverPausedReason
    ? `${state.serverPausedReason}；当前页面仍按原作者机制运行。`
    : (state.serverAvailable
      ? '后台保存与论坛工具已连接；计时、掷骰和正文生成只在当前页面运行'
      : '后台保存服务未连接；当前页面仍会运行，日志暂存在酒馆设置中');
  serverState.dataset.connected = state.serverAvailable ? 'true' : 'false';
}
const forumState = root.querySelector('[data-auto-musings-forum-state]');
if (forumState) {
  const forum = state.serverStatus?.forum;
  if (!state.settings.forumEnabled) {
    forumState.textContent = '论坛漫游已关闭；不会读取论坛，也不会调用 Gemini 或 Claude。';
    forumState.dataset.tone = 'standby';
  } else if (!state.serverAvailable) {
    forumState.textContent = '论坛漫游需要服务端伴侣；当前页面模式不会运行论坛流程。';
    forumState.dataset.tone = 'error';
  } else if (!forum?.filterProfileName || !forum?.reviewProfileName) {
    forumState.textContent = '请分别选择 Gemini 垃圾过滤 API 和 Claude 最终阅读 API；不会自动替你选择或切换。';
    forumState.dataset.tone = 'error';
  } else if (forum?.inFlight) {
    forumState.textContent = '论坛只读流程运行中；不会自动发帖或回帖。';
    forumState.dataset.tone = 'active';
  } else if (forum?.pendingCount > 0) {
    forumState.textContent = `有 ${forum.pendingCount} 个论坛任务等待手动重试；最近停在：${forum.latestPendingStage || '未知步骤'}。`;
    forumState.dataset.tone = 'error';
  } else {
    const memoryText = forum?.animaActiveFiles > 0 ? `Anima 已关联 ${forum.animaActiveFiles} 个聊天库` : 'Anima 尚未关联聊天库';
    const promptText = forum?.promptSnapshotAt ? '完整上下文快照已捕获' : '等待下一次正常对话捕获完整上下文';
    forumState.textContent = `${memoryText}；${promptText}；只读、不自动回复。`;
    forumState.dataset.tone = 'ready';
  }
}
for (const selector of ['#auto-musings-forum-test', '#auto-musings-forum-retry']) {
  const button = root.querySelector(selector);
  if (button) button.disabled = !state.serverAvailable
    || state.serverStatus?.forum?.inFlight
    || !state.settings.forumFilterProfileId
    || !state.settings.forumReviewProfileId;
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

const logs = getDisplayLogs();
if (logs.length === 0) {
  body.innerHTML = `<div class="amw-empty">\u6682\u65e0\u6f2b\u60f3\u65e5\u5fd7</div>`;
  return;
}

let html = '';
for (let i = logs.length - 1; i >= 0; i--) {
  const item = logs[i];
  const timeStr = formatTime(item.ts || Date.now());
  if (item.kind === 'diagnostic') {
    const technical = item.technical || {};
    const diagnosticTone = item.severity === 'warning' ? 'hold' : 'error';
    html += `
      <div class="amw-entry amw-diagnostic" data-diagnostic-id="${escapeHtml(item.id)}">
        <div class="amw-meta">
          <span class="amw-time">${timeStr}</span>
          <span class="amw-badge">${item.severity === 'warning' ? '运行提醒' : '故障诊断'}</span>
          <span class="amw-dec ${diagnosticTone}">${escapeHtml(item.stageName || item.stage || '未知步骤')}</span>
        </div>
        <div class="amw-diagnostic-title">${escapeHtml(item.title || '未知错误')}</div>
        <div class="amw-diagnostic-line"><b>发生了什么：</b>${escapeHtml(item.summary || '')}</div>
        <div class="amw-diagnostic-line"><b>影响：</b>${escapeHtml(item.impact || '')}</div>
        <div class="amw-diagnostic-line"><b>保存状态：</b>${escapeHtml(item.preservation || '')}</div>
        <div class="amw-diagnostic-line"><b>重试方式：</b>${escapeHtml(item.retry || '')}</div>
        <div class="amw-diagnostic-line"><b>自动切换 API：</b>${item.automaticApiSwitch === true ? '是' : '否'}</div>
        <div class="amw-diagnostic-action"><b>你可以怎么做：</b>${escapeHtml(item.action || '')}</div>
        <details class="amw-technical">
          <summary>给猴猴看的技术详情</summary>
          <div>诊断编号：${escapeHtml(item.id || '')}</div>
          <div>任务编号：${escapeHtml(technical.operationId || '无')}</div>
          <div>错误码：${escapeHtml(item.code || '')}</div>
          <div>HTTP：${escapeHtml(technical.status || '无')}</div>
          <div>配置：${escapeHtml(technical.profileName || '无')}</div>
          <div>模型：${escapeHtml(technical.model || '无')}</div>
          <div>接口主机：${escapeHtml(technical.endpointHost || '无')}</div>
          <div>错误类型：${escapeHtml(technical.errorName || '无')}</div>
          <div>系统错误码：${escapeHtml(technical.systemCode || '无')}</div>
          <div>服务错误码：${escapeHtml(technical.providerCode || '无')}</div>
          <div>服务错误类型：${escapeHtml(technical.providerType || '无')}</div>
          <div>请求编号：${escapeHtml(technical.requestId || '无')}</div>
          <div>技术信息：${escapeHtml(technical.message || '')}</div>
          ${technical.responseExcerpt ? `<div>返回摘要：${escapeHtml(technical.responseExcerpt)}</div>` : ''}
          <div>仅 Key、私密地址路径和完整提示词会自动保护。</div>
        </details>
      </div>`;
    continue;
  }
  if (item.kind === 'forum') {
    const posts = Array.isArray(item.posts) ? item.posts : [];
    const postHtml = posts.map((post) => {
      const review = post.review || {};
      const lane = post.lane === 'related' ? '相关' : '探索';
      const interest = Number.isFinite(Number(review.interest)) ? `${review.interest}%` : '未判断';
      return `
        <div class="amw-forum-post">
          <div class="amw-forum-post-title">${escapeHtml(post.title || post.id || '未命名帖子')}</div>
          <div class="amw-forum-post-meta">${lane} · 兴趣 ${escapeHtml(interest)}${review.wantToReply ? ' · 想参与' : ''}</div>
          ${review.reason ? `<div>${escapeHtml(review.reason)}</div>` : ''}
          ${review.replyIntent ? `<div class="amw-forum-intent">可能想说：${escapeHtml(review.replyIntent)}</div>` : ''}
        </div>`;
    }).join('');
    html += `
      <div class="amw-entry amw-forum-entry">
        <div class="amw-meta">
          <span class="amw-time">${timeStr}</span>
          <span class="amw-badge">论坛漫游</span>
          <span class="amw-dec hold">只读完成</span>
        </div>
        ${item.overall ? `<div class="amw-thought">${escapeHtml(item.overall)}</div>` : ''}
        ${postHtml || '<div class="amw-content">这批帖子已被高置信垃圾过滤拦下。</div>'}
        <div class="amw-forum-readonly">本次没有自动发帖或回帖。</div>
      </div>`;
    continue;
  }
  const typeText = item.type === 'context' ? '\u7247\u6bb5' : (item.type === 'idle' ? '\u53d1\u5446' : '\u79cd\u5b50');
  const legacyPending = ['pending_push', 'legacy_pending_archived'].includes(item.status);
  const decisionClass = item.decision === 'push' && !legacyPending
    ? 'push'
    : (['error', 'push_failed', 'worldbook_failed'].includes(item.status) ? 'error' : 'hold');
  const decisionText = legacyPending
    ? '旧补发已停用'
    : (item.status === 'push_failed'
      ? '正文发送失败'
      : (item.status === 'worldbook_failed'
        ? '世界书失败'
        : (item.decision === 'push' ? '\u5df2\u63a8\u9001' : (item.decision === 'idle' ? '\u53d1\u5446' : '\u4fdd\u7559'))));
  const entryClass = `amw-entry ${!legacyPending && (item.pushed || item.decision === 'push' || item.status === 'pushed') ? 'pushed' : 'idle'}`;

  const manualTag = item.manual ? `<span class="amw-manual">\u624b\u52a8</span>` : '';
  const sourceValue = item.source || item.content || '';
  const sourcePreview = item.type === 'context' && sourceValue.length > 220
    ? `${sourceValue.slice(0, 220)}\u2026`
    : sourceValue;
  const sourceSafe = escapeHtml(sourcePreview);
  const thoughtValue = item.thought || item.visibleText || '';
  const thoughtHtml = thoughtValue
    ? `<div class="amw-thought">${escapeHtml(thoughtValue)}</div>`
    : '';
  const errorHtml = item.error
    ? `<div class="amw-error">${escapeHtml(item.error)}</div>`
    : '';
  const worldBookHtml = item.worldBook?.saved
    ? `<span class="amw-world">\u5df2\u5b58\u4e16\u754c\u4e66</span>`
    : '';

  html += `
    <div class="${entryClass}">
      <div class="amw-meta">
        <span class="amw-time">${timeStr}</span>
        <span class="amw-badge">${typeText}</span>
        <span class="amw-dec ${decisionClass}">${decisionText}</span>
        ${worldBookHtml}
        ${manualTag}
      </div>
      <div class="amw-content">${sourceSafe}</div>
      ${thoughtHtml}
      ${errorHtml}
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
          <b class="auto-musings-heading">Auto Musings <span class="auto-musings-version">v${EXTENSION_VERSION}</span></b>
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
            <input id="auto-musings-check-interval" class="text_pole" type="number" min="0.25" max="1440" step="0.25">
          </label>
          <label class="auto-musings-field" for="auto-musings-musing-interval">
            <span>漫想间隔（分钟）</span>
            <input id="auto-musings-musing-interval" class="text_pole" type="number" min="0.25" max="1440" step="0.25">
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
        <details class="auto-musings-section auto-musings-runtime-section" open>
          <summary class="auto-musings-section-title">上下文与隐藏漫想</summary>
          <div class="auto-musings-grid">
            <label class="auto-musings-field" for="auto-musings-context-mode">
              <span>上下文读取方式</span>
              <select id="auto-musings-context-mode" class="text_pole">
                <option value="default">原作者默认（随机旧片段）</option>
                <option value="recent">最近 N 条消息</option>
              </select>
            </label>
            <label class="auto-musings-field" for="auto-musings-context-depth">
              <span>最近上下文条数（1–100）</span>
              <input id="auto-musings-context-depth" class="text_pole" type="number" min="1" max="100" step="1">
            </label>
            <label class="auto-musings-field" for="auto-musings-secondary-profile">
              <span>隐藏漫想使用的副 API</span>
              <select id="auto-musings-secondary-profile" class="text_pole"></select>
            </label>
            <label class="auto-musings-field" for="auto-musings-secondary-model">
              <span>副 API 模型名（配置留空时填）</span>
              <input id="auto-musings-secondary-model" class="text_pole" type="text" placeholder="例如 claude-sonnet-4-5">
            </label>
            <label class="auto-musings-field" for="auto-musings-hidden-max-tokens">
              <span>隐藏漫想最大 Tokens</span>
              <input id="auto-musings-hidden-max-tokens" class="text_pole" type="number" min="64" max="4096" step="16">
            </label>
          </div>
          <div class="auto-musings-hint">历史消息会明确标记 role=user / role=assistant 和发送者名称；未发送的漫想才会写入角色主世界书。副 API 失败时当前步骤立即停止并记日志，不会自动换配置、模型或 Key。</div>
          <div class="auto-musings-server-state" data-auto-musings-server-state>正在检查服务端伴侣…</div>
        </details>
        <details class="auto-musings-section auto-musings-forum-section">
          <summary class="auto-musings-section-title">论坛漫游（第一版只读）</summary>
          <label class="checkbox_label auto-musings-enable" for="auto-musings-forum-enabled">
            <input id="auto-musings-forum-enabled" type="checkbox">
            <span>允许漫想骰子触发论坛阅读</span>
          </label>
          <div class="auto-musings-grid">
            <label class="auto-musings-field" for="auto-musings-forum-probability">
              <span>每次漫想后的触发概率（%）</span>
              <input id="auto-musings-forum-probability" class="text_pole" type="number" min="0" max="100" step="1">
            </label>
            <label class="auto-musings-field" for="auto-musings-forum-cooldown">
              <span>论坛冷却时间（分钟）</span>
              <input id="auto-musings-forum-cooldown" class="text_pole" type="number" min="5" max="10080" step="5">
            </label>
            <label class="auto-musings-field" for="auto-musings-forum-post-count">
              <span>每次交给小克的帖子数</span>
              <input id="auto-musings-forum-post-count" class="text_pole" type="number" min="1" max="10" step="1">
            </label>
            <label class="auto-musings-field" for="auto-musings-forum-related-ratio">
              <span>相关内容比例（%）</span>
              <input id="auto-musings-forum-related-ratio" class="text_pole" type="number" min="0" max="100" step="1">
            </label>
            <label class="auto-musings-field" for="auto-musings-forum-filter-profile">
              <span>Gemini 垃圾过滤 API</span>
              <select id="auto-musings-forum-filter-profile" class="text_pole"></select>
            </label>
            <label class="auto-musings-field" for="auto-musings-forum-filter-model">
              <span>Gemini 模型名（需要时覆盖）</span>
              <input id="auto-musings-forum-filter-model" class="text_pole" type="text" placeholder="留空则使用连接配置里的模型">
            </label>
            <label class="auto-musings-field" for="auto-musings-forum-review-profile">
              <span>小克最终阅读使用的 Claude API</span>
              <select id="auto-musings-forum-review-profile" class="text_pole"></select>
            </label>
            <label class="auto-musings-field" for="auto-musings-forum-review-model">
              <span>Claude 模型名（需要时覆盖）</span>
              <input id="auto-musings-forum-review-model" class="text_pole" type="text" placeholder="留空则使用连接配置里的模型">
            </label>
            <label class="auto-musings-field" for="auto-musings-forum-mcp-server">
              <span>MCP 服务器名称</span>
              <input id="auto-musings-forum-mcp-server" class="text_pole" type="text" placeholder="lutopia">
            </label>
          </div>
          <div class="auto-musings-hint">约 70% 按 Anima 记忆、当前聊天、种子词和本次漫想选相关帖，其余用于随机探索。Gemini 只拦明显垃圾；Claude 一次读取整批后由小克自己判断。不会自动切换 API，也不会自动发帖或回帖。</div>
          <div class="auto-musings-forum-state" data-auto-musings-forum-state>论坛漫游已关闭。</div>
          <div class="auto-musings-actions auto-musings-forum-actions">
            <button id="auto-musings-forum-test" type="button" class="menu_button menu_button_icon">
              <i class="fa-solid fa-book-open-reader"></i>
              <span>立即测试只读流程</span>
            </button>
            <button id="auto-musings-forum-retry" type="button" class="menu_button menu_button_icon">
              <i class="fa-solid fa-rotate-right"></i>
              <span>重试上次失败任务</span>
            </button>
          </div>
        </details>
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
        </div>
        <div class="auto-musings-section">
          <label class="auto-musings-field" for="auto-musings-log-max">
            <span>日志上限数量（20–2000）</span>
            <input id="auto-musings-log-max" class="text_pole" type="number" min="20" max="2000" step="1">
          </label>
          <label class="auto-musings-field auto-musings-seed-field" for="auto-musings-seeds-input">
            <span>种子词配置（一行一个）</span>
            <textarea id="auto-musings-seeds-input" class="text_pole auto-musings-seeds"></textarea>
          </label>
          <div class="auto-musings-hint">漫想只在当前聊天页面打开时运行；后台负责保存日志和论坛工具，不会在页面休眠时积累待发送消息。</div>
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
1440,
DEFAULT_SETTINGS.checkIntervalMinutes,
);
state.settings.musingIntervalMinutes = clamp(
root.querySelector('#auto-musings-musing-interval')?.value,
0.25,
1440,
DEFAULT_SETTINGS.musingIntervalMinutes,
);
state.settings.pushMode = root.querySelector('#auto-musings-push-mode')?.value || DEFAULT_SETTINGS.pushMode;
state.settings.logMax = clamp(root.querySelector('#auto-musings-log-max')?.value, 20, 2000, 200);
state.settings.contextMode = root.querySelector('#auto-musings-context-mode')?.value === 'recent' ? 'recent' : 'default';
state.settings.contextDepth = Math.round(clamp(
root.querySelector('#auto-musings-context-depth')?.value,
1,
100,
DEFAULT_SETTINGS.contextDepth,
));
state.settings.secondaryProfileId = root.querySelector('#auto-musings-secondary-profile')?.value || '';
state.settings.secondaryModel = root.querySelector('#auto-musings-secondary-model')?.value?.trim() || '';
state.settings.hiddenMaxTokens = Math.round(clamp(
root.querySelector('#auto-musings-hidden-max-tokens')?.value,
64,
4096,
DEFAULT_SETTINGS.hiddenMaxTokens,
));
state.settings.forumEnabled = !!root.querySelector('#auto-musings-forum-enabled')?.checked;
state.settings.forumProbability = clamp(
root.querySelector('#auto-musings-forum-probability')?.value,
0,
100,
DEFAULT_SETTINGS.forumProbability,
);
state.settings.forumCooldownMinutes = clamp(
root.querySelector('#auto-musings-forum-cooldown')?.value,
5,
10080,
DEFAULT_SETTINGS.forumCooldownMinutes,
);
state.settings.forumPostsPerRun = Math.round(clamp(
root.querySelector('#auto-musings-forum-post-count')?.value,
1,
10,
DEFAULT_SETTINGS.forumPostsPerRun,
));
state.settings.forumRelatedRatio = clamp(
root.querySelector('#auto-musings-forum-related-ratio')?.value,
0,
100,
DEFAULT_SETTINGS.forumRelatedRatio,
);
state.settings.forumFilterProfileId = root.querySelector('#auto-musings-forum-filter-profile')?.value || '';
state.settings.forumFilterModel = root.querySelector('#auto-musings-forum-filter-model')?.value?.trim() || '';
state.settings.forumReviewProfileId = root.querySelector('#auto-musings-forum-review-profile')?.value || '';
state.settings.forumReviewModel = root.querySelector('#auto-musings-forum-review-model')?.value?.trim() || '';
state.settings.forumMcpServerName = root.querySelector('#auto-musings-forum-mcp-server')?.value?.trim() || DEFAULT_SETTINGS.forumMcpServerName;

const rawSeeds = root.querySelector('#auto-musings-seeds-input')?.value || '';
state.settings.seedWords = rawSeeds
  .split('\n')
  .map((item) => item.trim())
  .filter((item) => item.length > 0);

trimLogs();
saveSettings();
restartTimers();
scheduleServerSync(100);
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
root.querySelector('#auto-musings-context-mode').value = state.settings.contextMode;
root.querySelector('#auto-musings-context-depth').value = state.settings.contextDepth;
root.querySelector('#auto-musings-secondary-model').value = state.settings.secondaryModel;
root.querySelector('#auto-musings-hidden-max-tokens').value = state.settings.hiddenMaxTokens;
root.querySelector('#auto-musings-forum-enabled').checked = !!state.settings.forumEnabled;
root.querySelector('#auto-musings-forum-probability').value = state.settings.forumProbability;
root.querySelector('#auto-musings-forum-cooldown').value = state.settings.forumCooldownMinutes;
root.querySelector('#auto-musings-forum-post-count').value = state.settings.forumPostsPerRun;
root.querySelector('#auto-musings-forum-related-ratio').value = state.settings.forumRelatedRatio;
root.querySelector('#auto-musings-forum-filter-model').value = state.settings.forumFilterModel;
root.querySelector('#auto-musings-forum-review-model').value = state.settings.forumReviewModel;
root.querySelector('#auto-musings-forum-mcp-server').value = state.settings.forumMcpServerName;
populateConnectionProfiles();
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

function getFloatingViewportBounds() {
const viewport = window.visualViewport;
return {
  left: viewport?.offsetLeft || 0,
  top: viewport?.offsetTop || 0,
  width: viewport?.width || window.innerWidth,
  height: viewport?.height || window.innerHeight,
};
}

function getFloatingButtonMode() {
return window.matchMedia('(max-width: 900px)').matches ? 'mobile' : 'desktop';
}

function moveFloatingButtonToViewportPosition(button, targetLeft, targetTop) {
if (!button) return;
const rect = button.getBoundingClientRect();
const computed = getComputedStyle(button);
const cssLeft = Number.parseFloat(computed.left);
const cssTop = Number.parseFloat(computed.top);
button.style.left = `${Number.isFinite(cssLeft) ? cssLeft : rect.left}px`;
button.style.top = `${Number.isFinite(cssTop) ? cssTop : rect.top}px`;
button.style.right = 'auto';
button.style.bottom = 'auto';

const placedRect = button.getBoundingClientRect();
const placedStyle = getComputedStyle(button);
const placedLeft = Number.parseFloat(placedStyle.left);
const placedTop = Number.parseFloat(placedStyle.top);
if (Number.isFinite(placedLeft)) button.style.left = `${placedLeft + targetLeft - placedRect.left}px`;
if (Number.isFinite(placedTop)) button.style.top = `${placedTop + targetTop - placedRect.top}px`;
}

function keepFloatingElementInViewport(element, horizontal = false) {
if (!element || getComputedStyle(element).display === 'none') return;
const rect = element.getBoundingClientRect();
if (!rect.width || !rect.height) return;

const viewport = getFloatingViewportBounds();
const margin = 8;
const minLeft = viewport.left + margin;
const minTop = viewport.top + margin;
const maxLeft = Math.max(minLeft, viewport.left + viewport.width - rect.width - margin);
const maxTop = Math.max(minTop, viewport.top + viewport.height - rect.height - margin);
const targetLeft = horizontal ? Math.min(maxLeft, Math.max(minLeft, rect.left)) : rect.left;
const targetTop = Math.min(maxTop, Math.max(minTop, rect.top));
if (Math.abs(targetLeft - rect.left) < 0.5 && Math.abs(targetTop - rect.top) < 0.5) return;

if (horizontal) {
  moveFloatingButtonToViewportPosition(element, targetLeft, targetTop);
  return;
}
const currentTop = Number.parseFloat(getComputedStyle(element).top);
if (Number.isFinite(currentTop)) element.style.top = `${currentTop + targetTop - rect.top}px`;
}

function applySavedFloatingButtonPosition(button, mode) {
const position = state.settings?.floatingButtonPositions?.[mode];
const x = Number(position?.x);
const y = Number(position?.y);
if (!Number.isFinite(x) || !Number.isFinite(y)) return false;

const rect = button.getBoundingClientRect();
if (!rect.width || !rect.height) return false;
const viewport = getFloatingViewportBounds();
const margin = 8;
const availableX = Math.max(0, viewport.width - rect.width - margin * 2);
const availableY = Math.max(0, viewport.height - rect.height - margin * 2);
const targetLeft = viewport.left + margin + availableX * Math.min(1, Math.max(0, x));
const targetTop = viewport.top + margin + availableY * Math.min(1, Math.max(0, y));
if (Math.abs(targetLeft - rect.left) >= 0.5 || Math.abs(targetTop - rect.top) >= 0.5) {
  moveFloatingButtonToViewportPosition(button, targetLeft, targetTop);
}
return true;
}

function saveFloatingButtonPosition(button, mode) {
const rect = button.getBoundingClientRect();
if (!rect.width || !rect.height || !state.settings) return;
const viewport = getFloatingViewportBounds();
const margin = 8;
const availableX = Math.max(1, viewport.width - rect.width - margin * 2);
const availableY = Math.max(1, viewport.height - rect.height - margin * 2);
const x = Math.min(1, Math.max(0, (rect.left - viewport.left - margin) / availableX));
const y = Math.min(1, Math.max(0, (rect.top - viewport.top - margin) / availableY));
state.settings.floatingButtonPositions = {
  ...(state.settings.floatingButtonPositions || {}),
  [mode]: { x: Number(x.toFixed(4)), y: Number(y.toFixed(4)) },
};
saveSettings();
}

function repairFloatingPositionNow() {
const button = document.getElementById(FLOAT_BTN_ID);
const panel = document.getElementById(FLOAT_WIN_ID);
if (panel?.classList.contains('show')) {
  keepFloatingElementInViewport(panel);
  return;
}
if (!button || floatingButtonDragging) return;

const mode = getFloatingButtonMode();
if (button.dataset.autoMusingsPositionMode !== mode) {
  for (const property of ['left', 'top', 'right', 'bottom']) button.style.removeProperty(property);
  button.dataset.autoMusingsPositionMode = mode;
}
if (!applySavedFloatingButtonPosition(button, mode)) keepFloatingElementInViewport(button, true);
}

function scheduleFloatingPositionRepair() {
if (floatingPositionRepairFrame !== null) return;
floatingPositionRepairFrame = requestAnimationFrame(() => {
  floatingPositionRepairFrame = null;
  repairFloatingPositionNow();
});
}

function bindFloatingButtonDrag(button) {
if (!button || button.dataset.autoMusingsDragBound === 'true') return;
button.dataset.autoMusingsDragBound = 'true';
let active = false;
let moved = false;
let pointerId = null;
let startX = 0;
let startY = 0;
let startRect = null;
let startCssLeft = 0;
let startCssTop = 0;
let mode = getFloatingButtonMode();

const finish = (event, cancelled = false) => {
  if (!active) return;
  active = false;
  floatingButtonDragging = false;
  suppressFloatingButtonClickUntil = Date.now() + 420;
  if (moved) saveFloatingButtonPosition(button, mode);
  button.classList.remove('dragging');
  if (event?.cancelable) event.preventDefault();
  if (!moved && !cancelled) toggleFloatingWindow();
  try {
    if (pointerId !== null && button.hasPointerCapture(pointerId)) button.releasePointerCapture(pointerId);
  } catch {
    // Pointer capture can already be gone after cancellation.
  }
  pointerId = null;
  scheduleFloatingPositionRepair();
};

button.addEventListener('pointerdown', (event) => {
  if (event.isPrimary === false || (event.button !== undefined && event.button !== 0)) return;
  const rect = button.getBoundingClientRect();
  const computed = getComputedStyle(button);
  active = true;
  moved = false;
  pointerId = event.pointerId;
  startX = event.clientX;
  startY = event.clientY;
  startRect = rect;
  startCssLeft = Number.parseFloat(computed.left);
  startCssTop = Number.parseFloat(computed.top);
  if (!Number.isFinite(startCssLeft)) startCssLeft = rect.left;
  if (!Number.isFinite(startCssTop)) startCssTop = rect.top;
  mode = getFloatingButtonMode();
  floatingButtonDragging = true;
  button.classList.add('dragging');
  try {
    button.setPointerCapture(event.pointerId);
  } catch {
    // Dragging still works while the pointer stays over the button.
  }
  if (event.cancelable) event.preventDefault();
});

button.addEventListener('pointermove', (event) => {
  if (!active || event.pointerId !== pointerId || !startRect) return;
  const dx = event.clientX - startX;
  const dy = event.clientY - startY;
  if (!moved && Math.hypot(dx, dy) < 6) return;
  moved = true;
  const viewport = getFloatingViewportBounds();
  const margin = 8;
  const minLeft = viewport.left + margin;
  const minTop = viewport.top + margin;
  const maxLeft = Math.max(minLeft, viewport.left + viewport.width - startRect.width - margin);
  const maxTop = Math.max(minTop, viewport.top + viewport.height - startRect.height - margin);
  const targetLeft = Math.min(maxLeft, Math.max(minLeft, startRect.left + dx));
  const targetTop = Math.min(maxTop, Math.max(minTop, startRect.top + dy));
  button.style.left = `${startCssLeft + targetLeft - startRect.left}px`;
  button.style.top = `${startCssTop + targetTop - startRect.top}px`;
  button.style.right = 'auto';
  button.style.bottom = 'auto';
  if (event.cancelable) event.preventDefault();
});

button.addEventListener('pointerup', (event) => {
  if (!active || event.pointerId !== pointerId) return;
  finish(event);
});
button.addEventListener('pointercancel', (event) => {
  if (!active || event.pointerId !== pointerId) return;
  finish(event, true);
});
button.addEventListener('lostpointercapture', (event) => {
  if (active && event.pointerId === pointerId) finish(event, true);
});
}

function toggleFloatingWindow(forceOpen = null) {
createFloatingUI();
const win = document.getElementById(FLOAT_WIN_ID);
const btn = document.getElementById(FLOAT_BTN_ID);
if (!win) {
  console.warn('[Auto Musings] Floating console could not be created');
  return false;
}

const currentlyOpen = win.classList.contains('show');
state.windowOpen = forceOpen !== null ? !!forceOpen : !currentlyOpen;
if (state.windowOpen) {
  state.unreadCount = 0;
  win.classList.add('show');
  win.setAttribute('aria-hidden', 'false');
  if (btn) btn.classList.add('active');
  btn?.setAttribute('aria-expanded', 'true');
  updateFloatingWindowUI();
} else {
  win.classList.remove('show');
  win.setAttribute('aria-hidden', 'true');
  if (btn) btn.classList.remove('active');
  btn?.setAttribute('aria-expanded', 'false');
  updateFloatingWindowUI();
}
repairFloatingPositionNow();
scheduleFloatingPositionRepair();
return true;
}

function createFloatingUI() {
if (!document.body) return false;

let floatBtn = document.getElementById(FLOAT_BTN_ID);
if (floatBtn && (floatBtn.tagName !== 'BUTTON' || floatBtn.dataset.autoMusingsUiVersion !== EXTENSION_VERSION)) {
  floatBtn.remove();
  floatBtn = null;
}
if (!floatBtn) {
  floatBtn = document.createElement('button');
  floatBtn.id = FLOAT_BTN_ID;
  floatBtn.type = 'button';
  floatBtn.innerHTML = `
    <i class="fa-solid fa-lightbulb" aria-hidden="true"></i>
    <span class="amf-badge">0</span>
  `;
  document.body.appendChild(floatBtn);
}
floatBtn.dataset.autoMusingsUiVersion = EXTENSION_VERSION;
floatBtn.title = '\u62d6\u52a8\u8c03\u6574\u4f4d\u7f6e\uff1b\u8f7b\u70b9\u6253\u5f00 Auto Musings \u6f2b\u60f3\u53f0';
floatBtn.setAttribute('aria-label', '\u6253\u5f00 Auto Musings \u6f2b\u60f3\u53f0');
floatBtn.setAttribute('aria-controls', FLOAT_WIN_ID);
floatBtn.setAttribute('aria-expanded', String(state.windowOpen));
floatBtn.onclick = (event) => {
  if (floatingButtonDragging || Date.now() < suppressFloatingButtonClickUntil) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  toggleFloatingWindow();
};
bindFloatingButtonDrag(floatBtn);

let floatWin = document.getElementById(FLOAT_WIN_ID);
const floatingWindowIsComplete = floatWin
  && floatWin.querySelector('.amw-body')
  && floatWin.querySelector('#auto-musings-copy-diagnostic')
  && floatWin.querySelector('#auto-musings-clear-log')
  && floatWin.querySelector('#auto-musings-close-win');
if (floatWin && (floatWin.dataset.autoMusingsUiVersion !== EXTENSION_VERSION || !floatingWindowIsComplete)) {
  floatWin.remove();
  floatWin = null;
}
if (!floatWin) {
  floatWin = document.createElement('div');
  floatWin.id = FLOAT_WIN_ID;
  floatWin.setAttribute('role', 'dialog');
  floatWin.setAttribute('aria-label', `Auto Musings \u6f2b\u60f3\u53f0 v${EXTENSION_VERSION}`);
  floatWin.innerHTML = `
    <div class="amw-head">
      <div class="amw-title">Auto Musings \u6f2b\u60f3\u53f0 <span class="amw-version">v${EXTENSION_VERSION}</span></div>
      <div class="amw-tools">
        <button id="auto-musings-copy-diagnostic" class="menu_button" title="复制最近一条故障诊断（自动保护 Key 和私密地址）">复制诊断</button>
        <button id="auto-musings-clear-log" class="menu_button" title="\u6e05\u7a7a\u6240\u6709\u6f2b\u60f3\u65e5\u5fd7">\u6e05\u7a7a</button>
        <button id="auto-musings-close-win" class="menu_button" title="\u5173\u95ed\u7a97\u53e3">\u5173\u95ed</button>
      </div>
    </div>
    <div class="amw-body"></div>
  `;
  document.body.appendChild(floatWin);
}
floatWin.dataset.autoMusingsUiVersion = EXTENSION_VERSION;
floatWin.classList.toggle('show', state.windowOpen);
floatWin.setAttribute('aria-hidden', String(!state.windowOpen));
floatBtn.classList.toggle('active', state.windowOpen);

const closeButton = floatWin.querySelector('#auto-musings-close-win');
const copyButton = floatWin.querySelector('#auto-musings-copy-diagnostic');
const clearButton = floatWin.querySelector('#auto-musings-clear-log');
closeButton.onclick = () => toggleFloatingWindow(false);
copyButton.onclick = async () => {
  const logs = getDisplayLogs();
  const diagnostic = [...logs].reverse().find((item) => item?.kind === 'diagnostic');
  if (!diagnostic) {
    window.toastr?.info?.('目前没有故障诊断可复制');
    return;
  }
  const copied = await copyText(formatDiagnosticCopy(diagnostic));
  if (copied) window.toastr?.success?.('诊断信息已复制，可以直接发给猴猴');
  else window.toastr?.error?.('复制失败，请展开技术详情后手动选择');
};
clearButton.onclick = async () => {
  if (confirm('\u786e\u5b9a\u8981\u6e05\u7a7a\u6240\u6709\u6f2b\u60f3\u65e5\u5fd7\u5417\uff1f')) {
    if (state.serverAvailable) {
      try {
        await serverRequest('/history/clear');
      } catch (error) {
        console.error('[Auto Musings] \u6e05\u7a7a\u670d\u52a1\u7aef\u65e5\u5fd7\u5931\u8d25:', error);
        window.toastr?.error?.(`\u6e05\u7a7a\u5931\u8d25\uff1a${error.message}`);
        return;
      }
    }
    state.serverLogs = [];
    state.settings.musingLog = [];
    state.lastServerLogId = null;
    saveSettings();
    state.unreadCount = 0;
    updateFloatingWindowUI();
  }
};

updateFloatingWindowUI();
repairFloatingPositionNow();
scheduleFloatingPositionRepair();
return true;
}

function bindSettingsUI() {
const root = document.getElementById(ROOT_ID);
if (!root) return;
root.querySelectorAll('input, select, textarea').forEach((element) => {
element.addEventListener('change', readSettingsFromUI);
});
for (const [profileSelector, modelSelector] of [
  ['#auto-musings-secondary-profile', '#auto-musings-secondary-model'],
  ['#auto-musings-forum-filter-profile', '#auto-musings-forum-filter-model'],
  ['#auto-musings-forum-review-profile', '#auto-musings-forum-review-model'],
]) {
  root.querySelector(profileSelector)?.addEventListener('change', (event) => {
    const profile = getConnectionProfile(event.currentTarget.value);
    const modelInput = root.querySelector(modelSelector);
    if (profile?.model && modelInput) modelInput.value = profile.model;
    readSettingsFromUI();
  });
}
root.querySelector('#auto-musings-context-mode')?.addEventListener('change', updateUI);
root.querySelector('#auto-musings-test')?.addEventListener('click', () => {
musingLoop(true).catch((error) => console.error('[Auto Musings] \u6d4b\u8bd5\u5931\u8d25:', error));
});
root.querySelector('#auto-musings-check')?.addEventListener('click', () => {
checkIdle();
if (typeof window.toastr?.info === 'function') window.toastr.info('\u5df2\u68c0\u67e5\u5f53\u524d\u804a\u5929\u72b6\u6001');
});
root.querySelector('#auto-musings-forum-test')?.addEventListener('click', async () => {
  try {
    readSettingsFromUI();
    await syncServerState();
    await serverRequest('/forum/run');
    window.toastr?.info?.('论坛只读流程已启动；结果和报错会出现在浮动漫想台');
    toggleFloatingWindow(true);
  } catch (error) {
    recordDiagnostic(error, {
      stage: 'forum_discover',
      preservation: '尚未启动的论坛任务不会伪装成成功；已有历史日志不受影响。',
      retry: '检查面板设置后再由你手动点击测试。',
    });
    window.toastr?.error?.(`论坛测试启动失败：${error.message}`);
    toggleFloatingWindow(true);
  }
});
root.querySelector('#auto-musings-forum-retry')?.addEventListener('click', async () => {
  try {
    readSettingsFromUI();
    await syncServerState();
    await serverRequest('/forum/retry');
    window.toastr?.info?.('已使用当前面板配置重试上次论坛任务');
    toggleFloatingWindow(true);
  } catch (error) {
    recordDiagnostic(error, {
      stage: 'forum_discover',
      preservation: '原待重试任务仍留在服务器，不会被这次启动失败覆盖。',
      retry: '修正设置后再手动点击“重试上次失败任务”。',
    });
    window.toastr?.error?.(`重试失败：${error.message}`);
    toggleFloatingWindow(true);
  }
});
root.querySelector('#auto-musings-open-console')?.addEventListener('click', () => {
toggleFloatingWindow(true);
});
fillSettingsUI();
}

function addSettingsPanel(attempt = 0) {
if (document.getElementById(ROOT_ID)) return true;
const target = document.getElementById('extensions_settings2')
  || document.getElementById('extensions_settings')
  || document.getElementById('rm_extensions_block')
  || document.querySelector('[data-extension-settings]');
if (!target) {
if (attempt < INIT_MAX_ATTEMPTS) {
  setTimeout(() => addSettingsPanel(attempt + 1), INIT_RETRY_INTERVAL_MS);
} else {
  console.error('[Auto Musings] Settings container was not found');
}
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
if (attempt < INIT_MAX_ATTEMPTS) {
  setTimeout(() => addMenuButton(attempt + 1), INIT_RETRY_INTERVAL_MS);
}
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
if (eventTypes.CHAT_COMPLETION_PROMPT_READY) {
  source.on(eventTypes.CHAT_COMPLETION_PROMPT_READY, capturePromptSnapshot);
}
if (eventTypes.CHARACTER_MESSAGE_RENDERED) {
  source.on(eventTypes.CHARACTER_MESSAGE_RENDERED, () => scheduleServerSync(250));
}
if (eventTypes.MESSAGE_RECEIVED && eventTypes.MESSAGE_RECEIVED !== eventTypes.CHARACTER_MESSAGE_RENDERED) {
  source.on(eventTypes.MESSAGE_RECEIVED, () => scheduleServerSync(250));
}
if (eventTypes.APP_READY) source.on(eventTypes.APP_READY, () => {
  addSettingsPanel();
  addMenuButton();
  createFloatingUI();
});
window.addEventListener('focus', () => {
  createFloatingUI();
  scheduleServerSync(100);
});
window.addEventListener('pageshow', createFloatingUI);
window.addEventListener('resize', scheduleFloatingPositionRepair);
window.addEventListener('orientationchange', scheduleFloatingPositionRepair);
window.addEventListener('scroll', scheduleFloatingPositionRepair, true);
window.visualViewport?.addEventListener('resize', scheduleFloatingPositionRepair);
window.visualViewport?.addEventListener('scroll', scheduleFloatingPositionRepair);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    createFloatingUI();
    scheduleServerSync(100);
    resumeFrontendTimers();
  } else {
    suspendFrontendTimers();
  }
});
}

function init(ctx) {
if (state.initialized) return true;
state.initialized = true;
try {
state.ctx = ctx;
ensureSettings(state.ctx);
addSettingsPanel();
addMenuButton();
createFloatingUI();
bindEvents();
restartTimers();
void initializeServerBridge();
setTimeout(checkIdle, 3000);
state.uiRefreshTimer = setInterval(() => {
createFloatingUI();
updateUI();
updateFloatingWindowUI();
}, 5000);

  globalThis.AutoMusings = {
    openSettings,
    openConsole: () => toggleFloatingWindow(true),
    checkNow: checkIdle,
    test: () => musingLoop(true),
    getState: () => ({
      version: EXTENSION_VERSION,
      enabled: state.settings.enabled,
      isIdle: state.isIdle,
      generating: state.generating,
      lastCheckAt: state.lastCheckAt,
      lastMessageTime: state.lastMessageTime,
      lastMusing: state.lastMusing ? { ...state.lastMusing } : null,
      lastEvent: state.lastEvent,
      serverAvailable: state.serverAvailable,
      serverStatus: state.serverStatus ? { ...state.serverStatus } : null,
      promptSnapshotAt: state.promptSnapshotAt,
      promptSnapshotMessages: state.promptSnapshot.length,
      settings: { ...state.settings },
    }),
  };
  recordEvent('Auto Musings \u5df2\u52a0\u8f7d');
  return true;
} catch (error) {
  state.initialized = false;
  console.error('[Auto Musings] \u521d\u59cb\u5316\u5931\u8d25:', error);
  return false;
}
}

function bootstrap(attempt = 0) {
if (state.initialized) return;
const ctx = globalThis.SillyTavern?.getContext?.();
if (ctx && document.body) {
  if (!init(ctx) && attempt < INIT_MAX_ATTEMPTS) {
    setTimeout(() => bootstrap(attempt + 1), INIT_RETRY_INTERVAL_MS);
  }
  return;
}

if (attempt < INIT_MAX_ATTEMPTS) {
  setTimeout(() => bootstrap(attempt + 1), INIT_RETRY_INTERVAL_MS);
} else {
  console.error('[Auto Musings] Timed out while waiting for SillyTavern context');
}
}

bootstrap();
})();
