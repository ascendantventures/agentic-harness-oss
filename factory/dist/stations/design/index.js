/**
 * DesignStation — processes issues at 'station:spec', produces 'station:design'.
 *
 * Ported from makeDesignTask() in factory-loop.js.
 *
 * Gates:
 *  1. Base checks (skip/paused/phase2)
 *  2. Manifest check (skip if invalid, unless internal/change/standalone)
 *  3. spec_approved gate (skip if not approved, unless internal/change/standalone)
 *  4. hasDesignComment (skip if design already posted)
 */
import { BaseStation } from '../base.js';
import { hasDesignComment } from '../../github/issues.js';
import { isSpecApproved } from '../../notify/supabase.js';
import { extractBuildRepo } from '../../github/issues.js';
import { guardAutoAdvance } from '../../pipeline/reconciler.js';
export class DesignStation extends BaseStation {
    id = 'design';
    label = 'station:spec';
    nextLabel = 'station:design';
    model = 'claude-opus-4-5'; // Always Opus for design
    concurrency = 2; // v2 claude CLI allows true concurrency
    ttl = 7200000; // 2 hours
    async shouldProcess(issue, ctx) {
        // 1. Base checks: skip/paused/phase2
        const base = await this.baseCheck(issue, ctx);
        if (base)
            return base;
        // 2. Manifest check
        const manifest = this.manifestCheck(issue, ctx.env);
        if (manifest)
            return manifest;
        // 3. spec_approved gate (same as monolith's shouldProcess(issue, 'build'))
        const standaloneMode = !ctx.env.supabaseUrl;
        if (!issue.isInternal && !issue.isChangeRequest && !standaloneMode) {
            const approved = await isSpecApproved(issue.number, ctx.env.supabaseUrl, ctx.env.supabaseKey, ctx.log);
            if (!approved) {
                return { process: false, reason: `spec not approved by client yet` };
            }
        }
        // 4. Skip if design comment already posted (DESIGN already ran)
        //    Layer 2: Auto-advance the label instead of just skipping
        if (hasDesignComment(issue.number, ctx.env.repo)) {
            const reason = guardAutoAdvance(issue.number, ctx.env.repo, this.label, this.nextLabel, ctx.log, 'DESIGN.md already posted');
            return { process: false, reason };
        }
        return { process: true };
    }
    async buildTask(issue, ctx) {
        const SUPABASE_SERVICE_KEY = ctx.env.supabaseKey;
        const SUPABASE_URL = ctx.env.supabaseUrl;
        // ─── Change Request: prepend build-repo clone instructions ───────────
        let changeRequestPreamble = '';
        if (issue.isChangeRequest) {
            const buildRepo = issue.buildRepo ?? extractBuildRepo(issue.body);
            if (buildRepo) {
                const repoName = buildRepo.split('/')[1];
                const owner = ctx.config.templates?.owner ?? ctx.env.repo.split('/')[0] ?? 'your-org';
                changeRequestPreamble = `
## IMPORTANT: This is a CHANGE REQUEST on an existing live build

Before designing, read the current codebase to understand what already exists:
\`\`\`bash
CLONE_URL=$(curl -s -X POST ${ctx.env.factoryAppUrl}/api/github/clone-token \\
  -H "Content-Type: application/json" \\
  -H "x-factory-secret: $FACTORY_SECRET" \\
  -d '{"owner": "${owner}", "repo": "${repoName}"}' | jq -r .clone_url)
git clone "$CLONE_URL" /tmp/existing-build-${issue.number}
ls -la /tmp/existing-build-${issue.number}/
cat /tmp/existing-build-${issue.number}/tailwind.config.ts 2>/dev/null || cat /tmp/existing-build-${issue.number}/tailwind.config.js 2>/dev/null
cat /tmp/existing-build-${issue.number}/app/globals.css 2>/dev/null | head -80
\`\`\`

Your DESIGN.md should focus ONLY on the changes requested — NOT a full redesign.
- Reference existing colors, fonts, spacing values from the codebase above
- Specify only the deltas: what changes and how
- Keep the overall design system intact; update only what the client asked for

`;
            }
        }
        return {
            key: `design-issue-${issue.number}`,
            station: 'design',
            issueNumber: issue.number,
            issueTitle: issue.title,
            model: 'opus', // Always Opus for design — quality non-negotiable
            message: `You are a DESIGN agent for the factory pipeline.
${changeRequestPreamble}
Your job: produce a DESIGN.md so detailed and precise that the BUILD agent has zero design decisions to make. Every color, every font, every spacing value, every component state — all defined. The goal is quality so good the client doesn't even think about rejecting it.

## Step 0 — Mark station as active (run immediately)

\`\`\`bash
curl -s -X PATCH \\
  "${ctx.env.supabaseUrl}/rest/v1/submissions?github_issue_url=ilike.*%2Fissues%2F${issue.number}" \\
  -H "apikey: ${ctx.env.supabaseKey}" \\
  -H "Authorization: Bearer ${ctx.env.supabaseKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"station": "design"}' || true
\`\`\`

## Step 1 — Read the SPEC

\`\`\`bash
gh issue view ${issue.number} --repo ${ctx.env.repo} --comments
\`\`\`

Extract:
- Project type (saas / service / ecommerce / marketplace / booking / restaurant / coaching / professional)
- All REQ-NNN requirements — understand every user-facing flow
- All page routes and components mentioned in the spec
- User roles and what each role sees
- Tech stack and any design constraints

## Step 1b — Inventory existing UI features (DEDUPLICATION CHECK)

If this is a change request on an existing build repo, audit what already exists before designing new features:
\`\`\`bash
# Check for existing components that might overlap with this issue
cd /tmp/existing-build-${issue.number} 2>/dev/null || cd /tmp/build-work 2>/dev/null

# List all page routes
find src/app -name "page.tsx" 2>/dev/null | sort

# List all components
find src/components -name "*.tsx" 2>/dev/null | sort

# Search for any features that might overlap with what we're about to design
# (Adapt the grep terms based on the issue title/requirements)
grep -rl "NewIssue\\|Modal\\|Button.*create\\|Dashboard\\|Activity\\|Settings" src/ --include="*.tsx" 2>/dev/null | head -20

# Read CLAUDE.md for documented features
cat CLAUDE.md 2>/dev/null
\`\`\`

**CRITICAL: If an existing component already does what you're about to design, do NOT design a duplicate. Instead:**
- Enhance the existing component
- Move it if it needs to be in a different location
- Document in DESIGN.md which existing components to reuse vs create new

## Step 2 — Read Impeccable design skill (MANDATORY)

You MUST follow the Impeccable frontend design methodology (pbakaus/impeccable). If the skill is installed, read its SKILL.md and all reference files:
\`\`\`bash
cat ~/.agents/skills/frontend-design/SKILL.md 2>/dev/null
ls ~/.agents/skills/frontend-design/reference/ 2>/dev/null && for f in ~/.agents/skills/frontend-design/reference/*.md; do echo "=== $f ==="; cat "$f"; done
\`\`\`

If not installed, install it:
\`\`\`bash
npx skills install pbakaus/impeccable@frontend-design
\`\`\`

**Impeccable principles are non-negotiable:**
- Choose a BOLD aesthetic direction — no generic "AI slop"
- Use distinctive typography (NOT Inter/Arial/system defaults for display)
- Apply OKLCH color with tinted neutrals, not flat grays
- Follow spatial design systems (consistent scales, not arbitrary values)
- Design purposeful motion (easing curves, staggered animations)
- Write excellent UX copy (clear labels, helpful errors, good empty states)

Use reference apps, hero patterns, card patterns, nav patterns, and CTA patterns appropriate for this project type.
Determine if this project type should default to dark mode. State the mode choice and rationale in the Design Philosophy section.

## Step 2b — Define BOTH Dark and Light Mode Tokens (MANDATORY)

**Every DESIGN.md MUST include a complete token system for BOTH modes.** This is non-negotiable.

Follow Impeccable's two-layer token hierarchy:
1. **Primitive tokens** — raw OKLCH colors (shared across modes)
2. **Semantic tokens** — role-based tokens redefined per mode

**Rules (from Impeccable color-and-contrast reference):**
- ALL neutrals must be tinted (same hue as primary, chroma ~0.01) — no flat grays
- Sidebar, header, content, cards MUST share the same tint family
- Dark mode: surface elevation via lighter surfaces (NOT shadows), base at 12-18% lightness
- Dark mode: desaturate accents slightly (reduce chroma ~30%)
- Dark mode: reduce body font weight (350 instead of 400)
- Dark mode: never use pure black (#000) — use tinted dark surfaces
- Light mode: use tinted off-whites, not pure white for base surfaces
- ALL text must meet WCAG AA (4.5:1 body, 3:1 UI elements)
- Badge/tag colors must be calibrated for BOTH modes separately
- One unified accent color — referenced by sidebar, buttons, links, focus states

**Include in DESIGN.md:**
\`\`\`
### Token System

#### Primitive Tokens (shared)
--primary: oklch(...)
--green: oklch(...)
--red: oklch(...)
...

#### Dark Mode Semantic Tokens
--surface-base: oklch(12% 0.01 [hue])
--surface-1: oklch(15% 0.01 [hue])
--surface-2: oklch(20% 0.01 [hue])
--text-primary: oklch(95% 0.01 [hue])
--text-secondary: oklch(70% 0.01 [hue])
...

#### Light Mode Semantic Tokens
--surface-base: oklch(98% 0.005 [hue])
--surface-1: oklch(100% 0 0)
...
\`\`\`

**If you skip mode tokens, the BUILD agent will produce inconsistent dark/light modes.** This section prevents that.

## Step 3 — Write DESIGN.md to /tmp/design-issue-${issue.number}.md

Produce a complete design specification. Every section is mandatory. No vague language — every value must be exact and implementable.

### Required sections:

#### 1. Design Philosophy (2-3 sentences)
What is the emotional tone? What should users feel? What brands/apps is this inspired by?

#### 2. Color System
\`\`\`
Primary:        #XXXXXX  — used for: CTAs, active nav, key highlights
Primary Dark:   #XXXXXX  — hover states on primary
Secondary:      #XXXXXX  — used for: secondary actions, tags
Background:     #XXXXXX  — page background
Surface:        #XXXXXX  — cards, panels, modals
Surface Alt:    #XXXXXX  — table rows alt, subtle dividers
Border:         #XXXXXX  — all borders, dividers
Text Primary:   #XXXXXX  — headings, labels
Text Secondary: #XXXXXX  — body copy, descriptions
Text Muted:     #XXXXXX  — placeholders, metadata
Success:        #XXXXXX
Warning:        #XXXXXX
Error:          #XXXXXX
\`\`\`

#### 3. Typography
\`\`\`
Font Display:   [Google Font name] — used only for hero/display headings
Font UI:        [Google Font name] — used for all UI text, labels, body
CDN links:      <link href="https://fonts.googleapis.com/css2?family=..."> (exact URLs)

H1: font-display, 56px/1.1, weight 800, tracking -0.02em
H2: font-display, 40px/1.2, weight 700, tracking -0.01em
H3: font-ui, 28px/1.3, weight 600
H4: font-ui, 20px/1.4, weight 600
Body Large: font-ui, 18px/1.6, weight 400
Body: font-ui, 16px/1.6, weight 400
Small: font-ui, 14px/1.5, weight 400
Caption: font-ui, 12px/1.4, weight 500, tracking 0.02em, uppercase
\`\`\`

#### 4. Spacing & Layout
\`\`\`
Base unit: 4px
Container max-width: Xpx, padding: Xpx mobile / Xpx desktop
Section padding: Xpx vertical
Card padding: Xpx
Border radius: Xpx (cards), Xpx (buttons), Xpx (inputs), Xpx (badges)
Shadow: [exact box-shadow values for each elevation level]
\`\`\`

#### 5. Component Specifications

For EVERY component used in the project:

**Buttons:**
\`\`\`
Primary: bg=Primary, text=white, px=24px, py=12px, radius=Xpx, font=14px/600
  Hover: bg=Primary Dark, shadow: 0 4px 12px rgba(primary, 0.3)
  Active: scale(0.98)
  Disabled: opacity=0.4, cursor=not-allowed
Secondary: border=1px Border, bg=transparent, text=Text Primary
  Hover: bg=Surface Alt
Danger: bg=#DC2626, text=white
Ghost: bg=transparent, text=Primary
  Hover: bg=Primary/10
\`\`\`

**Form Inputs:**
\`\`\`
Height: 44px, border=1px Border, radius=Xpx, px=12px
Focus: border=Primary, shadow=0 0 0 3px Primary/20
Error state: border=Error, shadow=0 0 0 3px Error/20
Label: Text Secondary, 14px/500, mb=6px
Helper text: Text Muted, 12px, mt=4px
\`\`\`

**Cards:**
\`\`\`
bg=Surface, border=1px Border, radius=Xpx, shadow=[value]
Hover (if interactive): shadow=[elevated value], border=Primary/30, translateY(-2px)
transition: all 200ms ease
\`\`\`

**Navigation (sidebar or topbar — specify which):**
\`\`\`
[Exact colors, widths, active state, hover state, icon treatment]
\`\`\`

**Tables:**
\`\`\`
Header: bg=Surface Alt, text=Text Secondary, 12px/600 uppercase, tracking 0.05em
Row: bg=white, border-bottom=1px Border
Row Alt: bg=Surface Alt/50
Row Hover: bg=Primary/5
\`\`\`

**Badges / Status chips:**
\`\`\`
[Status → color mapping, exact bg/text combos, font size/weight]
\`\`\`

**Modals:**
\`\`\`
Overlay: rgba(0,0,0,0.5), backdrop-blur=4px
Container: bg=white, radius=Xpx, shadow=[value], max-width=Xpx, p=Xpx
Header: [font/size], close button [position/size]
\`\`\`

#### 6. Page-by-Page Layout Specifications

For EVERY page/route in the spec, specify the exact layout.

#### 7. Responsive Behavior
\`\`\`
Breakpoints: mobile=375px, tablet=768px, desktop=1280px, wide=1536px
[Rules for each breakpoint]
\`\`\`

#### 8. Micro-interactions & Animations
\`\`\`
Page transitions: fadeIn 200ms ease
Button hover: 150ms ease, bg shift + subtle shadow lift
Card hover: 200ms ease, translateY(-2px) + shadow elevation
Loading states: skeleton screens (bg=Surface Alt, animated pulse)
\`\`\`

#### 9. Empty States
For every list/table that can be empty.

#### 10. Icon System (MANDATORY — no exceptions)

⚠️ **RULE: ZERO emoji in the UI. Every icon must be a Lucide React SVG component.**

#### 11. Illustration / Hero Visual

#### 12. CSS Custom Properties (copy-paste ready)

#### 13. Tailwind Config Extension (MANDATORY)

Provide a complete \`extend\` block with ALL hex values filled in.

#### 14. Motion Spec (framer-motion — MANDATORY)

#### 15. Hero Visual Spec (MANDATORY — no placeholder comments allowed)

## Step 4 — Self-review before posting

Read your DESIGN.md and ask:
- Does every component have exact hex codes, pixel values, font sizes?
- Can a developer implement this with zero design decisions?
- Are ALL routes from the spec covered in the page specs?
- Does the Tailwind Config section have ALL hex values filled in (no #XXXXXX placeholders)?
- Is the Hero Visual section fully specified with exact CSS/JSX — no placeholder comments?
- Is the Motion Spec section present with project-specific overrides called out?

If any answer is no — fix it before posting.

## Step 5 — Post DESIGN.md + flip station

\`\`\`bash
# Post as GitHub comment
gh issue comment ${issue.number} --repo ${ctx.env.repo} --body-file /tmp/design-issue-${issue.number}.md

# Flip station: spec → design
gh issue edit ${issue.number} --repo ${ctx.env.repo} \\
  --remove-label "station:spec" --add-label "station:design"

# Update Supabase
curl -s -X PATCH \\
  "${SUPABASE_URL}/rest/v1/submissions?github_issue_url=ilike.*%2Fissues%2F${issue.number}" \\
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \\
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"station": "design"}'

# Notify chat thread
SUBMISSION_ID=$(curl -s \\
  "${SUPABASE_URL}/rest/v1/submissions?github_issue_url=ilike.*%2Fissues%2F${issue.number}&select=id" \\
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \\
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" | jq -r '.[0].id // empty')
if [ -n "$SUBMISSION_ID" ]; then
  curl -s -X POST "${ctx.env.factoryAppUrl}/api/threads/$SUBMISSION_ID/push" \\
    -H "Content-Type: application/json" \\
    -H "x-factory-secret: ${ctx.env.factorySecret}" \\
    -d '{"type":"status_update","content":"Design complete — build starting now.","payload":{"station":"design","issueNumber":${issue.number}}}' 2>/dev/null || true
fi
\`\`\`

⚠️ STOP after Step 5. Do NOT flip to station:build — BUILD owns that transition.
Confirm: DESIGN complete for issue #${issue.number}. BUILD will read DESIGN.md before writing any code.`,
        };
    }
}
//# sourceMappingURL=index.js.map