# Contributing

Thanks for your interest in improving `x2masto`.

## Development setup

```bash
git clone https://github.com/walterra/x2masto.git
cd x2masto
npm ci
```

Run checks before opening a PR:

```bash
npm run check
npm pack --dry-run
```

## Coding guidelines

- Keep CLI behavior explicit and user-friendly.
- Preserve compatibility with Node.js 20+.
- Add tests for new matching/search behavior and CSV output changes.
- Keep README examples copy/paste ready.

## Pull requests

Please include:

- What changed
- Why it changed
- How you validated it (tests, command, output)

If behavior changes for end users, update `README.md` in the same PR.

## Reporting bugs

Use the bug report issue template and include:

- command used
- Node.js version
- OS
- sanitized sample input/output
