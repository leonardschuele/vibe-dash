// event-bus.js — Typed pub/sub matching the EventBus contract in contracts.ts
//
// One bus created at boot, passed to every component.
// All inter-component communication flows through here.

export function createEventBus() {
  /** @type {Map<string, Array<(payload: any) => void>>} */
  const listeners = new Map();

  return {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },

    off(event, handler) {
      const handlers = listeners.get(event);
      if (!handlers) return;
      const idx = handlers.indexOf(handler);
      if (idx !== -1) handlers.splice(idx, 1);
    },

    emit(event, payload) {
      const handlers = listeners.get(event);
      if (!handlers || handlers.length === 0) return;
      // Snapshot the array so handlers that call off() during iteration don't cause skips
      for (const handler of [...handlers]) {
        try {
          handler(payload);
        } catch (e) {
          console.error(`[EventBus] Error in handler for "${event}":`, e);
        }
      }
    }
  };
}
