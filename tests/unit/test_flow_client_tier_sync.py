"""Tier-sync throttling — token_captured fires constantly, syncing must not."""

import asyncio
import json
import time
from unittest.mock import AsyncMock, patch

import pytest

from agent.services.flow_client import (
    FlowClient, TIER_SYNC_MIN_INTERVAL, TIER_SYNC_RETRY_INTERVAL,
    TIER_SYNC_CACHE_SIZE,
)


@pytest.fixture
def client():
    c = FlowClient()
    c._flow_key = "ya29.key-one"
    with patch("agent.db.crud.list_projects", new_callable=AsyncMock, return_value=[]):
        yield c


async def sync(c):
    c._maybe_sync_tier()
    await asyncio.gather(*c._tier_sync_tasks.values())


@pytest.mark.asyncio
class TestMaybeSyncTier:
    async def test_first_call_syncs(self, client):
        with patch.object(client, "get_credits", new_callable=AsyncMock, return_value={}) as credits:
            await sync(client)
            credits.assert_awaited_once_with(flow_key=client._flow_key)
            assert client._flow_key in client._tier_synced_at

    async def test_repeat_calls_within_the_window_do_not_sync(self, client):
        with patch.object(client, "get_credits", new_callable=AsyncMock, return_value={}) as credits:
            await sync(client)
            for _ in range(50):
                await sync(client)
            assert credits.await_count == 1

    async def test_a_new_key_syncs_immediately(self, client):
        with patch.object(client, "get_credits", new_callable=AsyncMock, return_value={}) as credits:
            await sync(client)
            client._flow_key = "ya29.key-two"
            await sync(client)
            assert credits.await_count == 2

    async def test_syncs_again_once_the_window_elapses(self, client):
        with patch.object(client, "get_credits", new_callable=AsyncMock, return_value={}) as credits:
            await sync(client)
            client._tier_synced_at[client._flow_key] = time.monotonic() - TIER_SYNC_MIN_INTERVAL - 1
            await sync(client)
            assert credits.await_count == 2

    async def test_key_going_absent_does_not_sync(self, client):
        with patch.object(client, "get_credits", new_callable=AsyncMock, return_value={}) as credits:
            await sync(client)
            client._flow_key = None
            await sync(client)
            assert credits.await_count == 1
            assert None not in client._tier_synced_at

    async def test_key_change_in_flight_is_queued_and_only_success_is_cached(self, client):
        started, release = asyncio.Event(), asyncio.Event()

        async def credits(*, flow_key):
            if flow_key == "A":
                started.set()
                await release.wait()
            return {"data": {"userPaygateTier": flow_key}}

        with patch.object(client, "get_credits", side_effect=credits) as get_credits, \
                patch("agent.db.crud.list_projects", new_callable=AsyncMock,
                      return_value=[{"id": "project"}]), \
                patch("agent.db.crud.update_project", new_callable=AsyncMock) as update:
            await client.handle_message({"type": "token_captured", "flowKey": "A"})
            await started.wait()
            for key in ("B", "A", "B"):
                await client.handle_message({"type": "token_captured", "flowKey": key})
            await asyncio.sleep(0)
            assert client._tier_synced_at == {}
            assert get_credits.await_count == 1
            release.set()
            await asyncio.gather(*client._tier_sync_tasks.values())
            assert [c.kwargs["flow_key"] for c in get_credits.await_args_list] == ["A", "B"]
            assert set(client._tier_synced_at) == {"A", "B"}
            assert update.await_args.kwargs["user_paygate_tier"] == "B"

    async def test_alternating_profiles_sync_once_per_key(self, client):
        profiles = {key: object() for key in ("A", "B")}
        for ws in profiles.values():
            client.set_extension(ws)
        with patch.object(client, "get_credits", new_callable=AsyncMock, return_value={}) as credits:
            for key in ("A", "B", "A", "B"):
                await client.handle_message({"type": "token_captured", "flowKey": key}, profiles[key])
                await asyncio.gather(*client._tier_sync_tasks.values())
            assert [c.kwargs["flow_key"] for c in credits.await_args_list] == ["A", "B"]

    @pytest.mark.parametrize("failure", [RuntimeError("offline"), {"error": "offline"},
                                        {"status": 503, "data": {}},
                                        {"data": {"error": "denied"}}])
    async def test_failure_retries_soon_without_caching_or_updating(self, client, failure):
        with patch.object(client, "get_credits", side_effect=[failure, {}]) as credits, \
                patch("agent.db.crud.update_project", new_callable=AsyncMock) as update:
            await sync(client)
            assert client._tier_synced_at == {}
            update.assert_not_awaited()
            await sync(client)
            assert credits.await_count == 1
            client._tier_failed_at[client._flow_key] -= TIER_SYNC_RETRY_INTERVAL + 1
            await sync(client)
            assert credits.await_count == 2
            assert client._flow_key in client._tier_synced_at
            assert client._flow_key not in client._tier_failed_at

    @pytest.mark.parametrize("result", [{}, {"error": "offline"}])
    async def test_token_history_is_bounded(self, client, result):
        with patch.object(client, "get_credits", new_callable=AsyncMock, return_value=result):
            for i in range(TIER_SYNC_CACHE_SIZE + 2):
                client._flow_key = str(i)
                await sync(client)
            history = client._tier_failed_at if result else client._tier_synced_at
            assert len(history) == TIER_SYNC_CACHE_SIZE
            assert "0" not in history and "1" not in history

    async def test_queued_key_uses_its_own_profile(self, client):
        a, b = AsyncMock(), AsyncMock()
        for ws, key in ((a, "A"), (b, "B")):
            client.set_extension(ws)
            client._extensions[ws]["flow_key"] = key
        client._extension_ws = b
        client._flow_key = "B"

        async def respond(message):
            request = json.loads(message)
            await client.handle_message({"id": request["id"], "data": {}}, a)

        a.send.side_effect = respond
        await client._sync_tier("A")
        a.send.assert_awaited_once()
        b.send.assert_not_awaited()
        assert "A" in client._tier_synced_at
