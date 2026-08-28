"""Direct Flow API endpoints — for manual operations outside the queue."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Literal, Optional

from agent.services.flow_client import get_flow_client
from agent.services.omni_flash import (
    check_omni_flash_status,
    generate_omni_flash_first_frame_video,
    generate_omni_flash_first_last_video,
    generate_omni_flash_text_video,
    generate_omni_flash_video,
)

router = APIRouter(prefix="/flow", tags=["flow"])


class GenerateImageRequest(BaseModel):
    prompt: str
    project_id: str
    aspect_ratio: str = "IMAGE_ASPECT_RATIO_PORTRAIT"
    user_paygate_tier: str = "PAYGATE_TIER_ONE"
    character_media_ids: Optional[list[str]] = None


class GenerateVideoRequest(BaseModel):
    start_image_media_id: str
    prompt: str
    project_id: str
    scene_id: str
    aspect_ratio: str = "VIDEO_ASPECT_RATIO_PORTRAIT"
    end_image_media_id: Optional[str] = None
    user_paygate_tier: str = "PAYGATE_TIER_ONE"
    # Backward compatible: legacy requests remain Veo unless explicitly set.
    model_family: Literal["veo", "omni_flash"] = "veo"
    duration_s: int = 8
    resolution: str = "360p"
    count: int = 1


class GenerateVideoRefsRequest(BaseModel):
    reference_media_ids: list[str]
    prompt: str
    project_id: str
    scene_id: str
    aspect_ratio: str = "VIDEO_ASPECT_RATIO_PORTRAIT"
    user_paygate_tier: str = "PAYGATE_TIER_ONE"
    # Backward compatible: existing callers keep the Veo R2V path unless they
    # explicitly opt into Omni Flash.
    model_family: Literal["veo", "omni_flash"] = "veo"
    duration_s: int = 8
    resolution: str = "360p"
    count: int = 1


class GenerateOmniFlashVideoRequest(BaseModel):
    reference_media_ids: list[str] = []
    prompt: str
    project_id: str
    scene_id: str = ""
    duration_s: int = 8
    aspect_ratio: str = "VIDEO_ASPECT_RATIO_PORTRAIT"
    user_paygate_tier: str = "PAYGATE_TIER_ONE"
    resolution: str = "360p"
    count: int = 1
    likeness_id: Optional[str] = None
    likeness_handle: str = "me"


class GenerateOmniTextVideoRequest(BaseModel):
    prompt: str
    project_id: str
    scene_id: str = ""
    duration_s: int = 8
    aspect_ratio: str = "VIDEO_ASPECT_RATIO_PORTRAIT"
    user_paygate_tier: str = "PAYGATE_TIER_ONE"
    resolution: str = "360p"
    count: int = 1
    likeness_id: Optional[str] = None
    likeness_handle: str = "me"


class UpscaleVideoRequest(BaseModel):
    media_id: str
    scene_id: str
    aspect_ratio: str = "VIDEO_ASPECT_RATIO_PORTRAIT"
    resolution: str = "VIDEO_RESOLUTION_4K"


class UploadImageRequest(BaseModel):
    file_path: str  # absolute path to local image file
    project_id: str = ""
    file_name: str = "image.png"


class CheckStatusRequest(BaseModel):
    operations: list[dict] = []
    # Omni/workflow-mode callers should pass workflow descriptors instead of
    # operation handles. If workflows is set, /check-status automatically uses
    # authenticated Flow project polling.
    workflows: Optional[list[dict]] = None
    project_id: str = ""
    include_encoded_video: bool = False


class CheckOmniStatusRequest(BaseModel):
    workflows: list[dict]
    project_id: str = ""
    include_encoded_video: bool = False


class EditImageRequest(BaseModel):
    prompt: str
    source_media_id: str
    project_id: str
    aspect_ratio: str = "IMAGE_ASPECT_RATIO_PORTRAIT"
    user_paygate_tier: str = "PAYGATE_TIER_ONE"


@router.get("/status")
async def extension_status():
    """Check if extension is connected."""
    client = get_flow_client()
    return {
        "connected": client.connected,
        "flow_key_present": client._flow_key is not None,
    }


@router.get("/last-generate")
async def last_generate():
    """Last Flow generate payload captured from the live UI or a bridge submit."""
    client = get_flow_client()
    return {"capture": getattr(client, "_last_flow_generate", None)}


@router.get("/credits")
async def get_credits():
    """Get user credits from Google Flow."""
    client = get_flow_client()
    if not client.connected:
        raise HTTPException(503, "Extension not connected")
    result = await client.get_credits()
    if result.get("error"):
        raise HTTPException(502, result["error"])
    return result.get("data", result)


@router.post("/generate-image")
async def generate_image(body: GenerateImageRequest):
    """Generate image directly (bypasses queue)."""
    client = get_flow_client()
    if not client.connected:
        raise HTTPException(503, "Extension not connected")
    result = await client.generate_images(**body.model_dump())
    if result.get("error") or (isinstance(result.get("status"), int) and result["status"] >= 400):
        raise HTTPException(result.get("status", 502), result.get("error", result.get("data")))
    return result.get("data", result)


@router.post("/generate-video")
async def generate_video(body: GenerateVideoRequest):
    """Submit frame-conditioned video generation using Veo or Omni Flash.

    Existing callers default to Veo. For Omni set ``model_family=omni_flash``
    and ``duration_s`` to 4/6/8/10. With only ``start_image_media_id`` the
    request uses Omni First frame. When ``end_image_media_id`` is also present,
    it uses Omni First+Last frames.

    Omni responses include ``flowkitPolling.workflows`` and must use workflow
    media polling rather than legacy operation polling.
    """
    client = get_flow_client()
    if not client.connected:
        raise HTTPException(503, "Extension not connected")

    if body.model_family == "omni_flash":
        try:
            common = dict(
                start_image_media_id=body.start_image_media_id,
                prompt=body.prompt,
                project_id=body.project_id,
                scene_id=body.scene_id,
                duration_s=body.duration_s,
                aspect_ratio=body.aspect_ratio,
                user_paygate_tier=body.user_paygate_tier,
                resolution=body.resolution,
                count=body.count,
            )
            if body.end_image_media_id:
                result = await generate_omni_flash_first_last_video(
                    end_image_media_id=body.end_image_media_id,
                    **common,
                )
            else:
                result = await generate_omni_flash_first_frame_video(**common)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
    else:
        result = await client.generate_video(
            **body.model_dump(
                exclude={"model_family", "duration_s", "resolution", "count"},
                exclude_none=True,
            )
        )

    if result.get("error") or (isinstance(result.get("status"), int) and result["status"] >= 400):
        raise HTTPException(result.get("status", 502), result.get("error", result.get("data")))
    return result.get("data", result)


@router.post("/generate-video-refs")
async def generate_video_refs(body: GenerateVideoRefsRequest):
    """Submit reference-to-video generation using Veo or Gemini Omni Flash.

    Existing requests default to ``model_family=veo``. Set
    ``model_family=omni_flash`` and ``duration_s`` to 4/6/8/10 to use Omni.
    Omni responses include ``flowkitPolling.workflows``; poll those workflows,
    not the operation-looking handles in the raw Flow response.
    """
    client = get_flow_client()
    if not client.connected:
        raise HTTPException(503, "Extension not connected")

    if body.model_family == "omni_flash":
        try:
            result = await generate_omni_flash_video(
                reference_media_ids=body.reference_media_ids,
                prompt=body.prompt,
                project_id=body.project_id,
                scene_id=body.scene_id,
                duration_s=body.duration_s,
                aspect_ratio=body.aspect_ratio,
                user_paygate_tier=body.user_paygate_tier,
                resolution=body.resolution,
                count=body.count,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
    else:
        result = await client.generate_video_from_references(
            **body.model_dump(exclude={"model_family", "duration_s", "resolution", "count"})
        )

    if result.get("error") or (isinstance(result.get("status"), int) and result["status"] >= 400):
        raise HTTPException(result.get("status", 502), result.get("error", result.get("data")))
    return result.get("data", result)


@router.post("/generate-video-omni")
async def generate_video_omni(body: GenerateOmniFlashVideoRequest):
    """Submit Gemini Omni Flash reference-to-video generation.

    The response includes ``flowkitPolling.workflows`` for the correct
    workflow/media polling path.
    """
    client = get_flow_client()
    if not client.connected:
        raise HTTPException(503, "Extension not connected")
    try:
        result = await generate_omni_flash_video(**body.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if result.get("error") or (isinstance(result.get("status"), int) and result["status"] >= 400):
        raise HTTPException(result.get("status", 502), result.get("error", result.get("data")))
    return result.get("data", result)


@router.post("/generate-video-text")
async def generate_video_text(body: GenerateOmniTextVideoRequest):
    """Submit Omni Flash text-to-video, optionally with a Flow ``@me`` avatar.

    Pass ``likeness_id`` (from projectContents.likenesses) so Flow uses the
    recorded visual + voice, not a still start frame.
    """
    client = get_flow_client()
    if not client.connected:
        raise HTTPException(503, "Extension not connected")
    try:
        result = await generate_omni_flash_text_video(**body.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if result.get("error") or (isinstance(result.get("status"), int) and result["status"] >= 400):
        raise HTTPException(
            result.get("status", 502),
            result.get("data") or result.get("error"),
        )
    return result.get("data", result)


@router.post("/upscale-video")
async def upscale_video(body: UpscaleVideoRequest):
    """Submit video upscale (returns operations for polling)."""
    client = get_flow_client()
    if not client.connected:
        raise HTTPException(503, "Extension not connected")
    result = await client.upscale_video(**body.model_dump())
    if result.get("error") or (isinstance(result.get("status"), int) and result["status"] >= 400):
        raise HTTPException(result.get("status", 502), result.get("error", result.get("data")))
    return result.get("data", result)


@router.post("/check-status")
async def check_status(body: CheckStatusRequest):
    """Check Veo operation status or Omni workflow/media status.

    Veo: pass ``operations``.
    Omni Flash: pass ``workflows`` from submit ``flowkitPolling.workflows``.
    """
    client = get_flow_client()
    if not client.connected:
        raise HTTPException(503, "Extension not connected")

    if body.workflows:
        try:
            return await check_omni_flash_status(
                body.workflows,
                include_encoded_video=body.include_encoded_video,
                project_id=body.project_id,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(502, str(exc)) from exc

    if not body.operations:
        raise HTTPException(400, "Provide operations for Veo or workflows for Omni Flash")

    result = await client.check_video_status(body.operations)
    if result.get("error"):
        raise HTTPException(502, result["error"])
    if isinstance(result.get("status"), int) and result["status"] >= 400:
        raise HTTPException(result["status"], result.get("data", "Flow polling failed"))
    return result.get("data", result)


@router.post("/check-omni-status")
async def check_omni_status(body: CheckOmniStatusRequest):
    """Poll Gemini Omni Flash jobs via workflow primary media IDs."""
    client = get_flow_client()
    if not client.connected:
        raise HTTPException(503, "Extension not connected")
    try:
        return await check_omni_flash_status(
            body.workflows,
            include_encoded_video=body.include_encoded_video,
            project_id=body.project_id,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc


@router.get("/project-contents/{project_id}")
async def project_contents(project_id: str):
    """Slim Flow project snapshot — workflows + media status/urls."""
    from agent.services.omni_flash import _fetch_project_initial_data

    client = get_flow_client()
    if not client.connected:
        raise HTTPException(503, "Extension not connected")
    response = await _fetch_project_initial_data(client, project_id)
    envelope = response.get("data") if isinstance(response, dict) else None
    result = envelope.get("result") if isinstance(envelope, dict) else None
    result_data = result.get("data") if isinstance(result, dict) else None
    project_json = result_data.get("json") if isinstance(result_data, dict) else None
    contents = project_json.get("projectContents") if isinstance(project_json, dict) else None
    if not isinstance(contents, dict):
        raise HTTPException(502, "Flow project snapshot missing projectContents")

    media_out = []
    for item in contents.get("media") or []:
        if not isinstance(item, dict):
            continue
        meta = item.get("mediaMetadata") if isinstance(item.get("mediaMetadata"), dict) else {}
        status = ((meta.get("mediaStatus") or {}) if isinstance(meta.get("mediaStatus"), dict) else {})
        video = item.get("video") if isinstance(item.get("video"), dict) else {}
        request_data = meta.get("requestData") if isinstance(meta.get("requestData"), dict) else {}

        def _slim_rd(obj, depth=0):
            if depth > 5:
                return "..."
            if isinstance(obj, dict):
                out = {}
                for k, v in list(obj.items())[:50]:
                    if isinstance(v, str) and (k.lower().endswith("bytes") or len(v) > 240):
                        out[k] = f"<{len(v)} chars>"
                    else:
                        out[k] = _slim_rd(v, depth + 1)
                return out
            if isinstance(obj, list):
                return [_slim_rd(x, depth + 1) for x in obj[:6]]
            return obj

        media_out.append({
            "name": item.get("name"),
            "workflowId": item.get("workflowId"),
            "generation_status": status.get("mediaGenerationStatus"),
            "fifeUrl": video.get("fifeUrl") or video.get("videoUri") or video.get("servingUri"),
            "has_encoded_video": bool(video.get("encodedVideo")),
            "meta_title": meta.get("mediaTitle"),
            "request_data": _slim_rd(request_data),
        })
    extra = {}
    for key in contents:
        if key in ("media", "workflows"):
            continue
        val = contents.get(key)
        if isinstance(val, list):
            slim = []
            for item in val[:30]:
                if not isinstance(item, dict):
                    slim.append(item)
                    continue
                copy = {
                    k: (f"<{k} {len(v)} chars>" if k.lower().endswith("bytes") and isinstance(v, str) else v)
                    for k, v in item.items()
                }
                slim.append(copy)
            extra[key] = slim
        elif isinstance(val, dict):
            extra[key] = {"_keys": list(val.keys())[:40], **{k: val[k] for k in list(val)[:8]}}
        else:
            extra[key] = val

    workflows_out = []
    for w in contents.get("workflows") or []:
        if not isinstance(w, dict):
            continue
        meta = w.get("metadata") if isinstance(w.get("metadata"), dict) else {}
        workflows_out.append({
            "name": w.get("name"),
            "primaryMediaId": meta.get("primaryMediaId"),
            "displayName": meta.get("displayName"),
        })

    return {
        "project_id": project_id,
        "content_keys": list(contents.keys()),
        "project_keys": list(project_json.keys()) if isinstance(project_json, dict) else [],
        "workflows": workflows_out,
        "media": media_out,
        "extra": extra,
    }


@router.post("/refresh-urls/{project_id}")
async def refresh_project_urls(project_id: str):
    """Bulk refresh all media URLs for a project via per-media get_media calls."""
    client = get_flow_client()
    if not client.connected:
        raise HTTPException(503, "Extension not connected")
    result = await client.refresh_project_urls(project_id)
    if result.get("error"):
        raise HTTPException(502, result["error"])
    return result


@router.get("/media/{media_id}")
async def get_media(media_id: str):
    """Get media metadata + fresh signed URL from Google Flow.

    Returns the raw response which may contain ``video.encodedVideo`` for
    workflow-backed video generations.
    """
    client = get_flow_client()
    if not client.connected:
        raise HTTPException(503, "Extension not connected")
    result = await client.get_media(media_id)
    if result.get("error"):
        raise HTTPException(502, result["error"])
    status = result.get("status", 200)
    if isinstance(status, int) and status >= 400:
        raise HTTPException(status, result.get("data", "Media not found"))
    return result.get("data", result)


@router.post("/edit-image")
async def edit_image(body: EditImageRequest):
    """Edit an existing image using IMAGE_INPUT_TYPE_BASE_IMAGE (bypasses queue)."""
    client = get_flow_client()
    if not client.connected:
        raise HTTPException(503, "Extension not connected")
    result = await client.edit_image(
        body.prompt, body.source_media_id, body.project_id,
        aspect_ratio=body.aspect_ratio,
        user_paygate_tier=body.user_paygate_tier,
    )
    if result.get("error") or (isinstance(result.get("status"), int) and result["status"] >= 400):
        raise HTTPException(result.get("status", 502), result.get("error", result.get("data")))
    return result.get("data", result)


@router.post("/upload-image")
async def upload_image(body: UploadImageRequest):
    """Upload a local image file to Google Flow and get a media_id."""
    import base64, mimetypes
    client = get_flow_client()
    if not client.connected:
        raise HTTPException(503, "Extension not connected")
    try:
        with open(body.file_path, "rb") as f:
            image_bytes = f.read()
    except FileNotFoundError:
        raise HTTPException(404, f"File not found: {body.file_path}")
    b64 = base64.b64encode(image_bytes).decode()
    mime = mimetypes.guess_type(body.file_path)[0] or "image/png"
    result = await client.upload_image(b64, mime_type=mime, project_id=body.project_id, file_name=body.file_name)
    if result.get("error") or (isinstance(result.get("status"), int) and result["status"] >= 400):
        raise HTTPException(result.get("status", 502), result.get("error", result.get("data")))
    media_id = result.get("_mediaId")
    return {"media_id": media_id, "raw": result.get("data", result)}
