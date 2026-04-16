# Open Claude Code — VSCode Extension

Use **Open Claude Code** as a chatbot directly inside VSCode's built-in Chat panel — no terminal required.

---

## Features

- **`@claude` chat participant** — ask questions, request code changes, and run agentic tools without leaving the editor
- **Full tool access** — the same 25+ tools as the CLI (Read, Write, Edit, Bash, Glob, Grep, WebFetch, …)
- **Multi-provider** — Anthropic Claude, OpenAI GPT, Google Gemini (set the model in settings)
- **Conversation memory** — history is maintained across turns in the same VSCode session
- **Slash commands** — `/clear` to reset, `/model` to switch models mid-session
- **Configurable permission mode** — control how aggressively the agent modifies your files

---

## Requirements

- **VSCode 1.90+** (Chat API required)
- **Node.js 18+** on your PATH
- An **API key** for the model provider you want to use (Anthropic, OpenAI, or Google)

---

## Installation

### Option A — from VSIX (recommended for local use)

1. Install [`vsce`](https://github.com/microsoft/vscode-vsce) if you haven't already:
   ```bash
   npm install -g @vscode/vsce
   ```
2. From the `vscode-extension/` directory, build the VSIX:
   ```bash
   cd vscode-extension
   npm install
   vsce package --no-dependencies
   ```
3. Install it in VSCode:
   ```bash
   code --install-extension open-claude-code-1.0.0.vsix
   ```
   Or use **Extensions → … → Install from VSIX…** in the VSCode UI.

### Option B — load as an unpacked extension (development)

1. Open the repo in VSCode.
2. Press **F5** to launch a new Extension Development Host window.
3. In the new window, open any project folder and use `@claude` in the Chat panel.

---

## Setup

### Set your API key

Run the command **Open Claude Code: Set API Key** from the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).

The key is stored securely in VSCode's [SecretStorage](https://code.visualstudio.com/api/references/vscode-api#SecretStorage) — it is never written to disk in plaintext.

Alternatively, set the environment variable before launching VSCode:
```bash
export ANTHROPIC_API_KEY=sk-ant-...
code .
```

---

## Usage

Open the **Chat** panel (`Ctrl+Alt+I` / `Cmd+Alt+I`) and type:

```
@claude explain this codebase
@claude fix the bug in src/server.js
@claude write unit tests for utils.ts
@claude what does the `loadSettings` function do?
```

### Slash commands

| Command | Description |
|---------|-------------|
| `@claude /clear` | Reset conversation history |
| `@claude /model claude-opus-4-6` | Switch model for this session |

### Command Palette commands

| Command | Description |
|---------|-------------|
| **Open Claude Code: Set API Key** | Store your API key securely |
| **Open Claude Code: Clear Session** | Reset conversation history |
| **Open Claude Code: Show Status** | Show bridge status, model, and key info |

---

## Configuration

Open **Settings** (`Ctrl+,`) and search for `openClaudeCode`:

| Setting | Default | Description |
|---------|---------|-------------|
| `openClaudeCode.model` | `claude-sonnet-4-6` | AI model to use |
| `openClaudeCode.permissionMode` | `default` | How the agent handles file/shell permissions |
| `openClaudeCode.maxTurns` | `20` | Maximum agentic tool-use turns per request |
| `openClaudeCode.showToolOutput` | `true` | Show tool progress and results in chat |

### Permission modes

| Mode | Description |
|------|-------------|
| `default` | Ask before each tool use (safest) |
| `auto` | Automatically approve safe operations |
| `plan` | Read-only — no file writes or shell commands |
| `acceptEdits` | Approve file edits without prompting |
| `bypassPermissions` | Skip all permission checks |

---

## How it works

The extension spawns **`agent-bridge.mjs`** as a long-lived Node.js subprocess in your workspace directory.  The bridge imports the Open Claude Code agent loop from `../v2/src/` and speaks a simple newline-delimited JSON protocol over stdin/stdout.

```
VSCode Chat UI
    │  vscode.chat.createChatParticipant
    ▼
extension.js (CJS, extension host)
    │  child_process.spawn
    ▼
agent-bridge.mjs (ESM, Node.js subprocess)
    │  createAgentLoop + 25 tools
    ▼
Anthropic / OpenAI / Google API
```

The subprocess persists across chat turns so the agent's conversation history is maintained.  Sending `@claude /clear` (or running the **Clear Session** command) resets the history.

---

## Troubleshooting

**"Failed to start agent"**
- Make sure you have set your API key (see Setup above).
- Check the **Output** panel → **Open Claude Code** channel for subprocess stderr logs.

**The agent hangs or doesn't respond**
- Run **Open Claude Code: Clear Session** to restart the bridge.
- Check that Node.js 18+ is on your PATH: `node --version`.

**Tool calls fail with permission errors**
- Change `openClaudeCode.permissionMode` to `auto` or `acceptEdits` in settings.

---

## License

MIT
