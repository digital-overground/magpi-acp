# ACP Registry readiness

Updated against the ACP Registry contribution rules and MagPi ACP `dev` branch on 2026-09-18.

## Current status

MagPi ACP is ready for a registry submission candidate:

- `magpi-acp` is a valid and currently unused registry ID.
- `magpi-acp@0.1.0` is public on npm; the unreleased bundled-Pi change requires Node.js 22.19.0 or newer.
- The source repository and MIT license are public under `digital-overground/magpi-acp`.
- The ACP `initialize` response identifies MagPi ACP and returns standard Terminal Auth fields.
- The unreleased bundled-Pi change makes `--terminal-login` launch the same packaged Pi used for sessions. A configured model provider and Pi authentication are still required.
- `icon.svg` is square, 16×16, and monochrome with `currentColor`.
- The npm package dry-run includes the executable, built runtime, README, and license.

The registry validates the manifest, icon, published package, process startup, and authentication handshake. After acceptance, its hourly updater tracks new npm releases automatically.

## Submission manifest

Create `magpi-acp/agent.json` in a fork of [`agentclientprotocol/registry`](https://github.com/agentclientprotocol/registry):

```json
{
  "id": "magpi-acp",
  "name": "MagPi ACP",
  "version": "0.1.0",
  "description": "ACP adapter for the Pi coding agent",
  "repository": "https://github.com/digital-overground/magpi-acp",
  "website": "https://github.com/digital-overground/magpi-acp#readme",
  "authors": ["Kyle Humphrey"],
  "license": "MIT",
  "license_url": "https://github.com/digital-overground/magpi-acp/blob/main/LICENSE",
  "distribution": {
    "npx": {
      "package": "magpi-acp@0.1.0"
    }
  }
}
```

Copy the repository's `icon.svg` beside the manifest.

## Remaining work

1. Test the manifest with the registry's local validation, including its live authentication check.
2. Publish a MagPi release with the exact Pi dependency, then verify the registry-installed `npx` package launches sessions and Terminal Auth without a global `pi` on `PATH`. Installing MagPi should install Pi; the user still configures and authenticates a model provider. `MAGPI_ACP_PI_COMMAND` opts into a separately installed Pi, maintained by the caller. Pi updates ship with tested MagPi releases.
3. Test installation and Terminal Auth from Zed using the registry fork or generated registry output.
4. Submit the registry pull request and address CI or review feedback.
5. After merge, confirm Zed installs `magpi-acp` and that a later npm release is picked up by the registry updater.

## References

- [Registry contribution guide](https://github.com/agentclientprotocol/registry/blob/main/CONTRIBUTING.md)
- [Registry authentication requirements](https://github.com/agentclientprotocol/registry/blob/main/AUTHENTICATION.md)
- [Registry agent schema](https://github.com/agentclientprotocol/registry/blob/main/agent.schema.json)
