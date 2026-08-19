# ACP Registry readiness

Checked against the ACP Registry contribution rules and validation code on 2026-08-18.

## Registry requirements

- An entry needs a unique lowercase ID, numeric semantic version, description, and at least one `binary`, `npx`, or `uvx` distribution. The directory name must equal the ID. [Contribution guide](https://github.com/agentclientprotocol/registry/blob/main/CONTRIBUTING.md#adding-a-new-agent) · [schema](https://github.com/agentclientprotocol/registry/blob/main/agent.schema.json)
- An npm distribution must use an existing package, pin the submitted version, and avoid `@latest`. The package version must match the entry version. [Distribution validation](https://github.com/agentclientprotocol/registry/blob/main/CONTRIBUTING.md#distribution-validation)
- Every entry needs a square 16×16 SVG using only `currentColor`, `none`, or `inherit` for fills and strokes. [Icon validation](https://github.com/agentclientprotocol/registry/blob/main/CONTRIBUTING.md#icon-validation)
- The launched agent must return at least one `agent` or `terminal` authentication method from ACP `initialize`. [Authentication requirements](https://github.com/agentclientprotocol/registry/blob/main/AUTHENTICATION.md)
- Registry CI validates the schema, package accessibility, process startup, and authentication handshake. [Local validation](https://github.com/agentclientprotocol/registry/blob/main/CONTRIBUTING.md#run-validation-locally)
- Registry versions are checked hourly against npm, PyPI, and GitHub Releases. [Automatic updates](https://github.com/agentclientprotocol/registry/blob/main/CONTRIBUTING.md#automatic-version-updates)

## MagPi ACP status

Ready:

- `magpi-acp` is a valid and currently unique registry ID.
- `package.json` uses semantic version `0.1.0`, package name `magpi-acp`, executable `magpi-acp`, and MIT licensing.
- The ACP initialize response identifies `MagPi ACP` version `0.1.0` and returns standard Terminal Auth fields.
- Tests, type checking, linting, build, smoke handshake, and npm package dry-run pass.
- The README is ACP-client-neutral and documents npx, source, authentication, configuration, and Pi prerequisites.
- `icon.svg` is a 16×16 monochrome `currentColor` magpie silhouette.
- A temporary `magpi-acp` registry entry passes the registry build and icon validation with URL checks disabled.
- The registry authentication client accepts the built adapter's Terminal Auth response.

Required before submission:

1. Make `kylehumphrey-ao/magpi-acp` public.
2. Authenticate npm and publish `magpi-acp@0.1.0`.
3. Copy `icon.svg` and the entry below into a registry fork.
4. Run registry validation against the published package and submit the pull request.

```json
{
  "id": "magpi-acp",
  "name": "MagPi ACP",
  "version": "0.1.0",
  "description": "ACP adapter for the Pi coding agent with roles, plans, elicitation, session titles, and tree navigation",
  "repository": "https://github.com/kylehumphrey-ao/magpi-acp",
  "authors": ["Kyle Humphrey"],
  "license": "MIT",
  "distribution": {
    "npx": {
      "package": "magpi-acp@0.1.0"
    }
  }
}
```

The registry does not impose requirements on an agent repository's README. Its checks apply to the registry entry, distribution, icon, launch behavior, and authentication handshake; the README changes are for accurate public documentation.
