#!/usr/bin/env node
/**
 * agent-bridge.mjs
 *
 * Long-lived subprocess that runs the Open Claude Code agent loop and
 * communicates with the VSCode extension over stdin/stdout using
 * newline-delimited JSON (ndjson).
 *
 * Protocol (stdin → bridge):
 *   {"type":"run",   "message":"<user text>"}
 *   {"type":"reset"}
 *   {"type":"model", "model":"<model name>"}
 *
 * Protocol (bridge → stdout):
 *   {"type":"stream_event",          "text":"..."}
 *   {"type":"assistant",             "content":"..."}
 *   {"type":"tool_progress",         "tool":"Bash","status":"running"}
 *   {"type":"result",                "tool":"Bash","result":"..."}
 *   {"type":"thinking",              "text":"..."}
 *   {"type":"compaction",            "count":1}
 *   {"type":"hookPermissionResult",  "tool":"...","allowed":false}
 *   {"type":"stop",                  "reason":"end_turn"}
 *   {"type":"error",                 "message":"..."}
 *   {"type":"ready"}
 *
 * Environment variables consumed:
 *   ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, GEMINI_API_KEY,
 *   NVIDIA_API_KEY
 *   ANTHROPIC_MODEL          — initial model override
 *   CLAUDE_CODE_PERMISSION_MODE
 *   CLAUDE_CODE_MAX_TURNS
 */

import { createAgentLoop } from '../v2/src/core/agent-loop.mjs';
import { createToolRegistry } from '../v2/src/tools/registry.mjs';
import { createPermissionChecker } from '../v2/src/permissions/checker.mjs';
import { loadSettings } from '../v2/src/config/settings.mjs';
import { HookEngine } from '../v2/src/hooks/engine.mjs';
import { AgentLoader } from '../v2/src/agents/loader.mjs';
import { SkillsLoader } from '../v2/src/skills/loader.mjs';
import readline from 'readline';

// Redirect console.error/warn to stderr so we don't pollute the ndjson stream.
// (It already goes to stderr by default, but belt-and-suspenders.)
const originalStderr = process.stderr.write.bind(process.stderr);

function emit(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
}

async function init() {
    let settings;
    try {
        settings = await loadSettings();
    } catch (err) {
        emit({ type: 'error', message: `Failed to load settings: ${err.message}` });
        process.exit(1);
    }

    const tools = createToolRegistry();
    const permissions = createPermissionChecker(settings.permissions);
    const hooks = new HookEngine(settings.hooks || {});

    // Load agents and skills
    const agentLoader = new AgentLoader();
    agentLoader.load();
    const skillsLoader = new SkillsLoader();
    skillsLoader.load();

    const skillTool = tools.get('Skill');
    if (skillTool) skillTool._skillsLoader = skillsLoader;

    const loop = createAgentLoop({
        model: settings.model || 'claude-sonnet-4-6',
        tools,
        permissions,
        settings,
        hooks,
    });

    loop.state._agentLoader = agentLoader;
    loop.state._skillsLoader = skillsLoader;
    loop.state._hooks = settings.hooks;
    loop.state._permissionMode = settings.permissions?.defaultMode || 'default';

    emit({ type: 'ready' });

    // ── Message loop ────────────────────────────────────────────────────────
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

    // Serialize requests so they never interleave.
    let queue = Promise.resolve();

    rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        let msg;
        try {
            msg = JSON.parse(trimmed);
        } catch {
            emit({ type: 'error', message: `Bad JSON from extension: ${trimmed}` });
            return;
        }

        if (msg.type === 'reset') {
            queue = queue.then(() => handleReset(loop));
        } else if (msg.type === 'run') {
            queue = queue.then(() => handleRun(loop, msg.message));
        } else if (msg.type === 'model') {
            queue = queue.then(() => handleModelSwitch(loop, msg.model));
        }
    });

    rl.on('close', () => process.exit(0));
}

async function handleRun(loop, message) {
    if (!message || typeof message !== 'string') {
        emit({ type: 'error', message: 'run message must have a non-empty "message" string' });
        emit({ type: 'stop', reason: 'error' });
        return;
    }
    try {
        for await (const event of loop.run(message)) {
            emit(event);
        }
    } catch (err) {
        emit({ type: 'error', message: err.message });
        emit({ type: 'stop', reason: 'error' });
    }
}

async function handleReset(loop) {
    loop.state.messages = [];
    loop.state.turnCount = 0;
    loop.state.tokenUsage = { input: 0, output: 0 };
    emit({ type: 'ready' });
}

async function handleModelSwitch(loop, model) {
    if (model && typeof model === 'string') {
        loop.state.model = model;
    }
    emit({ type: 'ready' });
}

init().catch((err) => {
    emit({ type: 'error', message: err.message });
    process.exit(1);
});
