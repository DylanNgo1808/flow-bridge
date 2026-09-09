"""Worker retry and recovery against a real SQLite database.

Every other test of this code mocks `crud` wholesale, which means the SQL these
paths depend on — the next_retry_at column, the filter in
list_actionable_requests, the conditional UPDATE in reset_processing_request —
is never exercised. That blind spot is not hypothetical: the three tests
covering _handle_failure patched a module attribute that had been refactored
away, so they errored at setup and the retry logic went untested for however
long. These run against a temporary database file instead; the live
flow_agent.db is never touched, so the running agent's worker cannot pick up a
row this module creates.
"""
import pathlib
import tempfile
from datetime import datetime, timedelta, timezone

import pytest


@pytest.fixture
async def db(monkeypatch):
    """A real, empty database on a temp path, with crud pointed at it."""
    import agent.config as cfg
    import agent.db.schema as schema

    tmpdir = tempfile.TemporaryDirectory()
    path = pathlib.Path(tmpdir.name) / "worker_integration.db"
    monkeypatch.setattr(cfg, "DB_PATH", path)
    monkeypatch.setattr(schema, "DB_PATH", path)
    monkeypatch.setattr(schema, "_db_connection", None)

    await schema.init_db()
    yield schema
    await schema.close_db()
    tmpdir.cleanup()


@pytest.fixture
async def scene_request(db):
    """Factory for a persisted request row attached to a real project/video/scene."""
    from agent.db import crud

    project = await crud.create_project(name="worker-integration")
    video = await crud.create_video(project_id=project["id"], title="v")
    scene = await crud.create_scene(video_id=video["id"], display_order=0, prompt="p")

    async def make(req_type="GENERATE_IMAGE"):
        return await crud.create_request(
            req_type, orientation="VERTICAL", project_id=project["id"],
            video_id=video["id"], scene_id=scene["id"],
        )

    return make


def ts(**delta):
    return (datetime.now(timezone.utc) + timedelta(**delta)).strftime("%Y-%m-%dT%H:%M:%SZ")


class TestRetryDeadlineIsDurable:
    async def test_captcha_failure_writes_a_deadline_the_scheduler_honours(self, scene_request):
        """The whole point of moving the deadline into the DB: the scheduler,
        which re-reads rows every tick, has to be able to see it."""
        from agent.db import crud
        from agent.worker import processor

        req = await scene_request()
        rid = req["id"]

        await processor._handle_failure(rid, {**req, "retry_count": 0},
                                        {"error": "CAPTCHA_FAILED: timeout"})

        row = await crud.get_request(rid)
        assert row["status"] == "PENDING"
        assert row["retry_count"] == 1
        assert row["next_retry_at"], "a captcha retry must schedule, not fire immediately"
        # Must round-trip through the same format crud._now() writes, or the
        # SQL comparison in list_actionable_requests silently misbehaves.
        datetime.strptime(row["next_retry_at"], "%Y-%m-%dT%H:%M:%SZ")

        actionable = {r["id"] for r in await crud.list_actionable_requests(limit=50)}
        assert rid not in actionable, "the deadline must hide the row from the scheduler"

        await crud.update_request(rid, next_retry_at=ts(seconds=-5))
        actionable = {r["id"] for r in await crud.list_actionable_requests(limit=50)}
        assert rid in actionable, "an elapsed deadline must release the row"

    async def test_generic_failure_also_writes_a_deadline(self, scene_request):
        from agent.db import crud
        from agent.worker import processor

        req = await scene_request("GENERATE_VIDEO")
        await processor._handle_failure(req["id"], {**req, "retry_count": 1},
                                        {"error": "Internal error encountered"})
        assert (await crud.get_request(req["id"]))["next_retry_at"]


class TestConditionalReset:
    async def test_resets_only_while_still_processing(self, scene_request):
        """Guards the sweep against clobbering a row that completed between the
        SELECT that found it and the UPDATE that resets it."""
        from agent.db import crud

        req = await scene_request()
        await crud.update_request(req["id"], status="PROCESSING")

        assert await crud.reset_processing_request(req["id"], "orphan") is True
        assert (await crud.get_request(req["id"]))["status"] == "PENDING"
        assert await crud.reset_processing_request(req["id"], "orphan") is False


class TestStaleSweep:
    async def test_recovers_an_orphan(self, scene_request, db):
        from agent.db import crud
        from agent.worker.processor import WorkerController, STALE_PROCESSING_TIMEOUT

        req = await scene_request("UPSCALE_VIDEO")
        await crud.update_request(req["id"], status="PROCESSING")
        conn = await db.get_db()
        await conn.execute("UPDATE request SET updated_at=? WHERE id=?",
                           (ts(seconds=-(STALE_PROCESSING_TIMEOUT + 120)), req["id"]))
        await conn.commit()

        await WorkerController()._sweep_stale_processing()
        assert (await crud.get_request(req["id"]))["status"] == "PENDING"

    async def test_never_touches_work_this_worker_is_running(self, scene_request, db):
        """The guard that makes the timeout safe to set at all."""
        from agent.db import crud
        from agent.worker.processor import WorkerController, STALE_PROCESSING_TIMEOUT

        req = await scene_request("GENERATE_VIDEO")
        await crud.update_request(req["id"], status="PROCESSING")
        conn = await db.get_db()
        await conn.execute("UPDATE request SET updated_at=? WHERE id=?",
                           (ts(seconds=-(STALE_PROCESSING_TIMEOUT * 10)), req["id"]))
        await conn.commit()

        controller = WorkerController()
        controller._active_ids.add(req["id"])
        await controller._sweep_stale_processing()
        assert (await crud.get_request(req["id"]))["status"] == "PROCESSING"

    async def test_leaves_a_young_row_alone(self, scene_request):
        from agent.db import crud
        from agent.worker.processor import WorkerController

        req = await scene_request()
        await crud.update_request(req["id"], status="PROCESSING")
        await WorkerController()._sweep_stale_processing()
        assert (await crud.get_request(req["id"]))["status"] == "PROCESSING"
