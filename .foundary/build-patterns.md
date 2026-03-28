# Build Patterns — [Project Name]

This file records lessons learned from Foundary pipeline runs on this project.
Agents MUST read this file before starting Station 02 (implement) work.

## Patterns

<!-- Add patterns as you discover them. Format:
### PATTERN N: [Title]
**Problem:** What went wrong
**Fix:** What to do instead
**Applies to:** Which station/files
-->

### PATTERN 1: Use FOUNDARY_SKIP_* for infra-only tasks
**Problem:** Pipeline blocks on tool artifacts for commits that don't touch UI/framework code
**Fix:** Set FOUNDARY_SKIP_IMPECCABLE=1 and FOUNDARY_SKIP_CONTEXT7=1 for config/infra changes
**Applies to:** Station 02

## Anti-patterns to avoid

<!-- Document things that have caused blocks or rework -->

## Known skip patterns

List task types that routinely use override flags:
- Config updates: FOUNDARY_SKIP_SUPERPOWERS=1
- CI changes: FOUNDARY_SKIP_IMPECCABLE=1 FOUNDARY_SKIP_CONTEXT7=1
