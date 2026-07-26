# Contributing to gpt-relay

Thank you for helping improve gpt-relay.

## Before you start

- Search existing issues and pull requests before opening a duplicate.
- For a bug, include the operating system, Node.js version, Chromium browser,
  extension version or commit, and a minimal reproduction.
- For a behavior change or new public API, open an issue first so the contract,
  compatibility, and security implications can be discussed.
- Do not include prompts, replies, session IDs, credentials, or private
  repository content in public reports.

Security vulnerabilities should follow [`SECURITY.md`](./SECURITY.md), not the
normal issue process.

## Development setup

Requirements:

- Node.js 22 or later
- npm
- A Chromium browser for manual extension validation

Install and validate:

```bash
npm install
npm run typecheck
npm test
npm pack --dry-run
```

Load `extension/` as an unpacked extension when a change affects browser
behavior. See [`extension/README.md`](./extension/README.md).

## Change guidelines

- Keep commits focused on one concern.
- Add or update tests for behavior changes.
- Preserve the public `/v1` contract unless the change explicitly includes a
  documented compatibility decision.
- Treat `/internal` as an extension contract even though it is not a public
  agent API; update extension integration tests when it changes.
- Keep source comments, diagnostics, and canonical documentation in English.
- Preserve intentional multilingual ChatGPT selectors, safety-detection
  patterns, and encoding fixtures.
- Never commit relay databases, pending task records, logs, browser data,
  secrets, or user content.

## Pull requests

A pull request should:

- explain the problem and solution;
- identify user-visible or protocol changes;
- list validation performed;
- call out compatibility, migration, security, and privacy effects;
- remain narrowly scoped.

CI runs on Ubuntu and Windows with Node.js 22. A pull request should pass
type-checking, tests, and package-content validation before review.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](./LICENSE).
