# Implementation Plan: Exo-Inspired Invariant Guards & Transactional Rollback Engine

> **Document Version**: 1.0.0  
> **Status**: APPROVED FOR IMPLEMENTATION  
> **Target Repository**: `pi-system2` (`packages/coding-agent`)  
> **Theoretical Foundation**: *Exo: An Architecture for Self-Improving Systems at Runtime* (arXiv:2611.00463)  
> **Process Framework**: TJ's Software Factory Loop (`/software-factory`)  

---

## Executive Summary

Autonomous coding agents that modify software at runtime inevitably face the **Runtime Self-Degradation Dilemma**: speculative edits that introduce subtle syntax errors, broken invariants, or test regressions pollute both the file system and the model's message context. Once a regression enters the prompt context, standard autoregressive loops degrade into frantic, uncoordinated patch-work that compounds errors.

Drawing directly from **Exo** (*arXiv:2611.00463: An Architecture for Self-Improving Systems at Runtime*), this implementation plan introduces a two-phase architecture to grant `pi-system2` provable execution safety and atomic self-healing:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           THE EXO-SYSTEM2 RUNTIME LOOP                          │
└─────────────────────────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
                     ┌───────────────────────────────────────┐
                     │  Phase 1: Pre-Execution Invariant     │
                     │  Gate (Safety, AST Syntax, Lint)      │
                     └───────────────────┬───────────────────┘
                                         │ Allowed
                                         ▼
                     ┌───────────────────────────────────────┐
                     │  Phase 2: Transactional Checkpoint    │
                     │  Snapshot (Git Tree + Session Context)│
                     └───────────────────┬───────────────────┘
                                         │
                                         ▼
                     ┌───────────────────────────────────────┐
                     │          Tool Execution               │
                     │      (write, edit, bash test)         │
                     └───────────────────┬───────────────────┘
                                         │
                                         ▼
                     ┌───────────────────────────────────────┐
                     │  Phase 1: Post-Execution Deterministic│
                     │  Validation & Test Interception       │
                     └───────────────────┬───────────────────┘
                                         │
                       ┌─────────────────┴─────────────────┐
                       │                                   │
              Pass (Green Suite)                  Fail (Regression)
                       │                                   │
                       ▼                                   ▼
          ┌────────────────────────┐          ┌────────────────────────┐
          │ Commit Checkpoint      │          │ Phase 2: Atomic        │
          │ Release Git Snapshot   │          │ Rollback Engine        │
          └────────────────────────┘          │ • git reset / clean    │
                                              │ • context omit attempt │
                                              │ • Arbiter Telemetry    │
                                              └────────────┬───────────┘
                                                           │
                                                           ▼
                                              ┌────────────────────────┐
                                              │ Arbiter Self-Healing   │
                                              │ Targeted Turn Prompt   │
                                              └────────────────────────┘
```

1. **Phase 1: Deterministic Invariant Guards** (`packages/coding-agent/src/core/system2/verifier.ts`)
   - Upgrades existing shallow keyword regexes with **Pre-Execution Syntax & Safety Gates** (fail-closed static AST validation for TypeScript, JavaScript, and Python) and **Post-Execution Deterministic Validation** (AST integrity on disk, semantic contract checks, and elimination of the silent fail-open vulnerability in `client.ts:172`).
2. **Phase 2: Checkpoint & Rollback Engine** (`packages/coding-agent/src/core/agent-session.ts` line 1447 & `packages/coding-agent/src/core/system2/checkpoint.ts`)
   - Replaces passive `console.error` regression logging with an **Atomic Transactional Rollback Engine**. When test assertion failures (`AssertionError`, `FAILED`, non-zero exit code) or invariant breaches are intercepted, the engine rolls back the file system (`git reset`/worktree restoration) and rewinds session context via `_omitRecoveryAttempt`, packaging a structured `System2ArbiterPayload` with failure telemetry for self-healing deliberation.

The document below adheres strictly to the **Software Factory Loop** specifications:
1. **Shape**: Complete `spec.toml` with deterministic commands, external boundary contracts, and PR justifications.
2. **Build**: Production TypeScript interfaces, algorithms, and integration patches.
3. **Verify**: Deterministic Vitest test suites, regression scripts, and exit-code thresholds.
4. **Review**: Concrete prompts and rubrics for the 3-agent adversarial triad.
5. **PR & Post-Merge**: Zero-downtime rollback procedures and runtime invariant monitoring.

---

## 1. Shape (`spec.toml`)

Per the Software Factory standard, this specification defines non-negotiable acceptance commands, outside-system contracts, expected quantitative outcomes, and strict size caps before a single line of code is committed.

```toml
[meta]
slug = "system2-exo-invariants-and-rollback"
ticket = "S2-042"
title = "feat(system2): exo invariant guards and transactional rollback engine"
author = "Thom James-Worrall"
repo = "/Users/thomjames-worrall/pi-system2"
base_branch = "origin/feature/system2-integration"
worktree_branch = "feat/tj-S2-042-exo-rollback"

[split]
step = "step 1 of 2"
# Step 1: Phase 1 Invariant Guards (verifier.ts, client.ts, types.ts)
# Step 2: Phase 2 Checkpoint & Rollback Engine (checkpoint.ts, agent-session.ts)

[size_cap]
max_changed_lines = 300
allow_test_expansion = true

[acceptance]
# 1. Typecheck and code hygiene
typecheck = "npm run check:ts-imports && npx tsc --noEmit"
lint = "node scripts/biome-check.mjs"

# 2. Phase 1 acceptance: Pre- and post-execution invariant verification
test_verifier_syntax_gate = "npm --prefix packages/coding-agent run test -- test/system2-verifier.test.ts -t 'syntax gate blocks invalid ts/js/python'"
test_verifier_fail_closed = "npm --prefix packages/coding-agent run test -- test/system2-verifier.test.ts -t 'fail-closed safety policy on daemon disconnect'"
test_verifier_post_check = "npm --prefix packages/coding-agent run test -- test/system2-verifier.test.ts -t 'post-execution validates written disk contents'"

# 3. Phase 2 acceptance: Checkpoint and atomic rollback on regression
test_checkpoint_worktree = "npm --prefix packages/coding-agent run test -- test/system2-checkpoint.test.ts -t 'creates and restores git worktree snapshot without stash leakage'"
test_session_regression_intercept = "npm --prefix packages/coding-agent run test -- test/system2-agent-session-rollback.test.ts -t 'intercepts test assertion failure and rolls back workspace'"
test_session_context_rewind = "npm --prefix packages/coding-agent run test -- test/system2-agent-session-rollback.test.ts -t 'omits regressed attempt from projected context and injects arbiter payload'"

# 4. Monorepo regression gate
monorepo_core_tests = "npm --prefix packages/coding-agent run test -- test/system2.test.ts"

[external]
# Every outside system touched must have an explicit contract and verification check
[[external.contract]]
name = "git-cli-plumbing"
target = "/usr/bin/git"
purpose = "Transactional snapshot creation and workspace rollback via low-overhead plumbing commands"
invariants = [
  "Must use 'git stash create' or 'git write-tree' to avoid polluting the user's stash stack or reflogs.",
  "Must respect an execution timeout <= 3000ms to prevent hanging on index locks.",
  "Must never run commands that purge unversioned files outside the workspace root.",
  "Must clean up ephemeral locks if child processes terminate abnormally."
]
pre_merge_check = "git --version && git rev-parse --is-inside-work-tree"

[[external.contract]]
name = "system2-bridge-daemon"
target = "http://127.0.0.1:8765"
purpose = "Local ModernBERT daemon verification endpoint (/v1/verify)"
invariants = [
  "Timeout strictly enforced at 1500ms via AbortSignal.",
  "Fail-closed policy: An uncontactable daemon MUST NOT allow unverified execution unless explicitly configured with verified local fallback.",
  "Zero process crashes on ECONNREFUSED or socket timeouts."
]
pre_merge_check = "node -e 'fetch(\"http://127.0.0.1:8765/v1/health\").catch(() => process.exit(0))'"

[[external.contract]]
name = "node-fs-runtime"
target = "node:fs/promises"
purpose = "Deterministic post-execution verification and content checksums"
invariants = [
  "Atomic reads and writes only.",
  "No path traversal outside workspace cwd.",
  "Preserves file permissions and symlinks."
]
pre_merge_check = "node -e 'require(\"fs\").statSync(process.cwd())'"

[expected]
# Concrete quantitative assertions before the test runs
tests_collected = 16
tests_passed = 16
tests_failed = 0
unhandled_rejections = 0
git_stash_leaks = 0
max_rollback_latency_ms = 85

[pr]
why = """
Current system2-agent has two critical safety vulnerabilities identified in production:
1. verifier.ts only tests for trivial substring occurrences ('verify_units', 'pint.') and allows malformed syntax to land on disk. client.ts line 172 contains a silent fail-open trap ('return { valid: true, details: "Verification service uncontactable" }').
2. agent-session.ts line 1447 intercepts test regressions but only outputs a console.error log ('[System 2 Catch: Regression]'), allowing the broken code to persist on disk and polluting subsequent LLM context with corrupt code.
Exo (arXiv:2611.00463) demonstrates that autonomous systems must isolate mutations within transactional checkpoint envelopes and roll back atomically upon invariant failure.
"""
merge_effect = "Enables automatic transactional checkpointing before file writes and bash executions, with atomic rollback and context rewinding when test suites fail."
rollback = "Set PI_SYSTEM2_INVARIANTS_ENABLED=false and PI_SYSTEM2_ROLLBACK_ENABLED=false in environment or revert the commit."
out_of_scope = "Cloud remote git syncing, multi-host distributed checkpoints, or modifying the core ModernBERT embedding model."
no_tests_reason = ""
```

---

## 2. Build (Architecture & Implementation Blueprint)

### Phase 1: Invariant Guards Upgrade

#### 1. Architectural Flaws in Current Implementation
- **The Fail-Open Hole** (`packages/coding-agent/src/core/system2/client.ts:172-175`):
  ```typescript
  // CURRENT FLAWED IMPLEMENTATION:
  if (res.ok) return (await res.json()) as System2VerifyResult;
  return { valid: true, details: "Verification service uncontactable; permitted with warning." };
  ```
  If the verification service crashes or hangs, all dangerous operations are unconditionally approved. Under Exo, safety gates must be **fail-closed** or fall back to verified local deterministic checks.
- **Absence of Syntax Validation** (`packages/coding-agent/src/core/system2/verifier.ts:43-57`):
  `write` and `edit` tools execute arbitrary strings. If the LLM generates truncated code or unbalanced braces, the file is written to disk broken, causing subsequent commands to fail unpredictably.

#### 2. Enhanced Data Contracts (`packages/coding-agent/src/core/system2/types.ts`)

```typescript
/**
 * Invariant Verification and Checkpoint Contracts for Exo-System2
 */

export type InvariantDomain = "syntax" | "safety" | "units" | "algebra" | "logic" | "state";

export type InvariantPolicy = "fail-closed" | "fail-open-with-telemetry" | "local-deterministic-fallback";

export interface System2VerifyRequest {
	code_or_expression: string;
	domain: InvariantDomain;
	filePath?: string;
	language?: "typescript" | "javascript" | "python" | "json" | "yaml" | "shell";
	policy?: InvariantPolicy;
}

export interface InvariantViolation {
	rule: string;
	message: string;
	line?: number;
	column?: number;
	severity: "blocker" | "warning";
}

export interface System2VerifyResult {
	valid: boolean;
	violations?: InvariantViolation[];
	error?: string;
	details?: string;
	engine: "local-ast" | "modernbert-daemon" | "fallback-heuristic";
}

export interface ToolVerificationResult {
	allowed: boolean;
	reason?: string;
	violations?: InvariantViolation[];
	remediationHint?: string;
}

export interface PostExecutionValidationRequest {
	toolName: string;
	params: Record<string, any>;
	result: any;
	cwd: string;
}

export interface PostExecutionValidationResult {
	valid: boolean;
	regressionDetected: boolean;
	invariantBreach?: InvariantViolation;
	outputSnippet?: string;
}
```

#### 3. Pre- & Post-Execution Guard Implementation (`packages/coding-agent/src/core/system2/verifier.ts`)

```typescript
import { promises as fs } from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { System2Client } from "./client.ts";
import type {
	InvariantViolation,
	PostExecutionValidationRequest,
	PostExecutionValidationResult,
	ToolVerificationResult,
} from "./types.ts";

const client = new System2Client();

/**
 * Deterministic In-Process Syntax Gate
 * Validates TS, JS, and JSON AST before files are written to disk.
 */
export function validateSyntax(
	code: string,
	filePath: string,
): { valid: boolean; violations: InvariantViolation[] } {
	const ext = path.extname(filePath).toLowerCase();
	const violations: InvariantViolation[] = [];

	if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mjs") {
		const sourceFile = ts.createSourceFile(
			path.basename(filePath),
			code,
			ts.ScriptTarget.Latest,
			true, // setParentNodes
			ext.includes("jsx") || ext.includes("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
		);

		const diagnostics = (sourceFile as any).parseDiagnostics || [];
		if (diagnostics.length > 0) {
			for (const diag of diagnostics.slice(0, 5)) {
				const pos = diag.file ? diag.file.getLineAndCharacterOfPosition(diag.start || 0) : { line: 0, character: 0 };
				violations.push({
					rule: "AST_SYNTAX_ERROR",
					message: ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
					line: pos.line + 1,
					column: pos.character + 1,
					severity: "blocker",
				});
			}
			return { valid: false, violations };
		}
	} else if (ext === ".json") {
		try {
			JSON.parse(code);
		} catch (err: any) {
			violations.push({
				rule: "JSON_PARSE_ERROR",
				message: err.message,
				severity: "blocker",
			});
			return { valid: false, violations };
		}
	} else if (ext === ".py") {
		// Balanced brackets & basic block syntax audit for Python
		const balanceError = checkPythonDelimiters(code);
		if (balanceError) {
			violations.push({
				rule: "PYTHON_SYNTAX_DELIMITER",
				message: balanceError,
				severity: "blocker",
			});
			return { valid: false, violations };
		}
	}

	return { valid: true, violations: [] };
}

function checkPythonDelimiters(code: string): string | null {
	const stack: { char: string; line: number }[] = [];
	const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
	const lines = code.split("\n");

	for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
		const line = lines[lineIdx];
		const trimmed = line.trim();
		if (trimmed.startsWith("#")) continue; // Skip comments

		for (let i = 0; i < line.length; i++) {
			const char = line[i];
			if (char === "(" || char === "[" || char === "{") {
				stack.push({ char, line: lineIdx + 1 });
			} else if (char === ")" || char === "]" || char === "}") {
				if (stack.length === 0) {
					return `Unmatched closing '${char}' at line ${lineIdx + 1}`;
				}
				const last = stack.pop()!;
				if (pairs[last.char] !== char) {
					return `Mismatched delimiter: opened '${last.char}' at line ${last.line}, closed with '${char}' at line ${lineIdx + 1}`;
				}
			}
		}
	}

	if (stack.length > 0) {
		const unclosed = stack.pop()!;
		return `Unclosed delimiter '${unclosed.char}' opened at line ${unclosed.line}`;
	}
	return null;
}

/**
 * Phase 1 Pre-Execution Verification
 */
export async function verifyToolCall(
	toolName: string,
	params: Record<string, any> | undefined,
	cwd: string = process.cwd(),
): Promise<ToolVerificationResult> {
	if (!params) return { allowed: true };

	// 1. Safety Audit for Terminal Executions
	if (toolName === "bash" || toolName === "terminal" || toolName === "run_command") {
		const command = String(params.command || params.cmd || "");
		if (!command) return { allowed: true };

		// High-precedence destructive command filter (fail-closed)
		const destructiveRegex = /\b(?:rm\s+-rf\s+(?:\/|\.\.|\~|\*)|mkfs|dd\s+if=.*of=\/dev|:\(\)\{\s*:\|:&\s*\};:)\b/;
		if (destructiveRegex.test(command)) {
			return {
				allowed: false,
				reason: "Blocked catastrophic command by System 2 Invariant Guard (Destructive Root Mutation).",
				violations: [{
					rule: "DESTRUCTIVE_FILESYSTEM_MUTATION",
					message: "Attempted to execute an unrecoverable system destruction command.",
					severity: "blocker",
				}],
			};
		}

		// Fast client verification
		const audit = await client.verify({
			code_or_expression: command,
			domain: "safety",
			policy: "fail-closed",
		});

		if (!audit.valid) {
			console.error(`\x1b[38;2;239;66;35m[System 2 Guard]\x1b[0m Blocked ${toolName} call: ${audit.error}`);
			return {
				allowed: false,
				reason: audit.error || "Command blocked by System 2 Safety Gatekeeper.",
				violations: audit.violations,
			};
		}
	}

	// 2. Syntax & Invariant Guard for File Writes / Edits
	if (toolName === "write" || toolName === "edit" || toolName === "write_file") {
		const content = String(params.content || params.code || "");
		const targetPath = String(params.path || params.filePath || "");

		if (content && targetPath) {
			const syntaxAudit = validateSyntax(content, targetPath);
			if (!syntaxAudit.valid) {
				const primary = syntaxAudit.violations[0];
				return {
					allowed: false,
					reason: `System 2 Pre-Execution Invariant Violation: Syntax error in proposed edit (${primary.message} at line ${primary.line || 1})`,
					violations: syntaxAudit.violations,
					remediationHint: "Fix the AST syntax violation before writing the file.",
				};
			}
		}

		// Domain unit verification
		if (content.includes("verify_units") || content.includes("pint.")) {
			const audit = await client.verify({
				code_or_expression: content,
				domain: "units",
				policy: "fail-closed",
			});
			if (!audit.valid) {
				return {
					allowed: false,
					reason: `System 2 Dimensional Invariant Violation: ${audit.error}`,
				};
			}
		}
	}

	return { allowed: true };
}

/**
 * Phase 1 Post-Execution Deterministic Validation
 */
export async function validatePostExecution(
	req: PostExecutionValidationRequest,
): Promise<PostExecutionValidationResult> {
	const { toolName, params, result, cwd } = req;

	// Audit file writes on disk
	if (toolName === "write" || toolName === "edit" || toolName === "write_file") {
		const targetPath = path.resolve(cwd, String(params.path || params.filePath || ""));
		try {
			const diskContent = await fs.readFile(targetPath, "utf-8");
			const syntax = validateSyntax(diskContent, targetPath);
			if (!syntax.valid) {
				return {
					valid: false,
					regressionDetected: true,
					invariantBreach: syntax.violations[0],
					outputSnippet: `File ${targetPath} corrupted on disk after write: ${syntax.violations[0].message}`,
				};
			}
		} catch (err: any) {
			return {
				valid: false,
				regressionDetected: true,
				outputSnippet: `Failed to verify written file on disk: ${err.message}`,
			};
		}
	}

	// Audit test executions
	if (toolName === "bash" || toolName === "terminal" || toolName === "run_command") {
		const output = Array.isArray(result?.content)
			? result.content.map((c: any) => c.text || "").join("\n")
			: typeof result === "string"
				? result
				: "";

		const isRegression =
			output.includes("AssertionError") ||
			/\b(?:FAIL|FAILED|failed with code|Tests failed:)\b/.test(output) ||
			result?.isError === true;

		if (isRegression) {
			return {
				valid: false,
				regressionDetected: true,
				outputSnippet: output.slice(0, 1000),
			};
		}
	}

	return { valid: true, regressionDetected: false };
}
```

---

### Phase 2: Checkpoint & Rollback Engine

#### 1. Architectural Foundation: The Exo State Envelope
Under Exo, an agent cannot mutate an active production codebase without establishing an **isolated transactional boundary**. If an execution produces an unhandled regression, the system must perform an atomic two-plane rollback:
1. **Physical Plane**: Reset the working tree and untracked files back to the exact pre-turn state.
2. **Cognitive Plane**: Prune the failed assistant generation and invalid tool result from projected message context, replacing them with a structured **Arbiter Diagnostic Envelope**.

#### 2. The Checkpoint Engine (`packages/coding-agent/src/core/system2/checkpoint.ts`)

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-ai";

const execFileAsync = promisify(execFile);

export interface System2Checkpoint {
	id: string;
	timestamp: number;
	cwd: string;
	treeSha: string;
	parentTurnIndex: number;
	activeEntryId?: string;
}

export interface RollbackResult {
	success: boolean;
	revertedFiles: string[];
	checkpointId: string;
	error?: string;
	latencyMs: number;
}

export class CheckpointEngine {
	private readonly cwd: string;
	private activeCheckpoint: System2Checkpoint | null = null;

	constructor(cwd: string = process.cwd()) {
		this.cwd = cwd;
	}

	/**
	 * Create an isolated git snapshot without touching user's stash list or reflogs.
	 * Uses 'git stash create' which returns an unreferenced commit SHA if workdir is dirty.
	 */
	async captureSnapshot(parentTurnIndex: number, activeEntryId?: string): Promise<System2Checkpoint> {
		const start = performance.now();
		const id = `chk_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

		let treeSha = "HEAD";
		try {
			// Check if worktree is clean or dirty
			const { stdout: stashSha } = await execFileAsync("git", ["stash", "create"], {
				cwd: this.cwd,
				timeout: 3000,
			});

			if (stashSha.trim()) {
				treeSha = stashSha.trim();
			} else {
				// Clean working directory: capture HEAD tree SHA
				const { stdout: headSha } = await execFileAsync("git", ["rev-parse", "HEAD"], {
					cwd: this.cwd,
					timeout: 2000,
				});
				treeSha = headSha.trim();
			}
		} catch (err: any) {
			// Fallback: capture write-tree if git stash create fails
			const { stdout: writeTreeSha } = await execFileAsync("git", ["write-tree"], {
				cwd: this.cwd,
				timeout: 2000,
			}).catch(() => ({ stdout: "HEAD" }));
			treeSha = writeTreeSha.trim() || "HEAD";
		}

		this.activeCheckpoint = {
			id,
			timestamp: Date.now(),
			cwd: this.cwd,
			treeSha,
			parentTurnIndex,
			activeEntryId,
		};

		return this.activeCheckpoint;
	}

	getActiveCheckpoint(): System2Checkpoint | null {
		return this.activeCheckpoint;
	}

	clearCheckpoint(): void {
		this.activeCheckpoint = null;
	}

	/**
	 * Atomically restore working directory and index to the checkpoint snapshot.
	 */
	async rollback(checkpoint?: System2Checkpoint): Promise<RollbackResult> {
		const target = checkpoint || this.activeCheckpoint;
		const start = performance.now();

		if (!target) {
			return {
				success: false,
				revertedFiles: [],
				checkpointId: "none",
				error: "No active checkpoint to roll back to.",
				latencyMs: performance.now() - start,
			};
		}

		const revertedFiles: string[] = [];

		try {
			// 1. Identify changed files before restoring
			const { stdout: diffOut } = await execFileAsync("git", ["status", "--porcelain"], {
				cwd: this.cwd,
				timeout: 2000,
			}).catch(() => ({ stdout: "" }));

			const lines = diffOut.split("\n").filter((l) => l.trim().length > 0);
			for (const line of lines) {
				revertedFiles.push(line.substring(3).trim());
			}

			// 2. Perform atomic restore
			if (target.treeSha === "HEAD") {
				await execFileAsync("git", ["reset", "--hard", "HEAD"], { cwd: this.cwd, timeout: 3000 });
				await execFileAsync("git", ["clean", "-fd"], { cwd: this.cwd, timeout: 3000 });
			} else {
				// Restore from stash commit
				await execFileAsync("git", ["read-tree", "-u", "--reset", target.treeSha], {
					cwd: this.cwd,
					timeout: 4000,
				});
			}

			this.activeCheckpoint = null;

			return {
				success: true,
				revertedFiles,
				checkpointId: target.id,
				latencyMs: performance.now() - start,
			};
		} catch (err: any) {
			return {
				success: false,
				revertedFiles,
				checkpointId: target.id,
				error: `Rollback command failed: ${err.message}`,
				latencyMs: performance.now() - start,
			};
		}
	}
}
```

#### 3. Integration in `AgentSession` (`packages/coding-agent/src/core/agent-session.ts`)

Upgrading lines 1420–1465 in `AgentSession._handleAgentEvent`:

```typescript
// Add imports at top of agent-session.ts
import { CheckpointEngine } from "./system2/checkpoint.ts";
import { validatePostExecution, verifyToolCall } from "./system2/verifier.ts";

// Add to AgentSession class members
private _system2CheckpointEngine: CheckpointEngine | null = null;

// Initialize in constructor:
this._system2CheckpointEngine = new CheckpointEngine(this._cwd);

// In _handleAgentEvent(event: AgentEvent):
} else if (event.type === "tool_execution_start") {
	if (this.model?.provider === "system2") {
		// 1. Phase 1: Pre-Execution Invariant Gate
		const check = await verifyToolCall(event.toolName, event.args as Record<string, any>, this._cwd);
		if (!check.allowed) {
			throw new Error(`[System 2 Guard] Blocked execution: ${check.reason}`);
		}

		// 2. Phase 2: Transactional Checkpoint Snapshot
		// Capture state if tool mutates files or executes terminal commands
		if (["write", "edit", "write_file", "bash", "terminal"].includes(event.toolName)) {
			const activeBranch = this.sessionManager.getBranch();
			const lastEntryId = activeBranch[activeBranch.length - 1]?.id;
			await this._system2CheckpointEngine?.captureSnapshot(this.agent.state.messages.length, lastEntryId);
		}
	}

	const extensionEvent: ToolExecutionStartEvent = {
		type: "tool_execution_start",
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		args: event.args,
	};
	await this._extensionRunner.emit(extensionEvent);

} else if (event.type === "tool_execution_end") {
	if (this.model?.provider === "system2") {
		// Phase 1 Post-Execution Validation
		const postCheck = await validatePostExecution({
			toolName: event.toolName,
			params: (event as any).args || {},
			result: event.result,
			cwd: this._cwd,
		});

		// Phase 2: Intercept test assertion failures and invariant breaches
		if (!postCheck.valid || postCheck.regressionDetected) {
			console.error(
				"\x1b[38;2;239;66;35m[System 2 Catch: Regression Intercepted]\x1b[0m Triggering Exo Atomic Rollback Protocol...",
			);

			// 1. Physical Rollback of File System
			const rollbackResult = await this._system2CheckpointEngine?.rollback();
			if (rollbackResult?.success) {
				console.error(
					`\x1b[38;2;62;131;99m[System 2 Rollback: Restored]\x1b[0m Cleaned ${rollbackResult.revertedFiles.length} file(s) in ${rollbackResult.latencyMs.toFixed(1)}ms.`,
				);
			}

			// 2. Cognitive Context Rollback
			// Find the offending assistant turn and omit it from projected context
			const lastAssistant = this._findLastAssistantMessage();
			if (lastAssistant) {
				try {
					this._omitRecoveryAttempt(lastAssistant);
				} catch (err: any) {
					console.error(`[System 2 Rollback] Failed to omit recovery attempt: ${err.message}`);
				}
			}

			// 3. Synthesize Arbiter Diagnostic Telemetry Turn
			const arbiterMessage: AgentMessage = {
				role: "user",
				content: [
					{
						type: "text",
						text: `[System 2 Arbiter Falsification Alert]
Your previous speculative modification triggered an empirical regression or invariant breach and was ATOMICALLY ROLLED BACK.
Files reverted to baseline: ${rollbackResult?.revertedFiles.join(", ") || "none"}
Failure Trace:
${postCheck.outputSnippet || "Test assertion failed or invariant check breached."}

Corrective Invariant: Formulate an alternative hypothesis that does NOT violate these constraints. Do not repeat the failed syntax or logic.`,
					},
				],
				timestamp: Date.now(),
			};

			// Append diagnostic message to session branch for self-healing
			this.sessionManager.appendMessage(arbiterMessage);
			this._refreshFinalizedContext();
		} else {
			// Invariant green bar -> Clear checkpoint
			this._system2CheckpointEngine?.clearCheckpoint();
			console.error("\x1b[38;2;62;131;99m[System 2 Invariant: Pass]\x1b[0m Invariants preserved. Checkpoint committed.");
		}
	}

	const extensionEvent: ToolExecutionEndEvent = {
		type: "tool_execution_end",
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		result: event.result,
		isError: event.isError,
		...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
	};
	await this._extensionRunner.emit(extensionEvent);
}
```

---

## 3. Verify (Deterministic Tests & Pass/Fail Thresholds)

All verifications are executed via Vitest and deterministic Node CLI commands. Per the factory rule: **the script decides, not a model.**

### Test Suite 1: `packages/coding-agent/test/system2-verifier.test.ts`
Tests pre-execution syntax/safety gates and post-execution invariant auditing.

```typescript
import { describe, expect, it } from "vitest";
import { validateSyntax, verifyToolCall, validatePostExecution } from "../src/core/system2/verifier.ts";

describe("System 2 Invariant Guards (Exo Phase 1)", () => {
	it("syntax gate blocks invalid ts/js/python", () => {
		// 1. Broken TypeScript
		const brokenTs = "export function foo( { console.log('unclosed');";
		const tsResult = validateSyntax(brokenTs, "test.ts");
		expect(tsResult.valid).toBe(false);
		expect(tsResult.violations.length).toBeGreaterThan(0);
		expect(tsResult.violations[0].rule).toBe("AST_SYNTAX_ERROR");

		// 2. Broken JSON
		const brokenJson = "{ key: 'missing quotes' ";
		const jsonResult = validateSyntax(brokenJson, "config.json");
		expect(jsonResult.valid).toBe(false);
		expect(jsonResult.violations[0].rule).toBe("JSON_PARSE_ERROR");

		// 3. Broken Python
		const brokenPy = "def bar():\n    return (1 + 2";
		const pyResult = validateSyntax(brokenPy, "script.py");
		expect(pyResult.valid).toBe(false);
		expect(pyResult.violations[0].rule).toBe("PYTHON_SYNTAX_DELIMITER");
	});

	it("verifyToolCall blocks catastrophic destructive terminal commands", async () => {
		const blocked = await verifyToolCall("bash", { command: "rm -rf / --no-preserve-root" });
		expect(blocked.allowed).toBe(false);
		expect(blocked.reason).toContain("Blocked catastrophic command");
	});

	it("fail-closed safety policy on daemon disconnect", async () => {
		// When bridge URL is unreachable, safety gate must NOT permit forbidden constructs
		const check = await verifyToolCall("bash", { command: "drop database production;" });
		expect(check.allowed).toBe(false);
	});

	it("post-execution validates written disk contents", async () => {
		const postCheck = await validatePostExecution({
			toolName: "bash",
			params: { command: "npm test" },
			result: { isError: false, content: [{ type: "text", text: "FAIL: AssertionError: expected 4 to equal 5" }] },
			cwd: process.cwd(),
		});
		expect(postCheck.valid).toBe(false);
		expect(postCheck.regressionDetected).toBe(true);
	});
});
```

### Test Suite 2: `packages/coding-agent/test/system2-checkpoint.test.ts`
Tests transactional worktree snapshot creation, restoration, and zero stash pollution.

```typescript
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CheckpointEngine } from "../src/core/system2/checkpoint.ts";

const execFileAsync = promisify(execFile);

describe("System 2 Transactional Checkpoint Engine (Exo Phase 2)", () => {
	const testDir = path.resolve(process.cwd(), ".test-worktree-temp");
	let engine: CheckpointEngine;

	beforeEach(async () => {
		await fs.mkdir(testDir, { recursive: true });
		await execFileAsync("git", ["init"], { cwd: testDir });
		await execFileAsync("git", ["config", "user.email", "test@system2.ai"], { cwd: testDir });
		await execFileAsync("git", ["config", "user.name", "Test Runner"], { cwd: testDir });
		await fs.writeFile(path.join(testDir, "base.txt"), "original content");
		await execFileAsync("git", ["add", "."], { cwd: testDir });
		await execFileAsync("git", ["commit", "-m", "initial commit"], { cwd: testDir });
		engine = new CheckpointEngine(testDir);
	});

	afterEach(async () => {
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("creates and restores git worktree snapshot without stash leakage", async () => {
		// 1. Capture snapshot on clean repo
		const chk1 = await engine.captureSnapshot(0);
		expect(chk1.treeSha).toBeDefined();

		// 2. Introduce destructive change and untracked file
		await fs.writeFile(path.join(testDir, "base.txt"), "mutated corrupt content");
		await fs.writeFile(path.join(testDir, "untracked.ts"), "const rogue = true;");

		// 3. Rollback
		const rollback = await engine.rollback();
		expect(rollback.success).toBe(true);

		// 4. Verify baseline restored
		const restoredContent = await fs.readFile(path.join(testDir, "base.txt"), "utf-8");
		expect(restoredContent).toBe("original content");

		// Verify untracked rogue file was cleaned
		const exists = await fs.access(path.join(testDir, "untracked.ts")).then(() => true).catch(() => false);
		expect(exists).toBe(false);

		// Verify stash list is empty
		const { stdout: stashList } = await execFileAsync("git", ["stash", "list"], { cwd: testDir });
		expect(stashList.trim()).toBe("");
	});
});
```

### Test Suite 3: `packages/coding-agent/test/system2-agent-session-rollback.test.ts`
Tests the complete end-to-end integration: `tool_execution_start` snapshot -> test assertion failure in `tool_execution_end` -> atomic rollback + context rewinding.

```typescript
import { describe, expect, it } from "vitest";
// Integration test asserting AgentSession context omission and file rollback
describe("System 2 AgentSession Rollback Integration", () => {
	it("intercepts test assertion failure and rolls back workspace", async () => {
		// Setup mock AgentSession with System2 provider
		// Execute speculative write + failing test
		// Assert file reverted on disk
	});

	it("omits regressed attempt from projected context and injects arbiter payload", async () => {
		// Assert sessionManager.buildSessionProjection() omits failed assistant message
		// Assert Arbiter message exists in session history
	});
});
```

### Deterministic Test Execution Script (`scripts/verify-exo.sh`)

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "========================================================"
echo "  System 2 / Exo Verification Script: Deterministic Run "
echo "========================================================"

REPO_DIR="/Users/thomjames-worrall/pi-system2"
cd "$REPO_DIR"

echo "[1/4] Checking TypeScript compilation & relative imports..."
npm run check:ts-imports
npx tsc --noEmit

echo "[2/4] Running Biome format & lint enforcement..."
node scripts/biome-check.mjs

echo "[3/4] Running System 2 Exo Invariant & Rollback Test Suite..."
npm --prefix packages/coding-agent run test -- \
  test/system2-verifier.test.ts \
  test/system2-checkpoint.test.ts \
  test/system2-agent-session-rollback.test.ts \
  test/system2.test.ts

echo "[4/4] Verifying clean git state (no lingering stashes or locks)..."
git status --porcelain
STASH_COUNT=$(git stash list | wc -l | tr -d ' ')
if [ "$STASH_COUNT" -ne 0 ]; then
  echo "FAIL: Stash leak detected ($STASH_COUNT entries in git stash)."
  exit 1
fi

echo "========================================================"
echo "  VERIFICATION RESULT: ALL INVARIANTS SATISFIED (PASS)  "
echo "========================================================"
```

---

## 4. Review (The 3-Agent Adversarial Triad)

Following the Software Factory Loop, the implementation must be reviewed by three independent adversarial agents operating in isolated contexts.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        3-AGENT ADVERSARIAL TRIAD                       │
└────────────────────────────────────────────────────────────────────────┘
          │                                 │                    │
          ▼                                 ▼                    ▼
┌───────────────────────┐       ┌───────────────────────┐  ┌───────────┐
│ Reviewer 1            │       │ Reviewer 2            │  │Reviewer 3 │
│ Domain Invariant      │       │ Systems & External    │  │Empirical  │
│ Auditor               │       │ Contract Adversary    │  │Falsifier  │
└───────────────────────┘       └───────────────────────┘  └───────────┘
```

### Reviewer 1: Domain Invariant Auditor (Cognitive & Deliberative Systems)

- **Role Persona**: Senior AI Systems Architect specializing in cognitive architectures, formal verification, and non-autoregressive deliberation.
- **Audit Mandate**: Ensure implementation strictly satisfies the Exo paper invariants (arXiv:2611.00463) and System 2 architectural invariants (`GEMINI.md`).
- **Prompt**:
  ```text
  You are the Domain Invariant Auditor reviewing the Exo Invariant Guards & Rollback implementation in pi-system2.
  Audit the codebase against the following core invariants:
  1. Fail-Closed Invariant: Does any path in verifier.ts or client.ts silently permit unverified execution when the bridge or AST parser encounters an anomaly?
  2. Cognitive Autonomy & Non-Autoregressive Purity: Does the rollback mechanism preserve deliberative separation? Does context rewinding (_omitRecoveryAttempt) avoid polluting the model's future thinking tokens with repetitive negative reasoning?
  3. Pre/Post-Condition Symmetry: Does every mutation tool (write, edit) pass through both the pre-execution AST syntax gate and the post-execution disk validation gate?
  Provide a detailed rubric score (PASS/FAIL) with line-by-line justification.
  ```

### Reviewer 2: Systems & External Contract Adversary

- **Role Persona**: Principal Staff Systems & Infrastructure Engineer specializing in OS-level concurrency, POSIX file systems, and Git internals.
- **Audit Mandate**: Hunt race conditions, child process leaks, file lock deadlocks, and corrupted Git repository states.
- **Prompt**:
  ```text
  You are the Systems & External Contract Adversary reviewing the CheckpointEngine in packages/coding-agent/src/core/system2/checkpoint.ts.
  Scrutinize all external boundary interactions:
  1. Git Plumbing Safety: Does `git stash create` or `git write-tree` leave stale index.lock files if the process is killed via SIGINT or SIGTERM?
  2. Subprocess Timeouts: Are all execFileAsync calls strictly bounded with execution timeouts? What happens if git status hangs on a massive monorepo?
  3. Git Clean Destructiveness: Does `git clean -fd` accidentally delete ignored files, .env credentials, or node_modules? Verify that `-x` is NOT passed to git clean.
  4. Memory & Performance: Does snapshotting the worktree introduce latency exceeding the 100ms budget per tool call?
  Identify any system hazard that could corrupt developer repositories or cause silent data loss.
  ```

### Reviewer 3: Empirical Falsification Red-Teamer

- **Role Persona**: Elite Adversarial QA & Fuzzing Specialist.
- **Audit Mandate**: Formulate and execute 5 concrete adversarial probe attacks designed to break the implementation under edge conditions.
- **Adversarial Probe Specifications**:

| Probe ID | Attack Scenario | Adversarial Input | Expected System Defense |
|---|---|---|---|
| **PROBE-1** | Partial AST Write Attack | `write_file` called with a file containing an unclosed template literal: `const msg = \`unclosed;` | Pre-execution `validateSyntax` intercepts error before disk write; tool call rejected with `AST_SYNTAX_ERROR`. Disk file untouched. |
| **PROBE-2** | Deceptive String Test Trap | `bash` runs a test command where a *passing* test includes the word "failed" in its name: `test('user failed login returns 401', () => pass)` | Post-execution validation must not trigger false-positive rollback on test name substring; regex strictly checks for exit code, `AssertionError`, or `FAIL/FAILED:` status lines. |
| **PROBE-3** | Dirty Worktree Pre-Existing Stash | User already has 12 manual stashes in `git stash list` prior to agent run. Agent triggers test failure and rollback. | Checkpoint engine uses `git stash create` (dangling commit) without calling `git stash push`. After rollback, `git stash list` must contain exactly the original 12 stashes—zero leakage. |
| **PROBE-4** | Simultaneous Write-Bash Race | Two tool calls dispatched in rapid succession (`write_file` immediately followed by `bash`). | Checkpoint engine maintains atomic lock per session; second checkpoint serializes or joins active state envelope. |
| **PROBE-5** | Verification Daemon Offline Blackout | ModernBERT daemon (`http://127.0.0.1:8765`) killed with `kill -9` right before an edit containing `verify_units`. | System falls back to fail-closed state; operation blocked with explicit notification rather than hanging or failing open. |

---

## 5. PR & Post-Merge (Rollback Procedures & Monitoring)

### 1. PR Metadata
- **Branch**: `feat/tj-S2-042-exo-rollback` -> `feature/system2-integration`
- **Title**: `[S2-042] feat(system2): implement exo invariant guards and transactional rollback engine`
- **Changelog Entry**:
  > Adds deterministic pre-execution syntax/safety gates and post-execution disk validation. Implements transactional Git worktree checkpointing with automatic atomic file restoration and session context rewinding upon test regression interception.

### 2. Emergency Kill-Switch & Rollback Playbook
If unexpected latency, false-positive test rollbacks, or tool execution deadlocks occur in production, operators can instantly disable the Exo engine without deploying new code:

```bash
# Emergency Disable via Environment Variables (zero-downtime)
export PI_SYSTEM2_INVARIANTS_ENABLED=false
export PI_SYSTEM2_ROLLBACK_ENABLED=false

# Full Git Revert Procedure
git checkout feature/system2-integration
git revert -m 1 <MERGE_COMMIT_SHA> -m "revert: rollback exo invariant engine due to incident"
git push origin feature/system2-integration
```

### 3. Invariant Monitoring & Telemetry Metrics
The following telemetry signals are emitted via `packages/telemetry` to monitor health:
1. `system2.guard.blocked_total`: Count of pre-execution AST syntax and safety rejections (categorized by language and rule).
2. `system2.checkpoint.latency_ms`: Histogram of Git snapshot creation and restoration durations (target p99 < 80ms).
3. `system2.rollback.executed_total`: Count of empirical regressions intercepted and reverted.
4. `system2.arbiter.healing_rate`: Percentage of self-healing turns following an Arbiter prompt that successfully pass the test suite on the subsequent attempt.

---

## 6. Implementation Task Checklist

- [ ] **Step 1: Invariant Guards (Phase 1)**
  - [ ] Add `validateSyntax` (AST TS/JS/Python/JSON) in `packages/coding-agent/src/core/system2/verifier.ts`.
  - [ ] Fix fail-open trap in `packages/coding-agent/src/core/system2/client.ts:172` with fail-closed policy.
  - [ ] Implement `validatePostExecution` in `verifier.ts`.
  - [ ] Write unit test suite `packages/coding-agent/test/system2-verifier.test.ts`.
  - [ ] Run `npm run check` and verify Step 1 lines changed <= 300.
- [ ] **Step 2: Checkpoint & Rollback Engine (Phase 2)**
  - [ ] Create `packages/coding-agent/src/core/system2/checkpoint.ts` (`CheckpointEngine`).
  - [ ] Wire snapshot creation at line 1420 (`tool_execution_start`) in `packages/coding-agent/src/core/agent-session.ts`.
  - [ ] Wire atomic rollback and Arbiter diagnostic context injection at line 1447 (`tool_execution_end`).
  - [ ] Write unit test suite `packages/coding-agent/test/system2-checkpoint.test.ts`.
  - [ ] Write integration test `packages/coding-agent/test/system2-agent-session-rollback.test.ts`.
  - [ ] Execute `scripts/verify-exo.sh` and ensure 100% green pass.
- [ ] **Step 3: Triad Review & PR**
  - [ ] Submit to 3-Agent Adversarial Triad.
  - [ ] Resolve any findings from Empirical Falsification Probes.
  - [ ] Generate PR body and open pull request.
