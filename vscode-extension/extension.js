'use strict';
/**
 * extension.js — Open Claude Code VSCode Extension
 *
 * Registers a VSCode Chat Participant (@claude) that forwards messages to a
 * long-lived agent-bridge.mjs subprocess running the Open Claude Code agent
 * loop.  Conversation state is maintained inside the subprocess between turns.
 *
 * Supported slash commands inside @claude:
 *   /clear   — reset conversation history
 *   /model   — switch model mid-session (e.g. /model claude-opus-4-6)
 *
 * Extension commands (Command Palette):
 *   Open Claude Code: Set API Key
 *   Open Claude Code: Clear Session
 *   Open Claude Code: Show Status
 */

const vscode = require('vscode');
const { spawn } = require('child_process');
const path = require('path');

const PARTICIPANT_ID = 'open-claude-code.claude';
const BRIDGE_SCRIPT = path.join(__dirname, 'agent-bridge.mjs');

// ── AgentBridge ────────────────────────────────────────────────────────────

/**
 * Manages a single long-lived agent-bridge.mjs child process.
 * Serializes requests so concurrent messages don't interleave.
 */
class AgentBridge {
    /**
     * @param {string} cwd   Workspace root (process.cwd for the bridge)
     * @param {Record<string,string>} env  Extra environment variables
     */
    constructor(cwd, env) {
        this._cwd = cwd;
        this._env = env;
        this._proc = null;
        this._lineBuffer = '';
        this._currentHandler = null;
        this._queue = Promise.resolve();
        this._started = false;
    }

    /** Spawn the bridge process and wait for the first "ready" event. */
    start() {
        if (this._started) return;
        this._started = true;

        this._proc = spawn(process.execPath, [BRIDGE_SCRIPT], {
            cwd: this._cwd,
            env: { ...process.env, ...this._env },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        this._proc.stdout.setEncoding('utf8');
        this._proc.stdout.on('data', (chunk) => {
            this._lineBuffer += chunk;
            const lines = this._lineBuffer.split('\n');
            this._lineBuffer = lines.pop(); // last may be incomplete
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed) this._dispatch(trimmed);
            }
        });

        this._proc.stderr.setEncoding('utf8');
        this._proc.stderr.on('data', (data) => {
            // Surface bridge stderr as VS Code output (not chat)
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
        try {
            event = JSON.parse(line);
        } catch {
            console.error('[open-claude-code bridge] bad JSON:', line);
            return;
        }
        if (this._currentHandler) {
            this._currentHandler(event);
        }
    }

    /**
     * Send a "run" request.  Resolves when the agent emits "stop" or "error".
     * @param {string} message
     * @param {(event: object) => void} onEvent
     */
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

    /** Reset conversation history inside the bridge. */
    reset() {
        this._queue = this._queue.then(
            () =>
                new Promise((resolve) => {
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

    /** Switch model inside the bridge. */
    switchModel(model) {
        this._queue = this._queue.then(
            () =>
                new Promise((resolve) => {
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
        if (!this._proc || !this._started) {
            throw new Error('Agent bridge is not running');
        }
        this._proc.stdin.write(JSON.stringify(obj) + '\n');
    }

    get isRunning() {
        return this._started && !!this._proc;
    }

    dispose() {
        if (this._proc) {
            this._proc.stdin.end();
            this._proc.kill();
            this._proc = null;
        }
        this._started = false;
    }
}

// ── Extension state ────────────────────────────────────────────────────────

/** @type {AgentBridge | null} */
let bridge = null;

/** @type {vscode.ExtensionContext | null} */
let extensionContext = null;

/**
 * Build (or rebuild) the bridge using current settings + stored API key.
 * @returns {Promise<AgentBridge>}
 */
async function getBridge() {
    if (bridge?.isRunning) return bridge;

    const config = vscode.workspace.getConfiguration('openClaudeCode');
    const model = config.get('model') || 'claude-sonnet-4-6';
    const permissionMode = config.get('permissionMode') || 'default';

    // Resolve API keys — prefer secrets store, fall back to process.env
    const anthropicKey =
        (await extensionContext?.secrets.get('openClaudeCode.apiKey')) ||
        process.env.ANTHROPIC_API_KEY ||
        '';
    const openaiKey = process.env.OPENAI_API_KEY || '';
    const googleKey =
        process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '';

    const env = {};
    if (anthropicKey) env.ANTHROPIC_API_KEY = anthropicKey;
    if (openaiKey) env.OPENAI_API_KEY = openaiKey;
    if (googleKey) env.GOOGLE_API_KEY = googleKey;
    env.ANTHROPIC_MODEL = model;
    env.CLAUDE_CODE_PERMISSION_MODE = permissionMode;

    const cwd =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
        process.cwd();

    bridge = new AgentBridge(cwd, env);
    bridge.start();
    return bridge;
}

// ── Chat participant ───────────────────────────────────────────────────────

/**
 * Handle a message sent to @claude.
 * @param {vscode.ChatRequest} request
 * @param {vscode.ChatContext} _context
 * @param {vscode.ChatResponseStream} stream
 * @param {vscode.CancellationToken} token
 */
async function handleChatRequest(request, _context, stream, token) {
    const config = vscode.workspace.getConfiguration('openClaudeCode');
    const showToolOutput = config.get('showToolOutput') !== false;

    // ── Slash commands ──────────────────────────────────────────────────────
    if (request.command === 'clear') {
        if (bridge?.isRunning) {
            await bridge.reset();
        }
        stream.markdown('🗑️ Session cleared. Starting a fresh conversation.');
        return;
    }

    if (request.command === 'model') {
        const modelArg = request.prompt.trim();
        if (!modelArg) {
            stream.markdown('Usage: `@claude /model <model-name>`\n\nExamples:\n- `claude-sonnet-4-6`\n- `claude-opus-4-6`\n- `claude-haiku-4-5`');
            return;
        }
        if (bridge?.isRunning) {
            await bridge.switchModel(modelArg);
        }
        stream.markdown(`✅ Switched model to \`${modelArg}\`.`);
        return;
    }

    // ── Regular prompt ──────────────────────────────────────────────────────
    const userMessage = request.prompt.trim();
    if (!userMessage) {
        stream.markdown('Please enter a message.');
        return;
    }

    let agentBridge;
    try {
        agentBridge = await getBridge();
    } catch (err) {
        stream.markdown(`❌ Failed to start agent: ${err.message}\n\nMake sure you have set your API key with the **Open Claude Code: Set API Key** command.`);
        return;
    }

    // Collect streamed text so we can render it in one markdown block per
    // assistant turn (avoids many tiny partial-text markdown calls).
    let pendingText = '';

    function flushText() {
        if (pendingText) {
            stream.markdown(pendingText);
            pendingText = '';
        }
    }

    await agentBridge.run(userMessage, (event) => {
        // Respect cancellation
        if (token.isCancellationRequested) return;

        switch (event.type) {
            case 'stream_event':
                pendingText += event.text || '';
                break;

            case 'assistant':
                if (event.content && !event._streamed) {
                    pendingText += event.content;
                }
                break;

            case 'thinking':
                // Thinking blocks are not shown by default — they can be noisy.
                break;

            case 'tool_progress':
                if (showToolOutput) {
                    flushText();
                    stream.progress(`⚙️ Running tool: ${event.tool}`);
                }
                break;

            case 'result':
                if (showToolOutput && event.result !== undefined) {
                    flushText();
                    const preview = String(event.result).slice(0, 400);
                    const truncated = String(event.result).length > 400 ? '…' : '';
                    stream.markdown(`\n\`\`\`\n${preview}${truncated}\n\`\`\`\n`);
                }
                break;

            case 'compaction':
                flushText();
                stream.markdown(`\n> ℹ️ Context compacted (pass ${event.count})\n`);
                break;

            case 'hookPermissionResult':
                if (!event.allowed) {
                    flushText();
                    stream.markdown(`\n> ⛔ Tool blocked by hook: \`${event.tool}\`\n`);
                }
                break;

            case 'error':
                flushText();
                stream.markdown(`\n❌ **Error:** ${event.message}`);
                break;

            case 'stop':
                flushText();
                break;

            default:
                break;
        }
    });

    // Final flush in case the loop ended without a 'stop' event
    flushText();
}

// ── Activation / deactivation ──────────────────────────────────────────────

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    extensionContext = context;

    // ── Chat participant ────────────────────────────────────────────────────
    const participant = vscode.chat.createChatParticipant(
        PARTICIPANT_ID,
        handleChatRequest
    );
    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'assets', 'icon.png');
    context.subscriptions.push(participant);

    // ── Commands ────────────────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('openClaudeCode.setApiKey', async () => {
            const key = await vscode.window.showInputBox({
                prompt: 'Enter your Anthropic API key (sk-ant-...)',
                password: true,
                placeHolder: 'sk-ant-api03-...',
                validateInput: (v) =>
                    v && v.startsWith('sk-ant-') ? null : 'Key should start with sk-ant-',
            });
            if (key) {
                await context.secrets.store('openClaudeCode.apiKey', key);
                // Restart bridge so it picks up the new key
                bridge?.dispose();
                bridge = null;
                vscode.window.showInformationMessage('API key saved. Bridge will restart on next message.');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('openClaudeCode.clearSession', async () => {
            if (bridge?.isRunning) {
                await bridge.reset();
                vscode.window.showInformationMessage('Open Claude Code session cleared.');
            } else {
                vscode.window.showInformationMessage('No active session to clear.');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('openClaudeCode.showStatus', async () => {
            const config = vscode.workspace.getConfiguration('openClaudeCode');
            const model = config.get('model') || 'claude-sonnet-4-6';
            const permissionMode = config.get('permissionMode') || 'default';
            const hasKey = !!(
                (await context.secrets.get('openClaudeCode.apiKey')) ||
                process.env.ANTHROPIC_API_KEY
            );
            const status = bridge?.isRunning ? '🟢 running' : '⚪ idle';

            vscode.window.showInformationMessage(
                `Open Claude Code — bridge: ${status} | model: ${model} | permission: ${permissionMode} | API key: ${hasKey ? '✅ set' : '❌ missing'}`
            );
        })
    );

    // Reload bridge when settings change
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('openClaudeCode')) {
                bridge?.dispose();
                bridge = null;
            }
        })
    );
}

function deactivate() {
    bridge?.dispose();
    bridge = null;
}

module.exports = { activate, deactivate };
