// source-router.js — Confidence-based intent routing
//
// Contract:
//   createSourceRouter(bus, sources, aiGenerator)
//   route(intent) → Promise<DataSourceResult>
//   resumeAfterClarification(requestId, answer) → Promise<DataSourceResult>
//
// Scores all registered sources via match(), picks highest above 0.5.
// Ties broken by registration order (first wins).
// Falls back to AI Widget Generator when nothing matches.
//
// Manages clarification lifecycle:
//   1. Source returns kind:"clarification" → Router assigns requestId, stores state
//   2. Caller emits system:message / clarification:pending (Router doesn't emit)
//   3. User answers → caller calls resumeAfterClarification(requestId, answer)
//   4. Router merges answer into intent, re-calls same source
//   5. Returns the new result (could be success, error, or another clarification)

const CONFIDENCE_THRESHOLD = 0.5;

export function createSourceRouter(bus, sources, aiGenerator) {
  // requestId → { source, intent, context }
  const pending = new Map();

  function generateId() {
    // crypto.randomUUID requires secure context; fallback for file:// or older browsers
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'xxxx-xxxx-xxxx'.replace(/x/g, () =>
      Math.floor(Math.random() * 16).toString(16)
    );
  }

  function storeClarification(result, source, intent) {
    const requestId = generateId();
    pending.set(requestId, {
      source,
      intent,
      context: result.request.context || {}
    });
    // Return clarification with requestId attached
    return {
      kind: 'clarification',
      request: { ...result.request, requestId }
    };
  }

  function mergeAnswer(originalIntent, answer, context) {
    const modified = {
      ...originalIntent,
      parameters: { ...originalIntent.parameters }
    };

    // If the source specified which parameter this answer fills, set it directly
    if (context.parameterKey) {
      modified.parameters[context.parameterKey] = answer;
    }

    // Also update subject — sources scan this as a fallback
    modified.subject = answer;

    return modified;
  }

  return {
    /**
     * Route a "create" intent to the best-matching source.
     * For "modify"/"remove", returns an error — the orchestrator should
     * handle those via Widget Runtime before calling route().
     *
     * @param {import('../contracts').Intent} intent
     * @returns {Promise<import('../contracts').DataSourceResult>}
     */
    async route(intent) {
      if (intent.action !== 'create') {
        return {
          kind: 'error',
          message: `Cannot route "${intent.action}" actions — only "create" intents are routable.`,
          retryable: false
        };
      }

      // Score all sources
      const scored = [];
      for (const source of sources) {
        try {
          const confidence = source.match(intent);
          if (confidence >= CONFIDENCE_THRESHOLD) {
            scored.push({ source, confidence });
          }
        } catch (e) {
          console.warn(`[Router] match() threw for source "${source.id}":`, e);
        }
      }

      // Sort descending by confidence; registration order breaks ties (stable sort)
      scored.sort((a, b) => b.confidence - a.confidence);

      if (scored.length === 0) {
        // No source matched — fall back to AI generator
        if (!aiGenerator) {
          return {
            kind: 'error',
            message: "I don't know how to create that, and no AI generator is configured.",
            retryable: false
          };
        }
        try {
          return await aiGenerator.generate(intent);
        } catch (e) {
          console.error('[Router] AI generator threw:', e);
          return {
            kind: 'error',
            message: 'AI widget generation failed unexpectedly.',
            retryable: false
          };
        }
      }

      // Call resolve on the best match
      const best = scored[0];
      let result;
      try {
        result = await best.source.resolve(intent);
      } catch (e) {
        console.error(`[Router] resolve() threw for source "${best.source.id}":`, e);
        return {
          kind: 'error',
          message: `Widget source "${best.source.id}" failed unexpectedly.`,
          retryable: true
        };
      }

      if (result.kind === 'clarification') {
        return storeClarification(result, best.source, intent);
      }

      return result;
    },

    /**
     * Resume after a clarification answer.
     * Merges the answer into the original intent and re-calls the same source.
     *
     * @param {string} requestId
     * @param {string} answer
     * @returns {Promise<import('../contracts').DataSourceResult>}
     */
    async resumeAfterClarification(requestId, answer) {
      const entry = pending.get(requestId);
      if (!entry) {
        return {
          kind: 'error',
          message: 'That question has expired. Try your request again.',
          retryable: false
        };
      }
      pending.delete(requestId);

      const modifiedIntent = mergeAnswer(entry.intent, answer, entry.context);

      let result;
      try {
        result = await entry.source.resolve(modifiedIntent);
      } catch (e) {
        console.error(`[Router] resolve() threw on clarification resume for "${entry.source.id}":`, e);
        return {
          kind: 'error',
          message: `Widget source "${entry.source.id}" failed on re-resolve.`,
          retryable: true
        };
      }

      // Could be another clarification (rare but possible)
      if (result.kind === 'clarification') {
        return storeClarification(result, entry.source, modifiedIntent);
      }

      return result;
    }
  };
}
