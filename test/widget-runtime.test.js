import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createWidgetRuntime } from '../src/widget-runtime.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createMockBus() {
  const calls = [];
  return {
    on() {},
    off() {},
    emit(event, payload) { calls.push({ event, payload }); },
    calls
  };
}

function createMockPersistence(initial = []) {
  const saves = [];
  return {
    load: () => initial,
    save(widgets) { saves.push([...widgets]); },
    flush(widgets) { saves.push([...widgets]); },
    clear() {},
    getApiKey: () => null,
    setApiKey() {},
    clearApiKey() {},
    saves
  };
}

function createMockRouter() {
  return {
    route: async () => ({
      kind: 'success',
      descriptor: { data: { refreshed: true } }
    })
  };
}

function makeDescriptor(overrides = {}) {
  return {
    sourceId: 'test',
    title: 'Test Widget',
    size: 'small',
    refreshIntervalMs: null,
    data: { value: 1 },
    render: { type: 'generic', config: { type: 'generic' } },
    resolvedIntent: { action: 'create', subject: 'test', parameters: {}, raw: 'test' },
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reorderWidgets', () => {
  let bus, persistence, runtime;

  beforeEach(() => {
    bus = createMockBus();
    persistence = createMockPersistence();
    runtime = createWidgetRuntime(bus, persistence, createMockRouter());
  });

  it('reorders widgets to match the given ID order', () => {
    const a = runtime.addWidget(makeDescriptor({ title: 'A' }));
    const b = runtime.addWidget(makeDescriptor({ title: 'B' }));
    const c = runtime.addWidget(makeDescriptor({ title: 'C' }));

    runtime.reorderWidgets([c.id, a.id, b.id]);

    const ids = runtime.getWidgets().map(w => w.id);
    assert.deepStrictEqual(ids, [c.id, a.id, b.id]);
  });

  it('calls save() after reordering', () => {
    const a = runtime.addWidget(makeDescriptor({ title: 'A' }));
    const b = runtime.addWidget(makeDescriptor({ title: 'B' }));
    const saveCountBefore = persistence.saves.length;

    runtime.reorderWidgets([b.id, a.id]);

    assert.ok(persistence.saves.length > saveCountBefore, 'save() should be called');
  });

  it('does NOT emit widgets:changed', () => {
    const a = runtime.addWidget(makeDescriptor({ title: 'A' }));
    const b = runtime.addWidget(makeDescriptor({ title: 'B' }));
    // Clear bus calls accumulated from addWidget
    bus.calls.length = 0;

    runtime.reorderWidgets([b.id, a.id]);

    const emitted = bus.calls.filter(c => c.event === 'widgets:changed');
    assert.strictEqual(emitted.length, 0, 'should not emit widgets:changed');
  });

  it('appends missing widgets at the end when orderedIds is incomplete', () => {
    const a = runtime.addWidget(makeDescriptor({ title: 'A' }));
    const b = runtime.addWidget(makeDescriptor({ title: 'B' }));
    const c = runtime.addWidget(makeDescriptor({ title: 'C' }));

    runtime.reorderWidgets([c.id, a.id]); // B missing

    const ids = runtime.getWidgets().map(w => w.id);
    assert.deepStrictEqual(ids, [c.id, a.id, b.id]);
  });

  it('silently ignores unknown IDs in orderedIds', () => {
    const a = runtime.addWidget(makeDescriptor({ title: 'A' }));
    const b = runtime.addWidget(makeDescriptor({ title: 'B' }));

    runtime.reorderWidgets(['unknown-id', b.id, a.id]);

    const ids = runtime.getWidgets().map(w => w.id);
    assert.deepStrictEqual(ids, [b.id, a.id]);
  });

  it('preserves all widgets when orderedIds is empty', () => {
    const a = runtime.addWidget(makeDescriptor({ title: 'A' }));
    const b = runtime.addWidget(makeDescriptor({ title: 'B' }));

    runtime.reorderWidgets([]);

    const ids = runtime.getWidgets().map(w => w.id);
    assert.deepStrictEqual(ids, [a.id, b.id]);
  });
});

describe('resize via updateWidget', () => {
  let bus, persistence, runtime;

  beforeEach(() => {
    bus = createMockBus();
    persistence = createMockPersistence();
    runtime = createWidgetRuntime(bus, persistence, createMockRouter());
  });

  it('changes size from small to medium', () => {
    const w = runtime.addWidget(makeDescriptor({ size: 'small' }));

    runtime.updateWidget(w.id, { size: 'medium' });

    const updated = runtime.getWidgets().find(x => x.id === w.id);
    assert.strictEqual(updated.size, 'medium');
  });

  it('emits widgets:changed on resize', () => {
    const w = runtime.addWidget(makeDescriptor({ size: 'small' }));
    bus.calls.length = 0;

    runtime.updateWidget(w.id, { size: 'medium' });

    const emitted = bus.calls.filter(c => c.event === 'widgets:changed');
    assert.strictEqual(emitted.length, 1);
  });

  it('does not overwrite id or resolvedIntent', () => {
    const original = makeDescriptor();
    const w = runtime.addWidget(original);
    const originalIntent = w.resolvedIntent;

    runtime.updateWidget(w.id, {
      size: 'large',
      id: 'hacked-id',
      resolvedIntent: { action: 'remove', subject: 'hacked', parameters: {}, raw: '' }
    });

    const updated = runtime.getWidgets().find(x => x.id === w.id);
    assert.strictEqual(updated.id, w.id);
    assert.deepStrictEqual(updated.resolvedIntent, originalIntent);
  });
});

describe('addWidget', () => {
  let bus, persistence, runtime;

  beforeEach(() => {
    bus = createMockBus();
    persistence = createMockPersistence();
    runtime = createWidgetRuntime(bus, persistence, createMockRouter());
  });

  it('assigns a unique id and lastUpdated', () => {
    const w = runtime.addWidget(makeDescriptor());

    assert.ok(typeof w.id === 'string' && w.id.length > 0, 'id should be a non-empty string');
    assert.ok(typeof w.lastUpdated === 'number' && w.lastUpdated > 0, 'lastUpdated should be a positive number');
  });

  it('assigns distinct ids to multiple widgets', () => {
    const w1 = runtime.addWidget(makeDescriptor());
    const w2 = runtime.addWidget(makeDescriptor());

    assert.notStrictEqual(w1.id, w2.id, 'ids should be unique');
  });

  it('appends to the widget list', () => {
    assert.strictEqual(runtime.getWidgets().length, 0);

    runtime.addWidget(makeDescriptor());
    assert.strictEqual(runtime.getWidgets().length, 1);

    runtime.addWidget(makeDescriptor());
    assert.strictEqual(runtime.getWidgets().length, 2);
  });

  it('emits widgets:changed', () => {
    runtime.addWidget(makeDescriptor());

    const emitted = bus.calls.filter(c => c.event === 'widgets:changed');
    assert.strictEqual(emitted.length, 1);
  });

  it('calls save()', () => {
    runtime.addWidget(makeDescriptor());

    assert.strictEqual(persistence.saves.length, 1);
  });
});

describe('removeWidget', () => {
  let bus, persistence, runtime;

  beforeEach(() => {
    bus = createMockBus();
    persistence = createMockPersistence();
    runtime = createWidgetRuntime(bus, persistence, createMockRouter());
  });

  it('removes the widget from the list', () => {
    const w = runtime.addWidget(makeDescriptor());
    assert.strictEqual(runtime.getWidgets().length, 1);

    runtime.removeWidget(w.id);
    assert.strictEqual(runtime.getWidgets().length, 0);
  });

  it('emits widgets:changed', () => {
    const w = runtime.addWidget(makeDescriptor());
    bus.calls.length = 0;

    runtime.removeWidget(w.id);

    const emitted = bus.calls.filter(c => c.event === 'widgets:changed');
    assert.strictEqual(emitted.length, 1);
  });

  it('calls save()', () => {
    const w = runtime.addWidget(makeDescriptor());
    const saveCountBefore = persistence.saves.length;

    runtime.removeWidget(w.id);

    assert.ok(persistence.saves.length > saveCountBefore);
  });

  it('is a no-op for an unknown ID (no crash, no emit)', () => {
    runtime.addWidget(makeDescriptor());
    bus.calls.length = 0;

    runtime.removeWidget('nonexistent-id');

    assert.strictEqual(runtime.getWidgets().length, 1);
    const emitted = bus.calls.filter(c => c.event === 'widgets:changed');
    assert.strictEqual(emitted.length, 0);
  });
});

describe('updateWidget', () => {
  let bus, persistence, runtime;

  beforeEach(() => {
    bus = createMockBus();
    persistence = createMockPersistence();
    runtime = createWidgetRuntime(bus, persistence, createMockRouter());
  });

  it('merges partial into the existing widget', () => {
    const w = runtime.addWidget(makeDescriptor({ title: 'Before' }));

    runtime.updateWidget(w.id, { title: 'After' });

    const updated = runtime.getWidgets().find(x => x.id === w.id);
    assert.strictEqual(updated.title, 'After');
  });

  it('preserves id and resolvedIntent (cannot be overwritten)', () => {
    const w = runtime.addWidget(makeDescriptor());
    const originalId = w.id;
    const originalIntent = w.resolvedIntent;

    runtime.updateWidget(w.id, {
      id: 'overwritten',
      resolvedIntent: { action: 'remove', subject: 'x', parameters: {}, raw: '' }
    });

    const updated = runtime.getWidgets().find(x => x.id === originalId);
    assert.strictEqual(updated.id, originalId);
    assert.deepStrictEqual(updated.resolvedIntent, originalIntent);
  });

  it('emits widgets:changed and calls save()', () => {
    const w = runtime.addWidget(makeDescriptor());
    bus.calls.length = 0;
    const saveCountBefore = persistence.saves.length;

    runtime.updateWidget(w.id, { title: 'New' });

    const emitted = bus.calls.filter(c => c.event === 'widgets:changed');
    assert.strictEqual(emitted.length, 1);
    assert.ok(persistence.saves.length > saveCountBefore);
  });

  it('is a no-op for an unknown ID', () => {
    runtime.addWidget(makeDescriptor());
    bus.calls.length = 0;

    runtime.updateWidget('nonexistent', { title: 'Nope' });

    const emitted = bus.calls.filter(c => c.event === 'widgets:changed');
    assert.strictEqual(emitted.length, 0);
  });
});

describe('getWidgets', () => {
  it('returns a shallow copy (mutations do not affect internal state)', () => {
    const bus = createMockBus();
    const persistence = createMockPersistence();
    const runtime = createWidgetRuntime(bus, persistence, createMockRouter());

    runtime.addWidget(makeDescriptor());

    const copy = runtime.getWidgets();
    copy.push({ fake: true });
    copy[0].title = 'mutated';

    assert.strictEqual(runtime.getWidgets().length, 1, 'push should not affect internal array');
    // Note: shallow copy means object refs are shared — title mutation IS visible.
    // This matches the "shallow copy" contract in the source code.
  });
});

describe('boot', () => {
  it('hydrates persisted widgets with data: null and lastUpdated: 0', async () => {
    const bus = createMockBus();
    const persisted = [
      {
        id: 'w1',
        sourceId: 'test',
        title: 'Persisted',
        size: 'small',
        refreshIntervalMs: null,
        render: { type: 'generic', config: { type: 'generic' } },
        resolvedIntent: { action: 'create', subject: 'test', parameters: {}, raw: 'test' }
      }
    ];
    const persistence = createMockPersistence(persisted);
    const runtime = createWidgetRuntime(bus, persistence, createMockRouter());

    await runtime.boot();

    const widgets = runtime.getWidgets();
    assert.strictEqual(widgets.length, 1);
    assert.strictEqual(widgets[0].data, null);
    assert.strictEqual(widgets[0].lastUpdated, 0);
  });

  it('emits widgets:changed immediately (before refresh)', async () => {
    const bus = createMockBus();
    const persisted = [
      {
        id: 'w1',
        sourceId: 'test',
        title: 'Persisted',
        size: 'small',
        refreshIntervalMs: 60000,
        render: { type: 'generic', config: { type: 'generic' } },
        resolvedIntent: { action: 'create', subject: 'test', parameters: {}, raw: 'test' }
      }
    ];
    let emitCalledBeforeRoute = false;
    const mockRouter = {
      route: async () => {
        // By the time route is called, emit should have already happened
        const emitted = bus.calls.filter(c => c.event === 'widgets:changed');
        if (emitted.length > 0) emitCalledBeforeRoute = true;
        return { kind: 'success', descriptor: { data: { refreshed: true } } };
      }
    };
    const persistence = createMockPersistence(persisted);
    const runtime = createWidgetRuntime(bus, persistence, mockRouter);

    await runtime.boot();

    assert.ok(emitCalledBeforeRoute, 'widgets:changed should be emitted before router.route()');
  });

  it('calls router.route() for widgets with refreshIntervalMs', async () => {
    const bus = createMockBus();
    const routeCalls = [];
    const mockRouter = {
      route: async (intent) => {
        routeCalls.push(intent);
        return { kind: 'success', descriptor: { data: { refreshed: true } } };
      }
    };
    const persisted = [
      {
        id: 'w1',
        sourceId: 'test',
        title: 'Auto-refresh',
        size: 'small',
        refreshIntervalMs: 60000,
        render: { type: 'generic', config: { type: 'generic' } },
        resolvedIntent: { action: 'create', subject: 'auto', parameters: {}, raw: 'auto' }
      },
      {
        id: 'w2',
        sourceId: 'test',
        title: 'No refresh',
        size: 'small',
        refreshIntervalMs: null,
        render: { type: 'generic', config: { type: 'generic' } },
        resolvedIntent: { action: 'create', subject: 'static', parameters: {}, raw: 'static' }
      }
    ];
    const persistence = createMockPersistence(persisted);
    const runtime = createWidgetRuntime(bus, persistence, mockRouter);

    await runtime.boot();

    assert.strictEqual(routeCalls.length, 1, 'only refreshable widget should be routed');
    assert.strictEqual(routeCalls[0].subject, 'auto');
  });
});
