#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "=== System 2 Native Self-Update Engine ==="
echo "Target repository: ${REPO_DIR}"

BRANCH=$(git -C "${REPO_DIR}" branch --show-current || echo "feature/system2-integration")
echo "Current branch: ${BRANCH}"

echo "Fetching remote updates..."
git -C "${REPO_DIR}" fetch origin "${BRANCH}"

echo "Rebasing local branch..."
git -C "${REPO_DIR}" rebase --autostash "origin/${BRANCH}"

echo "Building production bundle..."
npm --prefix "${REPO_DIR}/packages/coding-agent" run build

REVISION=$(git -C "${REPO_DIR}" rev-parse --short HEAD)
echo "System 2 successfully updated to revision ${REVISION}!"
