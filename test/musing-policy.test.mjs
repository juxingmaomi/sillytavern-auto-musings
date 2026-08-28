import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { beforeEach } from 'node:test';
import vm from 'node:vm';

const HOUR = 60 * 60 * 1000;
const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const bootstrapMarker = '\nbootstrap();\n})();';

assert.ok(source.includes(bootstrapMarker), 'index.js bootstrap marker changed');

const instrumentedSource = source.replace(bootstrapMarker, `
globalThis.__autoMusingsPolicy = {
  state,
  getPushThreshold,
  startPushCurve,
  resetPushCurve,
  pausePushCurve,
  resumePushCurve,
  getCurrentCharacter,
  getCurrentWorldName,
  saveHiddenMusingToWorldBook,
  generateHiddenMusing,
  getRandomChatSnippet,
  extractModelIds,
  isCompatibleServerVersion,
  validateIndependentSecondaryConfig,
  storeSecondaryApiKey,
  determineMusingDecision,
  musingLoop,
  setSecondaryDependencies(dependencies) {
    if (dependencies.serverRequest) serverRequest = dependencies.serverRequest;
    if (dependencies.coreApiRequest) coreApiRequest = dependencies.coreApiRequest;
    if (dependencies.getConnectionProfile) getConnectionProfile = dependencies.getConnectionProfile;
  },
  setMusingLoopDependencies(dependencies) {
    rollMusing = dependencies.rollMusing;
    generateHiddenMusing = dependencies.generateHiddenMusing;
    triggerMusing = dependencies.triggerMusing;
    saveHiddenMusingToWorldBook = dependencies.saveHiddenMusingToWorldBook;
    getConnectionProfile = dependencies.getConnectionProfile;
    pushLogEntry = dependencies.pushLogEntry;
    recordEvent = dependencies.recordEvent;
    recordDiagnostic = dependencies.recordDiagnostic;
    maybeTriggerForumFromMusing = dependencies.maybeTriggerForumFromMusing;
    updateUI = dependencies.updateUI;
  },
};
})();`);

const sandbox = {
  console: { log() {}, warn() {}, error() {} },
  document: { visibilityState: 'visible' },
  URL,
};

vm.runInNewContext(instrumentedSource, sandbox, { filename: 'index.js' });

const policy = sandbox.__autoMusingsPolicy;

beforeEach(() => {
  sandbox.SillyTavern = undefined;
  policy.state.ctx = null;
  policy.state.settings = { pushMode: 'dynamic' };
  policy.state.idleStartTime = null;
  policy.state.isIdle = false;
  policy.state.pageSuspended = false;
  policy.state.musingInFlight = false;
  policy.state.generating = false;
  policy.state.lastMusing = null;
  policy.state.serverAvailable = false;
  policy.state.serverVersion = '';
  policy.state.secondaryKeyStatus = null;
  policy.state.uiReady = false;
  policy.resetPushCurve();
});

test('dynamic curve starts cautiously regardless of the real idle duration', () => {
  const startedAt = 10 * HOUR;
  policy.state.idleStartTime = startedAt - (12 * HOUR);
  policy.startPushCurve(startedAt);

  assert.equal(policy.getPushThreshold(startedAt), 0.8);
  assert.equal(policy.getPushThreshold(startedAt + (30 * 60 * 1000)), 0.6);
  assert.equal(policy.getPushThreshold(startedAt + HOUR), 0.4);
  assert.equal(policy.getPushThreshold(startedAt + (3 * HOUR)), 0.2);
});

test('resetting the curve returns the dynamic threshold to 0.8', () => {
  const startedAt = 20 * HOUR;
  policy.startPushCurve(startedAt);
  assert.equal(policy.getPushThreshold(startedAt + (4 * HOUR)), 0.2);

  policy.resetPushCurve();
  assert.equal(policy.getPushThreshold(startedAt + (4 * HOUR)), 0.8);
});

test('pausing excludes hidden-page time from the dynamic curve', () => {
  const startedAt = 30 * HOUR;
  policy.startPushCurve(startedAt);
  policy.pausePushCurve(startedAt + (10 * 60 * 1000));

  assert.equal(policy.getPushThreshold(startedAt + (5 * HOUR)), 0.8);

  policy.resumePushCurve(startedAt + (2 * HOUR) + (10 * 60 * 1000));
  assert.equal(policy.getPushThreshold(startedAt + (2 * HOUR) + (30 * 60 * 1000)), 0.6);
});

test('idle rolls never become visible or hidden API work in any push mode', () => {
  for (const pushMode of ['dynamic', 'balanced', 'frequent']) {
    policy.state.settings.pushMode = pushMode;
    assert.equal(policy.determineMusingDecision('idle'), 'idle');
    assert.equal(policy.determineMusingDecision('idle', { manual: true }), 'idle');
    assert.equal(policy.determineMusingDecision('idle', { manual: true, forceHidden: true }), 'idle');
  }
});

test('automatic non-idle rolls follow the dynamic threshold', () => {
  assert.equal(policy.determineMusingDecision('context', { threshold: 0.8 }), 'hold');
  assert.equal(policy.determineMusingDecision('freeform', { threshold: 0.8 }), 'hold');
  assert.equal(policy.determineMusingDecision('context', { threshold: 0.6 }), 'push');
  assert.equal(policy.determineMusingDecision('freeform', { threshold: 0.6 }), 'hold');
  assert.equal(policy.determineMusingDecision('context', { threshold: 0.4 }), 'push');
  assert.equal(policy.determineMusingDecision('freeform', { threshold: 0.4 }), 'push');
});

test('manual visible and hidden tests cannot cross delivery paths', () => {
  assert.equal(policy.determineMusingDecision('freeform', { manual: true }), 'push');
  assert.equal(policy.determineMusingDecision('context', { manual: true }), 'push');
  assert.equal(policy.determineMusingDecision('freeform', { manual: true, forceHidden: true }), 'hold');
  assert.equal(policy.determineMusingDecision('context', { manual: true, forceHidden: true }), 'hold');
});

test('worldbook lookup refreshes a context captured before the character loaded', () => {
  policy.state.ctx = { characterId: undefined, characters: [] };
  sandbox.SillyTavern = {
    getContext: () => ({
      characterId: 0,
      characters: [{
        name: '小克',
        data: { extensions: { world: '小克' } },
      }],
    }),
  };

  assert.equal(policy.getCurrentCharacter().name, '小克');
  assert.equal(policy.getCurrentWorldName(), '小克');
});

test('hidden musings use the live context worldbook APIs and binding', async () => {
  let loadedWorld = '';
  let savedWorld = '';
  let savedData = null;
  policy.state.ctx = {
    characterId: undefined,
    characters: [],
    loadWorldInfo: async () => { throw new Error('stale context used'); },
  };
  sandbox.SillyTavern = {
    getContext: () => ({
      characterId: 0,
      name2: '小克',
      characters: [{
        name: '小克',
        data: { extensions: { world: '小克' } },
      }],
      loadWorldInfo: async (name) => {
        loadedWorld = name;
        return { entries: {} };
      },
      saveWorldInfo: async (name, data, immediately) => {
        savedWorld = name;
        savedData = data;
        assert.equal(immediately, true);
      },
    }),
  };

  const result = await policy.saveHiddenMusingToWorldBook({
    ts: Date.UTC(2026, 7, 19, 0, 0, 0),
    type: 'freeform',
    content: '存在主义',
    thought: '一段留在心里的念头',
  });

  assert.equal(result.saved, true);
  assert.equal(loadedWorld, '小克');
  assert.equal(savedWorld, '小克');
  const entry = Object.values(savedData.entries)[0];
  assert.match(entry.content, /一段留在心里的念头/);
  assert.equal(entry.disable, true);
});

test('random historical snippets keep the complete original message', () => {
  const fullMessage = '<ambience>安静</ambience>\n\n' + '完整的正文应当原样传递，不能在动作或标签中间截断。'.repeat(12);
  const chat = [
    { mes: fullMessage, is_user: false, name: '小克', send_date: '2026-08-28 03:38:00' },
    ...Array.from({ length: 10 }, (_, index) => ({
      mes: `最近消息 ${index}`,
      is_user: index % 2 === 0,
      name: index % 2 === 0 ? '薇薇' : '小克',
      send_date: `2026-08-28 10:${String(index).padStart(2, '0')}:00`,
    })),
  ];
  policy.state.ctx = {
    name1: '薇薇',
    name2: '小克',
    chat,
  };

  const snippet = policy.getRandomChatSnippet();

  assert.ok(snippet);
  assert.equal(snippet.role, 'assistant');
  assert.equal(snippet.content, fullMessage);
  assert.equal(snippet.content.includes('[Excerpt truncated here.]'), false);
});

test('an automatic idle roll exits before either API path', async () => {
  let hiddenCalls = 0;
  let visibleCalls = 0;
  let logCalls = 0;
  policy.setMusingLoopDependencies({
    rollMusing: async () => ({ type: 'idle', content: 'idle' }),
    generateHiddenMusing: async () => { hiddenCalls += 1; },
    triggerMusing: async () => { visibleCalls += 1; },
    saveHiddenMusingToWorldBook: async () => ({ saved: true }),
    getConnectionProfile: () => ({}),
    pushLogEntry: () => { logCalls += 1; },
    recordEvent: () => {},
    recordDiagnostic: () => {},
    maybeTriggerForumFromMusing: async () => {},
    updateUI: () => {},
  });
  policy.state.settings = { enabled: true, pushMode: 'dynamic' };
  policy.state.isIdle = true;
  policy.startPushCurve();

  const result = await policy.musingLoop();

  assert.equal(result, false);
  assert.equal(hiddenCalls, 0);
  assert.equal(visibleCalls, 0);
  assert.equal(logCalls, 1);
  assert.equal(policy.state.lastMusing.decision, 'idle');
  assert.equal(policy.state.lastMusing.status, 'idle');
});

test('an automatic hold roll uses only the hidden API path', async () => {
  let hiddenCalls = 0;
  let visibleCalls = 0;
  let worldBookCalls = 0;
  policy.setMusingLoopDependencies({
    rollMusing: async () => ({ type: 'freeform', content: 'seed' }),
    generateHiddenMusing: async () => {
      hiddenCalls += 1;
      return 'private thought';
    },
    triggerMusing: async () => {
      visibleCalls += 1;
      return true;
    },
    saveHiddenMusingToWorldBook: async () => {
      worldBookCalls += 1;
      return { saved: true };
    },
    getConnectionProfile: () => ({ name: 'secondary' }),
    pushLogEntry: () => {},
    recordEvent: () => {},
    recordDiagnostic: () => {},
    maybeTriggerForumFromMusing: async () => {},
    updateUI: () => {},
  });
  policy.state.settings = {
    enabled: true,
    pushMode: 'dynamic',
    secondaryProfileId: 'secondary',
    secondaryModel: '',
  };
  policy.state.isIdle = true;
  policy.startPushCurve();

  const result = await policy.musingLoop();

  assert.equal(result, false);
  assert.equal(hiddenCalls, 1);
  assert.equal(visibleCalls, 0);
  assert.equal(worldBookCalls, 1);
  assert.equal(policy.state.lastMusing.decision, 'hold');
  assert.equal(policy.state.lastMusing.status, 'hidden_saved');
});

test('profile mode keeps using ConnectionManagerRequestService with its bound secret', async () => {
  let captured = null;
  const profile = {
    id: 'secondary-profile',
    name: 'Secondary',
    model: 'profile-model',
    'secret-id': 'profile-secret',
  };
  policy.setSecondaryDependencies({ getConnectionProfile: () => profile });
  policy.state.settings = {
    secondaryApiMode: 'profile',
    secondaryProfileId: profile.id,
    secondaryModel: 'override-model',
    hiddenMaxTokens: 500,
    contextMode: 'default',
  };
  policy.state.ctx = {
    name2: '小克',
    ConnectionManagerRequestService: {
      sendRequest: async (...args) => {
        captured = args;
        return { content: 'profile thought' };
      },
    },
  };

  const result = await policy.generateHiddenMusing({ type: 'freeform', content: 'seed' });

  assert.equal(result, 'profile thought');
  assert.equal(captured[0], profile.id);
  assert.equal(captured[2], 500);
  assert.equal(captured[4].model, 'override-model');
  assert.equal(captured[4].secret_id, 'profile-secret');
});

test('independent mode sends its URL, exact secret ID and model to the companion', async () => {
  let captured = null;
  policy.setSecondaryDependencies({
    serverRequest: async (pathname, body) => {
      captured = { pathname, body };
      return { content: 'independent thought' };
    },
  });
  policy.state.serverAvailable = true;
  policy.state.serverVersion = '1.5.8';
  policy.state.settings = {
    secondaryApiMode: 'independent',
    secondaryApiUrl: 'https://secondary.example/v1',
    secondarySecretId: 'secondary-secret-id',
    secondaryIndependentModel: 'secondary-model',
    hiddenMaxTokens: 640,
    contextMode: 'default',
  };
  policy.state.ctx = { name2: '小克' };

  const result = await policy.generateHiddenMusing({ type: 'freeform', content: 'seed' });

  assert.equal(result, 'independent thought');
  assert.equal(captured.pathname, '/secondary/generate');
  assert.equal(captured.body.apiUrl, 'https://secondary.example/v1');
  assert.equal(captured.body.secretId, 'secondary-secret-id');
  assert.equal(captured.body.model, 'secondary-model');
  assert.equal(captured.body.maxTokens, 640);
  assert.equal(captured.body.messages.length, 2);
});

test('independent mode rejects incomplete settings before making a request', () => {
  policy.state.serverAvailable = true;
  policy.state.serverVersion = '1.5.8';
  policy.state.settings = {
    secondaryApiUrl: 'https://secondary.example/v1',
    secondarySecretId: 'secondary-secret-id',
    secondaryIndependentModel: '',
  };

  assert.throws(
    () => policy.validateIndependentSecondaryConfig(),
    (error) => error.code === 'secondary_api_model_missing',
  );
});

test('model parser supports OpenAI, models-array and direct-array responses', () => {
  assert.deepEqual(
    Array.from(policy.extractModelIds({ data: [{ id: 'b' }, { id: 'a' }] })),
    ['a', 'b'],
  );
  assert.deepEqual(
    Array.from(policy.extractModelIds({ models: [{ name: 'model-c' }, 'model-d'] })),
    ['model-c', 'model-d'],
  );
  assert.deepEqual(
    Array.from(policy.extractModelIds([{ model: 'model-e' }, { id: 'model-f' }])),
    ['model-e', 'model-f'],
  );
});

test('saving an independent key restores the previous global key and preserves imported secrets', async () => {
  const calls = [];
  let readCount = 0;
  policy.setSecondaryDependencies({
    coreApiRequest: async (pathname, body) => {
      calls.push({ pathname, body });
      if (pathname === '/api/secrets/read') {
        readCount += 1;
        return {
          api_key_custom: readCount === 1
            ? [
              { id: 'main-key', active: true, label: 'Main' },
              { id: 'imported-key', active: false, label: 'Imported' },
            ]
            : [
              { id: 'main-key', active: true, label: 'Main' },
              { id: 'imported-key', active: false, label: 'Imported' },
              { id: 'new-key', active: false, label: 'Auto Musings' },
            ],
        };
      }
      if (pathname === '/api/secrets/write') return { id: 'new-key' };
      return {};
    },
  });
  policy.state.settings = {
    secondarySecretId: 'imported-key',
    secondarySecretManaged: false,
  };
  policy.state.ctx = { saveSettingsDebounced() {} };

  const id = await policy.storeSecondaryApiKey('private-key-value');

  assert.equal(id, 'new-key');
  assert.equal(policy.state.settings.secondarySecretId, 'new-key');
  assert.equal(policy.state.settings.secondarySecretManaged, true);
  assert.ok(calls.some((call) => call.pathname === '/api/secrets/rotate' && call.body.id === 'main-key'));
  assert.equal(calls.some((call) => call.pathname === '/api/secrets/delete' && call.body.id === 'imported-key'), false);
});

test('updating a managed key never replaces it when it is the global active key', async () => {
  const calls = [];
  let readCount = 0;
  policy.setSecondaryDependencies({
    coreApiRequest: async (pathname, body) => {
      calls.push({ pathname, body });
      if (pathname === '/api/secrets/read') {
        readCount += 1;
        return {
          api_key_custom: readCount === 1
            ? [{ id: 'old-managed-key', active: true, label: 'Auto Musings old' }]
            : [
              { id: 'old-managed-key', active: true, label: 'Auto Musings old' },
              { id: 'new-managed-key', active: false, label: 'Auto Musings new' },
            ],
        };
      }
      if (pathname === '/api/secrets/write') return { id: 'new-managed-key' };
      return {};
    },
  });
  policy.state.settings = {
    secondarySecretId: 'old-managed-key',
    secondarySecretManaged: true,
  };
  policy.state.ctx = { saveSettingsDebounced() {} };

  await policy.storeSecondaryApiKey('replacement-value');

  assert.ok(calls.some((call) => call.pathname === '/api/secrets/rotate' && call.body.id === 'old-managed-key'));
  assert.equal(calls.some((call) => call.pathname === '/api/secrets/delete' && call.body.id === 'old-managed-key'), false);
  assert.equal(policy.state.settings.secondarySecretId, 'new-managed-key');
});

test('v1.5.9 frontend accepts the running 1.5.7 through 1.5.9 companions', () => {
  assert.equal(policy.isCompatibleServerVersion('1.5.7'), true);
  assert.equal(policy.isCompatibleServerVersion('1.5.8'), true);
  assert.equal(policy.isCompatibleServerVersion('1.5.9'), true);
  assert.equal(policy.isCompatibleServerVersion('1.5.6'), false);
  assert.equal(policy.isCompatibleServerVersion('2.0.0'), false);
});


