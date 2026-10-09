# Security policy

## Supported versions

Security fixes target the latest commit on the default branch and the latest
published release, when one exists. Older snapshots may be asked to upgrade
before receiving a fix.

## Reporting a vulnerability

Prefer GitHub's private vulnerability reporting for this repository when it is
available. Include:

- affected commit or version;
- impact and attack prerequisites;
- reproduction steps or a minimal proof of concept;
- suggested mitigation, if known.

If private vulnerability reporting is unavailable, open a public issue that
contains no sensitive exploit details and asks the maintainer to establish a
private contact channel.

Do not include credentials, ChatGPT content, session IDs, relay databases, or
private repository data in a report.

## Trust boundaries

gpt-relay is designed for local use or a trusted LAN:

- The server binds to `127.0.0.1` by default and has no authentication layer.
- Prompts, replies, session identifiers, and task state are stored in a local
  SQLite database.
- Pending CLI records are stored in the user's local data directory.
- Client bindings and pending records track stable server identity. This protects against accidental backend replacement, and does not authenticate a server or client.
- Non-loopback servers announce identity and port through LAN mDNS unless disabled. Discovery verifies the HTTP identity API before selecting a server.
- The browser extension can read and interact with supported ChatGPT pages and
  communicate with the configured relay URL.
- Submitted task content is sent through the user's ChatGPT web session and is
  subject to the user's account controls, plan limits, and applicable terms.

Changing `GPT_RELAY_HOST` to a non-loopback interface materially expands the
trust boundary. Do not expose the relay to an untrusted network without adding
appropriate transport security, authentication, authorization, and firewall
controls.

## Sensitive local data

Relay databases, pending records, logs, browser profiles, and extension storage
may contain private task content. Before sharing diagnostics:

1. Stop the relay and browser extension.
2. Copy only the minimum information needed to reproduce the issue.
3. Remove prompt and reply content, session and task identifiers, paths,
   credentials, and private repository references.
4. Verify the sanitized artifact before publishing it.

## Extension permissions

The extension permissions are documented in
[`extension/README.md`](./extension/README.md). Permission expansions should be
treated as security-sensitive changes and justified in the pull request.
