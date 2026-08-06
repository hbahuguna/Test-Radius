"""Tests for TRP4-36 browser-agent video recording."""

import asyncio
import os
import time
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient

import server


@pytest.fixture(autouse=True)
def clean_video_state(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "VIDEO_ROOT", tmp_path / "videos")
    server.VIDEO_ROOT.mkdir(parents=True, exist_ok=True)
    server.state.runs.clear()
    server.state.tasks.clear()
    server.state.video_dirs.clear()
    server.state.video_paths.clear()
    yield
    server.state.runs.clear()
    server.state.tasks.clear()
    server.state.video_dirs.clear()
    server.state.video_paths.clear()


def test_video_directory_is_unique_per_run():
    assert server.video_directory("run-a") != server.video_directory("run-b")
    assert server.video_directory("run-a").parent == server.VIDEO_ROOT


def test_finalize_video_records_finalized_mp4(tmp_path):
    run_id = "run-video"
    run_dir = server.video_directory(run_id)
    run_dir.mkdir(parents=True)
    video_path = run_dir / "recording.mp4"
    video_path.write_bytes(b"valid-enough-for-unit-test")
    server.state.runs[run_id] = {"status": "running"}
    server.state.video_dirs[run_id] = run_dir

    watchdog = MagicMock()
    watchdog.stop_recording = AsyncMock(return_value=video_path)
    browser = MagicMock()
    browser._recording_watchdog = watchdog

    result = asyncio.run(server.finalize_video(run_id, browser))

    assert result == video_path.resolve()
    assert server.state.video_paths[run_id] == video_path.resolve()
    watchdog.stop_recording.assert_awaited_once()


def test_finalize_video_returns_none_when_recording_fails():
    run_id = "run-no-video"
    server.state.runs[run_id] = {"status": "running"}
    watchdog = MagicMock()
    watchdog.stop_recording = AsyncMock(side_effect=OSError("disk full"))
    browser = MagicMock()
    browser._recording_watchdog = watchdog

    assert asyncio.run(server.finalize_video(run_id, browser)) is None
    assert run_id not in server.state.video_paths


def test_cleanup_removes_expired_video_and_preserves_recent_video(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "VIDEO_TTL_SECONDS", 3600)
    old_dir = server.video_directory("old-run")
    new_dir = server.video_directory("new-run")
    old_dir.mkdir(parents=True)
    new_dir.mkdir(parents=True)
    old_time = time.time() - 7200
    os.utime(old_dir, (old_time, old_time))

    assert server.cleanup_expired_videos() == 1
    assert not old_dir.exists()
    assert new_dir.exists()


def test_cleanup_does_not_remove_active_run():
    run_id = "active-run"
    run_dir = server.video_directory(run_id)
    run_dir.mkdir(parents=True)
    old_time = time.time() - 7200
    os.utime(run_dir, (old_time, old_time))
    server.state.runs[run_id] = {"status": "running"}

    assert server.cleanup_expired_videos() == 0
    assert run_dir.exists()


def test_video_endpoint_requires_known_run_and_returns_mp4():
    run_id = "endpoint-run"
    video_path = server.video_directory(run_id) / "recording.mp4"
    video_path.parent.mkdir(parents=True)
    video_path.write_bytes(b"mp4 test data")
    server.state.runs[run_id] = {"status": "completed"}
    server.state.video_paths[run_id] = video_path.resolve()

    with TestClient(server.app) as client:
        response = client.get(f"/run/{run_id}/video", headers={"X-Internal-Secret": server.INTERNAL_SECRET})

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("video/mp4")
    assert response.content == b"mp4 test data"


def test_video_endpoint_rejects_unknown_run_and_path_traversal():
    with TestClient(server.app) as client:
        unknown = client.get("/run/unknown/video", headers={"X-Internal-Secret": server.INTERNAL_SECRET})
        traversal = client.get("/run/../etc/video", headers={"X-Internal-Secret": server.INTERNAL_SECRET})

    assert unknown.status_code == 404
    assert traversal.status_code in {404, 405}
