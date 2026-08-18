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
  determineMusingDecision,
  musingLoop,
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
};

vm.runInNewContext(instrumentedSource, sandbox, { filename: 'index.js' });

const policy = sandbox.__autoMusingsPolicy;

beforeEach(() => {
  policy.state.settings = { pushMode: 'dynamic' };
  policy.state.idleStartTime = null;
  policy.state.isIdle = false;
  policy.state.pageSuspended = false;
  policy.state.musingInFlight = false;
  policy.state.generating = false;
  policy.state.lastMusing = null;
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
