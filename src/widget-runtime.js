// widget-runtime.js — Widget state manager and lifecycle owner
//
// Contract:
//   createWidgetRuntime(bus, persistence, router)
//   addWidget(descriptor)    → WidgetDescriptor (with id + lastUpdated assigned)
//   removeWidget(id)         → void
//   updateWidget(id, partial) → void
//   getWidgets()             → WidgetDescriptor[] (shallow copy)
//   boot()                   → Promise<void>
//
// Emits: "widgets:changed" on every add/remove/update
//
// Refresh loop:
//   For widgets with refreshIntervalMs !== null, runs a setInterval that
//   re-resolves via router.route(widget.resolvedIntent), updating only
//   data + lastUpdated. On failure, keeps stale data visible.
//
// Boot sequence:
//   1. Load PersistedWidget[] from persistence
//   2. Hydrate: add data: null, lastUpdated: 0
//   3. Emit widgets:changed (Layout Engine shows loading states)
//   4. Refresh all widgets with refreshIntervalMs !== null
//   5. Start refresh timers

export function createWidgetRuntime(bus, persistence, router) {
  /** @type {import('../contracts').WidgetDescriptor[]} */
  let widgets = [];

  /** @type {Map<string, number>} widgetId → setInterval ID */
  const refreshTimers = new Map();

  /** @type {Set<string>} widgetIds currently mid-refresh (prevents overlap) */
  const refreshing = new Set();

  // --- ID generation ---

  function generateId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'xxxx-xxxx-xxxx-xxxx'.replace(/x/g, () =>
      Math.floor(Math.random() * 16).toString(16)
    );
  }

  // --- Internal helpers ---

  function emitChanged() {
    bus.emit('widgets:changed', [...widgets]);
  }

  function save() {
    persistence.save(widgets);
  }

  function findIndex(id) {
    return widgets.findIndex(w => w.id === id);
  }

  // --- Refresh ---

  function startRefreshTimer(widget) {
    if (!widget.refreshIntervalMs) return;
    const timerId = setInterval(
      () => refreshWidget(widget.id),
      widget.refreshIntervalMs
    );
    refreshTimers.set(widget.id, timerId);
  }

  function stopRefreshTimer(id) {
    const timerId = refreshTimers.get(id);
    if (timerId != null) {
      clearInterval(timerId);
      refreshTimers.delete(id);
    }
  }

  async function refreshWidget(id) {
    // Guard: don't overlap refreshes for the same widget
    if (refreshing.has(id)) return;

    const idx = findIndex(id);
    if (idx === -1) {
      stopRefreshTimer(id);
      return;
    }

    const widget = widgets[idx];
    refreshing.add(id);

    try {
      const result = await router.route(widget.resolvedIntent);

      // Re-check: widget might have been removed while we were fetching
      const currentIdx = findIndex(id);
      if (currentIdx === -1) return;

      if (result.kind === 'success') {
        widgets[currentIdx] = {
          ...widgets[currentIdx],
          data: result.descriptor.data,
          lastUpdated: Date.now()
        };
        emitChanged();
        save();
      }
      // On error or clarification: keep stale data, don't remove widget.
      // Clarification during refresh is unusual — the resolvedIntent should
      // already be fully resolved. If it happens, we silently ignore it.
    } catch (e) {
      console.warn(`[Runtime] Refresh failed for widget "${id}":`, e);
    } finally {
      refreshing.delete(id);
    }
  }

  // --- Public API ---

  return {
    /**
     * Add a new widget from a source's resolved descriptor.
     * Assigns id and lastUpdated. Starts refresh timer if applicable.
     *
     * @param {Omit<import('../contracts').WidgetDescriptor, 'id' | 'lastUpdated'>} descriptor
     * @returns {import('../contracts').WidgetDescriptor}
     */
    addWidget(descriptor) {
      const widget = {
        ...descriptor,
        id: generateId(),
        lastUpdated: Date.now()
      };
      widgets.push(widget);
      emitChanged();
      save();
      startRefreshTimer(widget);
      return widget;
    },

    /**
     * Remove a widget by ID. Cancels its refresh timer.
     * @param {string} id
     */
    removeWidget(id) {
      const idx = findIndex(id);
      if (idx === -1) return;
      stopRefreshTimer(id);
      widgets.splice(idx, 1);
      emitChanged();
      save();
    },

    /**
     * Merge a partial update into an existing widget.
     * Used for modify actions ("make that bigger", "show as chart").
     * @param {string} id
     * @param {Partial<import('../contracts').WidgetDescriptor>} partial
     */
    updateWidget(id, partial) {
      const idx = findIndex(id);
      if (idx === -1) return;

      widgets[idx] = {
        ...widgets[idx],
        ...partial,
        id: widgets[idx].id,                             // never overwrite id
        resolvedIntent: widgets[idx].resolvedIntent,     // never overwrite resolvedIntent
        lastUpdated: Date.now()
      };
      emitChanged();
      save();

      // If refreshIntervalMs changed, restart timer
      if ('refreshIntervalMs' in partial) {
        stopRefreshTimer(id);
        startRefreshTimer(widgets[idx]);
      }
    },

    /**
     * Returns a shallow copy of the current widget array.
     * @returns {import('../contracts').WidgetDescriptor[]}
     */
    getWidgets() {
      return [...widgets];
    },

    /**
     * Boot sequence: hydrate from persistence, render, refresh, start timers.
     */
    async boot() {
      const persisted = persistence.load();

      // Hydrate: add missing fields
      widgets = persisted.map(pw => ({
        ...pw,
        data: pw.data ?? null,
        lastUpdated: 0
      }));

      // Emit immediately so Layout Engine can render loading states
      emitChanged();

      // Refresh all widgets that have auto-refresh enabled
      const toRefresh = widgets.filter(w => w.refreshIntervalMs != null);
      await Promise.allSettled(
        toRefresh.map(w => refreshWidget(w.id))
      );

      // Start ongoing refresh timers
      for (const widget of widgets) {
        startRefreshTimer(widget);
      }
    }
  };
}
