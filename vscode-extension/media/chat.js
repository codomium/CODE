/* eslint-disable */
/**
 * chat.js — Claude Code VS Code Webview Client
 *
 * Responsibilities:
 * - Render chat messages (markdown, code blocks with syntax highlighting)
 * - Stream assistant replies token-by-token
 * - Display tool execution cards (collapsible)
 * - @file autocomplete for context injection
 * - Apply-to-file button on code blocks
 * - Model / permission-mode selectors
 * - Stats bar (tokens, cost, elapsed time)
 */

(function () {
    'use strict';

    // ── VS Code API ──────────────────────────────────────────────────────────
    const vscode = acquireVsCodeApi();

    // ── State ────────────────────────────────────────────────────────────────
    let isLoading = false;
    let currentStreamMsg = null; // DOM element being streamed into
    let contextFiles = [];       // { name, path }
    let tokenStats = { input: 0, output: 0 };
    let costTotal = 0;
    let startTime = Date.now();
    let currentModel = '';
    let pendingApply = null;     // { code, language }
    let activeToolCards = {};    // toolName -> dom element

    // ── DOM refs ─────────────────────────────────────────────────────────────
    const messagesEl   = document.getElementById('messages');
    const welcomeEl    = document.getElementById('welcome');
    const inputEl      = document.getElementById('user-input');
    const sendBtn      = document.getElementById('send-btn');
    const stopBtn      = document.getElementById('stop-btn');
    const modelSelect  = document.getElementById('model-select');
    const modeSelect   = document.getElementById('mode-select');
    const addFileBtn   = document.getElementById('add-file-btn');
    const newChatBtn   = document.getElementById('new-chat-btn');
    const contextFilesEl = document.getElementById('context-files');
    const loadingEl    = document.getElementById('loading-indicator');
    const loadingText  = document.getElementById('loading-text');
    const statsModel   = document.getElementById('stats-model');
    const statsTokens  = document.getElementById('stats-tokens');
    const statsCost    = document.getElementById('stats-cost');
    const statsTime    = document.getElementById('stats-time');
    const autocompleteEl = document.getElementById('autocomplete');
    const applyModal   = document.getElementById('apply-modal');
    const applyModalBody = document.getElementById('apply-modal-body');
    const applyConfirmBtn = document.getElementById('apply-confirm-btn');
    const applyPickBtn   = document.getElementById('apply-pick-btn');
    const applyCancelBtn = document.getElementById('apply-cancel-btn');
    const thinkingToggleEl      = document.getElementById('thinking-toggle');
    const thinkingToggleWrapper = document.getElementById('thinking-toggle-wrapper');
    const thinkingLabelEl       = document.getElementById('thinking-label');

    /** Models that support NVIDIA thinking mode toggle */
    const THINKING_CAPABLE_MODELS = new Set([
        'moonshotai/kimi-k2.5',
        'deepseek-ai/deepseek-r1',
    ]);

    // ── Tick elapsed time ────────────────────────────────────────────────────
    setInterval(() => {
        if (!statsTime) return;
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        statsTime.textContent = elapsed < 60
            ? `${elapsed}s`
            : `${Math.floor(elapsed/60)}m${elapsed%60}s`;
    }, 1000);

    // ── Minimal Markdown → HTML renderer ─────────────────────────────────────
    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function renderMarkdown(text) {
        if (!text) return '';

        // Collect fenced code blocks to prevent inner processing
        const codeBlocks = [];
        let md = text.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
            const idx = codeBlocks.length;
            codeBlocks.push({ lang: lang.trim(), code });
            return `\x00CODE${idx}\x00`;
        });

        // Inline code
        const inlineCode = [];
        md = md.replace(/`([^`]+)`/g, (_, code) => {
            const idx = inlineCode.length;
            inlineCode.push(code);
            return `\x00INLINE${idx}\x00`;
        });

        // Escape HTML in the rest
        md = escapeHtml(md);

        // Headers
        md = md.replace(/^(#{1,6})\s+(.+)$/gm, (_, hashes, content) => {
            const level = hashes.length;
            return `<h${level}>${content}</h${level}>`;
        });

        // Bold + italic
        md = md.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
        md = md.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        md = md.replace(/\*(.+?)\*/g, '<em>$1</em>');
        md = md.replace(/__(.+?)__/g, '<strong>$1</strong>');
        md = md.replace(/_(.+?)_/g, '<em>$1</em>');

        // Strikethrough
        md = md.replace(/~~(.+?)~~/g, '<del>$1</del>');

        // Links
        md = md.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

        // Horizontal rules
        md = md.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '<hr>');

        // Blockquotes (simple, single-level)
        md = md.replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>');

        // Unordered lists (simple)
        md = md.replace(/^[\*\-]\s+(.+)$/gm, '<li>$1</li>');
        md = md.replace(/(<li>[\s\S]*?<\/li>)+/g, (m) => `<ul>${m}</ul>`);

        // Ordered lists
        md = md.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');

        // Tables
        md = md.replace(/^\|(.+)\|\s*\n\|[-| :]+\|\s*\n((?:\|.+\|\s*\n)*)/gm, (_, header, rows) => {
            const th = header.split('|').map(c => `<th>${c.trim()}</th>`).join('');
            const trs = rows.trim().split('\n').map(row => {
                const tds = row.slice(1, -1).split('|').map(c => `<td>${c.trim()}</td>`).join('');
                return `<tr>${tds}</tr>`;
            }).join('');
            return `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
        });

        // Paragraphs: wrap consecutive non-empty lines
        md = md.replace(/\n\n+/g, '\n\n');
        const paragraphs = md.split('\n\n').map(chunk => {
            chunk = chunk.trim();
            if (!chunk) return '';
            if (/^<(h\d|ul|ol|table|blockquote|hr)/.test(chunk)) return chunk;
            return `<p>${chunk.replace(/\n/g, '<br>')}</p>`;
        });
        md = paragraphs.join('\n');

        // Restore inline code
        md = md.replace(/\x00INLINE(\d+)\x00/g, (_, i) => {
            return `<code>${escapeHtml(inlineCode[+i])}</code>`;
        });

        // Restore code blocks — rendered as interactive elements
        md = md.replace(/\x00CODE(\d+)\x00/g, (_, i) => {
            const { lang, code } = codeBlocks[+i];
            return buildCodeBlockHtml(code, lang);
        });

        return md;
    }

    // ── Syntax Highlighter ────────────────────────────────────────────────────

    const keywords = {
        js: ['const','let','var','function','return','if','else','for','while','do','break','continue',
             'switch','case','default','class','extends','new','this','super','import','export','from',
             'async','await','try','catch','finally','throw','typeof','instanceof','in','of','delete',
             'void','yield','static','get','set','null','undefined','true','false'],
        ts: ['const','let','var','function','return','if','else','for','while','do','break','continue',
             'switch','case','default','class','extends','new','this','super','import','export','from',
             'async','await','try','catch','finally','throw','typeof','instanceof','in','of','delete',
             'void','yield','static','get','set','null','undefined','true','false',
             'interface','type','enum','namespace','declare','abstract','implements','readonly',
             'public','private','protected','as','keyof','infer','never','any','string','number','boolean'],
        py: ['def','class','return','if','elif','else','for','while','break','continue','pass','import',
             'from','as','try','except','finally','raise','with','lambda','yield','async','await',
             'True','False','None','and','or','not','in','is','del','global','nonlocal','print'],
        go: ['func','var','const','type','struct','interface','map','chan','package','import','return',
             'if','else','for','switch','case','default','break','continue','go','defer','select',
             'nil','true','false','string','int','float64','bool','error'],
        rust: ['fn','let','mut','const','struct','enum','impl','trait','mod','use','pub','crate','super',
               'self','return','if','else','for','while','loop','match','break','continue','async','await',
               'true','false','None','Some','Ok','Err'],
        java: ['class','interface','extends','implements','new','return','if','else','for','while','do',
               'switch','case','default','break','continue','try','catch','finally','throw','throws',
               'public','private','protected','static','final','abstract','import','package',
               'null','true','false','void','int','long','double','float','boolean','String'],
        sh: ['if','then','else','elif','fi','for','do','done','while','case','esac','function',
             'return','exit','echo','export','local','readonly','shift','source',
             'true','false','null'],
    };

    function highlightCode(code, lang) {
        const l = (lang || '').toLowerCase().replace(/[^a-z0-9#+-]/g, '');

        // Map aliases
        const langMap = {
            javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
            typescript: 'ts', tsx: 'ts',
            python: 'py', py3: 'py',
            golang: 'go',
            shell: 'sh', bash: 'sh', zsh: 'sh', cmd: 'sh',
            java: 'java',
            rust: 'rust', rs: 'rust',
        };
        const normalLang = langMap[l] || l;

        const kws = keywords[normalLang] || keywords.js;
        const kwSet = new Set(kws);

        // For JSON, use a simple formatter
        if (normalLang === 'json') return highlightJson(code);

        let result = '';
        let i = 0;
        const len = code.length;

        while (i < len) {
            // Single-line comment
            if ((normalLang === 'js' || normalLang === 'ts' || normalLang === 'go' ||
                 normalLang === 'java' || normalLang === 'rust') &&
                code[i] === '/' && code[i+1] === '/') {
                const end = code.indexOf('\n', i);
                const comment = end === -1 ? code.slice(i) : code.slice(i, end);
                result += `<span class="tok-comment">${escapeHtml(comment)}</span>`;
                i += comment.length;
                continue;
            }
            // Python/Bash comment
            if ((normalLang === 'py' || normalLang === 'sh') && code[i] === '#') {
                const end = code.indexOf('\n', i);
                const comment = end === -1 ? code.slice(i) : code.slice(i, end);
                result += `<span class="tok-comment">${escapeHtml(comment)}</span>`;
                i += comment.length;
                continue;
            }
            // Block comment
            if ((normalLang === 'js' || normalLang === 'ts' || normalLang === 'go' ||
                 normalLang === 'java' || normalLang === 'rust') &&
                code[i] === '/' && code[i+1] === '*') {
                const end = code.indexOf('*/', i + 2);
                const comment = end === -1 ? code.slice(i) : code.slice(i, end + 2);
                result += `<span class="tok-comment">${escapeHtml(comment)}</span>`;
                i += comment.length;
                continue;
            }
            // String (double quote)
            if (code[i] === '"') {
                let j = i + 1;
                while (j < len && !(code[j] === '"' && code[j-1] !== '\\')) j++;
                const str = code.slice(i, j + 1);
                result += `<span class="tok-string">${escapeHtml(str)}</span>`;
                i = j + 1;
                continue;
            }
            // String (single quote)
            if (code[i] === "'") {
                let j = i + 1;
                while (j < len && !(code[j] === "'" && code[j-1] !== '\\')) j++;
                const str = code.slice(i, j + 1);
                result += `<span class="tok-string">${escapeHtml(str)}</span>`;
                i = j + 1;
                continue;
            }
            // Template literal
            if (code[i] === '`' && (normalLang === 'js' || normalLang === 'ts')) {
                let j = i + 1;
                while (j < len && !(code[j] === '`' && code[j-1] !== '\\')) j++;
                const str = code.slice(i, j + 1);
                result += `<span class="tok-string">${escapeHtml(str)}</span>`;
                i = j + 1;
                continue;
            }
            // Number
            if (/\d/.test(code[i]) && (i === 0 || /\W/.test(code[i-1]))) {
                let j = i;
                while (j < len && /[\d._xXbBoO]/.test(code[j])) j++;
                result += `<span class="tok-number">${escapeHtml(code.slice(i, j))}</span>`;
                i = j;
                continue;
            }
            // Identifier or keyword
            if (/[a-zA-Z_$]/.test(code[i])) {
                let j = i;
                while (j < len && /[\w$]/.test(code[j])) j++;
                const word = code.slice(i, j);
                if (kwSet.has(word)) {
                    result += `<span class="tok-keyword">${escapeHtml(word)}</span>`;
                } else if (/^[A-Z]/.test(word)) {
                    result += `<span class="tok-type">${escapeHtml(word)}</span>`;
                } else if (code[j] === '(') {
                    result += `<span class="tok-function">${escapeHtml(word)}</span>`;
                } else {
                    result += `<span class="tok-variable">${escapeHtml(word)}</span>`;
                }
                i = j;
                continue;
            }
            // Operator
            if (/[=><!&|+\-*/%^~?]/.test(code[i])) {
                result += `<span class="tok-operator">${escapeHtml(code[i])}</span>`;
                i++;
                continue;
            }
            // Everything else
            result += escapeHtml(code[i]);
            i++;
        }
        return result;
    }

    function highlightJson(code) {
        return escapeHtml(code).replace(
            /("(?:\\.|[^"\\])*")\s*:|("(?:\\.|[^"\\])*")|(true|false|null)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
            (m, key, str, bool, num) => {
                if (key) return `<span class="tok-attr">${key}</span>:`;
                if (str) return `<span class="tok-string">${str}</span>`;
                if (bool) return `<span class="tok-keyword">${bool}</span>`;
                if (num) return `<span class="tok-number">${num}</span>`;
                return m;
            }
        );
    }

    // ── Code block HTML builder ───────────────────────────────────────────────
    let codeBlockIdCounter = 0;
    // Store code by ID to avoid large data attributes and XSS risks
    const codeStore = new Map();

    function buildCodeBlockHtml(code, lang) {
        const id = `cb-${++codeBlockIdCounter}`;
        const highlighted = highlightCode(code, lang);
        const displayLang = lang || 'code';
        // Store code in JS Map, not in DOM attribute
        codeStore.set(id, { code, language: lang || '' });
        // Use data-block-id for event delegation; no inline onclick
        return `<div class="code-block" id="${id}" data-block-id="${id}" data-lang="${escapeHtml(lang || '')}">
  <div class="code-header">
    <span class="code-lang">${escapeHtml(displayLang)}</span>
    <div class="code-actions">
      <button class="code-btn copy-btn" data-action="copy" data-block-id="${id}">Copy</button>
      <button class="code-btn apply-btn" data-action="apply" data-block-id="${id}">Apply to file…</button>
    </div>
  </div>
  <pre><code>${highlighted}</code></pre>
</div>`;
    }

    // ── Event delegation for code block buttons ───────────────────────────────
    // (replaces window.copyCode / window.applyCode inline onclick handlers)
    messagesEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        const blockId = btn.dataset.blockId;
        if (!blockId) return;
        if (action === 'copy') {
            const entry = codeStore.get(blockId);
            if (!entry) return;
            vscode.postMessage({ type: 'copyToClipboard', text: entry.code });
            btn.textContent = 'Copied!';
            setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
        } else if (action === 'apply') {
            const entry = codeStore.get(blockId);
            if (!entry) return;
            pendingApply = { code: entry.code, language: entry.language };
            showApplyModal(entry.code);
        }
    });

    function decodeHtmlEntities(str) {
        // Manually reverse only the escapes produced by escapeHtml()
        return str
            .replace(/&quot;/g, '"')
            .replace(/&#039;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&');
    }

    // ── Apply Modal ───────────────────────────────────────────────────────────
    function cancelApply() {
        applyModal.classList.remove('visible');
        pendingApply = null;
    }

    function showApplyModal(code) {
        const preview = code.length > 2000 ? code.slice(0, 2000) + '\n…' : code;
        applyModalBody.innerHTML = buildCodeBlockHtml(preview, pendingApply.language);
        applyModal.classList.add('visible');
    }

    const applyCancelTopBtn = document.getElementById('apply-cancel-top');
    if (applyCancelTopBtn) {
        applyCancelTopBtn.addEventListener('click', cancelApply);
    }

    if (applyCancelBtn) {
        applyCancelBtn.addEventListener('click', cancelApply);
    }

    if (applyConfirmBtn) {
        applyConfirmBtn.addEventListener('click', () => {
            if (!pendingApply) return;
            vscode.postMessage({
                type: 'applyCode',
                code: pendingApply.code,
                language: pendingApply.language,
            });
            cancelApply();
        });
    }

    if (applyPickBtn) {
        applyPickBtn.addEventListener('click', () => {
            if (!pendingApply) return;
            vscode.postMessage({
                type: 'applyCodeToFile',
                code: pendingApply.code,
                language: pendingApply.language,
            });
            cancelApply();
        });
    }

    // ── Message rendering ─────────────────────────────────────────────────────
    function hideWelcome() {
        if (welcomeEl && !welcomeEl.classList.contains('hidden')) {
            welcomeEl.classList.add('hidden');
        }
    }

    function scrollToBottom() {
        requestAnimationFrame(() => {
            messagesEl.scrollTop = messagesEl.scrollHeight;
        });
    }

    function addUserMessage(text) {
        hideWelcome();
        currentStreamMsg = null;
        const div = document.createElement('div');
        div.className = 'msg msg-user';
        div.innerHTML = `
            <div class="msg-meta">You</div>
            <div class="msg-bubble">${escapeHtml(text)}</div>
        `;
        messagesEl.appendChild(div);
        scrollToBottom();
    }

    function getOrCreateAssistantMessage() {
        if (currentStreamMsg) return currentStreamMsg;
        hideWelcome();
        const div = document.createElement('div');
        div.className = 'msg msg-assistant';
        div.innerHTML = `
            <div class="msg-header">
                <div class="msg-avatar">✦</div>
                <span class="msg-name">Claude</span>
            </div>
            <div class="msg-content streaming-cursor"></div>
        `;
        messagesEl.appendChild(div);
        currentStreamMsg = div.querySelector('.msg-content');
        scrollToBottom();
        return currentStreamMsg;
    }

    function appendStreamText(text) {
        const el = getOrCreateAssistantMessage();
        // Accumulate raw text on element, re-render markdown periodically
        el._rawText = (el._rawText || '') + text;
        // Throttle rendering to avoid layout thrashing
        if (!el._renderPending) {
            el._renderPending = true;
            requestAnimationFrame(() => {
                el._renderPending = false;
                if (el._rawText) {
                    el.innerHTML = renderMarkdown(el._rawText);
                    el.classList.add('streaming-cursor');
                }
                scrollToBottom();
            });
        }
    }

    function finalizeAssistantMessage(content) {
        if (currentStreamMsg) {
            const raw = currentStreamMsg._rawText || content || '';
            currentStreamMsg.innerHTML = raw ? renderMarkdown(raw) : '';
            currentStreamMsg.classList.remove('streaming-cursor');
            currentStreamMsg._rawText = '';
            currentStreamMsg = null;
        } else if (content) {
            hideWelcome();
            const div = document.createElement('div');
            div.className = 'msg msg-assistant';
            div.innerHTML = `
                <div class="msg-header">
                    <div class="msg-avatar">✦</div>
                    <span class="msg-name">Claude</span>
                </div>
                <div class="msg-content">${renderMarkdown(content)}</div>
            `;
            messagesEl.appendChild(div);
        }
        scrollToBottom();
    }

    let toolCardCounter = 0;

    function addToolCard(toolName) {
        hideWelcome();
        const id = `tool-${++toolCardCounter}`;

        // Build card using DOM API so toolName is safely set via textContent
        const msgDiv = document.createElement('div');
        msgDiv.className = 'msg';

        const card = document.createElement('div');
        card.className = 'tool-card';
        card.id = id;

        const header = document.createElement('div');
        header.className = 'tool-card-header';
        header.addEventListener('click', () => card.classList.toggle('expanded'));

        const iconSpan = document.createElement('span');
        iconSpan.className = 'tool-icon';
        iconSpan.textContent = '⚙';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'tool-name';
        nameSpan.textContent = toolName;          // safe — textContent, not innerHTML

        const statusSpan = document.createElement('span');
        statusSpan.className = 'tool-status';
        const spinnerSpan = document.createElement('span');
        spinnerSpan.className = 'tool-spinner';
        spinnerSpan.textContent = '⟳';
        statusSpan.appendChild(spinnerSpan);
        statusSpan.appendChild(document.createTextNode(' running…'));

        const chevron = document.createElement('span');
        chevron.className = 'tool-chevron';
        chevron.textContent = '▶';

        header.appendChild(iconSpan);
        header.appendChild(nameSpan);
        header.appendChild(statusSpan);
        header.appendChild(chevron);

        const body = document.createElement('div');
        body.className = 'tool-card-body';

        const resultDiv = document.createElement('div');
        resultDiv.className = 'tool-result';
        resultDiv.id = `${id}-result`;
        const em = document.createElement('em');
        em.textContent = 'Waiting for result…';
        resultDiv.appendChild(em);
        body.appendChild(resultDiv);

        card.appendChild(header);
        card.appendChild(body);
        msgDiv.appendChild(card);
        messagesEl.appendChild(msgDiv);

        activeToolCards[toolName] = id;
        scrollToBottom();
        return id;
    }

    function updateToolCard(toolName, result) {
        const id = activeToolCards[toolName];
        if (!id) return;
        const card = document.getElementById(id);
        if (!card) return;
        const statusEl = card.querySelector('.tool-status');
        if (statusEl) {
            statusEl.textContent = '';
            const doneSpan = document.createElement('span');
            doneSpan.style.color = 'var(--success)';
            doneSpan.textContent = '✓ done';
            statusEl.appendChild(doneSpan);
        }
        const resultEl = document.getElementById(`${id}-result`);
        if (resultEl) {
            const preview = result && result.length > 800
                ? result.slice(0, 800) + '\n…'
                : (result || '');
            resultEl.textContent = preview;      // safe — textContent only
        }
        delete activeToolCards[toolName];
    }

    let thinkingCounter = 0;

    function addThinkingBlock(text) {
        hideWelcome();
        const id = `think-${++thinkingCounter}`;
        const msgDiv = document.createElement('div');
        msgDiv.className = 'msg';

        const thinkEl = document.createElement('div');
        thinkEl.className = 'msg-thinking';
        thinkEl.id = id;

        const headerEl = document.createElement('div');
        headerEl.className = 'msg-thinking-header';
        headerEl.addEventListener('click', () => thinkEl.classList.toggle('expanded'));

        const bubbleIcon = document.createElement('span');
        bubbleIcon.textContent = '💭';
        const label = document.createElement('span');
        label.textContent = 'Extended thinking';
        const hint = document.createElement('span');
        hint.style.cssText = 'margin-left:auto;font-size:10px';
        hint.textContent = 'click to expand';

        headerEl.appendChild(bubbleIcon);
        headerEl.appendChild(label);
        headerEl.appendChild(hint);

        const bodyEl = document.createElement('div');
        bodyEl.className = 'msg-thinking-body';
        bodyEl.textContent = text || '';           // safe — textContent

        thinkEl.appendChild(headerEl);
        thinkEl.appendChild(bodyEl);
        msgDiv.appendChild(thinkEl);
        messagesEl.appendChild(msgDiv);
        scrollToBottom();
    }

    function addSystemMessage(text) {
        hideWelcome();
        const div = document.createElement('div');
        div.className = 'msg msg-system';
        div.innerHTML = `<div class="msg-bubble">${escapeHtml(text)}</div>`;
        messagesEl.appendChild(div);
        scrollToBottom();
    }

    function addErrorMessage(text) {
        hideWelcome();
        currentStreamMsg = null;
        const div = document.createElement('div');
        div.className = 'msg msg-error';
        div.innerHTML = `<div class="msg-bubble">⚠ ${escapeHtml(text)}</div>`;
        messagesEl.appendChild(div);
        scrollToBottom();
    }

    // ── Handle messages from extension ────────────────────────────────────────
    window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.type) {
            case 'stream_event':
                appendStreamText(msg.text || '');
                break;

            case 'assistant':
                if (msg.content && !msg._streamed) {
                    finalizeAssistantMessage(msg.content);
                } else {
                    finalizeAssistantMessage(null);
                }
                break;

            case 'thinking':
                addThinkingBlock(msg.text);
                break;

            case 'tool_progress':
                addToolCard(msg.tool);
                setLoading(true, `Running ${msg.tool}…`);
                break;

            case 'result':
                updateToolCard(msg.tool, typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result, null, 2));
                break;

            case 'compaction':
                addSystemMessage(`⟳ Context compacted (pass ${msg.count})`);
                break;

            case 'hookPermissionResult':
                if (!msg.allowed) {
                    addSystemMessage(`⛔ Tool blocked by hook: ${msg.tool}`);
                }
                break;

            case 'error':
                finalizeAssistantMessage(null);
                addErrorMessage(msg.message);
                setLoading(false);
                setSending(false);
                break;

            case 'stop':
                finalizeAssistantMessage(null);
                setLoading(false);
                setSending(false);
                break;

            case 'tokenUpdate':
                tokenStats = msg.tokens || tokenStats;
                costTotal = msg.cost || costTotal;
                updateStats();
                break;

            case 'modelChanged':
                currentModel = msg.model || currentModel;
                if (modelSelect) modelSelect.value = msg.model || '';
                syncThinkingToggleVisibility(currentModel);
                updateStats();
                break;

            case 'sessionCleared':
                messagesEl.innerHTML = '';
                if (welcomeEl) welcomeEl.classList.remove('hidden');
                currentStreamMsg = null;
                activeToolCards = {};
                tokenStats = { input: 0, output: 0 };
                costTotal = 0;
                startTime = Date.now();
                updateStats();
                break;

            case 'fileContent':
                // File was added to context
                addContextFile(msg.name, msg.path);
                break;

            case 'initialized':
                currentModel = msg.model || 'claude-sonnet-4-6';
                if (modelSelect && msg.model) modelSelect.value = msg.model;
                if (modeSelect && msg.mode) modeSelect.value = msg.mode;
                if (thinkingToggleEl) {
                    thinkingToggleEl.checked = !!msg.thinkingMode;
                    if (thinkingLabelEl) thinkingLabelEl.classList.toggle('active', !!msg.thinkingMode);
                }
                syncThinkingToggleVisibility(currentModel);
                updateStats();
                showWelcome(!!msg.hasApiKey);
                break;

            case 'apiKeySet':
                // Key was just saved — upgrade welcome screen without reload
                showWelcome(true);
                break;

            default:
                break;
        }
    });

    // ── Welcome / onboarding ──────────────────────────────────────────────────
    const setupGuideEl    = document.getElementById('setup-guide');
    const welcomeNormalEl = document.getElementById('welcome-normal');

    function showWelcome(hasKey) {
        if (!setupGuideEl || !welcomeNormalEl) return;
        if (hasKey) {
            setupGuideEl.style.display = 'none';
            welcomeNormalEl.style.display = 'flex';
        } else {
            setupGuideEl.style.display = 'flex';
            welcomeNormalEl.style.display = 'none';
        }
    }

    // Wire provider links to open in browser via extension
    ['link-anthropic', 'link-openai', 'link-google', 'link-nvidia'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('click', (e) => {
            e.preventDefault();
            vscode.postMessage({ type: 'runCommand', command: 'vscode.open', args: [el.href] });
        });
    });

    // "Set API Key" button in setup guide
    const btnSetKey = document.getElementById('btn-set-key');
    if (btnSetKey) {
        btnSetKey.addEventListener('click', () => {
            vscode.postMessage({ type: 'runCommand', command: 'openClaudeCode.setApiKey' });
        });
    }

    // "Open Settings" button
    const btnOpenSettings = document.getElementById('btn-open-settings');
    if (btnOpenSettings) {
        btnOpenSettings.addEventListener('click', () => {
            vscode.postMessage({ type: 'runCommand', command: 'workbench.action.openSettings', args: ['openClaudeCode'] });
        });
    }

    // Example prompts (setup guide + normal welcome) — click to fill input
    ['ex-1','ex-2','ex-3','ex-w-1','ex-w-2','ex-w-3'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('click', () => {
            if (inputEl) {
                inputEl.value = el.textContent.trim();
                inputEl.focus();
                inputEl.dispatchEvent(new Event('input'));
            }
        });
    });

    // ── Loading / sending state ───────────────────────────────────────────────
    function setLoading(on, text) {
        isLoading = on;
        if (loadingEl) loadingEl.classList.toggle('visible', on);
        if (loadingText && text) loadingText.textContent = text;
        else if (loadingText && !on) loadingText.textContent = 'Thinking…';
    }

    function setSending(on) {
        if (sendBtn) sendBtn.disabled = on;
        if (stopBtn) stopBtn.classList.toggle('visible', on);
        if (!on) setLoading(false);
    }

    // ── Stats bar ─────────────────────────────────────────────────────────────
    function updateStats() {
        if (statsModel) statsModel.textContent = currentModel || '—';
        if (statsTokens) {
            const total = (tokenStats.input || 0) + (tokenStats.output || 0);
            statsTokens.textContent = total >= 1000 ? `${(total/1000).toFixed(1)}K` : String(total);
        }
        if (statsCost) {
            statsCost.textContent = costTotal < 0.01
                ? `$${costTotal.toFixed(4)}`
                : `$${costTotal.toFixed(3)}`;
        }
    }

    // ── Context files ─────────────────────────────────────────────────────────
    function addContextFile(name, filePath) {
        // Avoid duplicates
        if (contextFiles.find(f => f.path === filePath)) return;
        contextFiles.push({ name, path: filePath });
        renderContextFiles();
    }

    function removeContextFile(filePath) {
        contextFiles = contextFiles.filter(f => f.path !== filePath);
        renderContextFiles();
        vscode.postMessage({ type: 'removeContextFile', path: filePath });
    }

    function renderContextFiles() {
        if (!contextFilesEl) return;
        contextFilesEl.innerHTML = '';
        for (const f of contextFiles) {
            const chip = document.createElement('div');
            chip.className = 'context-chip';

            const nameSpan = document.createElement('span');
            nameSpan.textContent = '📄 ' + f.name;   // safe — textContent

            const removeBtn = document.createElement('button');
            removeBtn.textContent = '×';
            // Capture path via closure; no attribute injection
            removeBtn.addEventListener('click', () => removeContextFile(f.path));

            chip.appendChild(nameSpan);
            chip.appendChild(removeBtn);
            contextFilesEl.appendChild(chip);
        }
        contextFilesEl.style.display = contextFiles.length ? 'flex' : 'none';
    }

    // No longer needed as a global since we use closures above
    // window._removeCtx kept as no-op for any residual references
    window._removeCtx = removeContextFile;

    // ── Input handling ────────────────────────────────────────────────────────
    if (inputEl) {
        inputEl.addEventListener('input', () => {
            // Auto-resize
            inputEl.style.height = 'auto';
            inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';

            // @mention autocomplete
            const val = inputEl.value;
            const cursorPos = inputEl.selectionStart;
            const before = val.slice(0, cursorPos);
            const atMatch = before.match(/@([\w./\\-]*)$/);
            if (atMatch) {
                const query = atMatch[1];
                showFileAutocomplete(query);
            } else {
                hideAutocomplete();
            }
        });

        inputEl.addEventListener('keydown', (e) => {
            // Submit on Enter (not Shift+Enter)
            if (e.key === 'Enter' && !e.shiftKey && !autocompleteEl.classList.contains('visible')) {
                e.preventDefault();
                submitMessage();
                return;
            }
            // Autocomplete navigation
            if (autocompleteEl.classList.contains('visible')) {
                if (e.key === 'ArrowDown') { e.preventDefault(); moveAcSelection(1); return; }
                if (e.key === 'ArrowUp')   { e.preventDefault(); moveAcSelection(-1); return; }
                if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault();
                    selectAcItem();
                    return;
                }
                if (e.key === 'Escape') { hideAutocomplete(); return; }
            }
            // Escape cancels loading
            if (e.key === 'Escape' && isLoading) {
                vscode.postMessage({ type: 'cancel' });
                setSending(false);
            }
        });
    }

    if (sendBtn) {
        sendBtn.addEventListener('click', submitMessage);
    }

    if (stopBtn) {
        stopBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'cancel' });
            setSending(false);
        });
    }

    function submitMessage() {
        if (!inputEl) return;
        const text = inputEl.value.trim();
        if (!text || isLoading) return;

        // Extract @file references from text before sending
        const fileRefs = [];
        text.replace(/@([\w./\\-]+)/g, (_, p) => fileRefs.push(p));

        addUserMessage(text);
        inputEl.value = '';
        inputEl.style.height = 'auto';
        hideAutocomplete();
        setSending(true);
        setLoading(true, 'Thinking…');

        vscode.postMessage({
            type: 'send',
            message: text,
            contextFiles: contextFiles.map(f => f.path),
            fileRefs,
        });

        // Clear context files after send
        contextFiles = [];
        renderContextFiles();
    }

    // ── File autocomplete ─────────────────────────────────────────────────────
    let acItems = [];
    let acSelectedIdx = -1;

    function showFileAutocomplete(query) {
        vscode.postMessage({ type: 'fileSearch', query });
    }

    function renderAutocomplete(files) {
        if (!files || files.length === 0) { hideAutocomplete(); return; }
        acItems = files;
        acSelectedIdx = 0;
        autocompleteEl.innerHTML = '';
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const item = document.createElement('div');
            item.className = 'ac-item' + (i === 0 ? ' selected' : '');
            item.innerHTML = `
                <span class="ac-icon">📄</span>
                <span class="ac-name">${escapeHtml(f.name)}</span>
                <span class="ac-desc">${escapeHtml(f.relativePath || '')}</span>
            `;
            item.addEventListener('click', () => {
                acSelectedIdx = i;
                selectAcItem();
            });
            autocompleteEl.appendChild(item);
        }
        autocompleteEl.classList.add('visible');
    }

    function hideAutocomplete() {
        autocompleteEl.classList.remove('visible');
        acItems = [];
        acSelectedIdx = -1;
    }

    function moveAcSelection(dir) {
        const items = autocompleteEl.querySelectorAll('.ac-item');
        if (items.length === 0) return;
        items[acSelectedIdx]?.classList.remove('selected');
        acSelectedIdx = (acSelectedIdx + dir + items.length) % items.length;
        items[acSelectedIdx]?.classList.add('selected');
    }

    function selectAcItem() {
        if (acSelectedIdx < 0 || acSelectedIdx >= acItems.length) return;
        const file = acItems[acSelectedIdx];
        // Replace the @query in input
        const val = inputEl.value;
        const cursorPos = inputEl.selectionStart;
        const before = val.slice(0, cursorPos);
        const replaced = before.replace(/@[\w./\\-]*$/, '') + `@${file.name} `;
        inputEl.value = replaced + val.slice(cursorPos);
        inputEl.setSelectionRange(replaced.length, replaced.length);
        hideAutocomplete();
        // Add to context
        vscode.postMessage({ type: 'addContextFile', path: file.path, name: file.name });
    }

    // ── Toolbar buttons ───────────────────────────────────────────────────────
    if (newChatBtn) {
        newChatBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'clear' });
        });
    }

    if (addFileBtn) {
        addFileBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'pickFile' });
        });
    }

    if (modelSelect) {
        modelSelect.addEventListener('change', () => {
            vscode.postMessage({ type: 'model', model: modelSelect.value });
            currentModel = modelSelect.value;
            updateStats();
            syncThinkingToggleVisibility(modelSelect.value);
        });
    }

    if (modeSelect) {
        modeSelect.addEventListener('change', () => {
            vscode.postMessage({ type: 'mode', mode: modeSelect.value });
        });
    }

    // ── Thinking mode toggle (NVIDIA capable models only) ─────────────────────
    function syncThinkingToggleVisibility(model) {
        const visible = THINKING_CAPABLE_MODELS.has(model);
        const display = visible ? '' : 'none';
        if (thinkingToggleWrapper) thinkingToggleWrapper.style.display = display;
        if (thinkingLabelEl)       thinkingLabelEl.style.display       = display;
    }

    if (thinkingToggleEl) {
        thinkingToggleEl.addEventListener('change', () => {
            const enabled = thinkingToggleEl.checked;
            if (thinkingLabelEl) thinkingLabelEl.classList.toggle('active', enabled);
            vscode.postMessage({ type: 'thinkingMode', enabled });
        });
    }

    // ── Message from extension: fileSearchResults ─────────────────────────────
    window.addEventListener('message', (event) => {
        if (event.data.type === 'fileSearchResults') {
            renderAutocomplete(event.data.files || []);
        }
    });

    // ── Signal ready ──────────────────────────────────────────────────────────
    vscode.postMessage({ type: 'ready' });

}());
