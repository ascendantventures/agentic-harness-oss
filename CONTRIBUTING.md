# Contributing to agentic-harness

Thanks for your interest in contributing! This guide covers everything you need to get started.

## Development Setup

### Prerequisites

- Node.js 18+
- [`claude` CLI](https://docs.anthropic.com/en/docs/claude-code) — `npm install -g @anthropic-ai/claude-code`
- [`gh` CLI](https://cli.github.com/) — authenticated with your GitHub account
- Anthropic API key or OAuth token

### Getting started

```bash
git clone https://github.com/agentic-harness/agentic-harness
cd agentic-harness
npm install

# Copy config files
cp .env.example .env
cp factory/config.example.json factory/config.json

# Edit both with your values, then run
npm run dev
```

### Available scripts

| Command | Description |
|---------|-------------|
| `npm start` | Run the factory loop once |
| `npm run dev` | Run with file watching (auto-restart on changes) |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Run unit tests |
| `npm run build` | Compile TypeScript |

## Project Structure

```
factory/src/
├── core/         # Config, locks, backoff, key rotation
├── github/       # Issue fetching, label management
├── stations/     # One file per station (spec, design, build, qa, bugfix, ...)
├── pipeline/     # Router, detector, runner
├── agents/       # Agent spawning and monitoring
├── notify/       # Discord and Supabase integrations
├── types/        # All shared TypeScript interfaces
└── loop.ts       # Main entrypoint
```

## How to Contribute

### Reporting Bugs

Open an issue using the **Bug Report** template. Include:

- Steps to reproduce
- Expected vs actual behavior
- Factory logs if available (`/tmp/factory-loop.log`)
- Your Node.js version and OS

### Suggesting Features

Open an issue using the **Feature Request** template. Describe the use case and why it would benefit the project.

### Submitting Code

1. Fork the repo and create a feature branch from `main`
2. Make your changes
3. Run `npm run typecheck` to ensure no type errors
4. Run `npm test` to ensure tests pass
5. Open a pull request against `main`

### Adding a New Station

This is the most common type of contribution. See [docs/adding-a-station.md](docs/adding-a-station.md) for a full guide.

Short version:

1. Create `factory/src/stations/<name>/index.ts` extending `BaseStation`
2. Implement `shouldProcess()` and `buildTask()`
3. Register in `StationRegistry.createDefault()`
4. Add to `pipelines.json`
5. Add tests in `tests/unit/stations/<name>.test.ts`

### Adding a New Pipeline

See [docs/custom-pipelines.md](docs/custom-pipelines.md). No core code changes needed — just `pipelines.json` config and station classes.

## Code Style

- TypeScript strict mode — no `any` types unless absolutely necessary
- Use the existing patterns: `BaseStation` for stations, `FactoryContext` for DI
- Comments should explain *why*, not *what*
- Keep station files self-contained — one file per station

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Include a clear description of what changed and why
- Add tests for new functionality
- Ensure `npm run typecheck` passes
- Update documentation if you changed behavior

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
