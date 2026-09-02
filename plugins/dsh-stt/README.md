# dsh-stt

An out-of-tree DeepSeek Harness plugin (browser-only) that adds speech-to-text
to the chat composer: a microphone button sits in the composer tool row, right
of the model selector and before the send button (`conversation.input.right`).

Click the mic to start recording. The browser's **Web Speech API**
(`SpeechRecognition` / `webkitSpeechRecognition`) transcribes continuously —
**it keeps listening until you click the mic again to stop** (no auto-stop on
silence). Interim results stream live into the prompt draft as you speak; the
final transcript is committed when recording stops.

Everything runs in the browser: no host half, no API keys, no networking. The
draft is written through the composer's own public action
(`inputActions.setDraft`) with an anchored tail-write, so text already in the
prompt is preserved and only the recording region is replaced.

## Layout

```
package.json       manifest + dsh.client declaration + bundle patch ref
lib/index.js       host loader entry (no host-side behavior)
lib/client.js      browser half (lazy-CJS factory): mic button + recognition
lib/types/         type stubs
cordis.patch.yml   bundle patch inserting the `stt` row
install.mjs        idempotent auto-install (called by the container entrypoint)
```

The browser half is written directly in the harness's lazy-CJS factory format
(`window.__ModuleLoader__.load({ id, factory })`) so it needs no bespoke
bundler; `react` and the `dsh-client-*` roster resolve through the client
module system.

## Behavior

| Interaction | Result |
|---|---|
| Click mic | Recording starts (browser mic-permission prompt on first use); interim text appears live in the prompt |
| Speak / pause | Recording continues — `continuous: true`, silence does not stop it |
| Click mic again | Recording stops; the final transcript stays in the draft |
| Session switch / plugin stop mid-recording | Recognition is aborted cleanly |

If the browser drops the recognition session (network blip, continuous-audio
cap), the plugin restarts it automatically while still recording (bounded to
avoid loops). Permission-denied and network failures stop cleanly and surface a
tooltip.

## Browser support

Works in **Chrome/Edge/Safari** (Web Speech API). In **Firefox** the button
renders disabled with a tooltip, since Firefox does not implement the API.

## Install

Baked into the image at `/opt/dsh-stt`; `entrypoint.sh` auto-installs it into
the `web` profile via `install.mjs` (idempotent, version-marker-gated). To
install manually:

```bash
dsh plugin --profile web add /opt/dsh-stt
```
