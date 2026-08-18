# OpenCode Go models in the desktop app

This fork documents how to use [OpenCode Go](https://opencode.ai) models from
the desktop model picker, exactly like switching models in the stock UI.

The bundled Codex CLI already supports OpenAI-compatible providers through
`~/.codex/config.toml`. The only missing piece upstream is that the desktop
model picker filters the model list for non-ChatGPT hosts. The bundled
`api-key-model-visibility` Linux feature removes that filter for API-key
authenticated providers, so every model the provider reports becomes
selectable in the picker.

## 1. Get an OpenCode Go API key

Create a key in the OpenCode console. Verify it works:

```bash
curl -s -H "Authorization: Bearer $OPENCODE_API_KEY" \
  https://opencode.ai/zen/go/v1/models
```

## 2. Configure the provider

Add to `~/.codex/config.toml`:

```toml
[model_providers.opencode_go]
name = "OpenCode Go"
base_url = "https://opencode.ai/zen/go/v1"
env_key = "OPENCODE_API_KEY"
wire_api = "chat"
```

The key itself is never written to the config file. Export it where the
desktop app can see it. On systemd-based desktops:

```bash
mkdir -p ~/.config/environment.d
printf 'OPENCODE_API_KEY=<your key>\n' > ~/.config/environment.d/50-opencode.conf
chmod 600 ~/.config/environment.d/50-opencode.conf
```

Log out and back in once so the session picks up the variable. Do not commit
the key anywhere.

## 3. Enable the model picker feature

Create `linux-features/features.json` (gitignored, local-only):

```json
{
  "enabled": [
    "api-key-model-visibility"
  ]
}
```

## 4. Build and install

```bash
make bootstrap-native
```

or, if build dependencies are already installed:

```bash
make install-native
```

## 5. Switch models in the UI

Launch the app, open the Codex pane with the `opencode_go` provider active
(`model_provider = "opencode_go"` in `~/.codex/config.toml` selects it as the
default), and pick any OpenCode Go model (for example `minimax-m3`, `kimi-k3`,
`glm-5.2`) from the model picker.

## Notes

- The picker can list models your plan cannot use; the provider rejects those
  at request time.
- ChatGPT-account hosts keep the upstream filtering rules; only API-key hosts
  are affected.
