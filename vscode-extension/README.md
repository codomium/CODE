# Open Claude Code — VSCode Extension

A **Cursor-style AI coding assistant** built directly into VSCode — no terminal required.

---

## Features

### 🖥️ Cursor-style Sidebar Panel (new in v1.1)
- **Dedicated activity bar icon** — opens a full chat panel in the VS Code sidebar
- **Rich markdown rendering** — headers, tables, bold/italic, blockquotes
- **Syntax-highlighted code blocks** — JavaScript, TypeScript, Python, Go, Rust, JSON, Bash and more
- **Copy button on every code block** — one click to copy to clipboard
- **Apply to file** — apply AI-suggested code directly to the active editor or pick a file
- **Streaming responses** — see tokens arrive in real-time with animated cursor
- **Tool visualization** — collapsible cards showing each tool execution and result
- **Extended thinking** — expandable thinking blocks when the model reasons
- **@file context** — type `@filename` in the input to inject file contents into the prompt
- **File picker** — add any workspace file to context with the 📄 button
- **Model & mode selector** — switch model and permission mode directly from the UI
- **Session stats** — token count, cost estimate, and elapsed time always visible
- **Stop button** — cancel generation at any time
- **New conversation** — clear history with one click

### 💬 `@claude` Chat Participant (VSCode built-in chat)
- Ask questions, request code changes, and run agentic tools without leaving the editor
- **Full tool access** — the same 25+ tools as the CLI (Read, Write, Edit, Bash, Glob, Grep, WebFetch, …)
- **Multi-provider** — Anthropic Claude, OpenAI GPT, Google Gemini
- **Conversation memory** — history is maintained across turns in the same VS Code session
- **Slash commands** — `/clear` to reset, `/model` to switch models mid-session
- **Configurable permission mode** — control how aggressively the agent modifies your files

---

## Requirements

- **VSCode 1.90+** (Chat API required)
- **Node.js 18+** on your PATH
- An **API key** for at least one supported provider (Anthropic, OpenAI, Google, or NVIDIA)

---

## Quick Start (already have VSCode installed)

1. **Install the extension** — load from VSIX or press F5 in the repo (see [Installation](#installation) below).
2. **Open the chat panel** — click the **✦** icon in the Activity Bar (left sidebar).
3. **Follow the setup guide** — the welcome screen walks you through getting and entering an API key.

   Or run **Open Claude Code: Set API Key** from the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).

4. **Start chatting** — type a message and press **Enter**.

> The first time you send a message the extension starts a Node.js agent subprocess in your workspace directory. This may take a second or two.

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
   code --install-extension open-claude-code-1.1.0.vsix
   ```
   Or use **Extensions → … → Install from VSIX…** in the VSCode UI.

### Option B — load as an unpacked extension (development)

1. Open the repo in VSCode.
2. Press **F5** to launch a new Extension Development Host window.
3. In the new window, open any project folder and use `@claude` in the Chat panel.

---

## Setup

### API key — which provider?

| Provider | Where to get a key | Environment variable |
|----------|--------------------|----------------------|
| **Anthropic** (recommended) | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) | `ANTHROPIC_API_KEY` |
| **OpenAI** | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | `OPENAI_API_KEY` |
| **Google** | [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) | `GOOGLE_API_KEY` or `GEMINI_API_KEY` |
| **NVIDIA NIM** | [integrate.api.nvidia.com](https://integrate.api.nvidia.com) | `NVIDIA_API_KEY` |

### Option 1 — Command Palette (recommended)

Run **Open Claude Code: Set API Key** (`Ctrl+Shift+P` / `Cmd+Shift+P`).

The key is stored securely in VSCode's [SecretStorage](https://code.visualstudio.com/api/references/vscode-api#SecretStorage) — it is never written to disk in plaintext.

### Option 2 — VS Code Settings (NVIDIA key only)

Open Settings (`Ctrl+,`), search for `openClaudeCode.nvidiaApiKey`, and paste your `nvapi-...` key.

### Option 3 — Environment variable

Set the variable before launching VSCode:
```bash
export ANTHROPIC_API_KEY=sk-ant-...
code .
```

---

## Usage

### Sidebar chat panel (recommended)

Click the **✦ Claude Code** icon in the activity bar (left sidebar) to open the chat panel, then:
- Type your message and press **Enter** to send (Shift+Enter for a new line)
- Use `@filename` to inject file contents into the prompt
- Click **📄** to pick a file from the workspace
- Click **New** to start a fresh conversation
- Use the **Model** and **Mode** dropdowns to configure the agent

When Claude suggests code, every code block has:
- **Copy** — copy the code to clipboard
- **Apply to file…** — apply the code to the active editor (or pick a file)

### @claude chat participant (VSCode built-in chat)

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
| **Open Claude Code: Open Chat Panel** | Focus the sidebar chat panel |
| **Open Claude Code: Apply Code to Active File** | Paste code into the active editor |

---

## Configuration

Open **Settings** (`Ctrl+,`) and search for `openClaudeCode`:

| Setting | Default | Description |
|---------|---------|-------------|
| `openClaudeCode.model` | `claude-sonnet-4-6` | AI model to use |
| `openClaudeCode.nvidiaApiKey` | _(empty)_ | NVIDIA NIM API key (`nvapi-...`) |
| `openClaudeCode.permissionMode` | `default` | How the agent handles file/shell permissions |
| `openClaudeCode.maxTurns` | `20` | Maximum agentic tool-use turns per request |
| `openClaudeCode.showToolOutput` | `true` | Show tool progress and results in chat |
| `openClaudeCode.enableWebviewPanel` | `true` | Show the Cursor-style sidebar chat panel |

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
┌──────────────────────────────────────────────────────┐
│  VS Code Extension Host                              │
│                                                      │
│  ┌─────────────────────────┐  ┌────────────────────┐ │
│  │  ClaudeCodeViewProvider │  │  ChatParticipant   │ │
│  │  (Cursor-style sidebar) │  │  (@claude)         │ │
│  └──────────┬──────────────┘  └─────────┬──────────┘ │
│             │ postMessage / onMessage    │            │
│             └────────────┬──────────────┘            │
│                          │ child_process.spawn        │
└──────────────────────────┼──────────────────────────-┘
                           ▼
              agent-bridge.mjs  (ESM Node.js subprocess)
                     │  createAgentLoop + 25 tools
                     ▼
          Anthropic / OpenAI / Google API
```

The subprocess persists across chat turns so the agent's conversation history is maintained.  Clicking **New** (or running the **Clear Session** command) resets the history.

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
