# OpenCode Go models in the desktop app

This fork documents how to use [OpenCode Go](https://opencode.ai) models from
the desktop model picker, exactly like switching models in the stock UI.

Two pieces are needed:

1. The bundled `api-key-model-visibility` Linux feature, which lets the
   desktop model picker show every model reported by an API-key authenticated
   provider.
2. A local [LiteLLM](https://docs.litellm.ai/) bridge. Current Codex CLI
   builds only speak the OpenAI Responses API (`wire_api = "responses"`;
   `"chat"` was removed, see
   [openai/codex#7782](https://github.com/openai/codex/discussions/7782)),
   while most OpenCode Go models only accept `/chat/completions`. The bridge
   translates Responses to Chat Completions locally.

## 1. Get an OpenCode Go API key

Create a key in the OpenCode console and verify it:

```bash
curl -s -H "Authorization: Bearer $OPENCODE_API_KEY" \
  https://opencode.ai/zen/go/v1/models
```

Store it where GUI apps can see it (systemd-based desktops), then log out and
back in once:

```bash
mkdir -p ~/.config/environment.d
printf 'OPENCODE_API_KEY=<your key>\n' > ~/.config/environment.d/50-opencode.conf
chmod 600 ~/.config/environment.d/50-opencode.conf
```

Never commit the key anywhere.

## 2. Run the LiteLLM bridge

Install LiteLLM. FastAPI must be pinned to 0.140.6 or older because newer
FastAPI removed `get_flat_dependant`, which the proxy still imports
(see [BerriAI/litellm#35763](https://github.com/BerriAI/litellm/issues/35763)):

```bash
uv tool install "litellm[proxy]" --with "fastapi==0.140.6"
```

Generate `~/.config/litellm/opencode.yaml` with one entry per model. The
`openai/chat_completions/<model>` prefix forces LiteLLM's Responses to Chat
Completions bridge instead of passing `/responses` through to the provider:

```yaml
model_list:
  - model_name: kimi-k3
    litellm_params:
      model: openai/chat_completions/kimi-k3
      api_base: https://opencode.ai/zen/go/v1
      api_key: os.environ/OPENCODE_API_KEY
  # repeat for every model id returned by /models

litellm_settings:
  drop_params: true
```

Run it as a systemd user service, `~/.config/systemd/user/litellm-opencode.service`:

```ini
[Unit]
Description=LiteLLM bridge for OpenCode Go (Responses to Chat Completions)
After=network-online.target

[Service]
EnvironmentFile=%h/.config/environment.d/50-opencode.conf
ExecStart=%h/.local/bin/litellm --config %h/.config/litellm/opencode.yaml --host 127.0.0.1 --port 4000
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now litellm-opencode.service
```

## 2b. Run the Codex models shim

Codex only trusts a provider model catalog served in its own `ModelsResponse`
schema (`{"models": [ModelInfo, ...]}`, snake_case, see
`codex-rs/protocol/src/openai_models.rs`); a plain OpenAI `/v1/models` list
fails to deserialize and Codex silently falls back to its built-in catalog.
Run a small shim in front of the bridge that serves `/v1/models` in Codex
format (templating each entry from a known-good `~/.codex/models_cache.json`
entry) and proxies everything else to LiteLLM. This repo's reference shim
lives at port 4001 with LiteLLM on 4000; run it as a second systemd user
service. Point `base_url` at the shim, not at LiteLLM directly.

Also enable the remote models feature in `~/.codex/config.toml`:

```toml
[features]
remote_models = true
```

With ChatGPT-account auth active, Codex replaces the picker catalog with the
provider list, so the picker shows exactly the OpenCode Go models while the
provider is active; remove the top-level `model_provider` line to go back to
the stock picker.

## 3. Configure the provider

Add to `~/.codex/config.toml`:

```toml
model_provider = "opencode_go"
model = "kimi-k3"

[model_providers.opencode_go]
name = "OpenCode Go"
base_url = "http://127.0.0.1:4001/v1"
env_key = "OPENCODE_API_KEY"
wire_api = "responses"
```

The top-level `model_provider`/`model` keys make OpenCode Go the active host;
the visibility feature only applies to API-key authenticated hosts.

## 4. Enable the model picker feature

Create `linux-features/features.json` (gitignored, local-only):

```json
{
  "enabled": [
    "api-key-model-visibility"
  ]
}
```

## 5. Build and install

```bash
make bootstrap-native
```

To install this variant side by side with a stock `codex-desktop` or the
official app, repackage `dist/deb-root` under a different package name and
`/opt` path, drop the updater files, and rename the desktop entry, launcher,
icon, and AppArmor profile accordingly. Note that all variants share the same
upstream `Codex` user profile: chat history carries over, but only one can
run at a time because of the upstream single-instance lock.

## 6. Verify and switch models in the UI

```bash
OPENCODE_API_KEY=<key> /opt/codex-desktop/resources/codex exec \
  --skip-git-repo-check -c model_provider=opencode_go -c model=kimi-k3 \
  'Reply with exactly: OPENCODE BRIDGE OK'
```

Then launch the app and pick any OpenCode Go model (for example `minimax-m3`,
`kimi-k3`, `glm-5.2`) from the model picker.

## Notes

- The picker can list models your plan cannot use; the provider rejects those
  at request time.
- ChatGPT-account hosts keep the upstream filtering rules; only API-key hosts
  are affected.
- A handful of OpenCode Go models (the DeepSeek v4 family, gpt-5.6-luna,
  grok-4.5 at the time of writing) also accept `/responses` natively, but the
  bridge covers the whole catalog uniformly.
