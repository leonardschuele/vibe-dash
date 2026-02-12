import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createPersistenceLayer } from '../src/persistence.js';

// ---------------------------------------------------------------------------
// localStorage polyfill (Node has no built-in localStorage)
// ---------------------------------------------------------------------------

function createMockStorage() {
  const store = new Map();
  return {
    getItem(key) { return store.get(key) ?? null; },
    setItem(key, value) { store.set(key, String(value)); },
    removeItem(key) { store.delete(key); },
    clear() { store.clear(); },
    get _store() { return store; }
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let storage;

beforeEach(() => {
  storage = createMockStorage();
  globalThis.localStorage = storage;
});

afterEach(() => {
  delete globalThis.localStorage;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWidget(overrides = {}) {
  return {
    id: 'w1',
    sourceId: 'test',
    title: 'Test',
    size: 'small',
    refreshIntervalMs: null,
    data: { secret: 'stuff' },
    lastUpdated: Date.now(),
    render: { type: 'generic', config: { type: 'generic' } },
    resolvedIntent: { action: 'create', subject: 'test', parameters: {}, raw: 'test' },
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// flush() — immediate write (easier to test than debounced save)
// ---------------------------------------------------------------------------

describe('flush', () => {
  it('writes widgets to localStorage immediately', () => {
    const p = createPersistenceLayer();
    const widget = makeWidget();

    p.flush([widget]);

    const raw = storage.getItem('vibe-dash-widgets');
    assert.ok(raw, 'should write to localStorage');
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].id, 'w1');
  });

  it('strips data and lastUpdated from persisted output', () => {
    const p = createPersistenceLayer();
    const widget = makeWidget({ data: { big: 'payload' }, lastUpdated: 999 });

    p.flush([widget]);

    const parsed = JSON.parse(storage.getItem('vibe-dash-widgets'));
    assert.strictEqual(parsed[0].data, undefined);
    assert.strictEqual(parsed[0].lastUpdated, undefined);
  });

  it('preserves id, sourceId, title, size, refreshIntervalMs, render, resolvedIntent', () => {
    const p = createPersistenceLayer();
    const widget = makeWidget({
      id: 'abc',
      sourceId: 'crypto',
      title: 'Bitcoin',
      size: 'large',
      refreshIntervalMs: 60000,
      render: { type: 'price-card', config: { type: 'price-card', coin: 'bitcoin' } },
      resolvedIntent: { action: 'create', subject: 'bitcoin', parameters: { coin: 'bitcoin' }, raw: 'btc' }
    });

    p.flush([widget]);

    const parsed = JSON.parse(storage.getItem('vibe-dash-widgets'));
    const w = parsed[0];
    assert.strictEqual(w.id, 'abc');
    assert.strictEqual(w.sourceId, 'crypto');
    assert.strictEqual(w.title, 'Bitcoin');
    assert.strictEqual(w.size, 'large');
    assert.strictEqual(w.refreshIntervalMs, 60000);
    assert.deepStrictEqual(w.render, widget.render);
    assert.deepStrictEqual(w.resolvedIntent, widget.resolvedIntent);
  });

  it('handles multiple widgets', () => {
    const p = createPersistenceLayer();
    p.flush([makeWidget({ id: 'a' }), makeWidget({ id: 'b' }), makeWidget({ id: 'c' })]);

    const parsed = JSON.parse(storage.getItem('vibe-dash-widgets'));
    assert.strictEqual(parsed.length, 3);
    assert.deepStrictEqual(parsed.map(w => w.id), ['a', 'b', 'c']);
  });

  it('handles empty array', () => {
    const p = createPersistenceLayer();
    p.flush([]);

    const parsed = JSON.parse(storage.getItem('vibe-dash-widgets'));
    assert.deepStrictEqual(parsed, []);
  });

  it('does not throw when localStorage.setItem fails', () => {
    const p = createPersistenceLayer();
    storage.setItem = () => { throw new Error('QuotaExceededError'); };

    assert.doesNotThrow(() => p.flush([makeWidget()]));
  });
});

// ---------------------------------------------------------------------------
// save() — debounced write
// ---------------------------------------------------------------------------

describe('save', () => {
  it('writes to localStorage after debounce delay', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = createPersistenceLayer();

    p.save([makeWidget()]);

    // Before debounce fires
    assert.strictEqual(storage.getItem('vibe-dash-widgets'), null);

    t.mock.timers.tick(500);

    // After debounce fires
    const parsed = JSON.parse(storage.getItem('vibe-dash-widgets'));
    assert.strictEqual(parsed.length, 1);
  });

  it('collapses multiple calls within debounce window', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = createPersistenceLayer();

    p.save([makeWidget({ id: 'first' })]);
    t.mock.timers.tick(200);
    p.save([makeWidget({ id: 'second' })]);
    t.mock.timers.tick(500);

    const parsed = JSON.parse(storage.getItem('vibe-dash-widgets'));
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].id, 'second');
  });

  it('does not throw when localStorage.setItem fails', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = createPersistenceLayer();
    storage.setItem = () => { throw new Error('QuotaExceededError'); };

    p.save([makeWidget()]);
    assert.doesNotThrow(() => t.mock.timers.tick(500));
  });
});

// ---------------------------------------------------------------------------
// load()
// ---------------------------------------------------------------------------

describe('load', () => {
  it('returns persisted widgets', () => {
    const widgets = [
      { id: 'w1', sourceId: 'test', title: 'A', size: 'small', refreshIntervalMs: null,
        render: { type: 'generic', config: { type: 'generic' } },
        resolvedIntent: { action: 'create', subject: 'a', parameters: {}, raw: 'a' } },
      { id: 'w2', sourceId: 'crypto', title: 'B', size: 'medium', refreshIntervalMs: 60000,
        render: { type: 'price-card', config: { type: 'price-card' } },
        resolvedIntent: { action: 'create', subject: 'b', parameters: {}, raw: 'b' } }
    ];
    storage.setItem('vibe-dash-widgets', JSON.stringify(widgets));

    const p = createPersistenceLayer();
    const loaded = p.load();

    assert.strictEqual(loaded.length, 2);
    assert.strictEqual(loaded[0].id, 'w1');
    assert.strictEqual(loaded[1].id, 'w2');
  });

  it('returns [] when nothing is stored', () => {
    const p = createPersistenceLayer();
    assert.deepStrictEqual(p.load(), []);
  });

  it('returns [] on corrupt JSON', () => {
    storage.setItem('vibe-dash-widgets', '{not valid json!!!');

    const p = createPersistenceLayer();
    assert.deepStrictEqual(p.load(), []);
  });

  it('returns [] when stored data is not an array', () => {
    storage.setItem('vibe-dash-widgets', JSON.stringify({ not: 'array' }));

    const p = createPersistenceLayer();
    assert.deepStrictEqual(p.load(), []);
  });

  it('filters out entries missing id', () => {
    const data = [
      { sourceId: 'test', title: 'no id' },
      { id: 'ok', sourceId: 'test', title: 'valid' }
    ];
    storage.setItem('vibe-dash-widgets', JSON.stringify(data));

    const p = createPersistenceLayer();
    const loaded = p.load();
    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0].id, 'ok');
  });

  it('filters out entries missing sourceId', () => {
    const data = [
      { id: 'w1', title: 'no sourceId' },
      { id: 'w2', sourceId: 'test', title: 'valid' }
    ];
    storage.setItem('vibe-dash-widgets', JSON.stringify(data));

    const p = createPersistenceLayer();
    const loaded = p.load();
    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0].id, 'w2');
  });

  it('filters out null entries', () => {
    const data = [null, { id: 'ok', sourceId: 'test' }];
    storage.setItem('vibe-dash-widgets', JSON.stringify(data));

    const p = createPersistenceLayer();
    const loaded = p.load();
    assert.strictEqual(loaded.length, 1);
  });
});

// ---------------------------------------------------------------------------
// clear()
// ---------------------------------------------------------------------------

describe('clear', () => {
  it('removes widget data from localStorage', () => {
    storage.setItem('vibe-dash-widgets', '[]');
    const p = createPersistenceLayer();

    p.clear();

    assert.strictEqual(storage.getItem('vibe-dash-widgets'), null);
  });

  it('cancels any pending debounced save', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = createPersistenceLayer();

    p.save([makeWidget()]);
    p.clear();
    t.mock.timers.tick(500);

    assert.strictEqual(storage.getItem('vibe-dash-widgets'), null);
  });
});

// ---------------------------------------------------------------------------
// round-trip: flush → load
// ---------------------------------------------------------------------------

describe('round-trip', () => {
  it('flush then load returns the same widgets (minus data/lastUpdated)', () => {
    const p = createPersistenceLayer();
    const original = makeWidget({
      id: 'rt1',
      sourceId: 'weather',
      title: 'Weather',
      size: 'medium',
      refreshIntervalMs: 300000,
      data: { temp: 72 },
      lastUpdated: 12345
    });

    p.flush([original]);
    const loaded = p.load();

    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0].id, 'rt1');
    assert.strictEqual(loaded[0].sourceId, 'weather');
    assert.strictEqual(loaded[0].title, 'Weather');
    assert.strictEqual(loaded[0].size, 'medium');
    assert.strictEqual(loaded[0].refreshIntervalMs, 300000);
    assert.strictEqual(loaded[0].data, undefined);
    assert.strictEqual(loaded[0].lastUpdated, undefined);
  });
});

// ---------------------------------------------------------------------------
// API key management
// ---------------------------------------------------------------------------

describe('API key', () => {
  it('getApiKey returns null when no key is stored', () => {
    const p = createPersistenceLayer();
    assert.strictEqual(p.getApiKey(), null);
  });

  it('setApiKey stores and getApiKey retrieves', () => {
    const p = createPersistenceLayer();
    p.setApiKey('sk-ant-test-key');
    assert.strictEqual(p.getApiKey(), 'sk-ant-test-key');
  });

  it('setApiKey with falsy value removes the key', () => {
    const p = createPersistenceLayer();
    p.setApiKey('sk-ant-test-key');
    p.setApiKey(null);
    assert.strictEqual(p.getApiKey(), null);
  });

  it('clearApiKey removes the stored key', () => {
    const p = createPersistenceLayer();
    p.setApiKey('sk-ant-test-key');
    p.clearApiKey();
    assert.strictEqual(p.getApiKey(), null);
  });

  it('API key storage is independent of widget storage', () => {
    const p = createPersistenceLayer();
    p.setApiKey('sk-ant-test-key');
    p.flush([makeWidget()]);
    p.clear(); // clears widgets only
    assert.strictEqual(p.getApiKey(), 'sk-ant-test-key');
  });
});
