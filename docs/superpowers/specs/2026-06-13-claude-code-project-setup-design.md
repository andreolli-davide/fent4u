# Claude Code Project Setup — Design

**Date:** 2026-06-13  
**Status:** Approved

## What We're Building

Project-level Claude Code configuration for the fent4u Deliveroo.js BDI agent project. Two files:

1. `CLAUDE.md` — project brief, DESIGN.md-is-law rule, TypeScript conventions, git workflow, Claude Code workflow
2. `.claude/settings.json` — enables superpowers, caveman, context7 plugins at project level (coworker inherits automatically)

## Approach Chosen

**Minimal anchor (Option A).** CLAUDE.md points to DESIGN.md as authoritative source rather than duplicating content. No section summaries — Claude reads DESIGN.md directly when architecture context is needed.

Reason: DESIGN.md is 1691 lines of versioned spec. Duplicating summaries creates drift risk. Low-maintenance anchor is better for a 2-person team.

## Key Rules Encoded

- DESIGN.md is law: code/design conflict → fix code
- TypeScript strict, no `any`, ESM modules
- Conventional Commits required; PRs for features/refactors
- `/brainstorming` before new features, `/writing-plans` before implementation
- Caveman mode active project-wide via startup hook

## Files Created

- `CLAUDE.md`
- `.claude/settings.json`
