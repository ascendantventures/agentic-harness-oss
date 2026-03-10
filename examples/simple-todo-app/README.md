# Example: Simple Todo App with Auth

This is a real end-to-end pipeline run using agentic-harness. The issue was created, labeled `station:intake`, and the factory ran all 5 stations autonomously — no human intervention after the initial issue.

**Total pipeline time:** ~55 minutes  
**Live URL:** https://build-work-1.vercel.app (example)  
**Result:** ✅ QA passed after 1 bugfix loop

---

## The Issue

```
Title: Build a simple todo app with auth
Labels: station:intake, spec_approved

Description:
Build a single-user todo application with email/password authentication.
Stack: Next.js + Supabase + Vercel.

Users should be able to:
- Sign up and log in
- Create, edit, delete todos
- Mark todos complete/incomplete
- Filter by All / Active / Completed
```

---

## Station 1: SPEC (~5 min)

The SPEC agent read the issue, then posted a full technical specification as a GitHub comment.

See: [spec-comment.md](spec-comment.md)

**Output:** Full spec with DB schema, API routes, component tree, REQ/AC acceptance criteria, and Playwright E2E tests.

**Label flip:** `station:intake` → `station:spec`

---

## Station 2: DESIGN (~38 min)

The DESIGN agent read the SPEC and produced a pixel-perfect UI specification.

See: [design-comment.md](design-comment.md) (abbreviated)

**Output:** Color system, typography, component specs with exact hex values and pixel measurements, page-by-page layouts, micro-interaction specs, Tailwind config extension.

**Label flip:** `station:spec` → `station:design`

---

## Station 3: BUILD (~21 min)

The BUILD agent:
1. Cloned the Next.js + Supabase + Vercel template
2. Ran the customize script with project manifest
3. Read the DESIGN.md and implemented the full UI
4. Applied the DB migration to Supabase
5. Set all env vars in Vercel
6. Deployed with `vercel --prod --yes`
7. Ran the health check (`/api/health → 200`)

**Build comment:**
```
✅ BUILD COMPLETE
Live URL: https://build-work-1.vercel.app
Build repo: github.com/owner/simple-todo-app-build-1

What was built:
- Email/password auth (signup/login/logout)
- Todos table with RLS (per-user isolation)
- Full CRUD: create, inline edit, delete, toggle complete
- FilterBar: All / Active / Completed tabs
- Framer Motion animations (21 usages)
- Inter font, #6366F1 primary color system
```

**Label flip:** `station:design` → `station:build`

---

## Station 4: QA (first run — FAIL)

The QA agent hit the live URL and ran smoke tests.

See: [qa-report.md](qa-report.md)

**Critical bug found:** `Database error saving new user` on signup. Root cause: a stale trigger from a previous project was colliding with the shared Supabase instance.

**Label flip:** `station:build` → `station:bugfix` (+ filed issue #2 with bug report)

---

## Station 5: BUGFIX (~15 min)

The BUGFIX agent read the QA report, found the stale trigger, dropped it, updated the migration, and redeployed.

```
✅ BUGFIX COMPLETE
Fixed: Dropped stale on_auth_user_created_old trigger
Redeployed: commit d7ca6d6
Smoke tests: /api/health ✅, signUp() returns access_token ✅
```

**Label flip:** `station:bugfix` → `station:build`

---

## Station 4: QA (re-run — PASS)

All 22 checks passed.

```
✅ QA PASS
- Auth: signup, login, logout, route protection
- Todo CRUD: create, inline edit, delete, toggle
- Filtering: All / Active / Completed
- RLS: per-user isolation verified
- No emoji in JSX (0 found)
- No hardcoded hex in className (0 found)
- Framer Motion: 21 usages ✅
```

**Label flip:** `station:build` → `station:done`

---

## Key Lesson

The QA → BUGFIX loop caught a real production bug (shared Supabase trigger collision) that would have gone undetected without automated testing. The factory ran the full loop — file bug, fix, redeploy, retest — with zero human involvement.
