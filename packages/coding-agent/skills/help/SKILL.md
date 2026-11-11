---
name: help
description: Comprehensive System 2 guide explaining dual-process deliberation, interactive controls, cognitive models, rollback engine, and multi-agent workflows.
argument-hint: [topic]
---

# System 2 Sovereign Dual-Process Engine Guide

System 2 is an autonomous, dual-process cognitive coding harness engineered to bridge reflexive edge execution (System 1) with formal multi-hypothesis deliberation (System 2), safeguarded by an immutable fail-closed sentinel kernel.

---

## 1. Cognitive Architecture: System 1 vs. System 2

System 2 implements Daniel Kahneman's dual-process cognitive model directly into the execution loop:

```
                  ┌──────────────────────────────────────────────┐
                  │            User Prompt / Request             │
                  └──────────────────────┬───────────────────────┘
                                         │
                         ┌───────────────▼───────────────┐
                         │   System 1 Fast Triage /      │
                         │   Reflexive Edge Execution    │
                         └───────┬───────────────┬───────┘
                     Routine /   │               │ Complex /
                     Syntactic   │               │ Architectural
                                 │               │
                 ┌───────────────▼──┐         ┌──▼───────────────────────────┐
                 │ System 1 Fast    │         │ System 2 Deliberator         │
                 │ Edge Execution   │         │ 5 Parallel ThoughtHeads      │
                 │ (Artisan / Qwen) │         │ Scale-Invariant Arbitration  │
                 └──────────────────┘         └──┬───────────────────────────┘
                                                 │
                                      ┌──────────▼───────────────────────────┐
                                      │ Selected Hypothesis & Verified Plan  │
                                      └──────────────────┬───────────────────┘
                                                         │
                                      ┌──────────────────▼───────────────────┐
                                      │ Two-Stage LFM Sentinel & Rollbacks   │
                                      └──────────────────────────────────────┘
```

- **System 1 (Reflexive / Fast)**: High-speed edge routing (`system2/local` or `system2/auto`). Runs on quantized weights with internal `<think>` loops disabled (Regime 2 Protocol) for sub-second execution with 0% quantization failure.
- **System 2 (Deliberative / Deep)**: Multi-hypothesis deliberation (`system2/deliberative`). Operates 5 parallel dense ThoughtHeads evaluating candidate paths simultaneously, applying **Scale-Invariant Logit Arbitration** to prevent variance disparities from drowning specialized perspectives.
- **Two-Stage Sentinel Guard**: Intercepts tool calls before execution and verifies AST integrity and file boundaries post-execution. If invariants are breached, triggers automatic sub-85ms transactional git rollback.

---

## 2. Interactive Controls & Keybindings

| Key / Command | Action | Description |
| :--- | :--- | :--- |
| **`Ctrl+P`** | **Cycle Models** | Cycles between active models (`deliberative`, `auto`, `local`, LM Studio models). |
| **`/model <name>`** | **Select Model** | Opens the interactive model picker or switches directly (e.g. `/model deliberative`). |
| **`Shift+Tab`** | **Thinking Level** | Cycles thinking depth: `off` $\to$ `minimal` $\to$ `low` $\to$ `medium` $\to$ `high` $\to$ `max`. |
| **`Ctrl+O`** | **Expand Output** | Toggles expansion of truncated tool results or full startup telemetry. |
| **`Escape`** | **Interrupt Turn** | Immediately halts ongoing model inference or tool execution. |
| **`Ctrl+C`** | **Clear / Exit** | Clears the prompt input; pressing `Ctrl+C` twice exits the harness. |
| **`Ctrl+D`** | **Exit Session** | Exits when the prompt buffer is empty. |
| **`/`** | **Slash Menu** | Opens the command menu (`/help`, `/model`, `/compact`, `/tree`, `/export`). |
| **`! <cmd>`** | **Run Bash** | Executes a shell command directly in the session (e.g. `! git status`). |
| **`!! <cmd>`** | **Silent Bash** | Executes shell command without injecting output into LLM context. |

---

## 3. Cognitive Model Roster

System 2 maps physical models to cognitive specializations:

| Persona | Physical Model | Role & Cognitive Specialization |
| :--- | :--- | :--- |
| **Artisan** | `qwen3.5-9b` | Primary System 1 code generation, tool calling, and refactoring. |
| **Sweetspot** | `qwen-3.8-27b@iq3_xxs` | Heavy polyglot coding, architectural design, and deep trace analysis. |
| **Heretic** | `deepseek-v4-pro-qwen3.5-9b` | Adversarial edge-case discovery, stress-testing, and unconstrained analysis. |
| **Gatekeeper** | `gemma-4-e2b-it-qat` | Fast AST verification, structural correctness, and regression triage. |
| **Sentinel** | `lfm2.5-1.2b-instruct` | Two-stage fail-closed policy enforcement and boundary validation. |
| **Nightwatch** | `lfm3-2b-omni-abliter8` | Uncensored invariant auditing, raw diff analysis, and security sanity. |
| **Ocular** | `qwen3-vl-4b-instruct` | Vision-language diagram analysis, UI layout verification, and charts. |

---

## 4. Mondrian Telemetry Badges

The footer provides real-time cognitive insights using the official Mondrian palette:

- **Cobalt Blue (`#3D8BAA`)**: System 2 Deliberative Engine active (`[Sys2: Deliberative]` or `[Sys2: code] → Sweetspot`).
- **Cadmium Red (`#EF4223`)**: System 1 Fast Reflexive track active (`[Sys1: fast] → Artisan`).
- **Cadmium Yellow (`#FFB703`)**: Two-Stage Sentinel Guard engaged (`[Sentinel]`) or active dynamic tool execution (`⚡ [bash: git status]`).

---

## 5. Transactional Rollback Engine

System 2 maintains an automatic snapshot tree across destructive tool calls (`write`, `edit`, `bash`):
- Before mutating repository files, a lightweight git stash index snapshot is captured (<85ms).
- If a syntax error, test regression, or policy violation is detected post-execution, the engine performs an atomic rollback to the exact prior clean tree state.

---

## 6. Local Concurrency & Software Factory Triads

With LM Studio configured for **4-slot concurrency (`n_parallel=4`)**, System 2 executes the **Software Factory Adversarial Triad** concurrently:
1. **Builder**: `Artisan (qwen3.5-9b)` authors code in an isolated worktree.
2. **Verifier**: Deterministic test runner (`vitest` / `pytest`) validates functional assertions.
3. **Concurrent 3-Agent Review**:
   - `Gatekeeper` (AST correctness & regressions)
   - `Heretic` (Edge cases & invariant boundaries)
   - `Sentinel` (Security & policy invariants)
   All three reviewers evaluate simultaneously across LM Studio's 4 parallel slots.

---

## 7. Native Update Engine

Update System 2 at any time directly from the CLI:
```bash
system2 update            # Fast-forward pulls latest code and rebuilds bundle
system2 update --force    # Forces clean rebase and rebuild from origin
```
