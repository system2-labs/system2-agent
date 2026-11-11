---
name: barrage-eval
description: >-
  Run a 10-pass architectural barrage evaluation suite inside a repository.
  Iteratively cycles through executive roles (CTO, Lead Quant, Product Founder, CFO, Security Red Team, Systems Architect)
  to build, optimize, and stress-test a full-stack system against the 4 System 2 pillars:
  Sys1 Reflexive Triage, Sys2 Deliberation, Arbiter Execution, and Invariant Verification.
---

# Barrage Evaluation Protocol

## Overview
The Barrage Evaluation protocol stress-tests an agent across 10 progressive architectural passes.
Each pass executes a specific milestone under an executive role persona, subjects the implementation to a 3-agent Software Factory adversarial review, documents empirical metrics, and advances to the next pass.

## 10-Pass Evaluation Lifecycle

1. **Pass 1 — Data Ingestion & Relational Schema (CTO / Database Architect)**
   - Normalizes unstructured or transposed data into a structured 3NF SQLite database.
   - Verifies primary keys, foreign key constraints, and compound lookup indices.
2. **Pass 2 — Core REST API Engine (Full-Stack Lead)**
   - Builds an ASGI REST API (FastAPI) serving typed endpoints.
   - Asserts parameter sanitization, Pydantic validation, and 404 entity handling.
3. **Pass 3 — Algorithmic Contact Matching (Lead Quant / Data Scientist)**
   - Implements multivariate compatibility scoring (demographic distance, Gaussian age decay, city affinity).
   - Validates that similarity scores are strictly bounded in $[0, 1]$.
4. **Pass 4 — Responsive Web Client (Product Lead)**
   - Generates a lightweight, responsive social UI with Profile, Feed, and Suggestions components.
   - Ensures zero external CDN dependencies for 100% on-device sovereign operation.
5. **Pass 5 — Viral Feed & Ranking Algorithm (Founder / Growth Architect)**
   - Implements an EdgeRank multi-factor feed ranker ($U \times W \times D$).
   - Validates strict descending order of scored posts with time decay.
6. **Pass 6 — Fail-Closed Security & Invariants (Security Engineer / Red Team)**
   - Executes SQL injection probes, parameter boundary checks, and PII protection tests.
   - Asserts zero unparameterized query executions and validates data type boundaries.
7. **Pass 7 — Unit Economics & TCO Monetization (Head of Finance / CFO)**
   - Models 3-year Total Cost of Ownership (Cloud vs. Sovereign Edge).
   - Simulates CPM advertising margins and subscription conversion tiers.
8. **Pass 8 — Async Event Bus Integration (Systems Engineer)**
   - Integrates asynchronous pub/sub messaging with typed events and handler error isolation.
   - Asserts non-blocking background dispatch and priority-based handler execution.
9. **Pass 9 — Full Integration Test Suite (QA Lead)**
   - Runs automated pytest verification across database integrity, API routes, matching, and economics.
   - Requires 100% green bar pass rate.
10. **Pass 10 — System 2 Optimization & Discrepancy Audit (Benchmark Specialist)**
    - Verifies execution across all 4 System 2 cognitive pillars.
    - Audits cross-repository discrepancies and outputs the final benchmark markdown scorecard.

## Execution Command
```bash
python3 ~/test/barrage/run_barrage.py
```
Output report is generated at `~/test/barrage/barrage_report.md`.
