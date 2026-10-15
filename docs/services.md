# Server service management

`gpt-relay start` is the portable foreground server. `gpt-relay service` manages an OS service without consulting or changing CLI backend bindings. The command dispatcher lives in `service/index.ts`; platform adapters implement the OS lifecycle separately. macOS LaunchAgent support is available now. Linux and Windows return an explicit unsupported-platform error; foreground startup continues to work there.

## macOS login service

Use a per-user LaunchAgent, without sudo, because task execution depends on the logged-in user's browser. The server starts immediately on installation, then at each GUI login, and launchd restarts it if it exits. Logging out stops it. It does not open Edge, log into ChatGPT, or prevent system sleep.

Stop any existing foreground server before installation. An occupied listener causes installation to fail before writing a plist; the command never kills an unknown process or silently chooses another port.

```bash
# Optional: inspect the generated configuration without writing or loading it.
GPT_RELAY_HOST=0.0.0.0 gpt-relay service install --dry-run

# Use 0.0.0.0 for trusted LAN clients; omission keeps the loopback default.
GPT_RELAY_HOST=0.0.0.0 gpt-relay service install

gpt-relay service status
gpt-relay health --local
```

A global installation is optional. From the checkout, replace `gpt-relay` with `node bin/gpt-relay.mjs`.

The plist is generated locally at `~/Library/LaunchAgents/io.github.solusquest.gpt-relay.plist`. No machine-specific paths or generated plists belong in the repository. Installation stores the resolved Node executable, package root, listener host/port, and absolute data/database/log paths. The tsx loader resolves from the package's working directory at launch, so pnpm dependency upgrades do not leave a stale loader path. Explicit server timeout, queue, discovery, name, and local-registry environment overrides are captured as well; unrelated shell variables and client backend configuration are not copied. A fixed port is required; `GPT_RELAY_PORT=0` is rejected.

Use the existing server environment variables at installation time:

```bash
GPT_RELAY_HOST=0.0.0.0 GPT_RELAY_PORT=8765 GPT_RELAY_DATA_DIR="$HOME/.gpt-relay" gpt-relay service install
```

Later shell exports do not change the installed service. To change saved settings, inspect `service status`, uninstall, and install with the desired environment. Installing over an existing plist is refused, rather than resetting a LAN listener or custom data directory to defaults.

## Lifecycle and logs

```bash
gpt-relay service status
gpt-relay service stop
gpt-relay service start
gpt-relay service restart
gpt-relay service uninstall
```

`stop` unloads the job for the current login; the plist remains and the next login starts it again. `uninstall` removes the plist as well. Both preserve SQLite, pending records, logs, and server identity. `restart` unloads gracefully and loads the same saved configuration, allowing SIGTERM cleanup instead of forcing a kill. Do not run a foreground server on the same port while the service is loaded.

Status reports whether the job is installed, loaded, and currently has a PID, plus its listener and log paths. Loading a job is separate from HTTP readiness: verify `gpt-relay health --local`, then `gpt-relay doctor --local` for browser availability.

By default, launchd output goes to:

```text
~/.gpt-relay/logs/launchd.stdout.log
~/.gpt-relay/logs/launchd.stderr.log
```

`GPT_RELAY_LOG_DIR` at install time changes these paths. Inspect stderr if the job keeps restarting or health fails. Restart attempts are throttled to once per ten seconds.

## Source and runtime updates

For a checkout or globally linked installation, source edits take effect after `gpt-relay service restart`; dependency changes also require `pnpm install`. For a copied package installation, update the installed package first.

The service deliberately uses the actual Node binary, not a mise/nvm/asdf shim, and does not depend on pnpm being on launchd's PATH. After removing or moving the recorded Node version or package directory, uninstall and reinstall the service using the new runtime and the desired server environment. For version-managed Node installations, keep the recorded version until migration is complete.
