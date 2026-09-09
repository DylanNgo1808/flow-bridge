# Flow Bridge — Agent Setup & Use Guide

**This file is for AI agents.** Read it first. Then walk the human through setup. After health is green, follow [`docs/AGENT.md`](docs/AGENT.md) for generation.

You talk only to `http://127.0.0.1:8100`. You never call Google Flow, `aisandbox-pa.googleapis.com`, or the extension WebSocket yourself.

```
Your agent  →  REST :8100  →  Python agent  →  WS :18765  →  Chrome extension  →  Google Flow
```

Credits, quota, and ToS sit on the Google account signed into the isolated Chrome profile. Use a **dedicated test account**. See [`docs/ACCOUNTS.md`](docs/ACCOUNTS.md).

---

## What this is

Local Python agent + unpacked Chrome MV3 extension. The extension rides a Google Flow session and proxies generation. The Python process is the only API the agent uses.

Two generation paths:

| User wants | Path |
|------------|------|
| Multi-scene story, character consistency, 8s Veo clips | **Veo** — `POST /api/requests/batch` then poll `/api/requests/batch-status` |
| Talking-head, `@me` avatar, native 360p/720p, 4/6/8/10s | **Omni Flash** — `POST /api/flow/generate-video-text` or `/generate-video-omni`, poll `/api/flow/check-status` |

Do not mix pollers. Do not invent a third pipeline.

Private repo. Do not publish the extension or load it in everyday Chrome.

---

## How to attach this repo (agent)

Give the agent these two files. Setup lives here. Generation lives in `docs/AGENT.md`. Recipes live in `skills/fk-*.md`.

| Tool | What to do |
|------|------------|
| Claude Code | This `README.md` plus `@docs/AGENT.md` in `CLAUDE.md`. Run `python setup.py --tool claude` (or `--tool all`) for `/fk-*` slash commands. |
| Codex CLI | Same: keep generated `AGENTS.md` and `@docs/AGENT.md`. |
| Cursor | Add `docs/AGENT.md` as a project rule. |
| Gemini CLI | Paste / `@` `docs/AGENT.md` into `GEMINI.md`. |
| Any session | `@` this README, then `@docs/AGENT.md`. |

If slash commands are missing, read `$FLOW_BRIDGE_ROOT/skills/fk-<name>.md` and follow it. Do not invent a parallel workflow.

Resolve the repo root:

```
FLOW_BRIDGE_ROOT =
  $FLOW_BRIDGE_ROOT env, else
  cwd if it contains skills/fk-create-project.md, else
  ~/flow-bridge if that directory exists, else
  ask the user
BASE = http://127.0.0.1:8100
```

Work from any cwd. Call the API with absolute URLs.

---

## Setup — you (the agent) guide the human

Do **not** start Chrome or the Python agent unasked. Ask first. Then run the commands they approve.

### 0. Prerequisites

Confirm these exist. If something is missing, tell the human how to install it. Do not continue until they are present.

| Need | Why | How to check / install |
|------|-----|------------------------|
| macOS, Linux, or Windows WSL | Scripts are bash | Windows: `wsl --install`, then run everything inside WSL |
| Python 3.10+ | Agent runtime | `python3 --version`. macOS: `brew install python@3.12`. Ubuntu/WSL: `sudo apt install python3 python3 python3-pip python3-venv` |
| ffmpeg + ffprobe | Concat / trim | `ffmpeg -version`. macOS: `brew install ffmpeg`. Ubuntu/WSL: `sudo apt install ffmpeg` |
| Google Chrome | Hosts the extension | https://www.google.com/chrome/ |
| A **test** Google account with Flow access | Generation credits | Not the human's main Gmail / main Flow login |
| This repo cloned | Source | `git clone` into e.g. `~/flow-bridge` |

### 1. Install Python deps

```bash
cd "$FLOW_BRIDGE_ROOT"
./setup.sh
```

This creates `venv/`, installs `requirements.txt`, and verifies `agent.main` imports.

If `setup.sh` is not executable: `chmod +x setup.sh && ./setup.sh`.

Manual equivalent:

```bash
cd "$FLOW_BRIDGE_ROOT"
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python3 -c "from agent.main import app; print('ok')"
```

Optional, for `/fk-*` slash commands in Claude / Gemini / Codex:

```bash
python setup.py --tool all
```

### 2. Isolated Chrome + unpacked extension

Everyday Chrome must **not** load this extension. The isolated profile lives at `~/.flow-bridge/chrome-test-profile` (outside the repo).

Ask the human, then:

```bash
cd "$FLOW_BRIDGE_ROOT"
./scripts/chrome-test-profile.sh
```

A separate Chrome window opens. Tell the human, **in that window only**:

1. Go to `chrome://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked** → choose this repo's `extension/` folder.
4. Confirm the Flow Bridge extension appears. The toolbar icon opens a **side panel**, not a popup.
5. Open **https://flow.google.com/** (https://labs.google/fx/tools/flow still works).
6. Sign in with the **test** Google account. Check the account chip in the Flow UI. If it is the main account, **stop**. Quit that Chrome. Do not generate.

Hard rules for this step:

- Do not load the unpacked extension in everyday Chrome.
- Do not sign the test profile into the main Google account.
- One Flow tab, one profile, one agent.

After changing `extension-ui/`, rebuild then reload the unpacked extension:

```bash
cd "$FLOW_BRIDGE_ROOT/extension-ui" && npm install && npm run build
```

Then in `chrome://extensions` → Reload on Flow Bridge.

### 3. Start the Python agent

Ask first. Then run as a **background** process (it stays up):

```bash
cd "$FLOW_BRIDGE_ROOT"
source venv/bin/activate
python -m agent.main
```

Binds `127.0.0.1` only:

- REST: `http://127.0.0.1:8100`
- WebSocket to the extension: `127.0.0.1:18765`

Do not expose either port. Do not put this behind a public URL.

Optional human UI: once the agent is running, `http://127.0.0.1:8100` serves the dashboard if it has been built (`dashboard/`).

### 4. Prove setup worked

```bash
curl -s http://127.0.0.1:8100/health
curl -s http://127.0.0.1:8100/api/flow/status
```

Both must be true:

```json
{"status":"ok","extension_connected":true}
{"connected":true,"flow_key_present":true}
```

Also useful:

```bash
curl -s http://127.0.0.1:8100/api/flow/credits
```

Setup is **not** done until `extension_connected` and `flow_key_present` are true. Do not generate before that.

### 5. If setup is not green

| Result | What you tell the human / do |
|--------|------------------------------|
| Connection refused on `:8100` | Agent is not running. Ask, then start `python -m agent.main` in the venv. |
| `extension_connected: false` | Wrong Chrome, extension not loaded, or Flow tab missing. Isolated profile → Load unpacked `extension/` → open https://flow.google.com/ signed in as the **test** account. |
| `flow_key_present: false` / `NO_FLOW_KEY` | Flow tab is open but no bearer token yet. Reload the Flow tab, sign in again, click around until the side panel shows a token. |
| `NO_FLOW_TAB` | Open a Google Flow tab in the isolated profile. |
| Side panel: "Agent disconnected" | Start `python -m agent.main`. |
| Import error / missing venv | Re-run `./setup.sh`. Need Python 3.10+, not a broken 3.13/arch mix. |
| Chrome not found | Set `FLOW_BRIDGE_CHROME` to the Chrome binary, then re-run `./scripts/chrome-test-profile.sh`. |
| HTTP 4xx/5xx, `CAPTCHA`, `UNUSUAL_ACTIVITY` | Stop guessing. Read `skills/fk-doctor.md` and follow it. |

Do not start generating while health is red.

---

## After setup — how you operate

Full operating manual: [`docs/AGENT.md`](docs/AGENT.md). Omni details: [`docs/OMNI_FLASH.md`](docs/OMNI_FLASH.md). Errors: [`skills/fk-doctor.md`](skills/fk-doctor.md).

### Pre-flight (before every generate)

```bash
curl -s http://127.0.0.1:8100/health
curl -s http://127.0.0.1:8100/api/flow/status
```

Must return `extension_connected: true` and `flow_key_present: true`.

Ask for **video model**, **image model**, **orientation**, and **material** when those are unknown. Do not guess. Talking-head / `@me` → Omni Flash (skip image model, material, and chain).

### Skills (read the file, then execute)

When the user says `/fk-<name>` or the intent matches, read `$FLOW_BRIDGE_ROOT/skills/fk-<name>.md`.

| Intent | Skill |
|--------|-------|
| New Veo project / story / scenes | `fk-create-project` (research first via `fk-research` when real events) |
| Character / location refs | `fk-gen-refs` |
| Scene stills | `fk-gen-images` |
| Scene videos (Veo) | `fk-gen-videos` or `fk-gen-chain-videos` |
| Remaining Veo pipeline | `fk-pipeline` |
| Concat / download | `fk-concat` / `fk-concat-fit-narrator` |
| Switch Veo model | `fk-change-model` |
| Status / what's next | `fk-status` |
| Anything broken | `fk-doctor` |
| Omni Flash / `@me` | `docs/AGENT.md` + `docs/OMNI_FLASH.md` (not `fk-gen-videos`) |

Typical Veo order. Do not skip.

```
research → health → create project → create video → create scenes
→ gen refs (wait, UUID media_id) → gen scene images → gen videos
→ review → concat
```

### Critical rules (do not weaken)

1. **`media_id` is always UUID** (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`). Never `CAMS…`. If a response is CAMS, extract UUID from `/image/{UUID}` in the URL. Repair with `fk-fix-uuids`.
2. **Scene prompts = ACTION only.** Appearance lives on entity refs. Never restyle the character in the scene prompt.
3. **Refs before scene images, scene images before Veo videos.** Verify every entity has UUID `media_id` first.
4. **No throwaway loop scripts.** Veo: `POST /api/requests/batch` then poll `batch-status`. Omni: one generate call, then poll `check-status`. The worker already throttles (max 5 concurrent, 10s cooldown).
5. **Locations → landscape refs. Characters → portrait refs.**
6. **`GENERATE_*` skips COMPLETED. `REGENERATE_*` clears and reruns.** Regenerating an image auto-clears downstream video + upscale.
7. **Every Veo project needs `material`** (`GET /api/materials`). Common: `realistic`, `3d_pixar`, `anime`, `ghibli`.
8. **Veo video prompts: timed 8s segments** (`0-3s` / `3-6s` / `6-8s`), English, camera as its own sentence, dialogue in quotes.
9. **Patch scenes, do not delete+recreate.** `PATCH /api/scenes/{sid}`.
10. **Fact-check real events** before scripting (`fk-research`). Never invent operations, dates, or statistics.
11. **Real famous people:** role-based alias as entity name; appearance-only description; never the real name in image/video prompts. Details in `fk-create-project`.
12. **Review Veo clips before upscale.** `POST /api/videos/{vid}/review?mode=light`. Score &lt; 7.5 → update `video_prompt` → regen. Max 2 cycles.
13. **On any pipeline error, `fk-doctor` first.**
14. **Omni 360p = model-key suffix `_360p`.** Never send `outputSpec` / `videoResolution` on the generate proto (400).
15. **`@me` is the Flow recorded likeness** (face + voice). Pass `likeness_id`. Literal `@me` in prompt text does not bind.

### Useful endpoints

```
GET  /health
GET  /api/flow/status
GET  /api/flow/credits
GET  /api/materials
GET  /api/models
GET  /api/projects
PUT  /api/active-project          {"project_id":"<PID>"}
POST /api/requests/batch
GET  /api/requests/batch-status?video_id=&type=
POST /api/videos/{vid}/review?mode=light
POST /api/flow/upload-image       {"file_path":"/abs/path.jpg","project_id":"<PID>"}
```

Upload paths must exist **on this machine**. A caller-local path on another computer will fail.

---

## Do not

- Load the extension in everyday Chrome or sign the test profile into the main Google account.
- Expose `:8100` or `:18765`.
- Commit `.env`, cookies, `youtube/channels/*/token.json`, or `~/.flow-bridge/`.
- Call Google Flow or the extension WebSocket directly.
- Stagger Veo jobs by hand or `sleep` in a `for` loop of curls.
- Put real names of public figures into image/video prompts.
- Mix Omni `workflows` polling with the Veo operations poller.

---

## Read next

| File | When |
|------|------|
| [`docs/AGENT.md`](docs/AGENT.md) | Operating manual after setup (Veo + Omni, rules, errors) |
| [`docs/ACCOUNTS.md`](docs/ACCOUNTS.md) | Test vs main Google account |
| [`docs/OMNI_FLASH.md`](docs/OMNI_FLASH.md) | Talking-head / `@me` / 360p |
| [`docs/INTERNAL.md`](docs/INTERNAL.md) | What this repo is / is not |
| [`skills/`](skills/) | Step-by-step recipes (`fk-*.md`) |
| [`skills/fk-doctor.md`](skills/fk-doctor.md) | Anything broken |

License: MIT (upstream Flow Kit). Keep `LICENSE` when copying files out.
