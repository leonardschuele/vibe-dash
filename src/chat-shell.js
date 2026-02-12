// chat-shell.js — Right-side chat panel
//
// Listens:  system:message, clarification:pending
// Emits:    user:message, clarification:resolved
//
// The Chat Shell is a dumb pipe with a UI. It does not interpret messages,
// route intents, or know about widgets. It renders what it's told and emits
// what the user types.

export function createChatShell(bus, container) {
  let pendingClarification = null;
  let userHasScrolled = false;

  // --- DOM ---

  injectStyles();

  const shell = document.createElement('div');
  shell.className = 'chat-shell';
  shell.innerHTML = `
    <div class="chat-header">
      <span class="chat-header-title">Vibe Dash</span>
      <span class="chat-header-sub">Describe what you want to see</span>
    </div>
    <div class="chat-messages"></div>
    <div class="chat-input-wrap">
      <textarea rows="1" placeholder="Show me bitcoin price..." spellcheck="false"></textarea>
    </div>
  `;
  container.appendChild(shell);

  const messagesEl = shell.querySelector('.chat-messages');
  const textareaEl = shell.querySelector('textarea');

  // --- Auto-scroll ---

  messagesEl.addEventListener('scroll', () => {
    const { scrollTop, scrollHeight, clientHeight } = messagesEl;
    // If user is within 40px of bottom, auto-scroll is active
    userHasScrolled = (scrollHeight - scrollTop - clientHeight) > 40;
  });

  function scrollToBottom() {
    if (!userHasScrolled) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  // --- Message rendering ---

  function addMessage(role, type, content) {
    const msg = document.createElement('div');
    msg.className = `chat-msg chat-msg-${role} chat-msg-${type}`;

    if (typeof content === 'string') {
      msg.innerHTML = escapeHtml(content)
        .split('\n')
        .map(line => `<p>${line}</p>`)
        .join('');
    } else {
      msg.appendChild(content);
    }

    messagesEl.appendChild(msg);
    scrollToBottom();
    return msg;
  }

  function renderClarification(sysMsg) {
    const req = sysMsg.clarification;
    const frag = document.createDocumentFragment();

    const text = document.createElement('p');
    text.textContent = sysMsg.text;
    frag.appendChild(text);

    const chips = document.createElement('div');
    chips.className = 'chat-chips';
    for (const opt of req.options) {
      const btn = document.createElement('button');
      btn.className = 'chat-chip';
      btn.textContent = opt.label;
      btn.dataset.value = opt.value;
      chips.appendChild(btn);
    }
    frag.appendChild(chips);

    return frag;
  }

  // --- Bus listeners ---

  bus.on('system:message', (msg) => {
    if (msg.type === 'clarification' && msg.clarification) {
      pendingClarification = msg.clarification;
      addMessage('system', 'clarification', renderClarification(msg));
    } else {
      addMessage('system', msg.type, msg.text);
    }
  });

  bus.on('clarification:pending', (req) => {
    // Set pending state — the display comes through system:message
    pendingClarification = req;
  });

  // --- Chip clicks ---

  messagesEl.addEventListener('click', (e) => {
    const chip = e.target.closest('.chat-chip');
    if (!chip || !pendingClarification) return;

    // Disable all chips in this clarification
    const chipsContainer = chip.closest('.chat-chips');
    if (chipsContainer) {
      for (const btn of chipsContainer.querySelectorAll('.chat-chip')) {
        btn.disabled = true;
      }
      chip.classList.add('chat-chip-selected');
    }

    const value = chip.dataset.value;
    addMessage('user', 'user', chip.textContent);

    bus.emit('clarification:resolved', {
      requestId: pendingClarification.requestId,
      answer: value
    });
    pendingClarification = null;
  });

  // --- Textarea input ---

  textareaEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitInput();
    }
  });

  function submitInput() {
    const text = textareaEl.value.trim();
    if (!text) return;

    textareaEl.value = '';
    autoResizeTextarea();
    addMessage('user', 'user', text);

    if (pendingClarification) {
      bus.emit('clarification:resolved', {
        requestId: pendingClarification.requestId,
        answer: text
      });
      pendingClarification = null;
    } else {
      bus.emit('user:message', text);
    }
  }

  // Auto-resize textarea to content (up to 4 lines)
  textareaEl.addEventListener('input', autoResizeTextarea);

  function autoResizeTextarea() {
    textareaEl.style.height = 'auto';
    textareaEl.style.height = Math.min(textareaEl.scrollHeight, 100) + 'px';
  }

  // Focus textarea on load
  textareaEl.focus();
}


// --- Helpers ---

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function injectStyles() {
  if (document.getElementById('chat-shell-styles')) return;
  const style = document.createElement('style');
  style.id = 'chat-shell-styles';
  style.textContent = `
    .chat-shell {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: #0f0f1a;
      color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      font-size: 14px;
    }

    .chat-header {
      padding: 20px 16px 16px;
      border-bottom: 1px solid #1e1e3a;
    }

    .chat-header-title {
      display: block;
      font-size: 16px;
      font-weight: 600;
      color: #fff;
      margin-bottom: 2px;
    }

    .chat-header-sub {
      display: block;
      font-size: 12px;
      color: #888;
    }

    .chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .chat-messages::-webkit-scrollbar { width: 6px; }
    .chat-messages::-webkit-scrollbar-track { background: transparent; }
    .chat-messages::-webkit-scrollbar-thumb { background: #2a2a4a; border-radius: 3px; }

    .chat-msg {
      max-width: 88%;
      padding: 10px 14px;
      border-radius: 12px;
      line-height: 1.45;
      word-wrap: break-word;
    }

    .chat-msg p { margin: 0; }
    .chat-msg p + p { margin-top: 0.4em; }
    .chat-msg p:empty { margin-top: 0.6em; }

    .chat-msg-user {
      align-self: flex-end;
      background: #2a2a5a;
      color: #fff;
      border-bottom-right-radius: 4px;
    }

    .chat-msg-system.chat-msg-info {
      align-self: flex-start;
      background: #1a1a30;
      color: #b0b0c8;
      border-bottom-left-radius: 4px;
    }

    .chat-msg-system.chat-msg-success {
      align-self: flex-start;
      background: #0f2a1a;
      color: #6fcf97;
      border-bottom-left-radius: 4px;
    }

    .chat-msg-system.chat-msg-error {
      align-self: flex-start;
      background: #2a0f0f;
      color: #f08080;
      border-bottom-left-radius: 4px;
    }

    .chat-msg-system.chat-msg-clarification {
      align-self: flex-start;
      background: #1a1a30;
      color: #b0b0c8;
      border-bottom-left-radius: 4px;
    }

    .chat-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 10px;
    }

    .chat-chip {
      background: #2a2a5a;
      border: 1px solid #3a3a6a;
      color: #d0d0f0;
      padding: 5px 14px;
      border-radius: 16px;
      cursor: pointer;
      font-size: 13px;
      font-family: inherit;
      transition: background 0.15s, border-color 0.15s;
    }

    .chat-chip:hover:not(:disabled) {
      background: #3a3a6a;
      border-color: #5a5a8a;
    }

    .chat-chip:disabled {
      opacity: 0.4;
      cursor: default;
    }

    .chat-chip-selected {
      background: #4a4a8a !important;
      border-color: #7a7aaa !important;
      opacity: 1 !important;
    }

    .chat-input-wrap {
      padding: 12px 16px 16px;
      border-top: 1px solid #1e1e3a;
    }

    .chat-input-wrap textarea {
      width: 100%;
      box-sizing: border-box;
      background: #1a1a30;
      border: 1px solid #2a2a4a;
      color: #e0e0e0;
      padding: 10px 14px;
      border-radius: 10px;
      resize: none;
      font-family: inherit;
      font-size: 14px;
      line-height: 1.4;
      outline: none;
      transition: border-color 0.15s;
    }

    .chat-input-wrap textarea::placeholder { color: #555; }

    .chat-input-wrap textarea:focus {
      border-color: #4a4a7a;
    }
  `;
  document.head.appendChild(style);
}
