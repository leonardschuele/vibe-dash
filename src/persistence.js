// persistence.js — localStorage persistence for widget state
//
// Saves: id, sourceId, title, size, refreshIntervalMs, render, resolvedIntent
// Strips: data (re-fetched on boot), lastUpdated (reset on refresh)
// Debounces writes by 500ms.
// Returns [] on missing or corrupt data — never throws.

const STORAGE_KEY = 'vibe-dash-widgets';
const API_KEY_KEY = 'vibe-dash-api-key';
const DEBOUNCE_MS = 500;

const PERSISTED_KEYS = [
  'id', 'sourceId', 'title', 'size', 'refreshIntervalMs', 'render', 'resolvedIntent'
];

export function createPersistenceLayer() {
  let debounceTimer = null;

  function stripForPersistence(widget) {
    const stripped = {};
    for (const key of PERSISTED_KEYS) {
      if (key in widget) stripped[key] = widget[key];
    }
    return stripped;
  }

  return {
    /**
     * Debounced save. Calls within 500ms collapse to the last one.
     * Returns a VibeDashError if localStorage write fails, null on success.
     * Because of debouncing, errors from previous calls may be lost —
     * the caller should not depend on the return value for critical flows.
     */
    save(widgets) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        try {
          const stripped = widgets.map(stripForPersistence);
          localStorage.setItem(STORAGE_KEY, JSON.stringify(stripped));
        } catch (e) {
          console.warn('[vibe-dash] localStorage write failed:', e.message);
          // Quota exceeded or storage disabled.
          // The Widget Runtime should surface this to the user via system:message.
          // We can't do it here because Persistence has no bus dependency.
        }
      }, DEBOUNCE_MS);
    },

    /**
     * Load persisted widgets. Returns PersistedWidget[] (no data, no lastUpdated).
     * On corruption or missing data, returns [] and logs a warning.
     */
    load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];

        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
          console.warn('[vibe-dash] Stored widget data is not an array, returning empty');
          return [];
        }

        // Basic validation: each entry must have at least an id and sourceId
        return parsed.filter(w => {
          if (!w || typeof w !== 'object' || !w.id || !w.sourceId) {
            console.warn('[vibe-dash] Skipping invalid persisted widget:', w);
            return false;
          }
          return true;
        });
      } catch (e) {
        console.warn('[vibe-dash] Failed to parse stored widgets:', e.message);
        return [];
      }
    },

    /** Force an immediate write, bypassing debounce. Used during unload. */
    flush(widgets) {
      clearTimeout(debounceTimer);
      try {
        const stripped = widgets.map(stripForPersistence);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(stripped));
      } catch (e) {
        console.warn('[vibe-dash] localStorage flush failed:', e.message);
      }
    },

    /** Clear all persisted widget data. */
    clear() {
      clearTimeout(debounceTimer);
      localStorage.removeItem(STORAGE_KEY);
    },

    /** Get stored Anthropic API key, or null. */
    getApiKey() {
      return localStorage.getItem(API_KEY_KEY) || null;
    },

    /** Store (or remove) the Anthropic API key. */
    setApiKey(key) {
      if (key) localStorage.setItem(API_KEY_KEY, key);
      else localStorage.removeItem(API_KEY_KEY);
    },

    /** Remove the stored API key. */
    clearApiKey() {
      localStorage.removeItem(API_KEY_KEY);
    }
  };
}
