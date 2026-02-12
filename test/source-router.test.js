import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSourceRouter } from '../src/source-router.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockBus() {
  return { on() {}, off() {}, emit() {} };
}

function makeIntent(overrides = {}) {
  return {
    action: 'create',
    subject: 'test',
    parameters: {},
    raw: 'test',
    targetWidgetId: null,
    ...overrides
  };
}

function makeSource(id, confidence, result) {
  return {
    id,
    match: () => confidence,
    resolve: async () => result ?? {
      kind: 'success',
      descriptor: { sourceId: id, title: id, size: 'small', data: {} }
    }
  };
}

function makeAiGenerator(result) {
  return {
    generate: async () => result ?? {
      kind: 'success',
      descriptor: { sourceId: 'ai', title: 'AI Widget', size: 'small', data: {} }
    }
  };
}

// ---------------------------------------------------------------------------
// route() — confidence-based matching
// ---------------------------------------------------------------------------

describe('route: confidence matching', () => {
  it('picks the source with the highest confidence', async () => {
    const low = makeSource('low', 0.6);
    const high = makeSource('high', 0.9);
    const router = createSourceRouter(createMockBus(), [low, high], null);

    const result = await router.route(makeIntent());

    assert.strictEqual(result.kind, 'success');
    assert.strictEqual(result.descriptor.sourceId, 'high');
  });

  it('breaks ties by registration order (first wins)', async () => {
    const first = makeSource('first', 0.8);
    const second = makeSource('second', 0.8);
    const router = createSourceRouter(createMockBus(), [first, second], null);

    const result = await router.route(makeIntent());

    assert.strictEqual(result.kind, 'success');
    assert.strictEqual(result.descriptor.sourceId, 'first');
  });

  it('ignores sources below 0.5 threshold', async () => {
    const low = makeSource('low', 0.4);
    const ai = makeAiGenerator();
    const router = createSourceRouter(createMockBus(), [low], ai);

    const result = await router.route(makeIntent());

    // Should fall through to AI since low is below threshold
    assert.strictEqual(result.kind, 'success');
    assert.strictEqual(result.descriptor.sourceId, 'ai');
  });

  it('includes sources at exactly 0.5', async () => {
    const borderline = makeSource('borderline', 0.5);
    const router = createSourceRouter(createMockBus(), [borderline], null);

    const result = await router.route(makeIntent());

    assert.strictEqual(result.kind, 'success');
    assert.strictEqual(result.descriptor.sourceId, 'borderline');
  });
});

// ---------------------------------------------------------------------------
// route() — AI fallback
// ---------------------------------------------------------------------------

describe('route: AI fallback', () => {
  it('falls back to AI generator when no source matches', async () => {
    const ai = makeAiGenerator();
    const router = createSourceRouter(createMockBus(), [], ai);

    const result = await router.route(makeIntent());

    assert.strictEqual(result.kind, 'success');
    assert.strictEqual(result.descriptor.sourceId, 'ai');
  });

  it('returns error when no source matches and no AI generator configured', async () => {
    const router = createSourceRouter(createMockBus(), [], null);

    const result = await router.route(makeIntent());

    assert.strictEqual(result.kind, 'error');
    assert.ok(result.message.includes('no AI generator'));
  });

  it('returns error when AI generator throws', async () => {
    const ai = { generate: async () => { throw new Error('boom'); } };
    const router = createSourceRouter(createMockBus(), [], ai);

    const result = await router.route(makeIntent());

    assert.strictEqual(result.kind, 'error');
    assert.ok(result.message.includes('failed'));
  });
});

// ---------------------------------------------------------------------------
// route() — non-create actions
// ---------------------------------------------------------------------------

describe('route: non-create actions', () => {
  it('rejects modify actions with an error', async () => {
    const router = createSourceRouter(createMockBus(), [], null);

    const result = await router.route(makeIntent({ action: 'modify' }));

    assert.strictEqual(result.kind, 'error');
    assert.ok(result.message.includes('modify'));
    assert.strictEqual(result.retryable, false);
  });

  it('rejects remove actions with an error', async () => {
    const router = createSourceRouter(createMockBus(), [], null);

    const result = await router.route(makeIntent({ action: 'remove' }));

    assert.strictEqual(result.kind, 'error');
    assert.ok(result.message.includes('remove'));
  });
});

// ---------------------------------------------------------------------------
// route() — error handling
// ---------------------------------------------------------------------------

describe('route: error handling', () => {
  it('skips sources whose match() throws', async () => {
    const broken = {
      id: 'broken',
      match: () => { throw new Error('match crash'); },
      resolve: async () => ({ kind: 'success', descriptor: { sourceId: 'broken' } })
    };
    const good = makeSource('good', 0.8);
    const router = createSourceRouter(createMockBus(), [broken, good], null);

    const result = await router.route(makeIntent());

    assert.strictEqual(result.kind, 'success');
    assert.strictEqual(result.descriptor.sourceId, 'good');
  });

  it('returns error when resolve() throws', async () => {
    const crashing = {
      id: 'crasher',
      match: () => 0.9,
      resolve: async () => { throw new Error('resolve crash'); }
    };
    const router = createSourceRouter(createMockBus(), [crashing], null);

    const result = await router.route(makeIntent());

    assert.strictEqual(result.kind, 'error');
    assert.ok(result.message.includes('crasher'));
    assert.strictEqual(result.retryable, true);
  });
});

// ---------------------------------------------------------------------------
// route() — clarification flow
// ---------------------------------------------------------------------------

describe('route: clarification', () => {
  it('assigns a requestId to clarification results', async () => {
    const clarifying = {
      id: 'clarifier',
      match: () => 0.8,
      resolve: async () => ({
        kind: 'clarification',
        request: {
          question: 'Which city?',
          options: [{ label: 'Denver', value: 'denver' }],
          source: 'clarifier',
          context: { parameterKey: 'location' }
        }
      })
    };
    const router = createSourceRouter(createMockBus(), [clarifying], null);

    const result = await router.route(makeIntent());

    assert.strictEqual(result.kind, 'clarification');
    assert.ok(typeof result.request.requestId === 'string');
    assert.strictEqual(result.request.question, 'Which city?');
  });
});

// ---------------------------------------------------------------------------
// resumeAfterClarification()
// ---------------------------------------------------------------------------

describe('resumeAfterClarification', () => {
  it('re-resolves the same source with the answer merged in', async () => {
    const resolvedIntents = [];
    const clarifying = {
      id: 'weather',
      match: () => 0.8,
      resolve: async (intent) => {
        resolvedIntents.push(intent);
        if (!intent.parameters.location) {
          return {
            kind: 'clarification',
            request: {
              question: 'Which city?',
              options: [{ label: 'Denver', value: 'Denver' }],
              source: 'weather',
              context: { parameterKey: 'location' }
            }
          };
        }
        return {
          kind: 'success',
          descriptor: { sourceId: 'weather', title: `Weather in ${intent.parameters.location}`, size: 'small', data: {} }
        };
      }
    };
    const router = createSourceRouter(createMockBus(), [clarifying], null);

    const clarResult = await router.route(makeIntent({ subject: 'weather' }));
    assert.strictEqual(clarResult.kind, 'clarification');

    const result = await router.resumeAfterClarification(clarResult.request.requestId, 'Denver');

    assert.strictEqual(result.kind, 'success');
    assert.strictEqual(result.descriptor.title, 'Weather in Denver');
    // The answer should be merged into the intent's parameters
    const resumeIntent = resolvedIntents[1];
    assert.strictEqual(resumeIntent.parameters.location, 'Denver');
  });

  it('returns error for unknown/expired requestId', async () => {
    const router = createSourceRouter(createMockBus(), [], null);

    const result = await router.resumeAfterClarification('nonexistent', 'answer');

    assert.strictEqual(result.kind, 'error');
    assert.ok(result.message.includes('expired'));
  });

  it('clears pending state after resuming (cannot reuse requestId)', async () => {
    const clarifying = {
      id: 'src',
      match: () => 0.8,
      resolve: async (intent) => {
        if (!intent.parameters.location) {
          return {
            kind: 'clarification',
            request: {
              question: 'Which?',
              options: [],
              source: 'src',
              context: { parameterKey: 'location' }
            }
          };
        }
        return { kind: 'success', descriptor: { sourceId: 'src', data: {} } };
      }
    };
    const router = createSourceRouter(createMockBus(), [clarifying], null);

    const clar = await router.route(makeIntent());
    await router.resumeAfterClarification(clar.request.requestId, 'Denver');

    // Second call with same requestId should fail
    const result = await router.resumeAfterClarification(clar.request.requestId, 'Denver');
    assert.strictEqual(result.kind, 'error');
    assert.ok(result.message.includes('expired'));
  });

  it('handles another clarification after resume (chained clarifications)', async () => {
    let callCount = 0;
    const multiClar = {
      id: 'multi',
      match: () => 0.8,
      resolve: async () => {
        callCount++;
        if (callCount <= 2) {
          return {
            kind: 'clarification',
            request: {
              question: `Question ${callCount}`,
              options: [],
              source: 'multi',
              context: {}
            }
          };
        }
        return { kind: 'success', descriptor: { sourceId: 'multi', data: {} } };
      }
    };
    const router = createSourceRouter(createMockBus(), [multiClar], null);

    const clar1 = await router.route(makeIntent());
    assert.strictEqual(clar1.kind, 'clarification');

    const clar2 = await router.resumeAfterClarification(clar1.request.requestId, 'a');
    assert.strictEqual(clar2.kind, 'clarification');
    // Should be a new requestId
    assert.notStrictEqual(clar2.request.requestId, clar1.request.requestId);

    const final = await router.resumeAfterClarification(clar2.request.requestId, 'b');
    assert.strictEqual(final.kind, 'success');
  });

  it('returns error when resolve() throws during resume', async () => {
    let first = true;
    const src = {
      id: 'crasher',
      match: () => 0.8,
      resolve: async () => {
        if (first) {
          first = false;
          return {
            kind: 'clarification',
            request: { question: '?', options: [], source: 'crasher', context: {} }
          };
        }
        throw new Error('boom on resume');
      }
    };
    const router = createSourceRouter(createMockBus(), [src], null);

    const clar = await router.route(makeIntent());
    const result = await router.resumeAfterClarification(clar.request.requestId, 'x');

    assert.strictEqual(result.kind, 'error');
    assert.ok(result.message.includes('crasher'));
    assert.strictEqual(result.retryable, true);
  });
});
