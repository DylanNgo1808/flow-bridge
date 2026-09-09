"""Credits caching — the statusline polls this endpoint on every refresh."""

import json
import time
from unittest.mock import AsyncMock, patch

import pytest

from agent.services.flow_client import FlowClient, CREDITS_CACHE_TTL


@pytest.fixture
def client():
    c = FlowClient()
    c._flow_key = "ya29.key"
    return c


def stub_send(c, payload):
    return patch.object(c, "_send", new_callable=AsyncMock, return_value=payload)


OK = {"data": {"credits": 810, "userPaygateTier": "PAYGATE_TIER_ONE"}}


class TestCreditsCache:
    @pytest.mark.asyncio
    async def test_repeat_calls_hit_the_cache(self, client):
        """The Claude Code statusline calls this on every refresh — many times a
        minute — and each miss is a real request through the extension to Google."""
        with stub_send(client, OK) as send:
            first = await client.get_credits()
            for _ in range(20):
                again = await client.get_credits()
        assert send.await_count == 1, "only the first call may reach the extension"
        assert again == first

    @pytest.mark.asyncio
    async def test_cache_expires(self, client):
        with stub_send(client, OK) as send:
            await client.get_credits()
            client._credits_cached_at = time.time() - CREDITS_CACHE_TTL - 1
            await client.get_credits()
        assert send.await_count == 2

    @pytest.mark.asyncio
    async def test_errors_are_not_cached(self, client):
        """A transient failure must not pin a bad answer for the whole TTL."""
        with stub_send(client, {"error": "Extension not connected"}) as send:
            await client.get_credits()
            await client.get_credits()
        assert send.await_count == 2

    @pytest.mark.asyncio
    async def test_a_new_flow_key_bypasses_the_cache(self, client):
        """A different account has different credits; never serve the old one."""
        with stub_send(client, OK) as send:
            await client.get_credits()
            client._flow_key = "ya29.other"
            await client.get_credits()
        assert send.await_count == 2

    @pytest.mark.asyncio
    async def test_force_refresh_bypasses_the_cache(self, client):
        with stub_send(client, OK) as send:
            await client.get_credits()
            await client.get_credits(force=True)
        assert send.await_count == 2

    @pytest.mark.asyncio
    async def test_unavailable_preferred_profile_does_not_cache_other_account(self, client):
        a, b = AsyncMock(), AsyncMock()
        for ws, key in ((a, "A"), (b, "B")):
            client.set_extension(ws)
            client._extensions[ws]["flow_key"] = key
        client._extension_ws = a
        client._flow_key = "A"
        client._extensions[a]["unavailable_until"] = time.time() + 60
        unavailable = {"error": "NO_FLOW_TAB"}

        async def respond_a(message):
            request = json.loads(message)
            await client.handle_message({"id": request["id"], **unavailable}, a)

        async def respond_b(message):
            request = json.loads(message)
            await client.handle_message({"id": request["id"], **OK}, b)

        a.send.side_effect = respond_a
        b.send.side_effect = respond_b
        first = await client.get_credits()
        explicit = await client.get_credits(flow_key="A")

        assert first.get("error") == "NO_FLOW_TAB"
        assert explicit.get("error") == "NO_FLOW_TAB"
        assert a.send.await_count == 2
        b.send.assert_not_awaited()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("body", [
        {"error": {"message": "denied"}},
        {"error": {"message": "denied"}, "credits": 810},
        {},
        None,
        "invalid response",
    ])
    async def test_invalid_http_200_body_is_not_cached(self, client, body):
        failure = {"status": 200, "data": body}
        with patch.object(client, "_send", side_effect=[failure, OK]) as send:
            assert await client.get_credits() == failure
            assert await client.get_credits() == OK
            assert await client.get_credits() == OK
        assert send.await_count == 2
