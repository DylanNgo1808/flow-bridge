"""Unit tests for agent/worker/processor.py — heavy mocking of crud, flow_client, operations."""

import aiosqlite
from datetime import datetime, timedelta, timezone

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from agent.worker.processor import (
    _is_already_completed,
    _mark_scene_failed,
    _handle_failure,
    _age_seconds,
    _backoff_seconds,
    WorkerController,
    CAPTCHA_MAX_RETRIES,
    BACKOFF_CAP_SECONDS,
)
from agent.db import crud
from agent.config import MAX_RETRIES, STALE_PROCESSING_TIMEOUT


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_req(
    req_type="GENERATE_IMAGE",
    scene_id="scene-001",
    orientation="VERTICAL",
    retry_count=0,
    rid="aaaaaaaa-bbbb-cccc-dddd-000000000001",
):
    return {
        "id": rid,
        "type": req_type,
        "scene_id": scene_id,
        "orientation": orientation,
        "retry_count": retry_count,
        "project_id": "proj-001",
        "video_id": "video-001",
    }


# ---------------------------------------------------------------------------
# _is_already_completed
# ---------------------------------------------------------------------------

class TestIsAlreadyCompleted:
    @pytest.mark.asyncio
    async def test_returns_true_when_vertical_image_completed(self, sample_scene_row):
        """Should return True when vertical_image_status is COMPLETED."""
        req = make_req(req_type="GENERATE_IMAGE", scene_id="scene-001")
        # sample_scene_row has vertical_image_status = "COMPLETED"
        with patch("agent.worker.processor.crud") as mock_crud:
            mock_crud.get_scene = AsyncMock(return_value=sample_scene_row)
            result = await _is_already_completed(req, "VERTICAL")
        assert result is True

    @pytest.mark.asyncio
    async def test_returns_false_when_vertical_image_pending(self, sample_scene_row):
        """Should return False when vertical_image_status is PENDING."""
        pending_scene = {**sample_scene_row, "vertical_image_status": "PENDING"}
        req = make_req(req_type="GENERATE_IMAGE", scene_id="scene-001")
        with patch("agent.worker.processor.crud") as mock_crud:
            mock_crud.get_scene = AsyncMock(return_value=pending_scene)
            result = await _is_already_completed(req, "VERTICAL")
        assert result is False

    @pytest.mark.asyncio
    async def test_returns_false_for_generate_character_image(self, sample_scene_row):
        """GENERATE_CHARACTER_IMAGE has no scene — should always return False."""
        req = make_req(req_type="GENERATE_CHARACTER_IMAGE", scene_id="scene-001")
        with patch("agent.worker.processor.crud") as mock_crud:
            mock_crud.get_scene = AsyncMock(return_value=sample_scene_row)
            result = await _is_already_completed(req, "VERTICAL")
        assert result is False
        mock_crud.get_scene.assert_not_called()

    @pytest.mark.asyncio
    async def test_returns_false_when_no_scene_id(self):
        """If scene_id is missing, should return False without querying DB."""
        req = make_req(req_type="GENERATE_IMAGE", scene_id=None)
        with patch("agent.worker.processor.crud") as mock_crud:
            mock_crud.get_scene = AsyncMock()
            result = await _is_already_completed(req, "VERTICAL")
        assert result is False
        mock_crud.get_scene.assert_not_called()

    @pytest.mark.asyncio
    async def test_edit_image_never_skipped_even_when_image_completed(self, sample_scene_row):
        """EDIT_IMAGE should always run — it replaces the existing image."""
        req = make_req(req_type="EDIT_IMAGE", scene_id="scene-001")
        # sample_scene_row has vertical_image_status = "COMPLETED"
        with patch("agent.worker.processor.crud") as mock_crud:
            mock_crud.get_scene = AsyncMock(return_value=sample_scene_row)
            result = await _is_already_completed(req, "VERTICAL")
        assert result is False


# ---------------------------------------------------------------------------
# _mark_scene_failed
# ---------------------------------------------------------------------------

class TestMarkSceneFailed:
    @pytest.mark.asyncio
    async def test_sets_vertical_image_status_failed_for_generate_image(self):
        req = make_req(req_type="GENERATE_IMAGE", scene_id="scene-001", orientation="VERTICAL")
        with patch("agent.worker.processor.crud") as mock_crud:
            mock_crud.update_scene = AsyncMock()
            await _mark_scene_failed(req)
        mock_crud.update_scene.assert_awaited_once_with("scene-001", vertical_image_status="FAILED")

    @pytest.mark.asyncio
    async def test_sets_vertical_video_status_failed_for_generate_video(self):
        req = make_req(req_type="GENERATE_VIDEO", scene_id="scene-001", orientation="VERTICAL")
        with patch("agent.worker.processor.crud") as mock_crud:
            mock_crud.update_scene = AsyncMock()
            await _mark_scene_failed(req)
        mock_crud.update_scene.assert_awaited_once_with("scene-001", vertical_video_status="FAILED")

    @pytest.mark.asyncio
    async def test_sets_vertical_upscale_status_failed_for_upscale_video(self):
        req = make_req(req_type="UPSCALE_VIDEO", scene_id="scene-001", orientation="VERTICAL")
        with patch("agent.worker.processor.crud") as mock_crud:
            mock_crud.update_scene = AsyncMock()
            await _mark_scene_failed(req)
        mock_crud.update_scene.assert_awaited_once_with("scene-001", vertical_upscale_status="FAILED")

    @pytest.mark.asyncio
    async def test_no_update_when_no_scene_id(self):
        req = make_req(req_type="GENERATE_IMAGE", scene_id=None)
        with patch("agent.worker.processor.crud") as mock_crud:
            mock_crud.update_scene = AsyncMock()
            await _mark_scene_failed(req)
        mock_crud.update_scene.assert_not_called()


# ---------------------------------------------------------------------------
# _handle_failure
# ---------------------------------------------------------------------------

class TestHandleFailure:
    @pytest.mark.asyncio
    async def test_retries_when_under_max_retries(self):
        """When retry_count+1 < MAX_RETRIES, request should go back to PENDING."""
        req = make_req(retry_count=0)
        rid = req["id"]
        result = {"error": "timeout"}

        with patch("agent.worker.processor.crud") as mock_crud:
            mock_crud.update_request = AsyncMock()
            mock_crud.update_scene = AsyncMock()
            await _handle_failure(rid, req, result)

        mock_crud.update_request.assert_awaited_once()
        call_kwargs = mock_crud.update_request.call_args
        assert call_kwargs[0][0] == rid
        assert call_kwargs[1]["status"] == "PENDING"
        assert call_kwargs[1]["retry_count"] == 1

    @pytest.mark.asyncio
    async def test_marks_failed_when_at_max_retries(self):
        """When retry_count+1 >= MAX_RETRIES, request + scene should be marked FAILED."""
        req = make_req(req_type="GENERATE_IMAGE", scene_id="scene-001", retry_count=MAX_RETRIES - 1)
        rid = req["id"]
        result = {"error": "permanent failure"}

        with patch("agent.worker.processor.crud") as mock_crud:
            mock_crud.update_request = AsyncMock()
            mock_crud.update_scene = AsyncMock()
            await _handle_failure(rid, req, result)

        mock_crud.update_request.assert_awaited_once()
        call_kwargs = mock_crud.update_request.call_args
        assert call_kwargs[0][0] == rid
        assert call_kwargs[1]["status"] == "FAILED"
        # Scene should also be marked failed
        mock_crud.update_scene.assert_awaited_once_with("scene-001", vertical_image_status="FAILED")

    @pytest.mark.asyncio
    async def test_extracts_error_message_from_nested_data(self):
        """Error message extraction from data.error.message should work."""
        req = make_req(retry_count=MAX_RETRIES - 1)
        rid = req["id"]
        result = {
            "data": {
                "error": {
                    "code": 403,
                    "message": "caller does not have permission",
                }
            }
        }

        with patch("agent.worker.processor.crud") as mock_crud:
            mock_crud.update_request = AsyncMock()
            mock_crud.update_scene = AsyncMock()
            await _handle_failure(rid, req, result)

        call_kwargs = mock_crud.update_request.call_args
        assert "caller does not have permission" in call_kwargs[1]["error_message"]


# ---------------------------------------------------------------------------
# _age_seconds
# ---------------------------------------------------------------------------

class TestAgeSeconds:
    def test_parses_crud_timestamp_format(self):
        now = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
        assert _age_seconds("2026-01-01T11:30:00Z", now) == 1800.0

    @pytest.mark.parametrize("bad", ["", None, "not-a-date", "2026-01-01 11:30:00"])
    def test_returns_none_for_unparseable(self, bad):
        """An unreadable timestamp must not be treated as infinitely old."""
        assert _age_seconds(bad) is None


# ---------------------------------------------------------------------------
# WorkerController._sweep_stale_processing
# ---------------------------------------------------------------------------

def stale_row(rid, age_seconds, req_type="GENERATE_VIDEO"):
    ts = datetime.now(timezone.utc) - timedelta(seconds=age_seconds)
    return {
        "id": rid,
        "type": req_type,
        "status": "PROCESSING",
        "updated_at": ts.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


class TestSweepStaleProcessing:
    @pytest.mark.asyncio
    async def test_resets_row_older_than_timeout(self):
        """A PROCESSING row nobody is working on is an orphan — return it to PENDING."""
        wc = WorkerController()
        row = stale_row("orphan-1", STALE_PROCESSING_TIMEOUT + 60)

        with patch("agent.worker.processor.crud") as mock_crud:
            mock_crud.list_requests = AsyncMock(return_value=[row])
            mock_crud.reset_processing_request = AsyncMock()
            await wc._sweep_stale_processing()

        mock_crud.reset_processing_request.assert_awaited_once()
        args, kwargs = mock_crud.reset_processing_request.call_args
        assert args[0] == "orphan-1"
        assert "stale PROCESSING" in kwargs["error_message"]

    @pytest.mark.asyncio
    async def test_never_touches_a_request_this_worker_is_running(self):
        """The guard that makes the timeout safe: in-flight work outranks age."""
        wc = WorkerController()
        wc._active_ids.add("live-1")
        row = stale_row("live-1", STALE_PROCESSING_TIMEOUT * 10)

        with patch("agent.worker.processor.crud") as mock_crud:
            mock_crud.list_requests = AsyncMock(return_value=[row])
            mock_crud.reset_processing_request = AsyncMock()
            await wc._sweep_stale_processing()

        mock_crud.reset_processing_request.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_leaves_row_younger_than_timeout(self):
        wc = WorkerController()
        row = stale_row("young-1", STALE_PROCESSING_TIMEOUT - 60)

        with patch("agent.worker.processor.crud") as mock_crud:
            mock_crud.list_requests = AsyncMock(return_value=[row])
            mock_crud.reset_processing_request = AsyncMock()
            await wc._sweep_stale_processing()

        mock_crud.reset_processing_request.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_leaves_row_with_unparseable_timestamp(self):
        wc = WorkerController()
        row = {"id": "weird-1", "type": "GENERATE_VIDEO", "status": "PROCESSING", "updated_at": "???"}

        with patch("agent.worker.processor.crud") as mock_crud:
            mock_crud.list_requests = AsyncMock(return_value=[row])
            mock_crud.reset_processing_request = AsyncMock()
            await wc._sweep_stale_processing()

        mock_crud.reset_processing_request.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_db_error_does_not_escape(self):
        """The sweep runs inside the worker loop; it must never take the loop down."""
        wc = WorkerController()
        with patch("agent.worker.processor.crud") as mock_crud:
            mock_crud.list_requests = AsyncMock(side_effect=RuntimeError("db gone"))
            mock_crud.reset_processing_request = AsyncMock()
            await wc._sweep_stale_processing()
        mock_crud.reset_processing_request.assert_not_awaited()


# ---------------------------------------------------------------------------
# reCAPTCHA retry backoff
# ---------------------------------------------------------------------------

class TestCaptchaBackoff:
    @pytest.mark.asyncio
    async def test_captcha_retry_schedules_backoff(self):
        """Retrying captcha immediately drives the reCAPTCHA score down — back off."""
        req = make_req(retry_count=0)
        rid = req["id"]
        before = datetime.now(timezone.utc)

        with patch("agent.worker.processor.crud") as mock_crud:
            mock_crud.update_request = AsyncMock()
            mock_crud.update_scene = AsyncMock()
            await _handle_failure(rid, req, {"error": "CAPTCHA_FAILED: timeout"})

        deadline = datetime.strptime(mock_crud.update_request.call_args.kwargs["next_retry_at"],
                                     "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        assert 19 <= (deadline - before).total_seconds() <= 21
        assert mock_crud.update_request.call_args[1]["status"] == "PENDING"
        assert mock_crud.update_request.call_args[1]["retry_count"] == 1

    @pytest.mark.asyncio
    async def test_captcha_gets_more_retries_than_generic_errors(self):
        """A captcha failure at the generic ceiling should still be retried."""
        req = make_req(retry_count=MAX_RETRIES)
        rid = req["id"]

        with patch("agent.worker.processor.crud") as mock_crud:
            mock_crud.update_request = AsyncMock()
            mock_crud.update_scene = AsyncMock()
            await _handle_failure(rid, req, {"error": "recaptcha rejected"})

        assert mock_crud.update_request.call_args[1]["status"] == "PENDING"

    @pytest.mark.asyncio
    async def test_captcha_fails_permanently_at_its_own_ceiling(self):
        req = make_req(req_type="GENERATE_IMAGE", scene_id="scene-001",
                       retry_count=CAPTCHA_MAX_RETRIES - 1)
        rid = req["id"]

        with patch("agent.worker.processor.crud") as mock_crud:
            mock_crud.update_request = AsyncMock()
            mock_crud.update_scene = AsyncMock()
            await _handle_failure(rid, req, {"error": "CAPTCHA_FAILED"})

        assert mock_crud.update_request.call_args[1]["status"] == "FAILED"
        mock_crud.update_scene.assert_awaited_once_with("scene-001", vertical_image_status="FAILED")

    def test_backoff_grows_and_is_capped(self):
        seq = [_backoff_seconds(i) for i in range(1, 10)]
        assert seq == sorted(seq), "backoff must be non-decreasing"
        assert max(seq) <= BACKOFF_CAP_SECONDS


@pytest.mark.asyncio
@pytest.mark.parametrize("error", ["timeout", "CAPTCHA_FAILED"])
async def test_retry_deadline_is_durable_and_filters_scheduler(error):
    async with aiosqlite.connect(":memory:") as db:
        db.row_factory = aiosqlite.Row
        await db.execute("CREATE TABLE request (id TEXT, type TEXT, status TEXT, retry_count INTEGER, next_retry_at TEXT, error_message TEXT, updated_at TEXT, created_at TEXT)")
        await db.execute("INSERT INTO request VALUES ('retry', 'GENERATE_IMAGE', 'PROCESSING', 0, NULL, NULL, NULL, '2026-01-01T00:00:00Z')")
        with patch.object(crud, "get_db", AsyncMock(return_value=db)):
            before = datetime.now(timezone.utc)
            await _handle_failure("retry", make_req(rid="retry"), {"error": error})
            row = await crud.get_request("retry")
            deadline = datetime.strptime(row["next_retry_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            assert 19 <= (deadline - before).total_seconds() <= 21
            assert row["retry_count"] == 1
            assert row["status"] == "PENDING"
            assert await crud.list_actionable_requests(limit=1) == []
            with patch.object(crud, "_now", return_value=row["next_retry_at"]):
                assert [r["id"] for r in await crud.list_actionable_requests()] == ["retry"]


@pytest.mark.asyncio
@pytest.mark.parametrize("new_status", ["COMPLETED", "FAILED", "PENDING", "PROCESSING"])
async def test_sweep_does_not_clobber_status_changed_after_select(new_status):
    async with aiosqlite.connect(":memory:") as db:
        db.row_factory = aiosqlite.Row
        await db.execute("CREATE TABLE request (id TEXT, status TEXT, error_message TEXT, updated_at TEXT)")
        await db.execute("INSERT INTO request VALUES ('race', ?, 'preserve', 'original')", (new_status,))
        selected = stale_row("race", STALE_PROCESSING_TIMEOUT + 60)
        with patch.object(crud, "get_db", AsyncMock(return_value=db)), \
             patch.object(crud, "list_requests", AsyncMock(return_value=[selected])):
            await WorkerController()._sweep_stale_processing()
            row = await crud.get_request("race")
        if new_status == "PROCESSING":
            assert row["status"] == "PENDING"
            assert "stale PROCESSING" in row["error_message"]
        else:
            assert row["status"] == new_status
            assert row["error_message"] == "preserve"
            assert row["updated_at"] == "original"
