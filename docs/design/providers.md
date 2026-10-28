# Providers

The catalog is pi-ai's generated built-in list (42 providers at 1.3.0), imported only by the CLI. The daemon registers
the default provider plus every provider in `config.models.registered`, through a static loader per catalog id, so a
chat-only process never pays for the full catalog.

- Key-only providers (single API key) are supported by the wizard.
- Providers needing an endpoint, region or OAuth are listed with that requirement.
- Keys go to `credentials.json` (0600); pi's auth.json is never modified; env vars remain the last layer.
- Validation registers the provider and calls `getAvailable`; an auth failure refuses to save, a network failure
  offers an explicit unverified save.
- E2E never touches the network: keys starting with `test-invalid` or `test-offline` exercise the refusal paths.
