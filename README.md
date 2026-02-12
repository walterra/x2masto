# x2masto

Collect your X/Twitter following data and build Mastodon import CSVs.

`x2masto` is a Node.js CLI toolkit that helps you:

1. get your following list from X (via an existing Chrome session),
2. extract likely Mastodon handles from profile text/links,
3. optionally run a second Mastodon search pass to discover more matches.

## Why this project exists

X and Mastodon don't offer a direct follow migration path. This toolchain builds
one from your own follow graph data.

## Install

### As an npm package

```bash
npm install -g x2masto
```

## Quickstart

### 1) Start Chrome with remote debugging

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.cache/browser-tools" \
  --no-first-run \
  --no-default-browser-check
```

Log into `x.com` in that Chrome window.

### 2) Collect your X following dataset

```bash
npm run collect:x-following -- --user <username>
```

Output files:

- `data/x-following-raw.csv`
- `data/x-following-raw.jsonl`

### 3) Extract Mastodon handles

```bash
npm run match:mastodon
```

Output files:

- `data/x-matches.csv`
- `data/x-mastodon-import.csv`

Optional handle verification via WebFinger:

```bash
npm run match:mastodon -- --verify --verify-workers 8
```

### 4) Optional: search Mastodon instances for additional matches

```bash
npm run search:mastodon -- --max-accounts 500
```

Output files:

- `data/x-search-matches.csv`
- `data/x-mastodon-import-search.csv`
- `data/x-mastodon-import-combined.csv`

## CLI commands

If installed globally from npm, you can use:

- `x2masto-collect`
- `x2masto-match`
- `x2masto-search`

Or keep using npm scripts from source:

- `npm run collect:x-following -- ...`
- `npm run match:mastodon -- ...`
- `npm run search:mastodon -- ...`

## Development

```bash
npm ci
npm run check
npm pack --dry-run
```

## Contributing & community

- [Contributing](./CONTRIBUTING.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Security Policy](./SECURITY.md)
- [License (MIT)](./LICENSE)

## Notes

- X UI and anti-bot behavior can change; selectors may need updates.
- Login/CAPTCHA/MFA are intentionally manual; extraction is scripted.
- Handle extraction is heuristic. Review generated CSVs before importing.
