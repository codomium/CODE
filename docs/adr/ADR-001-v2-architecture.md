# ADR-001: open-claude-code v2 Architecture

**Status**: Accepted  
**Date**: 2026-04-03  
**Deciders**: rUv  
**Tags**: v2, architecture, ruvector

## Context

open-claude-code v1 demonstrated that an open-source Claude Code alternative is viable. v2 rebuilds the system from the ground up, informed by decompilation analysis of Claude Code v2.1.91 (ADR-133 through ADR-139 in the RuVector project). The goal is feature parity with Claude Code while adding RuVector-powered local compute, collective intelligence via pi.ruv.io, and RVF container support for model weights and witness chains.

## Decision

v2 will be built on RVAgent (claude-flow) as the orchestration layer, use RVF containers for model weights and vectors, and integrate 31 RuVector WASM crates for local compute. The architecture mirrors the 8 core systems identified through decompilation.

## Architecture Overview

```
+------------------------------------------------------------------+
|                    open-claude-code v2                             |
+------------------------------------------------------------------+
|  Terminal UI (Ink/React)  |  39 Slash Commands  |  Keyboard Nav   |
+------------------------------------------------------------------+
|  Agent Loop (async generator, 13 event types, recursive)          |
+------------------------------------------------------------------+
|  Tool System   |  Permission  |  Hooks Engine  |  Context Mgr    |
|  (25+ tools)   |  (6 modes)   |  (6 events)    |  (compaction)   |
+------------------------------------------------------------------+
|  MCP Client (stdio/SSE/WS/sHTTP)  |  Settings Chain (5 layers)  |
+------------------------------------------------------------------+
|  Streaming Handler (SSE, 3 modes)  |  Custom Agents & Skills     |
+------------------------------------------------------------------+
|  RVAgent Optimizer  |  RVF Containers  |  WASM Crates (31)       |
+------------------------------------------------------------------+
|  pi.ruv.io Brain (6,961 memories)  |  ruDevolution Decompiler    |
+------------------------------------------------------------------+
```

## Core Systems

### 1. Agent Loop

The central execution engine is an async generator that yields 13 event types and recurses after tool use.

**Event Types**:
- `stream_request_start` -- new API request initiated
- `stream_event` -- raw SSE event from API
- `assistant` -- model response (text or tool_use)
- `user` -- user input message
- `system` -- system-generated message
- `result` -- final conversation result
- `progress` -- progress indicator update
- `stop` -- generation stopped
- `stopReason` -- reason for stop (end_turn, tool_use, max_tokens)
- `hookPermissionResult` -- hook permission decision
- `preventContinuation` -- block further recursion
- `tool_progress` -- streaming tool output
- `message` -- general message event

**Behavior**: After the model emits a `tool_use` content block, the loop executes the tool, appends the result as a `tool_result`, and recursively calls itself. This continues until the model produces an `end_turn` stop reason or max recursion depth is reached.

### 2. Tool System

25+ built-in tools with a consistent `validateInput(input) -> boolean` and `call(input, context) -> ToolResult` interface.

**Built-in Tools**:
- File ops: `Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `LS`, `NotebookEdit`
- Execution: `Bash`, `Agent` (sub-agent), `WebFetch`, `WebSearch`
- State: `TodoWrite`
- MCP: Tools from MCP servers namespaced as `mcp__server__tool`
- Deferred: `ToolSearch` for lazy-loading MCP tool schemas

**Tool Registry**: Dynamic registration allows MCP servers to add tools at runtime. Tools are presented to the model as function definitions with JSON Schema parameters.

### 3. Permission System

Six permission modes control tool execution authorization:

| Mode | Behavior |
|------|----------|
| `bypassPermissions` | All tools run without confirmation |
| `acceptEdits` | File edits auto-approved, others prompt |
| `auto` | Known-safe tools auto-approved, others prompt |
| `default` | Most tools require user confirmation |
| `dontAsk` | Deny rather than prompt |
| `plan` | Read-only mode, no mutations |

**Sandbox**: Uses bubblewrap (Linux) or seatbelt (macOS) to restrict file system and network access. The sandbox allowlist is configurable per project.

**Hook Overrides**: PreToolUse hooks can return `approve`, `deny`, or `modify` to override the default permission decision.

### 4. MCP Client

Full Model Context Protocol client supporting four transports:

- **stdio** -- spawn child process, communicate via stdin/stdout
- **SSE** -- Server-Sent Events over HTTP (legacy)
- **WebSocket** -- bidirectional WebSocket
- **Streamable HTTP** -- new MCP transport (POST with SSE response)

**Protocol Methods**: `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `prompts/list`, `completion/complete`.

**Deferred Tool Loading**: ToolSearch enables lazy loading of MCP tool schemas. Tools are advertised by name only until the model requests their full schema.

### 5. Hooks Engine

Event-driven hook system for extensibility:

**Events**:
- `PreToolUse` -- before tool execution (can block)
- `PostToolUse` -- after tool execution
- `PreToolUseFailure` -- tool validation failed
- `PostToolUseFailure` -- tool execution failed
- `Notification` -- system notification
- `Stop` -- generation stopped
- `SessionStart` -- session initialized

**Hook Types**:
- `command` -- execute a shell command, parse JSON stdout
- `http` -- POST to a webhook URL, parse JSON response

PreToolUse hooks can return `{ "decision": "block", "reason": "..." }` to prevent tool execution.

### 6. Context Manager

Manages the conversation context window to prevent overflow:

- **Auto-compaction**: Triggers at 80% of context window capacity. Summarizes older messages while preserving recent context.
- **Micro-compaction**: Selectively compresses stale tool results (large file reads, old search results) without full compaction.
- **Token counting**: Uses the API's token counting endpoint for accurate counts.
- **File re-read**: After compaction, stale file references are re-read to ensure current state.
- **clear_tool_uses_20250919**: Feature flag for aggressive tool result clearing.

### 7. Settings Chain

Five-layer settings hierarchy (later overrides earlier):

1. **User settings**: `~/.claude/settings.json` (global defaults)
2. **Project settings**: `.claude/settings.json` (committed to repo)
3. **Local settings**: `.claude/settings.local.json` (gitignored)
4. **Managed settings**: Enterprise policy (remote fetch)
5. **Feature flags**: Runtime feature toggles

76 settings properties covering: allowed/denied tools, MCP servers, hook definitions, model preferences, API configuration, UI behavior.

**CLAUDE.md**: Project-specific system prompt loaded from `.claude/CLAUDE.md`, `CLAUDE.md`, and parent directories. Supports `$ARGUMENTS` interpolation.

### 8. Streaming Handler

Processes Anthropic Messages API SSE events in three modes:

- **requesting** -- waiting for API response
- **responding** -- processing content blocks (text, tool_use, thinking)
- **tool-input** -- accumulating tool input JSON

**SSE Event Types**: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`.

Content block types: `text` (model output), `tool_use` (function call), `thinking` (extended thinking).

## RuVector Integration

### RVF Containers

RuVector File Format containers bundle multiple data types in a single file:
- Model weights (quantized)
- Code embeddings (HNSW indexed)
- Witness chains (provenance tracking)
- Metadata and configuration

### WASM Crates

31 RuVector WASM crates provide local compute without external dependencies:
- `micro-hnsw-wasm` -- vector similarity search (150x-12,500x vs brute force)
- `ruvector-cnn` -- local embedding generation
- `consciousness` -- IIT Phi computation for coherence scoring
- `mincut-decompiler` -- graph-based code decomposition
- `sparsifier` -- model weight sparsification
- `solver` -- constraint satisfaction
- Additional crates for tokenization, compression, and graph operations

### RVAgent Optimizer

Eight task profiles from ADR-139 for optimized agent behavior:
1. **code-generation** -- optimized for writing new code
2. **code-review** -- optimized for reviewing and critiquing
3. **debugging** -- optimized for finding and fixing bugs
4. **refactoring** -- optimized for restructuring code
5. **documentation** -- optimized for writing docs
6. **testing** -- optimized for writing tests
7. **architecture** -- optimized for system design
8. **research** -- optimized for information gathering

### pi.ruv.io Brain

Shared collective intelligence backend:
- 6,961+ memories with semantic search
- 350K+ graph edges for relationship mapping
- Differential privacy (epsilon=1.0)
- MinCut clustering for knowledge partitioning
- Witness chain for provenance

### ruDevolution Decompiler

Reverse-engineering pipeline for understanding dependencies:
- AST extraction from minified/bundled code
- WASM Louvain community detection for module boundaries
- Graph-derived folder hierarchy reconstruction
- Declaration extraction (34,759 declarations from Claude Code v2.1.91)

## Technology Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22+ (ESM modules) |
| UI | Ink 5.x (React for terminal) |
| API | Anthropic Messages API + OpenAI compatible endpoint |
| Local compute | RuVector WASM modules (31 crates) |
| State | RVF containers + optional Firestore |
| Testing | Vitest |
| Build | TypeScript 5.x + esbuild |
| Package | npm (scoped @open-claude-code) |

## Implementation Phases

### Phase 1: Foundation (Weeks 1-3)
- Agent loop with async generator pattern
- Tool system with built-in tools
- Basic streaming handler
- Settings chain loading

### Phase 2: Core Features (Weeks 4-6)
- MCP client (all 4 transports)
- Permission system with sandbox
- Context manager with compaction
- Hooks engine

### Phase 3: Intelligence (Weeks 7-9)
- RVAgent optimizer integration
- RVF container support
- WASM crate embedding
- pi.ruv.io brain connection

### Phase 4: Polish (Weeks 10-12)
- Terminal UI with Ink
- Custom agents and skills
- 39 slash commands
- Comprehensive test suite

## Consequences

### Positive
- Feature parity with Claude Code enables drop-in replacement
- Local WASM compute reduces API dependency and cost
- RVF containers provide portable, self-contained state
- Collective intelligence via pi.ruv.io accelerates development
- Open source enables community contribution and audit

### Negative
- Complexity of mirroring Claude Code architecture requires significant effort
- WASM crate integration adds build complexity
- Keeping pace with Claude Code updates requires ongoing decompilation
- pi.ruv.io dependency for brain features (graceful fallback needed)

### Risks
- Anthropic API changes may break streaming handler
- MCP protocol evolution requires tracking spec changes
- WASM performance on low-end hardware needs benchmarking
- Claude Code internal architecture may change significantly between versions

## References

- [ADR-133] Claude Code v2.1.91 Decompilation Analysis
- [ADR-134] Agent Loop Architecture
- [ADR-135] Tool System Design
- [ADR-136] MCP Protocol Integration
- [ADR-137] Permission and Sandbox Model
- [ADR-138] Context Management Strategy
- [ADR-139] RVAgent Task Profile Optimization
- [claude-flow](https://github.com/ruvnet/claude-flow) -- RVAgent orchestration framework
- [RuVector](https://github.com/ruvnet/ruvector) -- WASM crate ecosystem
