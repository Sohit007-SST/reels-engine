#!/bin/sh
# Point git at the versioned hooks in .githooks/ (run by `npm install` via the "prepare" script).
# Safe outside a git checkout (e.g. a tarball) and in CI.
if git rev-parse --git-dir >/dev/null 2>&1; then
  git config core.hooksPath .githooks
  chmod +x .githooks/pre-commit 2>/dev/null || true
  echo "git hooks: core.hooksPath=.githooks (gitleaks pre-commit active)"
fi
exit 0
