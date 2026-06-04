title: Contributing Guide
description: How to contribute to TestRadius
lastUpdated: 2026-06-04

Thanks for your interest in contributing to TestRadius!

---

## Development Workflow

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes
4. Run tests
5. Submit a pull request

## Code Style

### Python

- Follow PEP 8
- Use type hints for all function signatures
- Use async/await for I/O-bound operations
- Use `logging` (not `print`) for debug output

### TypeScript/React

- Follow the existing code patterns (see `artifacts/testradius/src/`)
- Use functional components with hooks
- Use TypeScript strict mode
- Use Tailwind CSS classes (not inline styles)

### Shell Scripts

- Use `local` for all variables in functions
- Pass ShellCheck with zero violations
- Use `[[ ]]` for conditionals

## Testing

- Python: `pytest` with `asyncio` support
- TypeScript: Vitest for unit tests, Playwright for e2e
- Shell: ShellCheck

Run the full test suite before submitting:

```bash
# Python tests
docker compose --profile ml exec core-ml pytest tests/ -v

# UI tests
cd artifacts/testradius && npx vitest run
```

## Pull Request Guidelines

- Keep PRs focused on a single concern
- Include tests for new functionality
- Update documentation when changing behavior
- Reference the issue number in the PR description

## Commit Messages

Follow conventional commit format:

```
type(scope): description

- type: feat, fix, refactor, test, docs, chore
- scope: core, ui, github-app, docs, docker
- description: imperative mood, no period
```

Examples:

```
feat(core): add symbol filtering by file path
fix(executor): install Playwright browsers before test run
docs(ui): add API reference page
```

## Code of Conduct

Be respectful, inclusive, and constructive. Focus on what's best for the project and the community.
