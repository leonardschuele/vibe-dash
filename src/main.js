// main.js — Orchestrator
//
// Wires all components per the boot sequence in contracts.ts.
// Handles:
//   user:message → parse → route/modify/remove → system feedback
//   clarification:resolved → router.resumeAfterClarification → system feedback
//
// Implements inline context resolution for modify/remove actions
// (the "phantom" Context Resolver identified during decomposition).

import { createEventBus } from './event-bus.js';
import { createPersistenceLayer } from './persistence.js';
import { createIntentParser } from './intent-parser.js';
import { createCryptoSource } from './sources/crypto.js';
import { createWeatherSource } from './sources/weather.js';
import { createNewsSource } from './sources/news.js';
import { createAiWidgetGenerator } from './ai-generator.js';
import { createSourceRouter } from './source-router.js';
import { createWidgetRuntime } from './widget-runtime.js';
import { createLayoutEngine } from './layout-engine.js';
import { createChatShell } from './chat-shell.js';


// ============================================================================
// Boot sequence (contracts.ts steps 1-9)
// ============================================================================

// 1. EventBus
const bus = createEventBus();

// 2. PersistenceLayer
const persistence = createPersistenceLayer();

// 3. IntentParser
const parser = createIntentParser();

// 4. DataSources
const sources = [
  createCryptoSource(),
  createWeatherSource(),
  createNewsSource(),
];

// 5. AiWidgetGenerator
const aiGenerator = createAiWidgetGenerator(
  window.VIBE_DASH_CONFIG || {}
);

// 6. SourceRouter
const router = createSourceRouter(bus, sources, aiGenerator);

// 7. WidgetRuntime
const runtime = createWidgetRuntime(bus, persistence, router);

// 8. LayoutEngine
const dashboardEl = document.getElementById('dashboard');
createLayoutEngine(bus, dashboardEl, (id) => {
  const widget = runtime.getWidgets().find(w => w.id === id);
  runtime.removeWidget(id);
  if (widget) {
    bus.emit('system:message', {
      type: 'info',
      text: `Removed "${widget.title}".`
    });
  }
});

// 9. ChatShell
const chatEl = document.getElementById('chat');
createChatShell(bus, chatEl);


// ============================================================================
// Orchestration wiring (contracts.ts step 10)
// ============================================================================

bus.on('user:message', async (text) => {
  try {
    const intent = parser.parse(text);

    switch (intent.action) {
      case 'create':
        await handleCreate(intent);
        break;
      case 'modify':
        handleModify(intent);
        break;
      case 'remove':
        handleRemove(intent);
        break;
    }
  } catch (e) {
    console.error('[vibe-dash] Error handling message:', e);
    bus.emit('system:message', {
      type: 'error',
      text: "Something went wrong. Try rephrasing your request."
    });
  }
});

bus.on('clarification:resolved', async ({ requestId, answer }) => {
  try {
    const result = await router.resumeAfterClarification(requestId, answer);
    handleRouteResult(result);
  } catch (e) {
    console.error('[vibe-dash] Error resuming after clarification:', e);
    bus.emit('system:message', {
      type: 'error',
      text: "Something went wrong resolving that. Try your request again."
    });
  }
});


// ============================================================================
// Action handlers
// ============================================================================

async function handleCreate(intent) {
  bus.emit('system:message', {
    type: 'info',
    text: `Looking for "${intent.subject}"...`
  });

  const result = await router.route(intent);
  handleRouteResult(result);
}

function handleRouteResult(result) {
  switch (result.kind) {
    case 'success':
      runtime.addWidget(result.descriptor);
      bus.emit('system:message', {
        type: 'success',
        text: `Added "${result.descriptor.title}" to your dashboard.`
      });
      break;

    case 'clarification':
      bus.emit('system:message', {
        type: 'clarification',
        text: result.request.question,
        clarification: result.request
      });
      bus.emit('clarification:pending', result.request);
      break;

    case 'error':
      bus.emit('system:message', {
        type: 'error',
        text: result.message
      });
      break;
  }
}

function handleModify(intent) {
  const target = resolveTarget(intent);
  if (!target) return;

  const partial = {};
  if (intent.parameters.size) {
    partial.size = intent.parameters.size;
  }

  if (Object.keys(partial).length === 0) {
    bus.emit('system:message', {
      type: 'info',
      text: "I'm not sure what to change. Try \"make it bigger\" or \"make it smaller\"."
    });
    return;
  }

  runtime.updateWidget(target.id, partial);
  bus.emit('system:message', {
    type: 'success',
    text: `Updated "${target.title}".`
  });
}

function handleRemove(intent) {
  const target = resolveTarget(intent);
  if (!target) return;

  runtime.removeWidget(target.id);
  bus.emit('system:message', {
    type: 'success',
    text: `Removed "${target.title}" from your dashboard.`
  });
}


// ============================================================================
// Context resolver — resolves targetWidgetId for modify/remove
// ============================================================================
// The intent parser always sets targetWidgetId: null.
// This inline resolver figures out which widget the user means.
//
// Strategy (first match wins):
//   1. Only one widget → that's the one.
//   2. Parameter match: coin name or location from intent matches a widget.
//   3. Text match: sourceId, title, or resolvedIntent.subject overlap.
//   4. Ambiguous → ask user to be more specific.

// Words the parser might leave in the subject that aren't useful for matching
const ACTION_NOISE = new Set([
  'remove', 'delete', 'close', 'dismiss', 'hide', 'clear',
  'change', 'make', 'update', 'switch', 'modify', 'resize',
  'it', 'that', 'this', 'the', 'a', 'one', 'widget', 'bigger', 'smaller'
]);

function resolveTarget(intent) {
  const widgets = runtime.getWidgets();

  if (widgets.length === 0) {
    bus.emit('system:message', {
      type: 'error',
      text: 'There are no widgets on your dashboard.'
    });
    return null;
  }

  // 1. Only one widget — unambiguous
  if (widgets.length === 1) return widgets[0];

  // 2. Parameter match (strongest signal)
  if (intent.parameters.coin) {
    const matches = widgets.filter(w =>
      w.resolvedIntent?.parameters?.coin === intent.parameters.coin
    );
    if (matches.length === 1) return matches[0];
  }

  if (intent.parameters.location) {
    const loc = intent.parameters.location.toLowerCase();
    const matches = widgets.filter(w =>
      w.resolvedIntent?.parameters?.location?.toLowerCase() === loc
    );
    if (matches.length === 1) return matches[0];
  }

  // 3. Text match — scan subject AND raw text against sourceId / title / subject
  //    (subject is often noise-only for modify/remove because the parser's
  //    reference regex strips phrases like "the weather widget")
  const fromSubject = intent.subject.toLowerCase().split(/\s+/);
  const fromRaw = intent.raw.toLowerCase().split(/\s+/);
  const keywords = [...new Set([...fromSubject, ...fromRaw])]
    .filter(w => w.length > 1 && !ACTION_NOISE.has(w));

  if (keywords.length > 0) {
    const scored = widgets.map(w => {
      const haystack = [
        w.sourceId,
        w.title,
        w.resolvedIntent?.subject || ''
      ].join(' ').toLowerCase();

      const hits = keywords.filter(kw => haystack.includes(kw)).length;
      return { widget: w, hits };
    }).filter(s => s.hits > 0);

    scored.sort((a, b) => b.hits - a.hits);

    if (scored.length === 1) return scored[0].widget;
    if (scored.length > 1 && scored[0].hits > scored[1].hits) {
      return scored[0].widget;
    }
  }

  // 4. Ambiguous
  bus.emit('system:message', {
    type: 'info',
    text: "Which widget do you mean? Try being more specific, like \"remove the weather widget\" or \"make the bitcoin one bigger\"."
  });
  return null;
}


// ============================================================================
// Lifecycle
// ============================================================================

window.addEventListener('beforeunload', () => {
  persistence.flush(runtime.getWidgets());
});


// ============================================================================
// Boot (contracts.ts step 11)
// ============================================================================

runtime.boot().catch(e => {
  console.error('[vibe-dash] Boot failed:', e);
  bus.emit('system:message', {
    type: 'error',
    text: 'Dashboard failed to load. Try refreshing the page.'
  });
});
