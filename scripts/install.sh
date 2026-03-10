#!/usr/bin/env bash
set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}"
echo "  ┌─────────────────────────────────┐"
echo "  │     agentic-harness installer     │"
echo "  │  SPEC → DESIGN → BUILD → QA → DONE │"
echo "  └─────────────────────────────────┘"
echo -e "${NC}"

# 1. Check Node.js >= 18
echo -e "Checking prerequisites..."
NODE_VER=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1 || echo "0")
if [ "$NODE_VER" -lt 18 ]; then
  echo -e "${RED}✗ Node.js 18+ required (found: $(node --version 2>/dev/null || echo 'not installed'))${NC}"
  exit 1
fi
echo -e "${GREEN}✓ Node.js $(node --version)${NC}"

# 2. Check claude CLI
if ! command -v claude &>/dev/null; then
  echo -e "${RED}✗ claude CLI not found${NC}"
  echo "  Install: npm install -g @anthropic-ai/claude-code"
  exit 1
fi
echo -e "${GREEN}✓ claude CLI $(claude --version 2>/dev/null | head -1)${NC}"

# 3. Check gh CLI
if ! command -v gh &>/dev/null; then
  echo -e "${RED}✗ gh CLI not found${NC}"
  echo "  Install: https://cli.github.com"
  exit 1
fi
if ! gh auth status &>/dev/null; then
  echo -e "${RED}✗ gh not authenticated — run: gh auth login${NC}"
  exit 1
fi
echo -e "${GREEN}✓ gh CLI authenticated${NC}"

# 4. Copy config templates
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

if [ ! -f "$REPO_ROOT/factory/config.json" ]; then
  cp "$REPO_ROOT/factory/config.example.json" "$REPO_ROOT/factory/config.json"
  echo -e "${GREEN}✓ Created factory/config.json${NC}"
else
  echo -e "${YELLOW}⚠ factory/config.json already exists — skipping${NC}"
fi

if [ ! -f "$REPO_ROOT/.env" ]; then
  cp "$REPO_ROOT/.env.example" "$REPO_ROOT/.env"
  echo -e "${GREEN}✓ Created .env${NC}"
else
  echo -e "${YELLOW}⚠ .env already exists — skipping${NC}"
fi

# 5. Prompt for required values
echo ""
echo -e "${BLUE}Required configuration:${NC}"

read -p "  GitHub repo (owner/repo): " GITHUB_REPO
if [ -n "$GITHUB_REPO" ]; then
  sed -i "s|owner/repo|$GITHUB_REPO|g" "$REPO_ROOT/.env" "$REPO_ROOT/factory/config.json"
  echo -e "${GREEN}✓ GITHUB_REPO set to $GITHUB_REPO${NC}"
fi

read -p "  Anthropic API key (sk-ant-... or sk-ant-oat01-...): " ANTHROPIC_KEY
if [ -n "$ANTHROPIC_KEY" ]; then
  if [[ "$ANTHROPIC_KEY" == sk-ant-oat* ]]; then
    sed -i "s|CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=$ANTHROPIC_KEY|" "$REPO_ROOT/.env"
  else
    sed -i "s|# ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=$ANTHROPIC_KEY|" "$REPO_ROOT/.env"
  fi
  echo -e "${GREEN}✓ API key configured${NC}"
fi

# 6. Set up GitHub labels
if [ -n "$GITHUB_REPO" ]; then
  echo ""
  echo -e "Setting up GitHub labels on $GITHUB_REPO..."
  bash "$REPO_ROOT/scripts/setup-labels.sh" "$GITHUB_REPO" 2>/dev/null && \
    echo -e "${GREEN}✓ Labels created${NC}" || \
    echo -e "${YELLOW}⚠ Label setup failed — run scripts/setup-labels.sh $GITHUB_REPO manually${NC}"
fi

# Done
echo ""
echo -e "${GREEN}✅ agentic-harness is ready!${NC}"
echo ""
echo "  Next steps:"
echo "  1. Review .env and factory/config.json"
echo "  2. Start the factory:  node factory/factory-loop.js"
echo "  3. Or as a cron:       */5 * * * * node $REPO_ROOT/factory/factory-loop.js"
echo "  4. Create an issue with label 'station:spec' to start a pipeline run"
echo ""
echo "  See examples/quickstart-issue.md for a ready-to-go test issue."
