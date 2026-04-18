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
    let contextFiles = [];       // { name, path, pinned?, isImage?, isCodebase? }
    let tokenStats = { input: 0, output: 0 };
    let costTotal = 0;
    let startTime = Date.now();
    let currentModel = '';
    let pendingApply = null;     // { code, language }
    let activeToolCards = {};    // toolName -> dom element
    let sessionMessages = [];    // tracked messages for history saving
    let lastUserMessage = '';    // for ↑ recall and regenerate
    let autoScroll = true;       // auto-scroll while streaming
    let pinnedFiles = [];        // files pinned across sessions
    let currentSessionId = null; // null for new sessions; history entry ID when continuing a saved session

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
    const settingsBtn   = document.getElementById('settings-btn');
    const historyBtn    = document.getElementById('history-btn');
    const historyPanel  = document.getElementById('history-panel');
    const historyList   = document.getElementById('history-list');
    const historySessionView = document.getElementById('history-session-view');
    const historyCloseBtn = document.getElementById('history-close-btn');
    const historyBackBtn  = document.getElementById('history-back-btn');
    const historyPanelTitle = document.getElementById('history-panel-title');

    const autoscrollBtn  = document.getElementById('autoscroll-btn');
    const exportBtn      = document.getElementById('export-btn');
    const searchBar      = document.getElementById('search-bar');
    const searchInput    = document.getElementById('search-input');
    const searchCount    = document.getElementById('search-count');
    const searchPrevBtn  = document.getElementById('search-prev');
    const searchNextBtn  = document.getElementById('search-next');
    const searchCloseBtn = document.getElementById('search-close');
    const contextBarEl   = document.getElementById('context-bar');
    const contextUsedEl  = document.getElementById('context-used');
    const contextMaxEl   = document.getElementById('context-max');
    const contextFillEl  = document.getElementById('context-bar-fill');

    /** Models that support NVIDIA thinking mode toggle */
    const THINKING_CAPABLE_MODELS = new Set([
        'moonshotai/kimi-k2.5',
        'deepseek-ai/deepseek-r1',
    ]);

    /** Approximate max context tokens per model */
    const MODEL_CONTEXT = {
        'claude-sonnet-4-6':                           200000,
        'claude-opus-4-6':                             200000,
        'claude-haiku-4-5':                            200000,
        'gpt-4o':                                      128000,
        'gpt-4o-mini':                                 128000,
        'gemini-2.0-flash':                           1000000,
        'moonshotai/kimi-k2.5':                        128000,
        'deepseek-ai/deepseek-r1':                      64000,
        'nvidia/llama-3.1-nemotron-70b-instruct':      128000,
        'meta/llama-3.1-405b-instruct':                128000,
        'meta/llama-3.3-70b-instruct':                 128000,
        'mistralai/mistral-large-2-instruct':          128000,
        'mistralai/mixtral-8x22b-instruct-v0.1':        64000,
    };

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
            // Show preview immediately; diff will arrive when extension reads active file
            showApplyModal(entry.code, null, null);
            vscode.postMessage({ type: 'getActiveFileContent' });
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

    /**
     * LCS-based line diff. Returns array of {type:'equal'|'add'|'remove', line}.
     * Falls back to showing all new lines when files are too large.
     */
    function computeDiff(aLines, bLines) {
        if (aLines.length * bLines.length > 400000) {
            return bLines.map(l => ({ type: 'add', line: l }));
        }
        const n = aLines.length, m = bLines.length;
        const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
        for (let i = 1; i <= n; i++) {
            for (let j = 1; j <= m; j++) {
                dp[i][j] = aLines[i - 1] === bLines[j - 1]
                    ? dp[i - 1][j - 1] + 1
                    : Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
        const result = [];
        let i = n, j = m;
        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && aLines[i - 1] === bLines[j - 1]) {
                result.unshift({ type: 'equal',  line: aLines[i - 1] }); i--; j--;
            } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
                result.unshift({ type: 'add',    line: bLines[j - 1] }); j--;
            } else {
                result.unshift({ type: 'remove', line: aLines[i - 1] }); i--;
            }
        }
        return result;
    }

    function buildDiffView(diff) {
        const container = document.createElement('div');
        container.className = 'diff-view';
        const pre = document.createElement('pre');
        for (const { type, line } of diff) {
            const span = document.createElement('span');
            span.className = 'diff-line diff-' + type;
            span.textContent = (type === 'add' ? '+ ' : type === 'remove' ? '- ' : '  ') + line;
            pre.appendChild(span);
            pre.appendChild(document.createTextNode('\n'));
        }
        container.appendChild(pre);
        return container;
    }

    function showApplyModal(newCode, oldContent, fileName) {
        const titleEl = document.getElementById('apply-modal-title');
        if (titleEl) {
            titleEl.textContent = (oldContent !== null && oldContent !== undefined)
                ? `Review changes — ${fileName || 'active file'}`
                : 'Apply code to file';
        }
        applyModalBody.innerHTML = '';
        if (oldContent !== null && oldContent !== undefined) {
            const diff = computeDiff(oldContent.split('\n'), newCode.split('\n'));
            applyModalBody.appendChild(buildDiffView(diff));
        } else {
            const preview = newCode.length > 2000 ? newCode.slice(0, 2000) + '\n…' : newCode;
            applyModalBody.innerHTML = buildCodeBlockHtml(preview, pendingApply ? pendingApply.language : '');
        }
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

    // ── Copy button helper ────────────────────────────────────────────────────
    function addCopyButtonToMessage(msgDiv, rawText, userPrompt) {
        const header = msgDiv.querySelector('.msg-header');
        if (!header || header.querySelector('.msg-copy-btn')) return;
        const btn = document.createElement('button');
        btn.className = 'msg-copy-btn';
        btn.title = 'Copy answer';
        btn.textContent = '⎘ Copy';
        btn.addEventListener('click', () => {
            vscode.postMessage({ type: 'copyToClipboard', text: rawText });
            btn.textContent = '✓ Copied';
            btn.classList.add('copied');
            setTimeout(() => {
                btn.textContent = '⎘ Copy';
                btn.classList.remove('copied');
            }, 1500);
        });
        header.appendChild(btn);

        if (userPrompt) {
            const regenBtn = document.createElement('button');
            regenBtn.className = 'msg-regen-btn';
            regenBtn.title = 'Regenerate response';
            regenBtn.textContent = '↺';
            regenBtn.addEventListener('click', () => {
                if (isLoading) return;
                regenerateFrom(msgDiv, userPrompt);
            });
            header.appendChild(regenBtn);
        }
    }

    // ── Message rendering ─────────────────────────────────────────────────────
    function hideWelcome() {
        if (welcomeEl && !welcomeEl.classList.contains('hidden')) {
            welcomeEl.classList.add('hidden');
        }
    }

    function scrollToBottom() {
        if (!autoScroll) return;
        requestAnimationFrame(() => {
            messagesEl.scrollTop = messagesEl.scrollHeight;
        });
    }

    function addUserMessage(text) {
        hideWelcome();
        currentStreamMsg = null;
        lastUserMessage = text;
        sessionMessages.push({ type: 'user', text });

        const div = document.createElement('div');
        div.className = 'msg msg-user';
        div._sessionIdx = sessionMessages.length - 1;

        const meta = document.createElement('div');
        meta.className = 'msg-meta';
        meta.appendChild(document.createTextNode('You'));

        const editBtn = document.createElement('button');
        editBtn.className = 'msg-edit-btn';
        editBtn.title = 'Edit message';
        editBtn.textContent = '✏';
        editBtn.addEventListener('click', () => editUserMessage(div, text));
        meta.appendChild(editBtn);

        const bubble = document.createElement('div');
        bubble.className = 'msg-bubble';
        bubble.textContent = text;   // safe — textContent

        div.appendChild(meta);
        div.appendChild(bubble);
        messagesEl.appendChild(div);
        scrollToBottom();
    }

    function getOrCreateAssistantMessage() {
        if (currentStreamMsg) return currentStreamMsg;
        hideWelcome();
        const div = document.createElement('div');
        div.className = 'msg msg-assistant';
        div._regenPrompt = lastUserMessage;    // capture for regenerate
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
            // Add copy + regenerate buttons + track in history
            if (raw) {
                const msgDiv = currentStreamMsg.closest('.msg-assistant');
                if (msgDiv) addCopyButtonToMessage(msgDiv, raw, msgDiv._regenPrompt);
                sessionMessages.push({ type: 'assistant', text: raw });
            }
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
            addCopyButtonToMessage(div, content);
            sessionMessages.push({ type: 'assistant', text: content });
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

    // ── Edit user message ─────────────────────────────────────────────────────
    function editUserMessage(msgDiv, originalText) {
        if (isLoading) return;
        const bubble = msgDiv.querySelector('.msg-bubble');
        if (!bubble) return;

        const ta = document.createElement('textarea');
        ta.className = 'msg-user-edit-area';
        ta.value = originalText;
        ta.rows = 3;

        const actionsRow = document.createElement('div');
        actionsRow.className = 'msg-user-edit-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'modal-btn';
        cancelBtn.textContent = 'Cancel';

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'modal-btn primary';
        confirmBtn.textContent = '↵ Resend';

        actionsRow.appendChild(cancelBtn);
        actionsRow.appendChild(confirmBtn);

        bubble.replaceWith(ta);
        msgDiv.appendChild(actionsRow);
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);

        cancelBtn.addEventListener('click', () => {
            ta.replaceWith(bubble);
            actionsRow.remove();
        });
        confirmBtn.addEventListener('click', confirmEdit);
        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirmEdit(); }
            if (e.key === 'Escape') { ta.replaceWith(bubble); actionsRow.remove(); }
        });

        function confirmEdit() {
            const newText = ta.value.trim();
            if (!newText) return;

            bubble.textContent = newText;
            ta.replaceWith(bubble);
            actionsRow.remove();
            msgDiv._originalText = newText;
            // Update edit button closure
            const eb = msgDiv.querySelector('.msg-edit-btn');
            if (eb) eb.onclick = null;
            if (eb) eb.addEventListener('click', () => editUserMessage(msgDiv, newText));

            // Remove all DOM messages after this one
            let el = msgDiv.nextElementSibling;
            while (el) { const nx = el.nextElementSibling; el.remove(); el = nx; }

            // Truncate sessionMessages to this user message (inclusive)
            const idx = typeof msgDiv._sessionIdx === 'number' ? msgDiv._sessionIdx : -1;
            if (idx >= 0) sessionMessages.splice(idx);
            sessionMessages.push({ type: 'user', text: newText });
            msgDiv._sessionIdx = sessionMessages.length - 1;

            lastUserMessage = newText;
            setSending(true);
            setLoading(true, 'Thinking…');
            vscode.postMessage({ type: 'send', message: newText, contextFiles: [], fileRefs: [] });
        }
    }

    // ── Regenerate response ───────────────────────────────────────────────────
    function regenerateFrom(assistantMsgDiv, userPrompt) {
        // Remove this assistant message and everything after it from the DOM
        let el = assistantMsgDiv;
        while (el) { const nx = el.nextElementSibling; el.remove(); el = nx; }

        // Truncate sessionMessages: remove the last assistant entry(s) for this prompt
        const lastUserIdx = [...sessionMessages].reduceRight((found, m, i) =>
            found === -1 && m.type === 'user' && m.text === userPrompt ? i : found, -1);
        if (lastUserIdx >= 0) sessionMessages.splice(lastUserIdx + 1);

        lastUserMessage = userPrompt;
        setSending(true);
        setLoading(true, 'Thinking…');
        vscode.postMessage({ type: 'send', message: userPrompt, contextFiles: [], fileRefs: [] });
    }

    // ── @codebase chip ────────────────────────────────────────────────────────
    function addCodebaseContext() {
        if (contextFiles.find(f => f.isCodebase)) return;
        contextFiles.push({ name: '@codebase', path: '__codebase__', isCodebase: true });
        renderContextFiles();
    }

    // ── Image paste chip ──────────────────────────────────────────────────────
    function addImageContext(name, dataUrl) {
        if (!contextFilesEl) return;
        contextFiles.push({ name, path: `__img__:${name}`, isImage: true, dataUrl });
        renderContextFiles();
    }

    // ── Toggle pin on a context file ─────────────────────────────────────────
    function togglePinFile(file) {
        file.pinned = !file.pinned;
        if (file.pinned) {
            if (!pinnedFiles.find(p => p.path === file.path))
                pinnedFiles.push({ name: file.name, path: file.path });
            vscode.postMessage({ type: 'pinFile', path: file.path });
        } else {
            pinnedFiles = pinnedFiles.filter(p => p.path !== file.path);
            vscode.postMessage({ type: 'unpinFile', path: file.path });
        }
        renderContextFiles();
    }

    // ── Context window usage bar ──────────────────────────────────────────────
    function updateContextBar() {
        if (!contextBarEl || !contextUsedEl || !contextMaxEl || !contextFillEl) return;
        const used = (tokenStats.input || 0) + (tokenStats.output || 0);
        const max  = MODEL_CONTEXT[currentModel] || 200000;
        const pct  = Math.min((used / max) * 100, 100);
        contextUsedEl.textContent = used >= 1000 ? `${(used / 1000).toFixed(1)}k` : String(used);
        contextMaxEl.textContent  = `${(max  / 1000).toFixed(0)}k`;
        contextFillEl.style.width      = pct + '%';
        contextFillEl.style.background = pct > 95 ? 'var(--error-text)'
                                       : pct > 80 ? 'var(--warning)'
                                       : 'var(--success)';
        contextBarEl.style.display = used > 0 ? '' : 'none';
    }

    // ── Conversation search ───────────────────────────────────────────────────
    let searchMatches = [];
    let searchCurrentIdx = -1;

    function showSearchBar() {
        if (!searchBar) return;
        searchBar.style.display = '';
        if (searchInput) { searchInput.focus(); searchInput.select(); }
    }

    function hideSearchBar() {
        if (!searchBar) return;
        searchBar.style.display = 'none';
        clearSearchHighlights();
        if (searchInput) searchInput.value = '';
        if (searchCount) searchCount.textContent = '';
    }

    function clearSearchHighlights() {
        messagesEl.querySelectorAll('.search-match, .search-match-current').forEach(el => {
            el.classList.remove('search-match', 'search-match-current');
        });
        searchMatches = [];
        searchCurrentIdx = -1;
    }

    function performSearch(query) {
        clearSearchHighlights();
        if (!query || query.length < 2) {
            if (searchCount) searchCount.textContent = '';
            return;
        }
        const lq = query.toLowerCase();
        messagesEl.querySelectorAll('.msg-user, .msg-assistant').forEach(el => {
            if ((el.textContent || '').toLowerCase().includes(lq)) {
                el.classList.add('search-match');
                searchMatches.push(el);
            }
        });
        if (searchMatches.length > 0) {
            searchCurrentIdx = 0;
            searchMatches[0].classList.add('search-match-current');
            searchMatches[0].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        if (searchCount) {
            searchCount.textContent = searchMatches.length > 0
                ? `${searchCurrentIdx + 1}/${searchMatches.length}`
                : 'No results';
        }
    }

    function searchNav(dir) {
        if (searchMatches.length === 0) return;
        searchMatches[searchCurrentIdx]?.classList.remove('search-match-current');
        searchCurrentIdx = (searchCurrentIdx + dir + searchMatches.length) % searchMatches.length;
        searchMatches[searchCurrentIdx].classList.add('search-match-current');
        searchMatches[searchCurrentIdx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        if (searchCount) searchCount.textContent = `${searchCurrentIdx + 1}/${searchMatches.length}`;
    }

    if (searchInput) {
        searchInput.addEventListener('input', () => performSearch(searchInput.value.trim()));
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); searchNav(e.shiftKey ? -1 : 1); }
            if (e.key === 'Escape') hideSearchBar();
        });
    }
    if (searchPrevBtn)  searchPrevBtn.addEventListener('click',  () => searchNav(-1));
    if (searchNextBtn)  searchNextBtn.addEventListener('click',  () => searchNav(1));
    if (searchCloseBtn) searchCloseBtn.addEventListener('click', hideSearchBar);

    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
            e.preventDefault();
            showSearchBar();
        }
    });
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
                // Auto-save current session after every response so VS Code restarts
                // don't lose the conversation (Cursor/Claude-style session memory).
                if (sessionMessages.length > 0) {
                    vscode.postMessage({ type: 'autoSaveSession', messages: [...sessionMessages], sessionId: currentSessionId });
                    if (currentSessionId) {
                        // Also update the history entry so it stays current when the
                        // user opens the history panel without clicking "New" first.
                        vscode.postMessage({ type: 'updateSession', id: currentSessionId, messages: [...sessionMessages] });
                    }
                }
                break;

            case 'tokenUpdate':
                tokenStats = msg.tokens || tokenStats;
                costTotal = msg.cost || costTotal;
                updateStats();
                updateContextBar();
                break;

            case 'modelChanged':
                currentModel = msg.model || currentModel;
                if (modelSelect) modelSelect.value = msg.model || '';
                syncThinkingToggleVisibility(currentModel);
                updateStats();
                updateContextBar();
                break;

            case 'sessionCleared':
                messagesEl.innerHTML = '';
                if (welcomeEl) welcomeEl.classList.remove('hidden');
                currentStreamMsg = null;
                activeToolCards = {};
                sessionMessages = [];
                currentSessionId = null;
                tokenStats = { input: 0, output: 0 };
                costTotal = 0;
                startTime = Date.now();
                // Restore pinned files into context
                contextFiles = pinnedFiles.map(f => ({ ...f, pinned: true }));
                renderContextFiles();
                updateStats();
                updateContextBar();
                // Clear the auto-saved active session
                vscode.postMessage({ type: 'autoSaveSession', messages: [] });
                break;

            case 'historyData':
                renderHistoryList(msg.sessions || []);
                break;

            case 'sessionData':
                renderHistorySession(msg.messages || [], msg.id || null);
                break;

            case 'resumeFromHistoryData':
                // Direct-resume (Cursor-style): triggered when user clicks a history item
                restoreSessionMessages(msg.messages || [], msg.id || null);
                break;

            case 'fileContent':
                addContextFile(msg.name, msg.path);
                break;

            case 'activeFileContent':
                // Arrives after user clicks "Apply to file…"
                if (pendingApply && applyModal.classList.contains('visible')) {
                    showApplyModal(pendingApply.code, msg.content, msg.fileName);
                }
                break;

            case 'pinnedFiles':
                pinnedFiles = (msg.files || []);
                for (const f of pinnedFiles) {
                    addContextFile(f.name, f.path, true);
                }
                break;

            case 'inlineEditRequest':
                if (inputEl && msg.selectedText) {
                    const ctx = msg.hasSelection
                        ? `Edit this code from \`${msg.fileName}\`:\n\`\`\`\n${msg.selectedText}\n\`\`\`\n\nInstruction: `
                        : `Regarding \`${msg.fileName}\`: `;
                    inputEl.value = ctx;
                    inputEl.style.height = 'auto';
                    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
                    inputEl.focus();
                    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
                }
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
                updateContextBar();
                // Restore active session if one was persisted (survives VS Code restarts)
                if (msg.activeSession && msg.activeSession.length > 0) {
                    restoreSessionMessages(msg.activeSession, msg.activeSessionId || null);
                } else {
                    showWelcome(!!msg.hasApiKey);
                }
                // Load pinned files from settings
                vscode.postMessage({ type: 'getPinnedFiles' });
                break;

            case 'apiKeySet':
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
    function addContextFile(name, filePath, pinned = false) {
        if (contextFiles.find(f => f.path === filePath)) return;
        contextFiles.push({ name, path: filePath, pinned });
        renderContextFiles();
    }

    function removeContextFile(filePath) {
        const file = contextFiles.find(f => f.path === filePath);
        if (file && file.pinned) {
            // Unpin when removed
            pinnedFiles = pinnedFiles.filter(p => p.path !== filePath);
            vscode.postMessage({ type: 'unpinFile', path: filePath });
        }
        contextFiles = contextFiles.filter(f => f.path !== filePath);
        renderContextFiles();
        vscode.postMessage({ type: 'removeContextFile', path: filePath });
    }

    function renderContextFiles() {
        if (!contextFilesEl) return;
        contextFilesEl.innerHTML = '';
        for (const f of contextFiles) {
            const chip = document.createElement('div');
            chip.className = 'context-chip' + (f.pinned ? ' pinned' : '');

            const nameSpan = document.createElement('span');
            const icon = f.isImage ? '🖼 ' : f.isCodebase ? '' : (f.pinned ? '📌 ' : '📄 ');
            nameSpan.textContent = icon + f.name;

            if (f.isImage && f.dataUrl) {
                const img = document.createElement('img');
                // dataUrl is always a data: URI from FileReader.readAsDataURL — validate before use
                if (/^data:image\/[a-z]+;base64,/.test(f.dataUrl)) {
                    img.src = f.dataUrl;
                }
                img.alt = f.name;
                chip.appendChild(img);
            }

            if (!f.isCodebase && !f.isImage) {
                const pinBtn = document.createElement('button');
                pinBtn.className = 'pin-btn';
                pinBtn.title = f.pinned ? 'Unpin file' : 'Pin to all sessions';
                pinBtn.textContent = '📎';
                pinBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePinFile(f); });
                chip.appendChild(nameSpan);
                chip.appendChild(pinBtn);
            } else {
                chip.appendChild(nameSpan);
            }

            const removeBtn = document.createElement('button');
            removeBtn.textContent = '×';
            removeBtn.addEventListener('click', () => removeContextFile(f.path));
            chip.appendChild(removeBtn);
            contextFilesEl.appendChild(chip);
        }
        contextFilesEl.style.display = contextFiles.length ? 'flex' : 'none';
    }

    // ── Input handling ────────────────────────────────────────────────────────
    if (inputEl) {
        inputEl.addEventListener('input', () => {
            // Auto-resize
            inputEl.style.height = 'auto';
            inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';

            const val = inputEl.value;
            const cursorPos = inputEl.selectionStart;
            const before = val.slice(0, cursorPos);

            // @codebase special mention — replace with chip immediately
            if (val.includes('@codebase')) {
                inputEl.value = val.replace(/@codebase\b/g, '').trim();
                inputEl.style.height = 'auto';
                inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
                addCodebaseContext();
                hideAutocomplete();
                return;
            }

            // Slash command autocomplete (when first char is /)
            const slashMatch = val.match(/^(\/[\w]*)$/);
            if (slashMatch) {
                showSlashCommands(slashMatch[1].slice(1));
                return;
            }

            // @mention autocomplete
            const atMatch = before.match(/@([\w./\\-]*)$/);
            if (atMatch) {
                showFileAutocomplete(atMatch[1]);
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
            // Up arrow in empty input → recall last message
            if (e.key === 'ArrowUp' && !inputEl.value && !autocompleteEl.classList.contains('visible')) {
                if (lastUserMessage) {
                    e.preventDefault();
                    inputEl.value = lastUserMessage;
                    inputEl.style.height = 'auto';
                    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
                    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
                }
                return;
            }
            // Escape cancels loading
            if (e.key === 'Escape' && isLoading) {
                vscode.postMessage({ type: 'cancel' });
                setSending(false);
            }
        });

        // Image paste
        inputEl.addEventListener('paste', (e) => {
            const items = [...(e.clipboardData?.items || [])];
            const imgItem = items.find(it => it.type.startsWith('image/'));
            if (!imgItem) return;
            e.preventDefault();
            const file = imgItem.getAsFile();
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => addImageContext(file.name || 'screenshot.png', ev.target.result);
            reader.readAsDataURL(file);
        });
    }

    // ── Drag-and-drop files onto input ────────────────────────────────────────
    const inputWrapper = document.getElementById('input-wrapper');
    if (inputWrapper) {
        const CODE_EXTS = new Set([
            'js','ts','jsx','tsx','py','go','rs','java','cpp','c','h','cs','rb',
            'php','swift','kt','scala','sh','bash','zsh','md','json','yaml','yml',
            'toml','html','css','scss','less','vue','svelte','sql','graphql','tf','txt',
        ]);
        inputWrapper.addEventListener('dragover', (e) => {
            e.preventDefault();
            inputWrapper.classList.add('drag-over');
        });
        inputWrapper.addEventListener('dragleave', () => inputWrapper.classList.remove('drag-over'));
        inputWrapper.addEventListener('drop', (e) => {
            e.preventDefault();
            inputWrapper.classList.remove('drag-over');
            const files = [...(e.dataTransfer?.files || [])];
            for (const file of files) {
                const ext = (file.name.split('.').pop() || '').toLowerCase();
                if (CODE_EXTS.has(ext)) {
                    const filePath = file.path || file.name;
                    vscode.postMessage({ type: 'addContextFile', path: filePath, name: file.name });
                }
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
        const rawText = inputEl.value.trim();
        if (!rawText || isLoading) return;

        // Extract @file references from text before sending
        const fileRefs = [];
        rawText.replace(/@([\w./\\-]+)/g, (_, p) => fileRefs.push(p));

        addUserMessage(rawText);
        inputEl.value = '';
        inputEl.style.height = 'auto';
        hideAutocomplete();
        setSending(true);
        setLoading(true, 'Thinking…');

        // Separate file paths from image/codebase context entries
        const sendContextFiles = contextFiles.filter(f => !f.isImage && !f.isCodebase).map(f => f.path);
        const hasCodebase = contextFiles.some(f => f.isCodebase);

        vscode.postMessage({
            type: 'send',
            message: rawText,
            contextFiles: sendContextFiles,
            fileRefs,
            useCodebase: hasCodebase,
        });

        // Clear non-pinned context after send
        contextFiles = contextFiles.filter(f => f.pinned);
        renderContextFiles();
    }

    // ── File autocomplete ─────────────────────────────────────────────────────
    let acItems = [];
    let acSelectedIdx = -1;

    function showFileAutocomplete(query) {
        vscode.postMessage({ type: 'fileSearch', query });
    }

    // ── Slash command autocomplete ─────────────────────────────────────────────
    const SLASH_COMMANDS = [
        { cmd: '/clear',  desc: 'Clear conversation and start fresh' },
        { cmd: '/model',  desc: 'Switch AI model' },
        { cmd: '/export', desc: 'Export conversation as Markdown' },
        { cmd: '/help',   desc: 'Show keyboard shortcuts' },
        { cmd: '/pin',    desc: 'Pin all current context files to every session' },
    ];

    function showSlashCommands(prefix) {
        const filtered = SLASH_COMMANDS.filter(c => c.cmd.slice(1).startsWith(prefix));
        if (!filtered.length) { hideAutocomplete(); return; }
        acItems = filtered.map(c => ({ isSlash: true, cmd: c.cmd, desc: c.desc }));
        acSelectedIdx = 0;
        autocompleteEl.innerHTML = '';
        for (let i = 0; i < filtered.length; i++) {
            const c = filtered[i];
            const item = document.createElement('div');
            item.className = 'ac-item' + (i === 0 ? ' selected' : '');
            const cmdSpan = document.createElement('span');
            cmdSpan.className = 'ac-name';
            cmdSpan.style.fontWeight = '600';
            cmdSpan.textContent = c.cmd;
            const descSpan = document.createElement('span');
            descSpan.className = 'ac-desc';
            descSpan.textContent = c.desc;
            item.appendChild(cmdSpan);
            item.appendChild(descSpan);
            item.addEventListener('click', () => { acSelectedIdx = i; selectAcItem(); });
            autocompleteEl.appendChild(item);
        }
        autocompleteEl.classList.add('visible');
    }

    function executeSlashCommand(cmd) {
        switch (cmd) {
            case '/clear':   newChatBtn && newChatBtn.click(); break;
            case '/model':   modelSelect && modelSelect.focus(); break;
            case '/export':  exportBtn && exportBtn.click(); break;
            case '/pin':     contextFiles.filter(f => !f.pinned).forEach(f => togglePinFile(f)); break;
            case '/help':
                addSystemMessage(
                    'Keyboard shortcuts: Enter=send · Shift+Enter=newline · @=add file · ' +
                    '@codebase=full codebase · /=commands · ↑=recall last message · ' +
                    'Ctrl+F=search · Ctrl+K=inline edit · Esc=stop'
                );
                break;
        }
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
        const item = acItems[acSelectedIdx];

        // Slash command selection
        if (item.isSlash) {
            inputEl.value = '';
            inputEl.style.height = 'auto';
            hideAutocomplete();
            executeSlashCommand(item.cmd);
            return;
        }

        // File selection — replace @query in input
        const file = item;
        const val = inputEl.value;
        const cursorPos = inputEl.selectionStart;
        const before = val.slice(0, cursorPos);
        const replaced = before.replace(/@[\w./\\-]*$/, '') + `@${file.name} `;
        inputEl.value = replaced + val.slice(cursorPos);
        inputEl.setSelectionRange(replaced.length, replaced.length);
        hideAutocomplete();
        vscode.postMessage({ type: 'addContextFile', path: file.path, name: file.name });
    }

    // ── History Panel ─────────────────────────────────────────────────────────
    /**
     * Persist the current in-progress session before switching to another one.
     * - If we're continuing a history session, update that entry (no duplicate).
     * - If this is a fresh session, create a new history entry.
     */
    function saveCurrentSessionIfNeeded() {
        if (sessionMessages.length === 0) return;
        if (currentSessionId) {
            vscode.postMessage({ type: 'updateSession', id: currentSessionId, messages: [...sessionMessages] });
        } else {
            vscode.postMessage({ type: 'saveSession', messages: [...sessionMessages] });
        }
    }

    /**
     * Restore a set of saved messages into the main chat panel and re-inject them
     * into the agent bridge, so the model remembers the full conversation context
     * (Cursor/Claude-style session memory).
     *
     * @param {Array}       messages  - saved user/assistant message objects
     * @param {string|null} sessionId - history entry ID being continued; null for a new session
     */
    function restoreSessionMessages(messages, sessionId) {
        // Track which history session we are editing so we update it (not duplicate it)
        currentSessionId = sessionId !== undefined ? sessionId : null;

        // Clear current UI state
        messagesEl.innerHTML = '';
        sessionMessages = [];
        activeToolCards = {};
        tokenStats = { input: 0, output: 0 };
        costTotal = 0;
        startTime = Date.now();
        updateStats();
        updateContextBar();

        if (messages.length === 0) {
            showWelcome(true);
            return;
        }

        // Replay messages into the DOM (addUserMessage / finalizeAssistantMessage
        // only touch the DOM and sessionMessages — they do not send to the bridge)
        for (const m of messages) {
            if (m.type === 'user') {
                addUserMessage(m.text);
            } else if (m.type === 'assistant') {
                finalizeAssistantMessage(m.text);
            }
        }

        // Re-inject the conversation history into the agent bridge so the next
        // user message is answered with full knowledge of the entire session.
        vscode.postMessage({ type: 'resumeSession', messages });
    }

    function openHistoryPanel() {
        if (historyPanel) historyPanel.classList.add('visible');
        if (historySessionView) historySessionView.classList.remove('visible');
        if (historyList) historyList.style.display = '';
        if (historyBackBtn) historyBackBtn.style.display = 'none';
        if (historyPanelTitle) historyPanelTitle.textContent = 'Chat History';
        vscode.postMessage({ type: 'getHistory' });
    }

    function closeHistoryPanel() {
        if (historyPanel) historyPanel.classList.remove('visible');
    }

    function renderHistoryList(sessions) {
        if (!historyList) return;
        historyList.innerHTML = '';
        if (sessions.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'history-empty';
            empty.textContent = 'No saved conversations yet.\nStart a new chat and click "New" to save it to history.';
            historyList.appendChild(empty);
            return;
        }
        for (const session of sessions) {
            const item = document.createElement('div');
            item.className = 'history-item';

            const titleEl = document.createElement('div');
            titleEl.className = 'history-item-title';
            titleEl.textContent = session.title || 'Untitled conversation';

            const metaEl = document.createElement('div');
            metaEl.className = 'history-item-meta';
            const dateEl = document.createElement('span');
            dateEl.textContent = new Date(session.createdAt).toLocaleString();
            const countEl = document.createElement('span');
            const msgCount = session.messageCount || 0;
            countEl.textContent = `${msgCount} msg${msgCount !== 1 ? 's' : ''}`;
            metaEl.appendChild(dateEl);
            metaEl.appendChild(countEl);

            const actionsEl = document.createElement('div');
            actionsEl.className = 'history-item-actions';

            const renameBtn = document.createElement('button');
            renameBtn.className = 'history-action-btn';
            renameBtn.title = 'Rename';
            renameBtn.textContent = '✏';
            renameBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const newTitle = window.prompt('Rename conversation:', session.title || '');
                if (newTitle !== null && newTitle.trim()) {
                    vscode.postMessage({ type: 'renameSession', id: session.id, title: newTitle.trim() });
                }
            });

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'history-action-btn history-delete-btn';
            deleteBtn.title = 'Delete';
            deleteBtn.textContent = '🗑';
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (window.confirm('Delete this conversation?')) {
                    vscode.postMessage({ type: 'deleteSession', id: session.id });
                }
            });

            actionsEl.appendChild(renameBtn);
            actionsEl.appendChild(deleteBtn);

            item.appendChild(titleEl);
            item.appendChild(metaEl);
            item.appendChild(actionsEl);
            // Cursor/Claude-style: clicking a session immediately switches to it.
            // The current session is auto-saved before switching so nothing is lost.
            item.addEventListener('click', () => {
                saveCurrentSessionIfNeeded();
                closeHistoryPanel();
                vscode.postMessage({ type: 'resumeFromHistory', id: session.id });
            });
            historyList.appendChild(item);
        }
    }

    let historyViewMessages = []; // messages of the session currently shown in history panel
    let historyViewSessionId = null; // ID of that session

    function renderHistorySession(messages, sessionId) {
        if (!historySessionView) return;
        historyViewMessages = messages;
        historyViewSessionId = sessionId || null;
        historySessionView.innerHTML = '';

        // ── Resume button ────────────────────────────────────────────────────
        if (messages.length > 0) {
            const resumeBar = document.createElement('div');
            resumeBar.className = 'history-resume-bar';

            const resumeBtn = document.createElement('button');
            resumeBtn.className = 'history-resume-btn';
            resumeBtn.textContent = '▶ Continue this conversation';
            resumeBtn.title = 'Switch to this conversation — the model will remember everything from the beginning';
            resumeBtn.addEventListener('click', () => {
                saveCurrentSessionIfNeeded();
                closeHistoryPanel();
                restoreSessionMessages(historyViewMessages, historyViewSessionId);
            });

            resumeBar.appendChild(resumeBtn);
            historySessionView.appendChild(resumeBar);
        }

        for (const m of messages) {
            if (m.type === 'user') {
                const div = document.createElement('div');
                div.className = 'msg msg-user';
                div.innerHTML = `
                    <div class="msg-meta">You</div>
                    <div class="msg-bubble">${escapeHtml(m.text)}</div>
                `;
                historySessionView.appendChild(div);
            } else if (m.type === 'assistant') {
                const div = document.createElement('div');
                div.className = 'msg msg-assistant';
                div.innerHTML = `
                    <div class="msg-header">
                        <div class="msg-avatar">✦</div>
                        <span class="msg-name">Claude</span>
                    </div>
                    <div class="msg-content">${renderMarkdown(m.text)}</div>
                `;
                addCopyButtonToMessage(div, m.text);
                historySessionView.appendChild(div);
            }
        }

        // Show session view, hide list
        if (historyList) historyList.style.display = 'none';
        historySessionView.classList.add('visible');
        if (historyBackBtn) historyBackBtn.style.display = '';
        if (historyPanelTitle) historyPanelTitle.textContent = 'Past Conversation';
        historySessionView.scrollTop = 0;
    }

    if (historyBtn) historyBtn.addEventListener('click', openHistoryPanel);
    if (historyCloseBtn) historyCloseBtn.addEventListener('click', closeHistoryPanel);
    if (historyBackBtn) {
        historyBackBtn.addEventListener('click', () => {
            if (historySessionView) historySessionView.classList.remove('visible');
            if (historyList) historyList.style.display = '';
            if (historyBackBtn) historyBackBtn.style.display = 'none';
            if (historyPanelTitle) historyPanelTitle.textContent = 'Chat History';
        });
    }

    // ── Toolbar buttons ───────────────────────────────────────────────────────
    if (newChatBtn) {
        newChatBtn.addEventListener('click', () => {
            saveCurrentSessionIfNeeded();
            sessionMessages = [];
            currentSessionId = null;
            vscode.postMessage({ type: 'clear' });
            // Immediately restore pinned files for the new session
            contextFiles = pinnedFiles.map(f => ({ ...f, pinned: true }));
            renderContextFiles();
        });
    }

    if (addFileBtn) {
        addFileBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'pickFile' });
        });
    }

    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'runCommand', command: 'workbench.action.openSettings', args: ['openClaudeCode'] });
        });
    }

    // Export conversation as Markdown
    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            if (sessionMessages.length === 0) return;
            const lines = sessionMessages.map(m =>
                m.type === 'user'
                    ? `## You\n\n${m.text}`
                    : `## Claude\n\n${m.text}`
            );
            const markdown = lines.join('\n\n---\n\n');
            vscode.postMessage({ type: 'exportConversation', markdown });
        });
    }

    // Auto-scroll toggle
    if (autoscrollBtn) {
        autoscrollBtn.addEventListener('click', () => {
            autoScroll = !autoScroll;
            autoscrollBtn.classList.toggle('locked', !autoScroll);
            autoscrollBtn.title = autoScroll ? 'Auto-scroll: On (click to lock)' : 'Auto-scroll: Off (click to unlock)';
            if (autoScroll) scrollToBottom();
        });
    }

    // Re-enable auto-scroll when user scrolls to the bottom
    messagesEl.addEventListener('scroll', () => {
        const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
        if (atBottom && !autoScroll) {
            autoScroll = true;
            if (autoscrollBtn) {
                autoscrollBtn.classList.remove('locked');
                autoscrollBtn.title = 'Auto-scroll: On (click to lock)';
            }
        } else if (!atBottom && autoScroll && isLoading) {
            // User scrolled up while response is streaming — pause auto-scroll
            autoScroll = false;
            if (autoscrollBtn) {
                autoscrollBtn.classList.add('locked');
                autoscrollBtn.title = 'Auto-scroll: Off (click to unlock)';
            }
        }
    });

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
