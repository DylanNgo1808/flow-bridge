"""Gemini Omni Flash video generation through the Google Flow bridge.

Supported Omni surfaces in this module:

* first frame -> video via ``batchAsyncGenerateVideoStartImage``
* first + last frame -> video via ``batchAsyncGenerateVideoStartAndEndImage``
* text -> video via ``batchAsyncGenerateVideoText`` (``@me`` avatar / likeness)
* reference images -> video via ``batchAsyncGenerateVideoReferenceImages``

Omni duration-specific model keys live in ``agent/models.json``.  First-frame
Flow requests have been captured with ``abra_i2v_<duration>s``.  The current
First+Last rollout uses the same Omni I2V family but the StartAndEnd endpoint;
that mapping is deliberately configurable separately so it can be changed
without a code release if Google's rollout rotates the wire key.

Important: Omni submit responses may contain operation-looking handles, but
those handles are not compatible with the legacy
``batchCheckAsyncVideoGenerationStatus`` polling endpoint. Omni jobs are
workflow-backed and are polled through Flow's authenticated project data.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from pathlib import Path
from urllib.parse import quote

from agent.services.flow_client import get_flow_client
from agent.services.headers import random_headers

logger = logging.getLogger(__name__)
_MODELS_FILE = Path(__file__).parent.parent / "models.json"

OMNI_FLASH_VALID_DURATIONS = (4, 6, 8, 10)
OMNI_FLASH_VALID_ASPECTS = {
    "VIDEO_ASPECT_RATIO_PORTRAIT",
    "VIDEO_ASPECT_RATIO_LANDSCAPE",
}
OMNI_FLASH_VALID_RESOLUTIONS = {
    "360p": "VIDEO_RESOLUTION_360P",
    "720p": "VIDEO_RESOLUTION_720P",
    "VIDEO_RESOLUTION_360P": "VIDEO_RESOLUTION_360P",
    "VIDEO_RESOLUTION_720P": "VIDEO_RESOLUTION_720P",
}
OMNI_FLASH_MAX_REFERENCE_IMAGES = 7
OMNI_FLASH_MAX_COUNT = 4
# Live Flow UI (Omni 1.1 Flash, Aug 2026). 360p is the draft tier.
OMNI_FLASH_CREDIT_COST = {
    "360p": {4: 4, 6: 5, 8: 6, 10: 7},
    "720p": {4: 7, 6: 10, 8: 12, 10: 15},
}


async def _fetch_project_initial_data(client, project_id: str) -> dict:
    """Fetch the same authenticated project snapshot used by the Flow UI."""
    query = quote(
        json.dumps({"json": {"projectId": project_id}}, separators=(",", ":")),
        safe="",
    )
    url = f"https://labs.google/fx/api/trpc/flow.projectInitialData?input={query}"
    return await client._send(
        "trpc_request",
        {
            "url": url,
            "method": "GET",
            "headers": {"content-type": "application/json"},
        },
        timeout=15,
    )


async def _fetch_media_url(client, media_id: str) -> dict:
    """Resolve Flow's authenticated media redirect without buffering the file."""
    url = (
        "https://labs.google/fx/api/trpc/media.getMediaUrlRedirect"
        f"?name={quote(media_id, safe='')}"
    )
    return await client._send(
        "trpc_request",
        {
            "url": url,
            "method": "GET",
            "headers": {"content-type": "application/json"},
            "responseMode": "url",
        },
        timeout=15,
    )


def _validate_duration(duration_s: int) -> None:
    if duration_s not in OMNI_FLASH_VALID_DURATIONS:
        raise ValueError(
            f"Omni Flash duration {duration_s}s is unsupported; "
            f"choose one of {list(OMNI_FLASH_VALID_DURATIONS)}"
        )


def _validate_aspect(aspect_ratio: str) -> None:
    if aspect_ratio not in OMNI_FLASH_VALID_ASPECTS:
        raise ValueError(
            f"Omni Flash aspect ratio {aspect_ratio!r} is unsupported; "
            "use VIDEO_ASPECT_RATIO_PORTRAIT or VIDEO_ASPECT_RATIO_LANDSCAPE"
        )


def _normalize_resolution(resolution: str | None) -> str:
    key = (resolution or "360p").strip()
    enum = OMNI_FLASH_VALID_RESOLUTIONS.get(key) or OMNI_FLASH_VALID_RESOLUTIONS.get(key.lower())
    if not enum:
        raise ValueError(
            f"Omni Flash resolution {resolution!r} is unsupported; use 360p or 720p"
        )
    return enum


def _unknown_field_error(result: dict, field: str) -> bool:
    """True when Flow rejected ``field`` as an unknown proto JSON name."""
    if not isinstance(result, dict):
        return False
    status = result.get("status")
    if not isinstance(status, int) or status != 400:
        return False
    blob = str(result)
    needle = f"Unknown name \"{field}\""
    return needle in blob or f"Unknown name '{field}'" in blob


def _structured_prompt(
    prompt: str,
    likeness_handle: str | None = None,
    likeness_id: str | None = None,
) -> dict:
    """Build Flow ``textInput.structuredPrompt``.

    Typing ``@me`` in Flow inserts a chip. The wire form is a part with
    ``reference.likeness`` (handle + likenessId). Literal ``@me`` in text
    does not bind the recorded face+voice.
    """
    text = prompt or ""
    handle = (likeness_handle or "").lstrip("@").strip()
    parts: list[dict] = []
    if likeness_id:
        parts.append({
            "reference": {
                "likeness": {
                    "handle": handle or "me",
                    "likenessId": likeness_id.strip(),
                }
            }
        })
    elif handle:
        token = f"@{handle}"
        if token.lower() not in text.lower():
            text = f"{token} {text}".strip()
    parts.append({"text": text})
    return {"structuredPrompt": {"parts": parts}}


def _reference_likenesses(likeness_id: str | None) -> list[dict] | None:
    """Bind a Flow ``@me`` avatar (recorded face + recorded voice).

    Live Flow UI sends ``{likenessId}`` only. Stored requestData later shows
    ``usageType: IMAGE_AND_VOICE``. Sending usageType together with 360p
    ``outputSpec`` 400s; omit it and let Flow default to image+voice.
    """
    if not isinstance(likeness_id, str) or not likeness_id.strip():
        return None
    return [{"likenessId": likeness_id.strip()}]


def _output_spec(res_enum: str) -> dict:
    """Omni 360p/720p rides on ``requests[].outputSpec.resolution``.

    Top-level ``resolution`` / ``videoResolution`` / ``videoModelControlInput``
    are not fields of the generate request proto (unknown-name 400).
    """
    return {"resolution": res_enum}


def _normalize_count(count: int | None) -> int:
    n = 1 if count is None else int(count)
    if n < 1 or n > OMNI_FLASH_MAX_COUNT:
        raise ValueError(
            f"Omni Flash count {count!r} is unsupported; use 1-{OMNI_FLASH_MAX_COUNT}"
        )
    return n


def _load_model_key(
    duration_s: int,
    mode: str = "reference_to_video",
    resolution: str | None = None,
) -> str:
    """Resolve a configured Omni Flash model key for ``mode`` + duration.

    Live Flow encodes 360p in the model key (``abra_r2v_6s_360p``). 720p is
    the unsuffixed key. ``outputSpec.resolution`` 400s on generate.
    """
    _validate_duration(duration_s)

    with open(_MODELS_FILE, encoding="utf-8") as f:
        models = json.load(f)

    key = (
        models.get("omni_flash_models", {})
        .get(mode, {})
        .get(str(duration_s))
    )
    if not key:
        raise ValueError(
            f"No Omni Flash model key configured for mode {mode!r}, {duration_s}s"
        )
    if resolution is not None and _normalize_resolution(resolution) == "VIDEO_RESOLUTION_360P":
        if not key.endswith("_360p"):
            key = f"{key}_360p"
    return key


def _validate_reference_inputs(
    reference_media_ids: list[str],
    duration_s: int,
    aspect_ratio: str,
    resolution: str | None = "360p",
    count: int | None = 1,
) -> list[str]:
    _validate_duration(duration_s)
    _validate_aspect(aspect_ratio)
    _normalize_resolution(resolution)
    _normalize_count(count)

    refs = [mid for mid in (reference_media_ids or []) if isinstance(mid, str) and mid]
    if not refs:
        raise ValueError("Omni Flash requires at least one reference image")
    if len(refs) > OMNI_FLASH_MAX_REFERENCE_IMAGES:
        raise ValueError(
            f"Omni Flash accepts at most {OMNI_FLASH_MAX_REFERENCE_IMAGES} reference images"
        )
    return refs


def _validate_frame_inputs(
    start_image_media_id: str,
    end_image_media_id: str | None,
    duration_s: int,
    aspect_ratio: str,
    resolution: str | None = "360p",
    count: int | None = 1,
) -> None:
    _validate_duration(duration_s)
    _validate_aspect(aspect_ratio)
    _normalize_resolution(resolution)
    _normalize_count(count)
    if not isinstance(start_image_media_id, str) or not start_image_media_id:
        raise ValueError("Omni Flash first-frame generation requires start_image_media_id")
    if end_image_media_id is not None and (
        not isinstance(end_image_media_id, str) or not end_image_media_id
    ):
        raise ValueError("Omni Flash First+Last requires a non-empty end_image_media_id")


def _normalize_workflow(workflow: dict) -> dict | None:
    """Normalize a raw Flow workflow or FlowKit polling descriptor."""
    if not isinstance(workflow, dict):
        return None
    name = workflow.get("name")
    primary_media_id = workflow.get("primary_media_id")
    if not primary_media_id:
        metadata = workflow.get("metadata")
        if isinstance(metadata, dict):
            primary_media_id = metadata.get("primaryMediaId")
    if not isinstance(name, str) or not name:
        return None
    if not isinstance(primary_media_id, str) or not primary_media_id:
        return None
    item = {"name": name, "primary_media_id": primary_media_id}
    project_id = workflow.get("project_id") or workflow.get("projectId")
    if isinstance(project_id, str) and project_id:
        item["project_id"] = project_id
    return item


def extract_omni_workflows(result: dict) -> list[dict]:
    """Extract ``name`` + ``primaryMediaId`` pairs from an Omni submit."""
    if not isinstance(result, dict):
        return []
    data = result.get("data") if isinstance(result.get("data"), dict) else result
    workflows = data.get("workflows", []) if isinstance(data, dict) else []
    normalized = []
    for workflow in workflows:
        item = _normalize_workflow(workflow)
        if item:
            normalized.append(item)
    return normalized


def _annotate_polling(result: dict, project_id: str) -> dict:
    """Add an explicit FlowKit polling descriptor to a successful submit."""
    workflows = extract_omni_workflows(result)
    if not workflows:
        return result
    data = result.get("data") if isinstance(result.get("data"), dict) else result
    if isinstance(data, dict):
        for workflow in workflows:
            workflow["project_id"] = project_id
        data["flowkitPolling"] = {
            "mode": "project_media",
            "project_id": project_id,
            "workflows": workflows,
        }
    return result


async def _send_omni_generate(client, *, endpoint: str, body: dict, project_id: str) -> dict:
    """POST an Omni generate body, dropping envelope resolution if Flow rejects it."""
    payload = {
        "url": client._build_url(endpoint),
        "method": "POST",
        "headers": random_headers(),
        "body": body,
        "captchaAction": "VIDEO_GENERATION",
    }
    result = await client._send("api_request", payload, timeout=60)
    ctx = body.get("mediaGenerationContext")
    if _unknown_field_error(result, "videoResolution") and isinstance(ctx, dict) and "videoResolution" in ctx:
        ctx.pop("videoResolution", None)
        result = await client._send("api_request", payload, timeout=60)
    if _unknown_field_error(result, "videoModelControlInput"):
        body.pop("videoModelControlInput", None)
        result = await client._send("api_request", payload, timeout=60)
    if isinstance(result, dict) and (
        result.get("error") or (isinstance(result.get("status"), int) and result["status"] >= 400)
    ):
        req0 = (body.get("requests") or [{}])[0] if isinstance(body.get("requests"), list) else {}
        logger.warning(
            "Omni generate HTTP %s endpoint=%s keys=%s outputSpec=%s likeness=%s data=%s",
            result.get("status"),
            endpoint,
            list(req0.keys()) if isinstance(req0, dict) else None,
            req0.get("outputSpec") if isinstance(req0, dict) else None,
            req0.get("referenceLikenesses") if isinstance(req0, dict) else None,
            json.dumps(result.get("data") or result.get("error"), default=str)[:2000],
        )
    try:
        client._last_flow_generate = {
            "endpoint": endpoint,
            "status": result.get("status") if isinstance(result, dict) else None,
            "requestKeys": list((body.get("requests") or [{}])[0].keys()) if body.get("requests") else [],
            "outputSpec": (body.get("requests") or [{}])[0].get("outputSpec") if body.get("requests") else None,
            "referenceLikenesses": (body.get("requests") or [{}])[0].get("referenceLikenesses") if body.get("requests") else None,
            "error": (result.get("data") or result.get("error")) if isinstance(result, dict) else None,
        }
    except Exception:
        pass
    return _annotate_polling(result, project_id)


async def _submit_omni_frame_video(
    *,
    start_image_media_id: str,
    end_image_media_id: str | None,
    prompt: str,
    project_id: str,
    scene_id: str = "",
    duration_s: int = 8,
    aspect_ratio: str = "VIDEO_ASPECT_RATIO_PORTRAIT",
    user_paygate_tier: str = "PAYGATE_TIER_ONE",
    seed: int | None = None,
    resolution: str = "360p",
    count: int = 1,
) -> dict:
    """Submit Omni first-frame or First+Last generation."""
    _validate_frame_inputs(
        start_image_media_id,
        end_image_media_id,
        duration_s,
        aspect_ratio,
        resolution=resolution,
        count=count,
    )

    mode = (
        "start_end_frame_to_video"
        if end_image_media_id is not None
        else "frame_to_video"
    )
    endpoint = (
        "generate_video_start_end"
        if end_image_media_id is not None
        else "generate_video"
    )
    model_key = _load_model_key(duration_s, mode=mode, resolution=resolution)
    client = get_flow_client()
    ts = int(time.time() * 1000)
    n = _normalize_count(count)
    base_seed = seed if seed is not None else ts % 1_000_000

    request_item = {
        "aspectRatio": aspect_ratio,
        "textInput": _structured_prompt(prompt),
        "videoModelKey": model_key,
        "metadata": {"sceneId": scene_id} if scene_id else {},
        "startImage": {"mediaId": start_image_media_id},
    }
    if end_image_media_id is not None:
        request_item["endImage"] = {"mediaId": end_image_media_id}

    requests = []
    for i in range(n):
        item = dict(request_item)
        item["seed"] = base_seed + i
        requests.append(item)

    context = client._client_context(project_id, user_paygate_tier)
    body = {
        "mediaGenerationContext": {"batchId": str(uuid.uuid4())},
        "clientContext": {**context, "sessionId": f";{ts}"},
        "requests": requests,
        "useV2ModelConfig": True,
    }
    return await _send_omni_generate(
        client, endpoint=endpoint, body=body, project_id=project_id,
    )


async def generate_omni_flash_first_frame_video(
    start_image_media_id: str,
    prompt: str,
    project_id: str,
    scene_id: str = "",
    duration_s: int = 8,
    aspect_ratio: str = "VIDEO_ASPECT_RATIO_PORTRAIT",
    user_paygate_tier: str = "PAYGATE_TIER_ONE",
    seed: int | None = None,
    resolution: str = "360p",
    count: int = 1,
) -> dict:
    """Submit Omni Flash First frame -> video."""
    return await _submit_omni_frame_video(
        start_image_media_id=start_image_media_id,
        end_image_media_id=None,
        prompt=prompt,
        project_id=project_id,
        scene_id=scene_id,
        duration_s=duration_s,
        aspect_ratio=aspect_ratio,
        user_paygate_tier=user_paygate_tier,
        seed=seed,
        resolution=resolution,
        count=count,
    )


async def generate_omni_flash_first_last_video(
    start_image_media_id: str,
    end_image_media_id: str,
    prompt: str,
    project_id: str,
    scene_id: str = "",
    duration_s: int = 8,
    aspect_ratio: str = "VIDEO_ASPECT_RATIO_PORTRAIT",
    user_paygate_tier: str = "PAYGATE_TIER_ONE",
    seed: int | None = None,
    resolution: str = "360p",
    count: int = 1,
) -> dict:
    """Submit Omni Flash First + Last frame -> video."""
    return await _submit_omni_frame_video(
        start_image_media_id=start_image_media_id,
        end_image_media_id=end_image_media_id,
        prompt=prompt,
        project_id=project_id,
        scene_id=scene_id,
        duration_s=duration_s,
        aspect_ratio=aspect_ratio,
        user_paygate_tier=user_paygate_tier,
        seed=seed,
        resolution=resolution,
        count=count,
    )


async def generate_omni_flash_text_video(
    prompt: str,
    project_id: str,
    scene_id: str = "",
    duration_s: int = 8,
    aspect_ratio: str = "VIDEO_ASPECT_RATIO_PORTRAIT",
    user_paygate_tier: str = "PAYGATE_TIER_ONE",
    seed: int | None = None,
    resolution: str = "360p",
    count: int = 1,
    likeness_id: str | None = None,
    likeness_handle: str = "me",
) -> dict:
    """Submit Omni Flash text-to-video, optionally with a Flow ``@me`` avatar.

    Live Flow binds ``@me`` on the ingredients endpoint with model key
    ``abra_r2v_<N>s_360p`` plus a structuredPrompt ``reference.likeness``
    chip. Plain T2V has no likeness field.
    """
    if likeness_id:
        return await generate_omni_flash_video(
            reference_media_ids=[],
            prompt=prompt,
            project_id=project_id,
            scene_id=scene_id,
            duration_s=duration_s,
            aspect_ratio=aspect_ratio,
            user_paygate_tier=user_paygate_tier,
            seed=seed,
            resolution=resolution,
            count=count,
            likeness_id=likeness_id,
            likeness_handle=likeness_handle,
        )
    _validate_duration(duration_s)
    _validate_aspect(aspect_ratio)
    n = _normalize_count(count)
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("Omni Flash text-to-video requires a non-empty prompt")
    model_key = _load_model_key(
        duration_s, mode="text_to_video", resolution=resolution,
    )
    client = get_flow_client()
    ts = int(time.time() * 1000)
    base_seed = seed if seed is not None else ts % 1_000_000
    request_item = {
        "aspectRatio": aspect_ratio,
        "textInput": _structured_prompt(prompt),
        "videoModelKey": model_key,
        "metadata": {"sceneId": scene_id} if scene_id else {},
    }
    requests = []
    for i in range(n):
        item = dict(request_item)
        item["seed"] = base_seed + i
        requests.append(item)
    context = client._client_context(project_id, user_paygate_tier)
    body = {
        "mediaGenerationContext": {
            "batchId": str(uuid.uuid4()),
            "audioFailurePreference": "BLOCK_SILENCED_VIDEOS",
        },
        "clientContext": {**context, "sessionId": f";{ts}"},
        "requests": requests,
        "useV2ModelConfig": True,
    }
    return await _send_omni_generate(
        client, endpoint="generate_video_text", body=body, project_id=project_id,
    )


async def generate_omni_flash_video(
    reference_media_ids: list[str],
    prompt: str,
    project_id: str,
    scene_id: str = "",
    duration_s: int = 8,
    aspect_ratio: str = "VIDEO_ASPECT_RATIO_PORTRAIT",
    user_paygate_tier: str = "PAYGATE_TIER_ONE",
    seed: int | None = None,
    resolution: str = "360p",
    count: int = 1,
    likeness_id: str | None = None,
    likeness_handle: str = "me",
) -> dict:
    """Submit Omni Flash ingredients (R2V), optionally with a Flow ``@me`` avatar.

    360p uses ``abra_r2v_<N>s_360p``. ``@me`` is ``referenceLikenesses``
    ``{likenessId}`` plus a structuredPrompt ``reference.likeness`` chip.
    """
    likes = _reference_likenesses(likeness_id)
    if likes:
        _validate_duration(duration_s)
        _validate_aspect(aspect_ratio)
        _normalize_resolution(resolution)
        _normalize_count(count)
        refs = [mid for mid in (reference_media_ids or []) if isinstance(mid, str) and mid]
        if len(refs) > OMNI_FLASH_MAX_REFERENCE_IMAGES:
            raise ValueError(
                f"Omni Flash accepts at most {OMNI_FLASH_MAX_REFERENCE_IMAGES} reference images"
            )
    else:
        refs = _validate_reference_inputs(
            reference_media_ids, duration_s, aspect_ratio, resolution=resolution, count=count,
        )
    model_key = _load_model_key(
        duration_s, mode="reference_to_video", resolution=resolution,
    )
    client = get_flow_client()

    ts = int(time.time() * 1000)
    n = _normalize_count(count)
    base_seed = seed if seed is not None else ts % 1_000_000
    handle = (likeness_handle or "me").lstrip("@") if likes else None
    request_item = {
        "aspectRatio": aspect_ratio,
        "textInput": _structured_prompt(
            prompt, likeness_handle=handle, likeness_id=likeness_id if likes else None,
        ),
        "videoModelKey": model_key,
        "metadata": {"sceneId": scene_id} if scene_id else {},
    }
    if refs:
        request_item["referenceImages"] = [
            {"mediaId": mid, "imageUsageType": "IMAGE_USAGE_TYPE_ASSET"}
            for mid in refs
        ]
    if likes:
        request_item["referenceLikenesses"] = likes

    requests = []
    for i in range(n):
        item = dict(request_item)
        item["seed"] = base_seed + i
        requests.append(item)
    context = client._client_context(project_id, user_paygate_tier)
    body = {
        "mediaGenerationContext": {
            "batchId": str(uuid.uuid4()),
            "audioFailurePreference": "BLOCK_SILENCED_VIDEOS",
        },
        "clientContext": {**context, "sessionId": f";{ts}"},
        "requests": requests,
        "useV2ModelConfig": True,
    }
    return await _send_omni_generate(
        client, endpoint="generate_video_references", body=body, project_id=project_id,
    )


async def check_omni_flash_status(
    workflows: list[dict],
    include_encoded_video: bool = False,
    project_id: str = "",
) -> dict:
    """Perform one non-blocking poll pass for Omni workflow-backed jobs.

    Flow's production UI exposes workflow status through its authenticated
    ``flow.projectInitialData`` tRPC response. The old ``/v1/media`` transport
    currently returns ``INVALID_ARGUMENT`` for these workflow media IDs.
    """
    normalized = []
    for workflow in workflows or []:
        item = _normalize_workflow(workflow)
        if item:
            normalized.append(item)
    if not normalized:
        raise ValueError(
            "Omni polling requires workflow descriptors with name and primary_media_id "
            "(or raw Flow metadata.primaryMediaId)"
        )

    resolved_project_id = project_id or next(
        (item.get("project_id", "") for item in normalized if item.get("project_id")),
        "",
    )
    if not resolved_project_id:
        raise ValueError(
            "Omni project polling requires project_id. Use the project_id returned "
            "inside flowkitPolling or pass project_id explicitly."
        )
    if any(
        item.get("project_id") and item["project_id"] != resolved_project_id
        for item in normalized
    ):
        raise ValueError(
            "All Omni workflows in one poll must belong to the same project_id"
        )

    client = get_flow_client()
    response = await _fetch_project_initial_data(client, resolved_project_id)
    http_status = response.get("status") if isinstance(response, dict) else None
    if isinstance(http_status, int) and http_status >= 400:
        data = response.get("data") if isinstance(response.get("data"), dict) else {}
        error = data.get("error") if isinstance(data, dict) else None
        if isinstance(error, dict):
            error = error.get("message") or error.get("code")
        raise RuntimeError(
            error
            or response.get("error")
            or f"Flow project poll failed: API_{http_status}"
        )

    envelope = response.get("data") if isinstance(response, dict) else None
    result = envelope.get("result") if isinstance(envelope, dict) else None
    result_data = result.get("data") if isinstance(result, dict) else None
    project_json = result_data.get("json") if isinstance(result_data, dict) else None
    contents = project_json.get("projectContents") if isinstance(project_json, dict) else None
    if not isinstance(contents, dict):
        raise RuntimeError("Flow project poll returned an unexpected response shape")

    project_workflows = contents.get("workflows")
    project_media = contents.get("media")
    project_workflows = project_workflows if isinstance(project_workflows, list) else []
    project_media = project_media if isinstance(project_media, list) else []
    known_workflow_names = {
        item.get("name")
        for item in project_workflows
        if isinstance(item, dict) and isinstance(item.get("name"), str)
    }
    media_by_id = {
        item.get("name"): item
        for item in project_media
        if isinstance(item, dict) and isinstance(item.get("name"), str)
    }
    media_by_workflow = {
        item.get("workflowId"): item
        for item in project_media
        if isinstance(item, dict) and isinstance(item.get("workflowId"), str)
    }

    items = []

    for workflow in normalized:
        name = workflow["name"]
        media_id = workflow["primary_media_id"]
        payload = media_by_id.get(media_id) or media_by_workflow.get(name)
        if not isinstance(payload, dict):
            items.append({
                "name": name,
                "primary_media_id": media_id,
                "project_id": resolved_project_id,
                "done": False,
                "status": "PENDING",
                "error": None,
                "workflow_present": name in known_workflow_names,
            })
            continue

        metadata = payload.get("mediaMetadata")
        metadata = metadata if isinstance(metadata, dict) else {}
        media_status = metadata.get("mediaStatus")
        media_status = media_status if isinstance(media_status, dict) else {}
        generation_status = media_status.get("mediaGenerationStatus")

        if isinstance(generation_status, str) and (
            generation_status.endswith("FAILED") or generation_status.endswith("CANCELLED")
        ):
            items.append({
                "name": name,
                "primary_media_id": media_id,
                "project_id": resolved_project_id,
                "done": True,
                "status": "FAILED",
                "error": generation_status,
            })
            continue

        if generation_status != "MEDIA_GENERATION_STATUS_SUCCESSFUL":
            items.append({
                "name": name,
                "primary_media_id": media_id,
                "project_id": resolved_project_id,
                "done": False,
                "status": "PENDING",
                "error": None,
            })
            continue

        url = None
        url_error = None
        video_block = payload.get("video") if isinstance(payload.get("video"), dict) else {}
        for key in ("fifeUrl", "videoUri", "servingUri"):
            cand = video_block.get(key)
            if isinstance(cand, str) and cand.startswith("http"):
                url = cand
                break
        real_media_id = payload.get("name") if isinstance(payload.get("name"), str) else media_id
        if not url:
            url_response = await _fetch_media_url(client, real_media_id)
            if isinstance(url_response, dict) and url_response.get("status", 500) < 400:
                url_data = url_response.get("data")
                candidate = url_data.get("url") if isinstance(url_data, dict) else None
                if isinstance(candidate, str) and candidate.startswith("https://flow-content.google/"):
                    url = candidate
                else:
                    url_error = "Flow media redirect returned no allowed URL"
            else:
                url_error = (
                    url_response.get("error")
                    if isinstance(url_response, dict)
                    else "Flow media redirect failed"
                )
        item = {
            "name": name,
            "primary_media_id": real_media_id,
            "project_id": resolved_project_id,
            "done": True,
            "status": "MEDIA_GENERATION_STATUS_SUCCESSFUL",
            "error": None,
            "media": {
                "media_id": real_media_id,
                "url": url,
                "encoded_video_available": False,
            },
        }
        if include_encoded_video:
            item["media"]["encoded_video"] = None
        if url_error:
            item["media"]["url_error"] = url_error
        items.append(item)

    all_done = bool(items) and all(item["done"] for item in items)
    any_failed = any(item.get("status") == "FAILED" for item in items)
    return {
        "project_id": resolved_project_id,
        "done": all_done,
        "status": "FAILED" if any_failed else ("COMPLETED" if all_done else "PENDING"),
        "workflows": items,
    }
