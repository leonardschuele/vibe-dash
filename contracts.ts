// ============================================================================
// VIBE DASH — SHARED CONTRACTS (Wave 0)
// ============================================================================
//
// This file is the single source of truth for all inter-component contracts.
// Every component builder receives this file alongside their behavioral spec.
//
// Rules:
//   1. No component may define its own shapes for data that crosses boundaries.
//   2. If a type isn't here, it's internal to one component and shouldn't leak.
//   3. Changes here require updating every component that touches the changed type.
//
// This file is types + constants only. No runtime code. No implementations.
// ============================================================================


// ----------------------------------------------------------------------------
// EVENT BUS — the communication mechanism
// ----------------------------------------------------------------------------
//
// All inter-component communication uses this bus. No CustomEvents, no
// callback injection, no class inheritance. One bus, created at boot,
// passed to every component's constructor.
//
// Usage:
//   bus.on("user:message", (text) => { ... })
//   bus.emit("user:message", "show me bitcoin price")
//

export type EventMap = {
  // Chat Shell emits when user submits text
  "user:message":           string;

  // System responses displayed in Chat Shell
  "system:message":         SystemMessage;

  // Widget lifecycle — Widget Runtime emits these
  "widgets:changed":        WidgetDescriptor[];

  // Clarification flow
  "clarification:pending":  ClarificationRequest;
  "clarification:resolved": { requestId: string; answer: string };
};

export interface EventBus {
  on<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void): void;
  off<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void): void;
  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void;
}


// ----------------------------------------------------------------------------
// SYSTEM MESSAGES — what the Chat Shell renders
// ----------------------------------------------------------------------------

export type SystemMessageType = "info" | "success" | "error" | "clarification";

export interface SystemMessage {
  type: SystemMessageType;
  text: string;

  // Present only when type === "clarification"
  clarification?: ClarificationRequest;
}

export interface ClarificationRequest {
  requestId: string;           // unique id to correlate answer with question
  question: string;            // displayed to user
  options: ClarificationOption[];
  source: string;              // which component asked — "parser", "router", "weather", etc.
  context: Record<string, unknown>; // opaque bag returned with the answer so the
                                     // asking component can resume without re-parsing
}

export interface ClarificationOption {
  label: string;  // displayed on the chip
  value: string;  // sent back as the answer (may differ from label)
}

// Behavior:
//   When Chat Shell renders a clarification, clicking an option emits
//   "clarification:resolved" with { requestId, answer: option.value }.
//   If the user types freeform instead of clicking a chip, the Chat Shell
//   still emits "clarification:resolved" (not "user:message") as long as
//   a clarification is pending. The pending state clears on resolution.


// ----------------------------------------------------------------------------
// INTENT — output of the Intent Parser
// ----------------------------------------------------------------------------

export type IntentAction = "create" | "modify" | "remove";

export interface Intent {
  action: IntentAction;
  subject: string;             // the core noun: "bitcoin price", "weather", "pomodoro timer"
  parameters: IntentParameters;
  raw: string;                 // original user utterance, always preserved

  // Present only for "modify" and "remove" actions.
  // Null means the target is ambiguous — the resolver couldn't determine which widget.
  // An upstream component (Context Resolver) fills this in; the Parser leaves it null.
  targetWidgetId: string | null;
}

// Parameter keys are a known vocabulary. Sources read specific keys.
// The Parser extracts what it can. Unknown keys are dropped, not invented.
export interface IntentParameters {
  location?: string;           // "Colorado Springs", "Denver", "Tokyo"
  coin?: string;               // "bitcoin", "ethereum", "solana"
  symbol?: string;             // "BTC", "ETH", "SOL"
  period?: string;             // "24h", "7d", "30d", "1y"
  count?: number;              // "top 5 coins", "last 10 headlines"
  displayFormat?: DisplayFormat;  // "chart", "card", "table"
  size?: WidgetSize;           // explicit size request: "make it bigger"
  query?: string;              // freeform search terms that don't fit other keys
}

// When a new data source needs a parameter that doesn't fit these keys,
// ADD A KEY HERE FIRST. Do not put source-specific data in a loose bag.
// This is the vocabulary that couples Parser ↔ Sources — making it
// explicit here is how we keep that coupling visible and controlled.


// ----------------------------------------------------------------------------
// WIDGET DESCRIPTOR — the unit of dashboard state
// ----------------------------------------------------------------------------

export type WidgetSize = "small" | "medium" | "large";

export interface WidgetDescriptor {
  id: string;                       // uuid, assigned by Widget Runtime on creation
  sourceId: string;                 // "crypto", "weather", "ai-generated"
  title: string;                    // display title rendered by Layout Engine
  size: WidgetSize;
  refreshIntervalMs: number | null; // null = no auto-refresh

  // Source-specific data. Populated by resolve(), cleared on persist,
  // re-populated on boot via refresh.
  data: unknown;

  // How to render this widget.
  render: WidgetRenderSpec;

  // Stored so the system can re-resolve on refresh and boot hydration.
  // This is the structured intent, NOT just the raw string — avoids re-parsing.
  resolvedIntent: Intent;

  lastUpdated: number;              // Date.now() timestamp, set by Runtime on every data update
}

export interface WidgetRenderSpec {
  type: RenderType;
  config: RenderConfig;
}


// ----------------------------------------------------------------------------
// RENDER TYPES — the contract between Data Sources and Layout Engine
// ----------------------------------------------------------------------------
//
// Each render type is a specific visual template. Data Sources set the type,
// Layout Engine renders it. A new source that needs a new visual MUST:
//   1. Add the type here
//   2. Define its config shape here
//   3. Add a template in the Layout Engine
//
// "generic" is the fallback — Layout Engine renders title + JSON dump.
// It always exists. A source should never need to use it intentionally.

export type RenderType =
  | "price-card"
  | "weather-card"
  | "chart"
  | "html-block"
  | "generic";

// Discriminated union: render config shape depends on render type.
export type RenderConfig =
  | PriceCardConfig
  | WeatherCardConfig
  | ChartConfig
  | HtmlBlockConfig
  | GenericConfig;

export interface PriceCardConfig {
  type: "price-card";
  coin: string;
  symbol: string;
  iconUrl?: string;
}

export interface WeatherCardConfig {
  type: "weather-card";
  location: string;
  units: "imperial" | "metric";
}

export interface ChartConfig {
  type: "chart";
  chartType: "line" | "bar" | "sparkline";
  xLabel?: string;
  yLabel?: string;
}

export interface HtmlBlockConfig {
  type: "html-block";
  // The generated HTML lives HERE, not in data.
  // data is stripped on persistence; config is preserved.
  // This ensures AI-generated widgets survive browser restarts.
  html: string;
  // The Layout Engine renders this in a sandboxed iframe:
  //   sandbox="allow-scripts" (NO allow-same-origin, NO allow-forms)
  //   srcdoc set from config.html
}

export interface GenericConfig {
  type: "generic";
  // No config — Layout Engine renders title + JSON.stringify(data, null, 2)
}


// ----------------------------------------------------------------------------
// DISPLAY FORMAT — how the user wants data presented
// ----------------------------------------------------------------------------

export type DisplayFormat = "card" | "chart" | "table";

// Mapping intent to render type is the Source's job, not the Parser's.
// The Parser extracts the user's stated preference into intent.parameters.displayFormat.
// The Source uses it as a hint when choosing render.type. It may ignore it
// if the display format doesn't make sense for the data.


// ----------------------------------------------------------------------------
// DATA SOURCE INTERFACE — what the Source Router registers
// ----------------------------------------------------------------------------

export interface DataSource {
  id: string;                  // unique, matches WidgetDescriptor.sourceId

  // Return 0.0-1.0. See confidence semantics below.
  match(intent: Intent): number;

  // Produce a partial WidgetDescriptor (no id, no lastUpdated — Runtime adds those).
  // On failure, return a DataSourceError. Never throw.
  resolve(intent: Intent): Promise<DataSourceResult>;
}

export type DataSourceResult =
  | DataSourceSuccess
  | DataSourceClarification
  | DataSourceError;

export interface DataSourceSuccess {
  kind: "success";
  descriptor: Omit<WidgetDescriptor, "id" | "lastUpdated">;
}

export interface DataSourceClarification {
  kind: "clarification";
  request: Omit<ClarificationRequest, "requestId">; // Router assigns requestId
}

export interface DataSourceError {
  kind: "error";
  message: string;             // human-readable, displayed in Chat Shell
  retryable: boolean;          // hint to Runtime: worth retrying on next refresh cycle?
}

// --- CONFIDENCE SEMANTICS ---
//
// 0.0       — "I definitely cannot handle this"
// 0.1 - 0.4 — "This is tangentially related but probably not for me"
// 0.5       — threshold: below this, the source is not considered
// 0.6 - 0.7 — "Partial match: I recognize some keywords" (e.g., "crypto" without a coin name)
// 0.8 - 0.9 — "Strong match: I know exactly what this is" (e.g., "bitcoin" → crypto source)
// 1.0       — "This is literally my exact domain, verbatim match"
//
// DO NOT return 1.0 unless the match is unambiguous.
// DO NOT return 0.0 unless you are certain you can't handle it.
// The Router picks the highest confidence above 0.5.
// Ties are broken by source registration order (first registered wins).
//
// The AI Widget Generator is NOT registered as a normal source.
// It is the Router's hardcoded fallback when nothing scores above 0.5.


// ----------------------------------------------------------------------------
// PERSISTENCE — what gets saved vs. dropped
// ----------------------------------------------------------------------------
//
// Persistence serializes WidgetDescriptor[] to JSON in localStorage.
//
// Fields PRESERVED on save:
//   id, sourceId, title, size, refreshIntervalMs,
//   render (full object), resolvedIntent (full object)
//
// Fields DROPPED on save:
//   data         → re-fetched on boot via refresh
//   lastUpdated  → reset on boot when fresh data arrives
//
// On load, every widget comes back with data: null and lastUpdated: 0.
// Widget Runtime must refresh widgets with refreshIntervalMs !== null
// immediately after hydration. Widgets without refresh (e.g., AI-generated)
// rely on render.config for display and are NOT re-resolved on boot.
//
// localStorage key: "vibe-dash-widgets"
// If the stored JSON is corrupt or unparseable, return [] and log a warning.
// If localStorage.setItem throws (quota exceeded), save() fails silently
// (console.warn). The Widget Runtime is responsible for detecting save
// failures and emitting a system:message of type "error" to the user.
// Persistence itself has no bus dependency and cannot emit events.

export interface PersistedWidget
  extends Omit<WidgetDescriptor, "data" | "lastUpdated"> {
  // This type exists to make the stripping explicit.
  // Persistence saves PersistedWidget[], loads PersistedWidget[].
  // Runtime hydrates these back into full WidgetDescriptor[] by adding
  // data: null and lastUpdated: 0.
}


// ----------------------------------------------------------------------------
// ERRORS — shared error shape for inter-component failures
// ----------------------------------------------------------------------------

export interface VibeDashError {
  code: ErrorCode;
  message: string;             // human-readable
  source: string;              // component that generated it: "crypto", "router", "runtime"
  retryable: boolean;
  details?: unknown;           // optional structured data for debugging
}

export type ErrorCode =
  | "SOURCE_FETCH_FAILED"     // network error or API returned non-2xx
  | "SOURCE_RATE_LIMITED"     // 429 from an external API
  | "SOURCE_NOT_FOUND"       // Router found no matching source (before AI fallback)
  | "PARSE_FAILED"           // Intent Parser couldn't make sense of input
  | "WIDGET_NOT_FOUND"       // modify/remove targeted a widget id that doesn't exist
  | "RENDER_FAILED"          // Layout Engine couldn't render a widget
  | "PERSIST_FAILED"         // localStorage write failed
  | "AI_GENERATION_FAILED";  // AI Widget Generator couldn't produce output

// Components return VibeDashError in their result types (see DataSourceError).
// They NEVER throw across component boundaries.
// Within a component, throw whatever you want. At the boundary, catch and wrap.


// ----------------------------------------------------------------------------
// COMPONENT CONSTRUCTORS — what each component receives at boot
// ----------------------------------------------------------------------------
//
// Every component is a plain object or class. Constructed once at boot.
// Every component receives the EventBus. Some receive additional dependencies.
//
// This section exists so the orchestrator (main.ts) knows the wiring.
//
// ChatShell(bus: EventBus, container: HTMLElement)
//   - Listens: "system:message", "clarification:pending"
//   - Emits:   "user:message", "clarification:resolved"
//
// IntentParser()
//   - Pure function, no bus dependency. Called directly by the orchestrator
//     or context resolver. Signature: parse(text: string) → Intent
//   - Stateless. Does not need the bus.
//
// SourceRouter(bus: EventBus, sources: DataSource[], aiGenerator: AiWidgetGenerator)
//   - Called directly: route(intent: Intent) → Promise<DataSourceResult>
//   - Also handles clarification re-entry via resolve-after-clarification.
//
// WidgetRuntime(bus: EventBus, persistence: PersistenceLayer, router: SourceRouter)
//   - Listens: (internal refresh timers)
//   - Emits:   "widgets:changed"
//   - Called:   addWidget(), removeWidget(), updateWidget(), boot()
//
// LayoutEngine(bus: EventBus, container: HTMLElement, removeWidget: RemoveWidgetFn)
//   - Listens: "widgets:changed"
//   - Emits:   (nothing — leaf component, renders to DOM)
//   - Calls:   WidgetRuntime.removeWidget() when user clicks X
//             (receives removeWidget as a callback, does NOT import Runtime)
//
// PersistenceLayer()
//   - Pure. No bus dependency.
//   - save(widgets): debounced write to localStorage. Fails silently on quota errors.
//   - load() → PersistedWidget[]: returns [] on missing/corrupt data.
//   - flush(widgets): immediate write, bypassing debounce. Use on beforeunload.
//   - clear(): removes all persisted widget data.
//
// AiWidgetGenerator()
//   - Called directly by SourceRouter as fallback.
//   - Signature: generate(intent: Intent) → Promise<DataSourceResult>
//   - Requires LLM API key (read from env or config at construction).

// For LayoutEngine's remove callback:
export type RemoveWidgetFn = (widgetId: string) => void;


// ----------------------------------------------------------------------------
// BOOT SEQUENCE — the order things happen at startup
// ----------------------------------------------------------------------------
//
// 1. Create EventBus
// 2. Create PersistenceLayer
// 3. Create IntentParser
// 4. Create all DataSources (crypto, weather, ...)
// 5. Create AiWidgetGenerator
// 6. Create SourceRouter(bus, sources, aiGenerator)
// 7. Create WidgetRuntime(bus, persistence, router)
// 8. Create LayoutEngine(bus, dashboardContainer, runtime.removeWidget)
// 9. Create ChatShell(bus, chatContainer)
// 10. Wire the orchestration:
//     - bus.on("user:message") → parse → dispatch by action:
//         create  → route → runtime.addWidget
//         modify  → resolve target widget → runtime.updateWidget
//         remove  → resolve target widget → runtime.removeWidget
//     - bus.on("clarification:resolved") → router.resumeAfterClarification
// 11. runtime.boot() — loads from persistence, refreshes widgets with refreshIntervalMs !== null
//
// After step 11, the app is live. The user types, widgets appear.
