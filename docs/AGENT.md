# Flow Bridge — Agent Guide

Give this file to your AI agent (Claude Code, Codex, Cursor, Gemini CLI, Grok).
It is the operating manual. Recipe details live in `skills/fk-*.md` — read those
when executing a step. Do not invent a parallel pipeline.

```
Claude Code   copy into CLAUDE.md, or add:  @docs/AGENT.md
Codex CLI     copy into AGENTS.md, or keep generated AGENTS.md and @ this file
Cursor        add as a project rule
Gemini CLI    copy into GEMINI.md
Any session   paste this file at the start, or @-mention it
```

First-run setup (you guide the human through Chrome + the Python agent) is in
[README.md](../README.md) and [ACCOUNTS.md](ACCOUNTS.md). You (the agent) talk
only to `http://127.0.0.1:8100`.

---

## What this is

Local Python agent + unpacked Chrome extension. The extension rides the Google
Flow session in an isolated Chrome profile and proxies generation. Credits and
ToS sit on the Google account signed into that profile.

```
Your agent  →  REST http://127.0.0.1:8100  →  Python agent  →  WS :18765  →  Chrome extension  →  Google Flow
```

Do not call Google Flow, `aisandbox-pa.googleapis.com`, or the extension
WebSocket yourself. Do not expose `:8100` or `:18765`.

---

## Resolve the repo

```
FLOW_BRIDGE_ROOT =
  $FLOW_BRIDGE_ROOT env, else
  cwd if it contains skills/fk-create-project.md, else
  ~/flow-bridge if that directory exists, else
  ask the user
BASE = http://127.0.0.1:8100
```

Work from any cwd. Call the API with absolute URLs. When a recipe says "read
`skills/fk-….md`", read `$FLOW_BRIDGE_ROOT/skills/fk-….md`.

Slash commands (`/fk-create-project`, …) exist after the human runs
`python setup.py --tool all` inside the repo. If those commands are missing,
read the matching skill file and follow it.

---

## Pre-flight (before any generate)

```bash
curl -s http://127.0.0.1:8100/health
curl -s http://127.0.0.1:8100/api/flow/status
```

Must return `extension_connected: true` and `flow_key_present: true`.

| Result | Action |
|--------|--------|
| Connection refused | Ask before starting the agent. If yes: `cd "$FLOW_BRIDGE_ROOT" && source venv/bin/activate && python -m agent.main` as a **background** command. Re-check health. |
| `extension_connected: false` / `flow_key_present: false` | Stop. Tell the user: isolated Chrome via `./scripts/chrome-test-profile.sh` → Load unpacked `extension/` → open **https://flow.google.com/** (labs.google/fx/tools/flow still works) → sign in with the **test** account. Do not start Chrome unasked. |
| HTTP 4xx/5xx, `FAILED`, stuck `PROCESSING`, `UNSAFE_GENERATION`, `CAPTCHA`, `NO_FLOW_KEY` | Read `skills/fk-doctor.md` and follow it. Do not guess. |

Ask for **video model**, **image model**, **orientation**, and **material** when
those are unknown. Do not guess. Talking-head / `@me` → Omni Flash (skip image
model, material, and chain).

---

## Two pipelines (pick one)

| User wants | Path | Submit | Poll |
|------------|------|--------|------|
| Multi-scene story, character consistency, Veo 8s clips | **Veo** | `POST /api/requests/batch` | `GET /api/requests/batch-status` |
| Talking-head, `@me` avatar, native 360p/720p, 4/6/8/10s | **Omni Flash** | `POST /api/flow/generate-video-text` or `/generate-video-omni` | `POST /api/flow/check-status` with `workflows` |

Do not mix pollers. Omni workflow names must not go to the Veo operations
poller. Do not PATCH Veo `video_models` for Omni.

---

## Critical rules

1. **`media_id` is always UUID** (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`). Never `CAMS…` / base64. If a response is CAMS, extract UUID from `/image/{UUID}` in the URL. Repair with `skills/fk-fix-uuids.md`.
2. **Scene prompts = ACTION only.** Appearance lives on entity refs via `imageInputs`. Never restyle the character in the scene prompt.
3. **Refs before scene images, scene images before Veo videos.** Verify every entity has UUID `media_id` first.
4. **No throwaway loop scripts.** Veo: `POST /api/requests/batch` then poll `batch-status`. Omni: one generate call, then poll `check-status`. The worker already throttles (max 5 concurrent, 10s cooldown).
5. **Locations → landscape refs. Characters → portrait refs.**
6. **`GENERATE_*` skips COMPLETED. `REGENERATE_*` clears and reruns.** Regenerating an image auto-clears downstream video + upscale.
7. **Every Veo project needs `material`** (`GET /api/materials`). Common: `realistic`, `3d_pixar`, `anime`, `ghibli`.
8. **Veo video prompts: timed 8s segments** (`0-3s` / `3-6s` / `6-8s`), English, camera as its own sentence, dialogue in quotes, end with `Negative: subtitles, watermark, text overlay`.
9. **Patch scenes, do not delete+recreate.** `PATCH /api/scenes/{sid}` for `prompt`, `video_prompt`, `narrator_text`, `character_names`.
10. **Fact-check real events** before scripting (`skills/fk-research.md`). Never invent operations, dates, or statistics.
11. **Real famous people:** role-based English alias as entity name; appearance-only description; never the real name in `description` / `image_prompt` / `prompt` / `video_prompt`. `narrator_text` may use real titles. Details: `skills/fk-create-project.md` (Real-People section).
12. **Review Veo clips before upscale.** `POST /api/videos/{vid}/review?mode=light`. Score &lt; 7.5 → update `video_prompt` from review errors → regen. Max 2 cycles.
13. **On any pipeline error, `skills/fk-doctor.md` first.**
14. **Omni 360p = model-key suffix `_360p`** (`abra_r2v_6s_360p`). 720p = unsuffixed key. Never send `outputSpec` / `videoResolution` on the generate proto (400).
15. **`@me` is the Flow recorded likeness** (face + voice), not a still start-frame. Pass `likeness_id`. Literal `@me` in prompt text does not bind.

---

## Veo pipeline

Order. Do not skip.

```
0. Research (real events)     skills/fk-research.md
1. Health                     GET /health
2. Create project             POST /api/projects   (entities + material)
3. Create video               POST /api/videos
4. Create scenes              POST /api/scenes     (character_names, chain_type)
5. Switch active project      PUT  /api/active-project
6. Gen refs                   batch GENERATE_CHARACTER_IMAGE → poll project_id
7. Gen scene images           batch GENERATE_IMAGE           → poll video_id
8. Gen videos                 batch GENERATE_VIDEO           → poll video_id
9. Review                     POST /api/videos/{vid}/review?mode=light
10. Concat                    skills/fk-concat.md
```

Optional after review: 4K upscale (`UPSCALE_VIDEO`, TIER_TWO only), TTS, thumbnails.

### Batch submit + poll

```bash
curl -s -X POST http://127.0.0.1:8100/api/requests/batch \
  -H "Content-Type: application/json" \
  -d '{"requests":[
    {"type":"GENERATE_CHARACTER_IMAGE","project_id":"<PID>","character_id":"<CID>","orientation":"VERTICAL"}
  ]}'

curl -s "http://127.0.0.1:8100/api/requests/batch-status?project_id=<PID>&type=GENERATE_CHARACTER_IMAGE"
# {"total":N,"pending":…,"processing":…,"completed":…,"failed":…,"done":false,"all_succeeded":false}
```

Wait until `done=true`. Then verify IDs (entity `media_id` / scene `image_media_id`)
are UUID. Same pattern for `GENERATE_IMAGE` and `GENERATE_VIDEO` with `video_id`.

Request `type` values: `GENERATE_IMAGE`, `REGENERATE_IMAGE`, `EDIT_IMAGE`,
`GENERATE_VIDEO`, `REGENERATE_VIDEO`, `GENERATE_VIDEO_REFS`, `UPSCALE_VIDEO`,
`GENERATE_CHARACTER_IMAGE`, `REGENERATE_CHARACTER_IMAGE`, `EDIT_CHARACTER_IMAGE`.

Orientation: `VERTICAL` (9:16) or `HORIZONTAL` (16:9).

### Create project (minimum)

```bash
curl -s -X POST http://127.0.0.1:8100/api/projects \
  -H "Content-Type: application/json" \
  -d '{
    "name": "…",
    "story": "…",
    "material": "realistic",
    "characters": [
      {"name": "Luna", "entity_type": "character",
       "description": "Small white cat, big blue eyes, orange space suit, round glass helmet. Pixar-style 3D.",
       "voice_description": "Soft curious childlike voice"},
      {"name": "Candy Planet", "entity_type": "location",
       "description": "Alien surface of hard candies, lollipop trees, pastel sky. Pixar-style 3D."}
    ]
  }'
```

Then `POST /api/videos`, `POST /api/scenes`, `PUT /api/active-project`. Full
intake and prompt formulas: `skills/fk-create-project.md`.

Entity types: `character`, `location`, `creature`, `visual_asset`,
`generic_troop`, `faction`.

Chain: `ROOT` for a new visual chain (character/location cut, interview, time
skip). `CONTINUATION` + `parent_scene_id` only when the same primary character
continues in the same space. Never chain different primary characters.

### Veo model presets

Ask the user, then PATCH via `skills/fk-change-model.md` Quick Switch Presets.
Do not PATCH for status-only or Omni jobs.

| Preset | Notes |
|--------|-------|
| VEO 3.1 Lite Low Priority | 0 credits, works on ADVANCED. Recommended for free Veo runs. |
| VEO 3.1 Lite | ~5 credits / 8s, every tier, no r2v |
| VEO 3.1 Fast Ultra | ~10 credits / 8s, full quality |
| VEO 3.1 Low Priority "leaving" | 0 credits, needs `SERVICE_TIER_ULTRA` — silent fail on ADVANCED |

Image: `GEM_PIX_2` (recommended) or `NARWHAL`. Check credits: `GET /api/flow/credits`.

---

## Omni Flash / `@me`

Read `docs/OMNI_FLASH.md` plus this. Do not use `fk-gen-videos.md` for Omni.

| Job | Endpoint |
|-----|----------|
| Text / `@me` talking-head | `POST /api/flow/generate-video-text` |
| Reference images (+ optional `@me`) | `POST /api/flow/generate-video-omni` |
| First frame / first+last | `POST /api/flow/generate-video` with `"model_family":"omni_flash"` |
| Poll | `POST /api/flow/check-status` with `workflows` from submit `flowkitPolling.workflows` |
| Upload a local still | `POST /api/flow/upload-image` (`file_path` = **absolute path on this machine**) |

```json
{
  "prompt": "<spoken line + action only>",
  "project_id": "<uuid>",
  "scene_id": "",
  "duration_s": 6,
  "aspect_ratio": "VIDEO_ASPECT_RATIO_PORTRAIT",
  "resolution": "360p",
  "count": 1,
  "likeness_id": "<uuid from projectContents.likenesses>",
  "likeness_handle": "me"
}
```

- Durations: `4` | `6` | `8` | `10`. Aspects: `VIDEO_ASPECT_RATIO_PORTRAIT` or `_LANDSCAPE`.
- Credits (observed): 360p 6s ≈ 5; 720p 6s ≈ 10.
- `@me` always goes through the ingredients (R2V) path. Plain T2V with no
  `likeness_id` is a random face.
- Handle on the wire is `me` (no `@`). Reuse a stored `likeness_id` when you
  have one; otherwise `GET /api/flow/project-contents/{project_id}` → `likenesses`.
- Persist `flowkitPolling` from the submit response. Poll every 10–20s.
  `PENDING` → continue. `FAILED` → stop and report. `COMPLETED` → download
  `media.url` immediately (GCS signed, short-lived).

---

## Skills map

When the user says `/fk-<name>` or the intent matches, read
`$FLOW_BRIDGE_ROOT/skills/fk-<name>.md` and follow it.

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
| Omni Flash / `@me` | this file + `docs/OMNI_FLASH.md` |

After creating a project, `PUT /api/active-project` as `fk-create-project.md` requires.

For "make a video of X" with no existing project: intake → create project → gen
refs → gen images → gen videos. Confirm before kicking off generation if the
story or entities are still fuzzy.

---

## Useful endpoints

```
GET  /health
GET  /api/flow/status
GET  /api/flow/credits
GET  /api/materials
GET  /api/models
GET  /api/projects
GET  /api/projects/{pid}
GET  /api/videos?project_id=
GET  /api/scenes?video_id=
GET  /api/active-project
PUT  /api/active-project          {"project_id":"<PID>"}
POST /api/requests/batch
GET  /api/requests/batch-status?video_id=&type=
GET  /api/requests?status=FAILED
POST /api/videos/{vid}/review?mode=light
POST /api/flow/upload-image       {"file_path":"/abs/path.jpg","project_id":"<PID>"}
GET  /api/projects/{pid}/output-dir
```

Dashboard (human): `http://127.0.0.1:8100` once the agent is running, if the
dashboard is built. Extension side panel shows the live request log.

---

## Errors (quick)

Full taxonomy: `skills/fk-doctor.md`.

| Signal | First move |
|--------|------------|
| `extension_connected: false` / `NO_FLOW_KEY` / `NO_FLOW_TAB` | Isolated Chrome + Flow tab at https://flow.google.com/ |
| `PUBLIC_ERROR_UNSAFE_GENERATION` | Alias + appearance-only; see Real-People in `fk-create-project.md` |
| `PUBLIC_ERROR_USER_QUOTA_REACHED` | Stop. Wait for daily reset or change model |
| `PUBLIC_ERROR_MODEL_ACCESS_DENIED` | `GET /api/flow/credits`, then `fk-change-model` |
| `PUBLIC_ERROR_UNUSUAL_ACTIVITY` | Pause submits. User clears cookies for google.com + flow.google.com, re-signs in |
| `Requested entity was not found` | Expired upload. Re-upload or wait for worker recovery |
| `CAMS…` media_id | `fk-fix-uuids` |
| Stuck `PROCESSING` &gt; 10 min | Reload unpacked extension; `fk-doctor` |
| Upscale permission denied | Needs TIER_TWO |

Do not write retry-loop scripts. Do not mark a request FAILED in the DB while
the worker is still retrying.

---

## Do not

- Load the extension in everyday Chrome or sign the test profile into the main Google account. See `docs/ACCOUNTS.md`.
- Put real names of public figures into image/video prompts.
- Stagger Veo jobs by hand or sleep in a `for` loop of curls.
- Use a caller-local image path with `/api/flow/upload-image` unless that exact file exists on the Flow Bridge machine.
