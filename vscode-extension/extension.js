'use strict';
/**
 * extension.js — Open Claude Code VSCode Extension
 *
 * Provides two interfaces:
 *
 * 1. Custom Webview Panel (Cursor-style sidebar)
 *    - Activity bar icon → dedicated chat panel
 *    - Rich HTML/CSS/JS UI with markdown, syntax highlighting, code apply, @file mentions
 *    - Streaming token display, tool visualization, model/mode switching
 *
 * 2. Chat Participant (@claude) — kept for backwards compatibility
 *    - Forwards messages to the shared agent-bridge subprocess
 *
 * Commands:
 *   Open Claude Code: Set API Key
 *   Open Claude Code: Clear Session
 *   Open Claude Code: Show Status
 *   Open Claude Code: Open Chat Panel
 *   Open Claude Code: Apply Code to Active File
 */

const vscode = require('vscode');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PARTICIPANT_ID = 'open-claude-code.claude';
const BRIDGE_SCRIPT  = path.join(__dirname, 'agent-bridge.mjs');

// ── AgentBridge ─────────────────────────────────────────────────────────────

/**
 * Manages a single long-lived agent-bridge.mjs child process.
 * Serializes requests so concurrent messages don't interleave.
 */
class AgentBridge {
    constructor(cwd, env) {
        this._cwd  = cwd;
        this._env  = env;
        this._proc = null;
        this._lineBuffer = '';
        this._currentHandler = null;
        this._queue  = Promise.resolve();
        this._started = false;
    }

    start() {
        if (this._started) return;
        this._started = true;

        this._proc = spawn(process.execPath, [BRIDGE_SCRIPT], {
            cwd:   this._cwd,
            env:   { ...process.env, ...this._env },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        this._proc.stdout.setEncoding('utf8');
        this._proc.stdout.on('data', (chunk) => {
            this._lineBuffer += chunk;
            const lines = this._lineBuffer.split('\n');
            this._lineBuffer = lines.pop();
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed) this._dispatch(trimmed);
            }
        });

        this._proc.stderr.setEncoding('utf8');
        this._proc.stderr.on('data', (data) => {
            console.error('[open-claude-code bridge]', data.trim());
        });

        this._proc.on('exit', (code, signal) => {
            this._started = false;
            if (this._currentHandler) {
                this._currentHandler({
                    type: 'error',
                    message: `Agent bridge exited unexpectedly (code=${code}, signal=${signal})`,
                });
                this._currentHandler = null;
            }
        });
    }

    _dispatch(line) {
        let event;
        try { event = JSON.parse(line); } catch {
            console.error('[open-claude-code bridge] bad JSON:', line);
            return;
        }
        if (this._currentHandler) this._currentHandler(event);
    }

    run(message, onEvent) {
        this._queue = this._queue.then(() => this._doRun(message, onEvent));
        return this._queue;
    }

    _doRun(message, onEvent) {
        return new Promise((resolve) => {
            this._currentHandler = (event) => {
                onEvent(event);
                if (event.type === 'stop' || event.type === 'error') {
                    this._currentHandler = null;
                    resolve();
                }
            };
            this._send({ type: 'run', message });
        });
    }

    reset() {
        this._queue = this._queue.then(
            () => new Promise((resolve) => {
                this._currentHandler = (event) => {
                    if (event.type === 'ready' || event.type === 'error') {
                        this._currentHandler = null;
                        resolve();
                    }
                };
                this._send({ type: 'reset' });
            })
        );
        return this._queue;
    }

    switchModel(model) {
        this._queue = this._queue.then(
            () => new Promise((resolve) => {
                this._currentHandler = (event) => {
                    if (event.type === 'ready' || event.type === 'error') {
                        this._currentHandler = null;
                        resolve();
                    }
                };
                this._send({ type: 'model', model });
            })
        );
        return this._queue;
    }

    _send(obj) {
        if (!this._proc || !this._started) throw new Error('Agent bridge is not running');
        this._proc.stdin.write(JSON.stringify(obj) + '\n');
    }

    get isRunning() { return this._started && !!this._proc; }

    dispose() {
        if (this._proc) {
            this._proc.stdin.end();
            this._proc.kill();
            this._proc = null;
        }
        this._started = false;
    }
}

// ── Extension state ──────────────────────────────────────────────────────────

/** @type {AgentBridge | null} */
let bridge = null;

/** @type {vscode.ExtensionContext | null} */
let extensionContext = null;

/** @type {ClaudeCodeViewProvider | null} */
let viewProvider = null;

async function getBridge() {
    if (bridge && bridge.isRunning) return bridge;

    const config = vscode.workspace.getConfiguration('openClaudeCode');
    const model          = config.get('model')          || 'claude-sonnet-4-6';
    const permissionMode = config.get('permissionMode') || 'default';

    const anthropicKey =
        (await extensionContext.secrets.get('openClaudeCode.apiKey')) ||
        process.env.ANTHROPIC_API_KEY || '';
    const openaiKey  = process.env.OPENAI_API_KEY  || '';
    const googleKey  = process.env.GOOGLE_API_KEY  || process.env.GEMINI_API_KEY || '';
    const nvidiaKey  = config.get('nvidiaApiKey') || process.env.NVIDIA_API_KEY  || '';

    const env = {};
    if (anthropicKey) env.ANTHROPIC_API_KEY  = anthropicKey;
    if (openaiKey)    env.OPENAI_API_KEY     = openaiKey;
    if (googleKey)    env.GOOGLE_API_KEY     = googleKey;
    if (nvidiaKey)    env.NVIDIA_API_KEY     = nvidiaKey;
    env.ANTHROPIC_MODEL              = model;
    env.CLAUDE_CODE_PERMISSION_MODE  = permissionMode;
    env.CLAUDE_CODE_MAX_TURNS        = String(config.get('maxTurns') || 20);

    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

    bridge = new AgentBridge(cwd, env);
    bridge.start();
    return bridge;
}

// ── ClaudeCodeViewProvider (Webview sidebar) ─────────────────────────────────

class ClaudeCodeViewProvider {
    constructor(context) {
        this._context = context;
        this._view = null;
        this._isCancelled = false;
        this._tokenUsage = { input: 0, output: 0 };
        this._cost = 0;
    }

    resolveWebviewView(webviewView) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._context.extensionUri, 'media'),
            ],
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(
            (msg) => this._handleWebviewMessage(msg),
            null,
            this._context.subscriptions
        );
    }

    postMessage(msg) {
        if (this._view) {
            this._view.webview.postMessage(msg);
        }
    }

    async _handleWebviewMessage(msg) {
        switch (msg.type) {
            case 'ready': {
                const config = vscode.workspace.getConfiguration('openClaudeCode');
                this.postMessage({
                    type: 'initialized',
                    model: config.get('model') || 'claude-sonnet-4-6',
                    mode:  config.get('permissionMode') || 'default',
                });
                break;
            }

            case 'send': {
                await this._runPrompt(msg.message, msg.contextFiles, msg.fileRefs);
                break;
            }

            case 'clear': {
                if (bridge && bridge.isRunning) await bridge.reset();
                this._tokenUsage = { input: 0, output: 0 };
                this._cost = 0;
                this.postMessage({ type: 'sessionCleared' });
                break;
            }

            case 'cancel': {
                this._isCancelled = true;
                break;
            }

            case 'model': {
                const config = vscode.workspace.getConfiguration('openClaudeCode');
                await config.update('model', msg.model, vscode.ConfigurationTarget.Global);
                if (bridge && bridge.isRunning) await bridge.switchModel(msg.model);
                this.postMessage({ type: 'modelChanged', model: msg.model });
                break;
            }

            case 'mode': {
                const config = vscode.workspace.getConfiguration('openClaudeCode');
                await config.update('permissionMode', msg.mode, vscode.ConfigurationTarget.Global);
                if (bridge) { bridge.dispose(); bridge = null; }
                break;
            }

            case 'applyCode': {
                await this._applyCodeToActiveEditor(msg.code, msg.language);
                break;
            }

            case 'applyCodeToFile': {
                await this._applyCodeWithFilePicker(msg.code, msg.language);
                break;
            }

            case 'copyToClipboard': {
                await vscode.env.clipboard.writeText(msg.text || '');
                break;
            }

            case 'pickFile': {
                const uris = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    openLabel: 'Add to context',
                });
                if (uris && uris[0]) {
                    await this._addFileToContext(uris[0].fsPath);
                }
                break;
            }

            case 'addContextFile': {
                if (msg.path) await this._addFileToContext(msg.path);
                break;
            }

            case 'fileSearch': {
                const results = await this._searchFiles(msg.query || '');
                this.postMessage({ type: 'fileSearchResults', files: results });
                break;
            }

            default:
                break;
        }
    }

    async _runPrompt(message, contextFilePaths, fileRefs) {
        this._isCancelled = false;

        let fullPrompt = message;

        // Inject context file contents
        const allPaths = new Set(contextFilePaths || []);
        if (fileRefs && fileRefs.length > 0) {
            const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (ws) {
                for (const ref of fileRefs) {
                    const abs = path.resolve(ws, ref);
                    if (fs.existsSync(abs)) allPaths.add(abs);
                }
            }
        }

        if (allPaths.size > 0) {
            const fileContents = [];
            for (const fp of allPaths) {
                try {
                    const content = fs.readFileSync(fp, 'utf8');
                    const rel = vscode.workspace.asRelativePath(fp);
                    fileContents.push('\n\n--- File: ' + rel + ' ---\n' + content);
                } catch {
                    // skip unreadable files
                }
            }
            if (fileContents.length > 0) {
                fullPrompt = message + '\n\n[Context files:]' + fileContents.join('');
            }
        }

        let agentBridge;
        try {
            agentBridge = await getBridge();
        } catch (err) {
            this.postMessage({ type: 'error', message: 'Failed to start agent: ' + err.message });
            this.postMessage({ type: 'stop' });
            return;
        }

        await agentBridge.run(fullPrompt, (event) => {
            if (this._isCancelled) return;
            this.postMessage(event);
        });

        if (!this._isCancelled) {
            this.postMessage({ type: 'stop' });
        }
    }

    async _applyCodeToActiveEditor(code) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor. Open a file first.');
            return;
        }
        await editor.edit((editBuilder) => {
            if (!editor.selection.isEmpty) {
                editBuilder.replace(editor.selection, code);
            } else {
                const lastLine = editor.document.lineCount - 1;
                const lastChar = editor.document.lineAt(lastLine).text.length;
                const end = new vscode.Position(lastLine, lastChar);
                editBuilder.insert(end, '\n' + code);
            }
        });
        await vscode.commands.executeCommand('workbench.action.files.save');
        vscode.window.showInformationMessage('Code applied to ' + path.basename(editor.document.fileName));
    }

    async _applyCodeWithFilePicker(code, language) {
        const ext = languageToExt(language);
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Apply to this file',
            filters: ext ? { [language || 'code']: [ext] } : undefined,
        });
        if (!uris || !uris[0]) return;

        const doc = await vscode.workspace.openTextDocument(uris[0]);
        const editor = await vscode.window.showTextDocument(doc);
        await editor.edit((eb) => {
            const fullRange = new vscode.Range(
                doc.positionAt(0),
                doc.positionAt(doc.getText().length)
            );
            eb.replace(fullRange, code);
        });
        await vscode.commands.executeCommand('workbench.action.files.save');
    }

    async _addFileToContext(filePath) {
        const name = path.basename(filePath);
        this.postMessage({ type: 'fileContent', path: filePath, name });
    }

    async _searchFiles(query) {
        const pattern = query ? ('**/*' + query + '*') : '**/*';
        const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 20);
        return uris.map((u) => ({
            name:         path.basename(u.fsPath),
            path:         u.fsPath,
            relativePath: vscode.workspace.asRelativePath(u.fsPath),
        }));
    }

    _getHtmlForWebview(webview) {
        const cssUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._context.extensionUri, 'media', 'chat.css')
        );
        const jsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._context.extensionUri, 'media', 'chat.js')
        );

        const templatePath = path.join(this._context.extensionPath, 'media', 'chat.html');
        let html = fs.readFileSync(templatePath, 'utf8');

        const nonce = generateNonce();
        const csp = [
            "default-src 'none'",
            "style-src " + webview.cspSource + " 'unsafe-inline'",
            "script-src 'nonce-" + nonce + "'",
            "img-src " + webview.cspSource + " data: https:",
            "font-src " + webview.cspSource,
        ].join('; ');

        html = html
            .replace('<!--CSP_PLACEHOLDER-->', '<meta http-equiv="Content-Security-Policy" content="' + csp + '">')
            .replace('<!--CSS_URI-->', cssUri.toString())
            .replace(/<!--JS_URI-->/g, jsUri.toString())
            .replace('<script src="' + jsUri + '">', '<script nonce="' + nonce + '" src="' + jsUri + '">');

        return html;
    }
}

ClaudeCodeViewProvider.viewType = 'claudeCode.chatView';

function generateNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

function languageToExt(lang) {
    const map = {
        javascript: 'js', typescript: 'ts', python: 'py', java: 'java',
        go: 'go', rust: 'rs', cpp: 'cpp', c: 'c', html: 'html', css: 'css',
        json: 'json', yaml: 'yaml', markdown: 'md', shell: 'sh', bash: 'sh',
    };
    return map[(lang || '').toLowerCase()];
}

// ── Chat Participant (kept for backwards-compatibility) ──────────────────────

async function handleChatRequest(request, _context, stream, token) {
    const config = vscode.workspace.getConfiguration('openClaudeCode');
    const showToolOutput = config.get('showToolOutput') !== false;

    if (request.command === 'clear') {
        if (bridge && bridge.isRunning) await bridge.reset();
        stream.markdown('🗑️ Session cleared. Starting a fresh conversation.');
        return;
    }

    if (request.command === 'model') {
        const modelArg = request.prompt.trim();
        if (!modelArg) {
            stream.markdown('Usage: `@claude /model <model-name>`\n\nExamples:\n- `claude-sonnet-4-6`\n- `claude-opus-4-6`\n- `claude-haiku-4-5`');
            return;
        }
        if (bridge && bridge.isRunning) await bridge.switchModel(modelArg);
        stream.markdown('✅ Switched model to `' + modelArg + '`.');
        return;
    }

    const userMessage = request.prompt.trim();
    if (!userMessage) { stream.markdown('Please enter a message.'); return; }

    let agentBridge;
    try {
        agentBridge = await getBridge();
    } catch (err) {
        stream.markdown('❌ Failed to start agent: ' + err.message + '\n\nMake sure you have set your API key with the **Open Claude Code: Set API Key** command.');
        return;
    }

    let pendingText = '';
    function flushText() {
        if (pendingText) { stream.markdown(pendingText); pendingText = ''; }
    }

    await agentBridge.run(userMessage, (event) => {
        if (token.isCancellationRequested) return;
        switch (event.type) {
            case 'stream_event':    pendingText += event.text || ''; break;
            case 'assistant':       if (event.content && !event._streamed) pendingText += event.content; break;
            case 'thinking':        break;
            case 'tool_progress':
                if (showToolOutput) { flushText(); stream.progress('⚙️ Running tool: ' + event.tool); }
                break;
            case 'result':
                if (showToolOutput && event.result !== undefined) {
                    flushText();
                    const preview = String(event.result).slice(0, 400);
                    const truncated = String(event.result).length > 400 ? '…' : '';
                    stream.markdown('\n```\n' + preview + truncated + '\n```\n');
                }
                break;
            case 'compaction':
                flushText();
                stream.markdown('\n> ℹ️ Context compacted (pass ' + event.count + ')\n');
                break;
            case 'hookPermissionResult':
                if (!event.allowed) { flushText(); stream.markdown('\n> ⛔ Tool blocked by hook: `' + event.tool + '`\n'); }
                break;
            case 'error':   flushText(); stream.markdown('\n❌ **Error:** ' + event.message); break;
            case 'stop':    flushText(); break;
            default: break;
        }
    });

    flushText();
}

// ── Activation / deactivation ────────────────────────────────────────────────

function activate(context) {
    extensionContext = context;

    // Sidebar webview panel
    viewProvider = new ClaudeCodeViewProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ClaudeCodeViewProvider.viewType,
            viewProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // Chat participant (@claude)
    const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handleChatRequest);
    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
    context.subscriptions.push(participant);

    // Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('openClaudeCode.setApiKey', async () => {
            const key = await vscode.window.showInputBox({
                prompt: 'Enter your Anthropic API key (sk-ant-...)',
                password: true,
                placeHolder: 'sk-ant-api03-...',
                validateInput: (v) => v && v.startsWith('sk-ant-') ? null : 'Key should start with sk-ant-',
            });
            if (key) {
                await context.secrets.store('openClaudeCode.apiKey', key);
                if (bridge) { bridge.dispose(); bridge = null; }
                vscode.window.showInformationMessage('API key saved. Bridge will restart on next message.');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('openClaudeCode.clearSession', async () => {
            if (bridge && bridge.isRunning) {
                await bridge.reset();
                if (viewProvider) viewProvider.postMessage({ type: 'sessionCleared' });
                vscode.window.showInformationMessage('Open Claude Code session cleared.');
            } else {
                vscode.window.showInformationMessage('No active session to clear.');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('openClaudeCode.showStatus', async () => {
            const config = vscode.workspace.getConfiguration('openClaudeCode');
            const model          = config.get('model') || 'claude-sonnet-4-6';
            const permissionMode = config.get('permissionMode') || 'default';
            const hasKey = !!(
                (await context.secrets.get('openClaudeCode.apiKey')) ||
                process.env.ANTHROPIC_API_KEY
            );
            const status = (bridge && bridge.isRunning) ? '🟢 running' : '⚪ idle';
            vscode.window.showInformationMessage(
                'Open Claude Code — bridge: ' + status +
                ' | model: ' + model +
                ' | permission: ' + permissionMode +
                ' | API key: ' + (hasKey ? '✅ set' : '❌ missing')
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('openClaudeCode.openChat', () => {
            vscode.commands.executeCommand('claudeCode.chatView.focus');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('openClaudeCode.applyCode', async () => {
            const code = await vscode.window.showInputBox({
                prompt: 'Paste code to apply to the active editor',
                placeHolder: '// paste code here',
            });
            if (code && viewProvider) {
                await viewProvider._applyCodeToActiveEditor(code);
            }
        })
    );

    // Reload bridge when settings change
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('openClaudeCode')) {
                if (bridge) { bridge.dispose(); bridge = null; }
            }
        })
    );
}

function deactivate() {
    if (bridge) { bridge.dispose(); bridge = null; }
}

module.exports = { activate, deactivate };
