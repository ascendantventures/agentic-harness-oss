# Troubleshooting

Common issues and how to resolve them.

## Factory won't start

**Symptom:** `npm start` exits immediately or throws an error.

**Check:**
- Ensure Node.js 18+ is installed: `node --version`
- Ensure dependencies are installed: `npm install`
- Ensure `factory/config.json` exists (copy from `factory/config.example.json`)
- Ensure `.env` exists (copy from `.env.example`)
- Ensure `gh` CLI is authenticated: `gh auth status`

## Agents not spawning

**Symptom:** The factory runs but no agents are created for issues that should be processed.

**Check:**
- Verify the issue has the correct station label (e.g., `station:intake`)
- Check for active locks: `cat /tmp/factory-loop.lock`
- Check crash backoff: if an agent recently failed fast, it enters exponential backoff (5–30 min)
- Check concurrency limits in `config.json` — the factory won't spawn more than `maxTasksPerRun` agents per tick
- Look at the factory log for "skip" or "locked" messages

## Agent fails immediately

**Symptom:** Agent spawns but exits within seconds.

**Check:**
- Verify your Anthropic auth is valid:
  - OAuth: `CLAUDE_CODE_OAUTH_TOKEN` should start with `sk-ant-oat01-`
  - API key: `ANTHROPIC_API_KEY` should start with `sk-ant-api03-`
- Do not set both `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY`
- Verify `claude` CLI is installed and on PATH: `claude --version`
- Check the factory log for the exact error message

## QA station is stuck / stalled

**Symptom:** An issue stays at `station:build` and QA never re-runs.

**Cause:** The QA stall guard prevents re-running QA when the build repo has no new commits since the last QA failure.

**Fix:**
- Push a new commit to the build repo (even a whitespace change)
- Or manually move the issue to a different station by editing its labels

## Lock file is stale

**Symptom:** An issue is locked but no agent is running for it.

**Cause:** The agent crashed without cleaning up its lock.

**Fix:**
- Locks have TTLs and are automatically cleaned up on the next tick
- To force-clear: delete `/tmp/factory-loop.lock` (or remove the specific entry from it)

## GitHub rate limiting

**Symptom:** `gh` commands fail with 403 or rate limit errors.

**Cause:** The factory makes many GitHub API calls per tick. With many issues, you may hit rate limits.

**Fix:**
- Reduce `maxTasksPerRun` in `config.json`
- Increase the cron interval (e.g., every 2 minutes instead of every 1)
- Use a GitHub App token instead of a personal access token (higher rate limits)

## TypeScript errors on build

**Symptom:** `npm run typecheck` or `npm run build` fails.

**Check:**
- Ensure all dependencies are installed: `npm install`
- Check the TypeScript version: `npx tsc --version`
- If you added a new station, ensure it's registered in `StationRegistry.createDefault()` and exported from `stations/index.ts`

## Vercel deployment fails

**Symptom:** BUILD or BUGFIX agent can't deploy to Vercel.

**Check:**
- Ensure `VERCEL_TOKEN` is set in `.env`
- Verify the token is valid: `vercel list --token $VERCEL_TOKEN`
- Check that the Vercel project is linked in the build repo

## Getting help

If none of the above resolves your issue:

1. Check the factory log: `cat /tmp/factory-loop.log` (or wherever `FACTORY_LOG` points)
2. Open an issue on GitHub with the **Bug Report** template
3. Include relevant log output and your Node.js version / OS
