// layout-engine.js — Dashboard grid renderer
//
// Contract:
//   createLayoutEngine(bus, container, { removeWidget, reorderWidgets, resizeWidget })
//   Listens: "widgets:changed"
//   Emits:   nothing (leaf component)
//
// Renders WidgetDescriptor[] into a CSS Grid dashboard.
// Templates: price-card, weather-card, html-block, generic (fallback).
// Reconciles: creates new widgets, updates existing, animates out removed.
// Does NOT own state — pure projection of the widget array onto the DOM.

export function createLayoutEngine(bus, container, { removeWidget, reorderWidgets, resizeWidget }) {
  /** @type {Map<string, { element: HTMLElement, lastUpdated: number, renderType: string }>} */
  const rendered = new Map();

  /** @type {boolean} True while a drag is in progress — suppresses reconciliation */
  let dragging = false;

  injectStyles();

  const grid = document.createElement('div');
  grid.className = 'dashboard-grid';
  container.appendChild(grid);

  // Empty state
  const emptyState = document.createElement('div');
  emptyState.className = 'dashboard-empty';
  emptyState.innerHTML = `
    <div class="dashboard-empty-icon">+</div>
    <div class="dashboard-empty-text">Describe a widget in the chat to get started</div>
  `;
  grid.appendChild(emptyState);

  // --- SortableJS ---

  new Sortable(grid, {
    draggable: '.widget-card',
    filter: '.widget-remove, .widget-resize, a, button, input, textarea, iframe',
    preventOnFilter: false,
    delay: 150,
    delayOnTouchOnly: true,
    animation: 150,
    ghostClass: 'widget-ghost',
    chosenClass: 'widget-chosen',
    onStart() {
      dragging = true;
    },
    onEnd() {
      const orderedIds = [];
      for (const child of grid.children) {
        if (child.dataset && child.dataset.widgetId) {
          orderedIds.push(child.dataset.widgetId);
        }
      }
      reorderWidgets(orderedIds);
      dragging = false;
    }
  });

  // --- Reconciliation ---

  bus.on('widgets:changed', (widgets) => {
    if (dragging) return;

    const currentIds = new Set(widgets.map(w => w.id));

    // Remove widgets that are no longer present
    for (const [id, entry] of rendered) {
      if (!currentIds.has(id)) {
        animateOut(entry.element, () => {
          entry.element.remove();
          rendered.delete(id);
        });
      }
    }

    // Add or update widgets
    for (let i = 0; i < widgets.length; i++) {
      const widget = widgets[i];
      const existing = rendered.get(widget.id);

      if (!existing) {
        // New widget — create and insert
        const el = createWidgetElement(widget);
        grid.appendChild(el);
        rendered.set(widget.id, {
          element: el,
          lastUpdated: widget.lastUpdated,
          renderType: widget.render.type
        });
      } else if (existing.lastUpdated !== widget.lastUpdated) {
        // Data changed — update content in place
        updateWidgetContent(existing.element, widget);
        // Update size class if it changed
        existing.element.className = `widget-card widget-${widget.size}`;
        existing.lastUpdated = widget.lastUpdated;
        existing.renderType = widget.render.type;
      }
    }

    // Reconcile DOM order to match widget array order
    for (let i = 0; i < widgets.length; i++) {
      const entry = rendered.get(widgets[i].id);
      if (entry && entry.element !== grid.children[i]) {
        grid.insertBefore(entry.element, grid.children[i]);
      }
    }

    // Show/hide empty state
    emptyState.style.display = widgets.length === 0 ? '' : 'none';
  });

  // --- Widget element creation ---

  function createWidgetElement(widget) {
    const card = document.createElement('div');
    card.className = `widget-card widget-${widget.size}`;
    card.dataset.widgetId = widget.id;

    // Resize button
    const resizeBtn = document.createElement('button');
    resizeBtn.className = 'widget-resize';
    resizeBtn.innerHTML = '&#x21C5;';
    resizeBtn.title = 'Cycle size';
    resizeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sizeOrder = ['small', 'medium', 'large'];
      const current = card.className.match(/widget-(small|medium|large)/);
      const currentSize = current ? current[1] : 'small';
      const nextSize = sizeOrder[(sizeOrder.indexOf(currentSize) + 1) % sizeOrder.length];
      resizeWidget(widget.id, nextSize);
    });
    card.appendChild(resizeBtn);

    // Remove button
    const btn = document.createElement('button');
    btn.className = 'widget-remove';
    btn.innerHTML = '&#215;';
    btn.title = 'Remove widget';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeWidget(widget.id);
    });
    card.appendChild(btn);

    // Title
    const title = document.createElement('div');
    title.className = 'widget-title';
    title.textContent = widget.title;
    card.appendChild(title);

    // Content area
    const content = document.createElement('div');
    content.className = 'widget-content';
    card.appendChild(content);

    renderContent(content, widget);
    return card;
  }

  function updateWidgetContent(card, widget) {
    // Update title
    const titleEl = card.querySelector('.widget-title');
    if (titleEl) titleEl.textContent = widget.title;

    // Update content
    const content = card.querySelector('.widget-content');
    if (!content) return;

    // For html-block: don't re-render (iframe is static)
    if (widget.render.type === 'html-block' && content.querySelector('iframe')) {
      return;
    }

    renderContent(content, widget);
  }

  // --- Content renderers ---

  function renderContent(container, widget) {
    if (widget.data === null && widget.render.type !== 'html-block') {
      container.innerHTML = '<div class="widget-loading">Loading\u2026</div>';
      return;
    }

    switch (widget.render.type) {
      case 'price-card':
        renderPriceCard(container, widget);
        break;
      case 'weather-card':
        renderWeatherCard(container, widget);
        break;
      case 'news-card':
        renderNewsCard(container, widget);
        break;
      case 'html-block':
        renderHtmlBlock(container, widget);
        break;
      default:
        renderGeneric(container, widget);
        break;
    }
  }

  // --- Price Card ---

  function renderPriceCard(container, widget) {
    const d = widget.data;
    const changeClass = (d.change24h ?? 0) >= 0 ? 'positive' : 'negative';
    const changeSign = (d.change24h ?? 0) >= 0 ? '+' : '';

    container.innerHTML = `
      <div class="price-card">
        <div class="price-card-price">${formatPrice(d.price)}</div>
        <div class="price-card-change ${changeClass}">
          ${changeSign}${(d.change24h ?? 0).toFixed(2)}%
        </div>
        <div class="price-card-meta">
          ${d.marketCap ? `<span>MCap ${formatCompact(d.marketCap)}</span>` : ''}
          ${d.volume24h ? `<span>Vol ${formatCompact(d.volume24h)}</span>` : ''}
        </div>
      </div>
    `;
  }

  // --- Weather Card ---

  function renderWeatherCard(container, widget) {
    const d = widget.data;

    let forecastHtml = '';
    if (d.forecast && d.forecast.length > 0) {
      const days = d.forecast.map(day => `
        <div class="weather-fc-day">
          <div class="weather-fc-name">${getDayName(day.date)}</div>
          <div class="weather-fc-icon">${day.icon || ''}</div>
          <div class="weather-fc-temps">
            <span class="weather-fc-hi">${Math.round(day.high)}\u00B0</span>
            <span class="weather-fc-lo">${Math.round(day.low)}\u00B0</span>
          </div>
        </div>
      `).join('');
      forecastHtml = `<div class="weather-forecast">${days}</div>`;
    }

    container.innerHTML = `
      <div class="weather-card">
        <div class="weather-current">
          <div class="weather-current-main">
            <span class="weather-icon">${d.icon || ''}</span>
            <span class="weather-temp">${Math.round(d.tempF)}\u00B0F</span>
          </div>
          <div class="weather-condition">${escapeHtml(d.condition)}</div>
          <div class="weather-details">
            ${d.feelsLikeF != null ? `<span>Feels ${Math.round(d.feelsLikeF)}\u00B0</span>` : ''}
            <span>Humidity ${d.humidity}%</span>
            <span>Wind ${Math.round(d.windSpeed)} mph</span>
          </div>
        </div>
        ${forecastHtml}
      </div>
    `;
  }

  // --- News Card ---

  function renderNewsCard(container, widget) {
    const d = widget.data;
    const stories = d.stories || [];

    if (stories.length === 0) {
      container.innerHTML = '<div class="widget-loading">No stories found</div>';
      return;
    }

    const items = stories.map((story, i) => {
      const domain = extractDomain(story.url);
      const timeAgo = formatTimeAgo(story.createdAt);
      const titleHtml = escapeHtml(story.title);
      const authorHtml = story.author ? escapeHtml(story.author) : '';

      return `
        <li class="news-story">
          <span class="news-rank">${i + 1}.</span>
          <div class="news-story-body">
            <a class="news-story-link" href="${escapeAttr(story.url)}" target="_blank" rel="noopener noreferrer">${titleHtml}</a>
            <div class="news-meta">
              ${domain ? `<span class="news-domain">${escapeHtml(domain)}</span>` : ''}
              ${story.points != null ? `<span>${story.points} pts</span>` : ''}
              ${story.commentCount != null ? `<a class="news-comments" href="${escapeAttr(story.commentUrl)}" target="_blank" rel="noopener noreferrer">${story.commentCount} comments</a>` : ''}
              ${authorHtml ? `<span>by ${authorHtml}</span>` : ''}
              ${timeAgo ? `<span>${timeAgo}</span>` : ''}
            </div>
          </div>
        </li>
      `;
    }).join('');

    container.innerHTML = `
      <ol class="news-list">${items}</ol>
    `;
  }

  // --- HTML Block (AI-generated) ---

  function renderHtmlBlock(container, widget) {
    // Only create iframe once — don't recreate on updates
    if (container.querySelector('iframe')) return;

    const html = widget.render.config.html;
    if (!html) {
      container.innerHTML = '<div class="widget-loading">No content</div>';
      return;
    }

    const iframe = document.createElement('iframe');
    iframe.className = 'widget-iframe';
    iframe.sandbox = 'allow-scripts';
    iframe.srcdoc = html;
    iframe.title = widget.title;

    container.innerHTML = '';
    container.appendChild(iframe);
  }

  // --- Generic fallback ---

  function renderGeneric(container, widget) {
    const dataStr = widget.data != null
      ? JSON.stringify(widget.data, null, 2)
      : 'null';

    container.innerHTML = `
      <div class="generic-card">
        <pre class="generic-data"><code>${escapeHtml(dataStr)}</code></pre>
      </div>
    `;
  }

  // --- Animation ---

  function animateOut(element, onDone) {
    let done = false;
    const finish = () => { if (done) return; done = true; onDone(); };
    element.classList.add('widget-exiting');
    element.addEventListener('transitionend', finish, { once: true });
    // Safety: if transition doesn't fire (e.g., display:none), clean up anyway
    setTimeout(finish, 300);
  }
}


// --- Formatting helpers ---

function formatPrice(n) {
  if (n == null) return '$\u2014';
  if (n >= 1) {
    return '$' + n.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }
  // Small prices (meme coins): show more decimals
  if (n >= 0.0001) {
    return '$' + n.toLocaleString('en-US', {
      minimumFractionDigits: 4,
      maximumFractionDigits: 6
    });
  }
  return '$' + n.toExponential(2);
}

function formatCompact(n) {
  if (n == null) return '\u2014';
  if (n >= 1e12) return '$' + (n / 1e12).toFixed(1) + 'T';
  if (n >= 1e9)  return '$' + (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6)  return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3)  return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
}

function getDayName(dateStr) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const d = new Date(dateStr + 'T12:00:00');
  return days[d.getDay()];
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatTimeAgo(isoString) {
  if (!isoString) return '';
  const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function extractDomain(url) {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}


// --- Styles ---

function injectStyles() {
  if (document.getElementById('layout-engine-styles')) return;
  const style = document.createElement('style');
  style.id = 'layout-engine-styles';
  style.textContent = `
    /* --- Grid --- */

    .dashboard-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 16px;
      padding: 24px;
      align-content: start;
      height: 100%;
      overflow-y: auto;
    }

    .dashboard-grid::-webkit-scrollbar { width: 6px; }
    .dashboard-grid::-webkit-scrollbar-track { background: transparent; }
    .dashboard-grid::-webkit-scrollbar-thumb { background: #1e1e3a; border-radius: 3px; }

    /* --- Empty state --- */

    .dashboard-empty {
      grid-column: 1 / -1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 300px;
      color: #444;
      gap: 12px;
    }

    .dashboard-empty-icon {
      width: 56px;
      height: 56px;
      border: 2px dashed #333;
      border-radius: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      color: #444;
    }

    .dashboard-empty-text {
      font-size: 14px;
    }

    /* --- Widget card --- */

    .widget-card {
      background: #13132a;
      border: 1px solid #1e1e3a;
      border-radius: 16px;
      padding: 20px;
      position: relative;
      animation: widget-enter 0.3s ease-out;
      transition: opacity 0.25s ease, transform 0.25s ease;
      cursor: grab;
    }

    .widget-card:active { cursor: grabbing; }

    .widget-ghost { opacity: 0.3; }

    .widget-chosen {
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
      z-index: 10;
    }

    .widget-card.widget-exiting {
      opacity: 0;
      transform: scale(0.95) translateY(8px);
    }

    @keyframes widget-enter {
      from { opacity: 0; transform: translateY(16px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    .widget-small  { grid-column: span 1; }
    .widget-medium { grid-column: span 2; }
    .widget-large  { grid-column: 1 / -1; }

    /* Responsive: collapse multi-column widgets on narrow screens */
    @media (max-width: 640px) {
      .widget-medium, .widget-large { grid-column: span 1; }
    }

    /* --- Remove button --- */

    .widget-remove {
      position: absolute;
      top: 12px;
      right: 12px;
      width: 26px;
      height: 26px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 8px;
      color: #555;
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s, background 0.15s, color 0.15s;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      font-family: inherit;
    }

    .widget-card:hover .widget-remove,
    .widget-card:hover .widget-resize { opacity: 1; }

    .widget-remove:hover {
      background: rgba(255, 80, 80, 0.15);
      border-color: rgba(255, 80, 80, 0.2);
      color: #f88;
    }

    /* --- Resize button --- */

    .widget-resize {
      position: absolute;
      top: 12px;
      right: 42px;
      width: 26px;
      height: 26px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 8px;
      color: #555;
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s, background 0.15s, color 0.15s;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      font-family: inherit;
    }

    .widget-resize:hover {
      background: rgba(78, 205, 196, 0.15);
      border-color: rgba(78, 205, 196, 0.2);
      color: #4ecdc4;
    }

    /* --- Title --- */

    .widget-title {
      font-size: 13px;
      font-weight: 600;
      color: #888;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 12px;
    }

    /* --- Loading --- */

    .widget-loading {
      color: #444;
      font-size: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 80px;
      animation: pulse 1.8s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 0.4; }
      50%      { opacity: 1; }
    }

    /* --- Price card --- */

    .price-card-price {
      font-size: 32px;
      font-weight: 700;
      color: #fff;
      line-height: 1.2;
    }

    .price-card-change {
      font-size: 15px;
      font-weight: 600;
      margin-top: 4px;
    }

    .price-card-change.positive { color: #4ecdc4; }
    .price-card-change.negative { color: #ff6b6b; }

    .price-card-meta {
      display: flex;
      gap: 16px;
      margin-top: 14px;
      font-size: 12px;
      color: #666;
    }

    /* --- Weather card --- */

    .weather-current {
      margin-bottom: 16px;
    }

    .weather-current-main {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 4px;
    }

    .weather-icon {
      font-size: 40px;
      line-height: 1;
    }

    .weather-temp {
      font-size: 40px;
      font-weight: 700;
      color: #fff;
      line-height: 1;
    }

    .weather-condition {
      font-size: 14px;
      color: #aaa;
      margin-bottom: 8px;
    }

    .weather-details {
      display: flex;
      gap: 16px;
      font-size: 12px;
      color: #666;
    }

    .weather-forecast {
      display: flex;
      gap: 4px;
      padding-top: 14px;
      border-top: 1px solid #1e1e3a;
      overflow-x: auto;
    }

    .weather-fc-day {
      flex: 1;
      text-align: center;
      min-width: 44px;
      font-size: 12px;
      color: #888;
    }

    .weather-fc-name {
      font-weight: 600;
      margin-bottom: 4px;
      color: #aaa;
    }

    .weather-fc-icon {
      font-size: 18px;
      margin-bottom: 4px;
      line-height: 1.2;
    }

    .weather-fc-temps {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .weather-fc-hi {
      color: #ccc;
      font-weight: 500;
    }

    .weather-fc-lo {
      color: #555;
    }

    /* --- News card --- */

    .news-list {
      list-style: none;
      margin: 0;
      padding: 0;
      max-height: 400px;
      overflow-y: auto;
    }

    .news-list::-webkit-scrollbar { width: 4px; }
    .news-list::-webkit-scrollbar-track { background: transparent; }
    .news-list::-webkit-scrollbar-thumb { background: #1e1e3a; border-radius: 2px; }

    .news-story {
      display: flex;
      gap: 8px;
      padding: 8px 0;
      border-bottom: 1px solid #1a1a30;
    }

    .news-story:last-child {
      border-bottom: none;
    }

    .news-rank {
      color: #444;
      font-size: 12px;
      min-width: 22px;
      text-align: right;
      padding-top: 1px;
      flex-shrink: 0;
    }

    .news-story-body {
      min-width: 0;
    }

    .news-story-link {
      color: #d0d0e0;
      text-decoration: none;
      font-size: 13px;
      line-height: 1.4;
      display: block;
      word-wrap: break-word;
    }

    .news-story-link:visited {
      color: #8888a0;
    }

    .news-story-link:hover {
      color: #fff;
    }

    .news-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 3px;
      font-size: 11px;
      color: #555;
    }

    .news-domain {
      color: #666;
    }

    .news-comments {
      color: #555;
      text-decoration: none;
    }

    .news-comments:hover {
      color: #4ecdc4;
    }

    /* --- HTML block (iframe) --- */

    .widget-card:has(.widget-iframe) {
      padding: 0;
      overflow: hidden;
    }

    .widget-card:has(.widget-iframe) .widget-title {
      padding: 16px 20px 0;
    }

    .widget-card:has(.widget-iframe) .widget-content {
      height: 280px;
    }

    .widget-card.widget-large:has(.widget-iframe) .widget-content {
      height: 400px;
    }

    .widget-iframe {
      width: 100%;
      height: 100%;
      border: none;
      display: block;
    }

    /* --- Generic fallback --- */

    .generic-data {
      background: #0a0a1a;
      border-radius: 8px;
      padding: 12px;
      font-size: 11px;
      color: #888;
      overflow: auto;
      max-height: 200px;
      margin: 0;
      white-space: pre-wrap;
      word-break: break-all;
    }

    .generic-data code {
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    }
  `;
  document.head.appendChild(style);
}
