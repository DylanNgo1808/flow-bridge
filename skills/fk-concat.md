Download and concatenate all scene videos into a single video with optional TTS narration.

Usage: `/fk-concat <video_id> [--with-tts] [--4k]`

Default: uses best available quality (4K upscale > regular video), preserves original audio.

## Step 1: Get project, video, and scenes

```bash
curl -s http://127.0.0.1:8100/api/videos/<VID>
# Get project_id from video response
curl -s http://127.0.0.1:8100/api/projects/<PID>
curl -s "http://127.0.0.1:8100/api/scenes?video_id=<VID>"
```

Note: project name (for output folder), orientation (HORIZONTAL or VERTICAL).
Sort scenes by `display_order`.

## Step 2: Determine video source for each scene

Priority order for each scene:
1. **Local 4K file:** `${OUTDIR}/4k/{scene_id}.mp4` (saved from rawBytes — best quality)
2. **Upscale URL:** `horizontal_upscale_url` or `vertical_upscale_url` (4K signed URL — may be expired)
3. **Video URL:** `horizontal_video_url` or `vertical_video_url` (standard quality)

Check orientation from project or first scene. Use matching prefix (`horizontal_` or `vertical_`).

**ABORT** if any scene has no video source. Tell user to run `/fk-gen-videos` first.

## Step 3: Setup output directory

```bash
# Get project output directory (creates dir + meta.json if needed)
PROJ_OUT=$(curl -s http://127.0.0.1:8100/api/projects/<PID>/output-dir)
OUTDIR=$(echo "$PROJ_OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['path'])")
SLUG=$(echo "$PROJ_OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['slug'])")
mkdir -p "${OUTDIR}/4k" "${OUTDIR}/narrated" "${OUTDIR}/norm"
```

## Step 4: Download videos (skip if local file exists)

```bash
# IDX3 = zero-padded 3-digit display_order (e.g. 000, 001, ...)
IDX3=$(printf "%03d" $DISPLAY_ORDER)
CANONICAL="${OUTDIR}/4k/scene_${IDX3}_${SCENE_ID}.mp4"
LEGACY="${OUTDIR}/4k/${SCENE_ID}.mp4"

# For each scene, check local canonical name first, then legacy name
if [ -f "$CANONICAL" ]; then
  : # already present, skip download
elif [ -f "$LEGACY" ]; then
  cp "$LEGACY" "$CANONICAL"
else
  curl -L -o "$CANONICAL" "${UPSCALE_URL_OR_VIDEO_URL}"
fi
```

Verify each download: `ffprobe` should return valid video stream.

## Step 5: Determine output resolution

- If `--4k` flag: use `3840:2160` (HORIZONTAL) or `2160:3840` (VERTICAL)
- Otherwise: match source resolution from first downloaded scene via ffprobe

**IMPORTANT: Never downscale 4K videos. If source is 3840x2160, output must be 3840x2160.**

## Step 6: Normalize + mix audio

**Every ffmpeg call below is per-scene, so you will run them in a loop — and
ffmpeg reads stdin.** Inside `while read ... done < list`, ffmpeg swallows the
rest of the list and the loop silently processes every other scene. This has
happened: 6 of 12 scenes were dropped with no error. Hence `-nostdin` on every
invocation here; keep it if you rewrite these commands.


### Option A: Without TTS (default)
Preserve original video audio (sound effects from Google Flow):
```bash
# CANONICAL = "${OUTDIR}/4k/scene_${IDX3}_${SCENE_ID}.mp4" (set in Step 4)
ffmpeg -nostdin -y -i "$CANONICAL" \
  -c:v libx264 -preset fast -crf 18 \
  -vf "scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2" \
  -r 24 -pix_fmt yuv420p \
  -c:a aac -b:a 192k \
  -movflags +faststart "${OUTDIR}/norm/scene_${IDX3}_${SCENE_ID}.mp4"
```

### Option B: With TTS narration (`--with-tts`)
Mix TTS audio WITH video sound effects using `amix` filter:

```bash
# Find matching TTS wav
TTS_WAV="${OUTDIR}/tts/scene_${IDX3}_${SCENE_ID}.wav"

if [ -f "$TTS_WAV" ]; then
  # MIX: video SFX at 30% volume + TTS narrator at 150% volume
  ffmpeg -nostdin -y -i "$CANONICAL" -i "$TTS_WAV" \
    -filter_complex "[0:a]volume=0.3[bg];[1:a]volume=1.5[fg];[bg][fg]amix=inputs=2:duration=first[aout]" \
    -map 0:v -map "[aout]" \
    -c:v libx264 -preset fast -crf 18 \
    -vf "scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2" \
    -r 24 -pix_fmt yuv420p \
    -c:a aac -b:a 192k \
    -movflags +faststart "${OUTDIR}/narrated/scene_${IDX3}_${SCENE_ID}.mp4"
else
  # No TTS for this scene — normalize with original audio only
  ffmpeg -nostdin -y -i "$CANONICAL" \
    -c:v libx264 -preset fast -crf 18 \
    -vf "scale=${W}:${H}" -r 24 -pix_fmt yuv420p \
    -c:a aac -b:a 192k \
    -movflags +faststart "${OUTDIR}/narrated/scene_${IDX3}_${SCENE_ID}.mp4"
fi
```

**CRITICAL: Do NOT use `-an` (strips all audio). Always preserve or mix audio.**

## Step 7: Create concat list and merge

Replace `<VID>` below with the same `<video_id>` supplied to `/fk-concat` and
used in Step 1. Run this block as a unit. Any error aborts the workflow: do not
continue to Step 8 or report success. An existing final file may belong to a
previous run and is not evidence that this concat succeeded.

The subshell keeps its cleanup trap separate from any surrounding shell traps.
Each invocation uses a unique temporary directory for all three intermediate
files, preventing concurrent runs from exchanging scene lists. The directory is
removed on success, failure, or a handled signal; the final output stays in
`OUTDIR`. Keep the parentheses and run the whole block together.

```bash
(
VIDEO_ID="<VID>"  # Substitute the input video_id used in Step 1
if [ -z "$VIDEO_ID" ] || [ "$VIDEO_ID" = "<VID>" ]; then
  echo "ERROR: video_id is missing; use the /fk-concat input from Step 1." >&2
  exit 1
fi

if ! CONCAT_TMPDIR=$(mktemp -d); then
  echo "ERROR: could not create concat temporary directory; concat aborted." >&2
  exit 1
fi
trap 'rm -rf -- "$CONCAT_TMPDIR" || { echo "ERROR: could not remove concat temporary directory: $CONCAT_TMPDIR" >&2; exit 1; }' EXIT
trap 'echo "ERROR: concat interrupted; concat aborted." >&2; exit 1' HUP INT TERM

# Use narrated/ if --with-tts, otherwise norm/
SRC_DIR="${OUTDIR}/narrated"  # or "${OUTDIR}/norm"

# `: >` not a bare `>`: in zsh a redirection with no command runs NULLCMD (cat),
# which blocks on stdin — the same trap this step warns about.
if ! : > "${CONCAT_TMPDIR}/concat.txt"; then
  echo "ERROR: could not create concat list; concat aborted." >&2
  exit 1
fi
# Feed the loop plain "<display_order> <scene_id>" lines, sorted by
# display_order. Do NOT try to iterate an array of records: bash has no
# array-of-maps, so ${scene[display_order]} indexes `scene` with the arithmetic
# value of an unset name — 0 — and every iteration reads the same element.
# Redirect stdin from the list, not a pipe, so nothing downstream can eat it.
if ! curl -fsS "http://127.0.0.1:8100/api/scenes?video_id=${VIDEO_ID}" -o "${CONCAT_TMPDIR}/scenes.json"; then
  echo "ERROR: scene fetch failed for video ${VIDEO_ID}; concat aborted." >&2
  exit 1
fi
if ! python3 -c '
import sys, json
scenes = json.load(sys.stdin)
if not isinstance(scenes, list):
    raise ValueError("Expected a JSON list of scenes")
for scene in sorted(scenes, key=lambda s: s["display_order"]):
    print(scene["display_order"], scene["id"])
' < "${CONCAT_TMPDIR}/scenes.json" > "${CONCAT_TMPDIR}/scenes.txt"; then
  echo "ERROR: could not parse scene response for video ${VIDEO_ID}; concat aborted." >&2
  exit 1
fi
if [ ! -s "${CONCAT_TMPDIR}/scenes.txt" ]; then
  echo "ERROR: no scenes returned for video ${VIDEO_ID}; concat aborted." >&2
  exit 1
fi

while read -r ORDER SCENE_ID; do
  IDX3=$(printf "%03d" "$ORDER")
  CANONICAL_NORM="${SRC_DIR}/scene_${IDX3}_${SCENE_ID}.mp4"
  # Fallback to legacy 2-digit name if canonical not found
  LEGACY_NORM="${SRC_DIR}/scene_$(printf "%02d" "$ORDER").mp4"
  if [ -f "$CANONICAL_NORM" ]; then
    NORM_FILE="$CANONICAL_NORM"
  elif [ -f "$LEGACY_NORM" ]; then
    NORM_FILE="$LEGACY_NORM"
  else
    echo "ERROR: missing normalized file for scene ${IDX3}_${SCENE_ID}" >&2
    exit 1
  fi
  if ! echo "file '$NORM_FILE'" >> "${CONCAT_TMPDIR}/concat.txt"; then
    echo "ERROR: could not write concat list; concat aborted." >&2
    exit 1
  fi
done < "${CONCAT_TMPDIR}/scenes.txt" || {
  echo "ERROR: could not read scene list; concat aborted." >&2
  exit 1
}

if ! ffmpeg -nostdin -y -f concat -safe 0 -i "${CONCAT_TMPDIR}/concat.txt" -c copy -movflags +faststart \
  "${OUTDIR}/${SLUG}_final.mp4"; then
  echo "ERROR: ffmpeg concat failed; do not verify or report the final file as complete." >&2
  exit 1
fi
)
```

## Step 8: Verify and output

Run this step only after the entire Step 7 block succeeds in this run. If Step 7
fails, stop even if `${SLUG}_final.mp4` already exists.
The Step 7 subshell has already cleaned up its temporary lists; verify the final
file below, without relying on any intermediate files.

```bash
# Verify final video
ffprobe -v quiet -show_entries stream=width,height,codec_name,codec_type -of csv=p=0 "${OUTDIR}/${SLUG}_final.mp4"
ls -lh "${OUTDIR}/${SLUG}_final.mp4"
ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${OUTDIR}/${SLUG}_final.mp4"

# Verify audio is present (not silent)
ffmpeg -nostdin -t 10 -i "${OUTDIR}/${SLUG}_final.mp4" -af "volumedetect" -f null /dev/null 2>&1 | grep "mean_volume"
# mean_volume should be between -30 and -10 dB (not -inf which means silent)
```

Print:
```
Concat complete: <project_name>
  Output: ${OUTDIR}/${SLUG}_final.mp4
  Duration: X:XX
  Resolution: WxH
  Audio: AAC (SFX + TTS narrator) or AAC (SFX only)
  Size: XXX MB
  Scenes: N
```

## Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| No audio in final | Used `-an` in normalize step | Remove `-an`, use `-c:a aac` |
| TTS not audible | TTS wav not mixed, only video audio used | Use `amix` filter with `-filter_complex` |
| Video is 1080p not 4K | Normalize used wrong scale | Match source resolution, never downscale |
| Signed URL expired | GCS URLs have ~8h TTL | Check local `${OUTDIR}/4k/` files first |
| Scene order wrong | Not sorted by display_order | Sort scenes before processing |
