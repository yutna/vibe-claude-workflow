'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const hook = require('../.claude/hooks/scripts/workflow_hook.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wfhook-test-'));
}

function writeState(dir, state) {
  const stateDir = path.join(dir, '.claude');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'workflow-state.json'), JSON.stringify(state, null, 2));
}

function readState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'workflow-state.json'), 'utf8'));
}

function makeState(overrides = {}) {
  return hook.deepMerge(hook.deepCopyDefaultState(), overrides);
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// deepCopyDefaultState
// ---------------------------------------------------------------------------

describe('deepCopyDefaultState', () => {
  it('returns a fresh copy each call', () => {
    const a = hook.deepCopyDefaultState();
    const b = hook.deepCopyDefaultState();
    assert.deepEqual(a, b);
    a.phase = 'planning';
    assert.notEqual(a.phase, b.phase);
  });

  it('has the correct schema version', () => {
    assert.equal(hook.deepCopyDefaultState().version, hook.SCHEMA_VERSION);
  });
});

// ---------------------------------------------------------------------------
// deepMerge
// ---------------------------------------------------------------------------

describe('deepMerge', () => {
  it('merges nested objects recursively', () => {
    const base = { a: { b: 1, c: 2 }, d: 3 };
    const patch = { a: { c: 99 }, e: 4 };
    const result = hook.deepMerge(base, patch);
    assert.deepEqual(result, { a: { b: 1, c: 99 }, d: 3, e: 4 });
  });

  it('overwrites arrays instead of merging them', () => {
    const base = { items: [1, 2, 3] };
    const patch = { items: [4] };
    assert.deepEqual(hook.deepMerge(base, patch), { items: [4] });
  });

  it('overwrites scalars', () => {
    assert.deepEqual(hook.deepMerge({ x: 1 }, { x: 2 }), { x: 2 });
  });

  it('does not mutate originals', () => {
    const base = { a: { b: 1 } };
    const patch = { a: { c: 2 } };
    hook.deepMerge(base, patch);
    assert.equal(base.a.c, undefined);
  });
});

// ---------------------------------------------------------------------------
// mergeKnownSections
// ---------------------------------------------------------------------------

describe('mergeKnownSections', () => {
  it('fills missing sections from defaults', () => {
    const result = hook.mergeKnownSections({}, { phase: 'planning' });
    assert.equal(result.phase, 'planning');
    assert.equal(result.requirements.status, 'needs-clarification');
    assert.deepEqual(result.implementation.filesTouched, []);
  });

  it('shallow-merges known sections (incoming overwrites base keys, unmentioned keys kept from base)', () => {
    const base = makeState({ delivery: { status: 'blocked', notes: 'stale note' } });
    const incoming = { delivery: { status: 'ready-for-review' } };
    const result = hook.mergeKnownSections(base, incoming);
    assert.equal(result.delivery.status, 'ready-for-review');
    // notes is preserved from base because shallow merge spreads defaults, then base, then incoming
    assert.equal(result.delivery.notes, 'stale note');
  });
});

// ---------------------------------------------------------------------------
// validateState
// ---------------------------------------------------------------------------

describe('validateState', () => {
  it('accepts a valid default state', () => {
    assert.deepEqual(hook.validateState(hook.deepCopyDefaultState()), []);
  });

  it('rejects invalid phase', () => {
    const state = makeState({ phase: 'bogus' });
    const errors = hook.validateState(state);
    assert.ok(errors.some((e) => e.includes('phase')));
  });

  it('rejects invalid requirements.status', () => {
    const state = makeState({ requirements: { status: 'nope' } });
    const errors = hook.validateState(state);
    assert.ok(errors.some((e) => e.includes('requirements.status')));
  });

  it('rejects invalid plan.status', () => {
    const state = makeState({ plan: { status: 'yolo' } });
    const errors = hook.validateState(state);
    assert.ok(errors.some((e) => e.includes('plan.status')));
  });

  it('rejects invalid implementation.status', () => {
    const state = makeState({ implementation: { status: 'running' } });
    const errors = hook.validateState(state);
    assert.ok(errors.some((e) => e.includes('implementation.status')));
  });

  it('rejects negative retryCount', () => {
    const state = makeState({ implementation: { retryCount: -1 } });
    const errors = hook.validateState(state);
    assert.ok(errors.some((e) => e.includes('retryCount')));
  });

  it('rejects invalid gate status', () => {
    const state = makeState({ qualityGates: { typecheck: 'green' } });
    const errors = hook.validateState(state);
    assert.ok(errors.some((e) => e.includes('qualityGates.typecheck')));
  });

  it('rejects invalid delivery.status', () => {
    const state = makeState({ delivery: { status: 'shipped' } });
    const errors = hook.validateState(state);
    assert.ok(errors.some((e) => e.includes('delivery.status')));
  });

  it('rejects non-boolean userApproved', () => {
    const state = makeState({ delivery: { userApproved: 'yes' } });
    const errors = hook.validateState(state);
    assert.ok(errors.some((e) => e.includes('userApproved')));
  });

  it('rejects non-string arrays in acceptanceCriteria', () => {
    const state = makeState({ requirements: { acceptanceCriteria: [1, 2] } });
    const errors = hook.validateState(state);
    assert.ok(errors.some((e) => e.includes('acceptanceCriteria')));
  });
});

// ---------------------------------------------------------------------------
// validateStateTransition
// ---------------------------------------------------------------------------

describe('validateStateTransition', () => {
  it('allows advancing one phase forward', () => {
    const old = makeState({ phase: 'discovery', requirements: { status: 'approved' } });
    const next = makeState({ phase: 'planning', requirements: { status: 'approved' } });
    assert.deepEqual(hook.validateStateTransition(old, next), []);
  });

  it('blocks skipping forward more than one phase', () => {
    const old = makeState({ phase: 'discovery', requirements: { status: 'approved' } });
    const next = makeState({ phase: 'implementation', requirements: { status: 'approved' }, plan: { status: 'approved' } });
    const errors = hook.validateStateTransition(old, next);
    assert.ok(errors.some((e) => e.includes('skip forward')));
  });

  it('allows jumping backward any distance', () => {
    const old = makeState({
      phase: 'delivery',
      requirements: { status: 'approved' },
      plan: { status: 'approved' },
      qualityGates: { typecheck: 'passed', lint: 'passed', tests: 'passed', verification: 'passed' },
    });
    const next = makeState({ phase: 'discovery' });
    assert.deepEqual(hook.validateStateTransition(old, next), []);
  });

  it('requires clarified requirements for planning', () => {
    const old = makeState({ phase: 'discovery' });
    const next = makeState({ phase: 'planning', requirements: { status: 'needs-clarification' } });
    const errors = hook.validateStateTransition(old, next);
    assert.ok(errors.some((e) => e.includes('clarified requirements')));
  });

  it('requires approved plan for implementation', () => {
    const old = makeState({ phase: 'planning', requirements: { status: 'approved' } });
    const next = makeState({
      phase: 'implementation',
      requirements: { status: 'approved' },
      plan: { status: 'proposed' },
    });
    const errors = hook.validateStateTransition(old, next);
    assert.ok(errors.some((e) => e.includes('plan.status = approved')));
  });

  it('requires green gates for delivery', () => {
    const old = makeState({
      phase: 'verification',
      requirements: { status: 'approved' },
      plan: { status: 'approved' },
    });
    const next = makeState({
      phase: 'delivery',
      requirements: { status: 'approved' },
      plan: { status: 'approved' },
      qualityGates: { typecheck: 'passed', lint: 'passed', tests: 'failed', verification: 'passed' },
    });
    const errors = hook.validateStateTransition(old, next);
    assert.ok(errors.some((e) => e.includes('quality gates')));
  });

  it('requires userApproved for delivery.status=approved', () => {
    const old = makeState({
      phase: 'delivery',
      requirements: { status: 'approved' },
      plan: { status: 'approved' },
      qualityGates: { typecheck: 'passed', lint: 'passed', tests: 'passed', verification: 'passed' },
      delivery: { status: 'ready-for-review', userApproved: false },
    });
    const next = makeState({
      phase: 'delivery',
      requirements: { status: 'approved' },
      plan: { status: 'approved' },
      qualityGates: { typecheck: 'passed', lint: 'passed', tests: 'passed', verification: 'passed' },
      delivery: { status: 'approved', userApproved: false },
    });
    const errors = hook.validateStateTransition(old, next);
    assert.ok(errors.some((e) => e.includes('userApproved')));
  });

  it('enforces retry budget — must set blocked + record blocker', () => {
    const old = makeState({
      phase: 'implementation',
      requirements: { status: 'approved' },
      plan: { status: 'approved' },
      implementation: { retryCount: 2, status: 'in-progress' },
    });
    const next = makeState({
      phase: 'implementation',
      requirements: { status: 'approved' },
      plan: { status: 'approved' },
      implementation: { retryCount: 3, status: 'in-progress', blockedItems: [] },
    });
    const errors = hook.validateStateTransition(old, next);
    assert.ok(errors.some((e) => e.includes('retry budget')));
    assert.ok(errors.some((e) => e.includes('blockedItems')));
  });

  it('allows retry budget exhaustion when blocked + blocker recorded', () => {
    const old = makeState({
      phase: 'implementation',
      requirements: { status: 'approved' },
      plan: { status: 'approved' },
      implementation: { retryCount: 2, status: 'in-progress' },
    });
    const next = makeState({
      phase: 'implementation',
      requirements: { status: 'approved' },
      plan: { status: 'approved' },
      implementation: { retryCount: 3, status: 'blocked', blockedItems: ['Test fix failed 3 times'] },
    });
    assert.deepEqual(hook.validateStateTransition(old, next), []);
  });
});

// ---------------------------------------------------------------------------
// formatGateSummary
// ---------------------------------------------------------------------------

describe('formatGateSummary', () => {
  it('formats all gates', () => {
    const state = makeState({
      qualityGates: { typecheck: 'passed', lint: 'failed', tests: 'pending', verification: 'not-applicable' },
    });
    const summary = hook.formatGateSummary(state);
    assert.ok(summary.includes('typecheck=passed'));
    assert.ok(summary.includes('lint=failed'));
    assert.ok(summary.includes('tests=pending'));
    assert.ok(summary.includes('verification=not-applicable'));
  });
});

// ---------------------------------------------------------------------------
// saveState / loadState / readStateStrict (file I/O)
// ---------------------------------------------------------------------------

describe('saveState and loadState', () => {
  let dir;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { cleanup(dir); });

  it('round-trips a valid state', () => {
    const state = makeState({ phase: 'planning', requirements: { status: 'approved' } });
    const [saved, errors] = hook.saveState(dir, state);
    assert.deepEqual(errors, []);
    assert.equal(saved.phase, 'planning');
    assert.ok(saved.lastUpdated);

    const loaded = hook.loadState(dir);
    assert.equal(loaded.phase, 'planning');
  });

  it('rejects an invalid state on save', () => {
    const state = makeState({ phase: 'bogus' });
    const [saved, errors] = hook.saveState(dir, state);
    assert.equal(saved, null);
    assert.ok(errors.length > 0);
  });

  it('returns default state when file missing', () => {
    const loaded = hook.loadState(dir);
    assert.equal(loaded.phase, 'discovery');
  });
});

describe('readStateStrict', () => {
  let dir;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { cleanup(dir); });

  it('returns errors for corrupt JSON', () => {
    const stateDir = path.join(dir, '.claude');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'workflow-state.json'), '{bad json}');
    const [state, errors] = hook.readStateStrict(dir);
    assert.equal(state, null);
    assert.ok(errors.some((e) => e.includes('not valid JSON')));
  });

  it('returns state for valid file', () => {
    const original = makeState({ phase: 'implementation', requirements: { status: 'approved' }, plan: { status: 'approved' } });
    writeState(dir, original);
    const [state, errors] = hook.readStateStrict(dir);
    assert.deepEqual(errors, []);
    assert.equal(state.phase, 'implementation');
  });
});

// ---------------------------------------------------------------------------
// updateStateMode (the state API entry point)
// Uses execFileSync to invoke the CLI in a subprocess so we don't interfere
// with the TAP reporter by monkey-patching process.stdout.write.
// ---------------------------------------------------------------------------

const { execFileSync } = require('node:child_process');
const HOOK_SCRIPT = path.resolve(__dirname, '..', '.claude', 'hooks', 'scripts', 'workflow_hook.cjs');

function runUpdateState(dir, ...args) {
  const out = execFileSync(process.execPath, [HOOK_SCRIPT, 'update-state', ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 5000,
  });
  return JSON.parse(out.trim());
}

function runValidateState(dir) {
  const out = execFileSync(process.execPath, [HOOK_SCRIPT, 'validate-state'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 5000,
  });
  return JSON.parse(out.trim());
}

describe('updateStateMode', () => {
  let dir;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { cleanup(dir); });

  it('applies a valid patch', () => {
    const baseline = makeState({ phase: 'discovery', requirements: { status: 'approved' } });
    hook.saveState(dir, baseline);

    const result = runUpdateState(dir, 'phase=planning');
    assert.equal(result.saved, true);
    assert.equal(result.state.phase, 'planning');
  });

  it('rejects an invalid transition', () => {
    const baseline = makeState({ phase: 'discovery', requirements: { status: 'approved' } });
    hook.saveState(dir, baseline);

    const result = runUpdateState(dir, 'phase=implementation');
    assert.equal(result.saved, false);
    assert.ok(result.errors.length > 0);
  });

  it('clears stale delivery.notes on transition to ready-for-review', () => {
    const deliveryReady = makeState({
      phase: 'delivery',
      requirements: { status: 'approved' },
      plan: { status: 'approved' },
      implementation: { status: 'completed' },
      qualityGates: { typecheck: 'passed', lint: 'passed', tests: 'passed', verification: 'passed' },
      delivery: { status: 'blocked', notes: 'Implementation changed after prior validation.' },
    });
    hook.saveState(dir, deliveryReady);

    const result = runUpdateState(dir, 'delivery.status=ready-for-review');
    assert.equal(result.saved, true);
    assert.equal(result.state.delivery.notes, '');
  });

  it('preserves delivery.notes when caller explicitly sets them', () => {
    const deliveryReady = makeState({
      phase: 'delivery',
      requirements: { status: 'approved' },
      plan: { status: 'approved' },
      implementation: { status: 'completed' },
      qualityGates: { typecheck: 'passed', lint: 'passed', tests: 'passed', verification: 'passed' },
      delivery: { status: 'blocked', notes: 'old note' },
    });
    hook.saveState(dir, deliveryReady);

    const result = runUpdateState(dir, 'delivery.status=ready-for-review', 'delivery.notes=custom note');
    assert.equal(result.saved, true);
    assert.equal(result.state.delivery.notes, 'custom note');
  });
});

// ---------------------------------------------------------------------------
// validateStateMode
// ---------------------------------------------------------------------------

describe('validateStateMode', () => {
  let dir;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { cleanup(dir); });

  it('reports valid for a correct state', () => {
    hook.saveState(dir, hook.deepCopyDefaultState());
    const result = runValidateState(dir);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it('reports invalid for corrupt file', () => {
    const stateDir = path.join(dir, '.claude');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'workflow-state.json'), 'not json');
    const result = runValidateState(dir);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });
});
