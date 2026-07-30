"""Tests for failure bundle generation (TRP4-30).

Unit tests for extract_root_cause, generate_fix_suggestion,
failure bundle structure, and integration tests for the
/run/{id}/failure-bundle endpoint.
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from server import (
    app,
    extract_root_cause,
    generate_fix_suggestion,
    build_failure_bundle,
    state,
)


# =============================================================================
# Unit Tests: extract_root_cause()
# =============================================================================

class TestExtractRootCause:
    def test_element_not_found(self):
        error = Exception("ElementNotFoundError: element #submit-btn was not found in the DOM")
        assert extract_root_cause(error) == "element_not_found"

    def test_no_such_element(self):
        error = Exception("no such element: Unable to locate element: {\"method\":\"css selector\",\"selector\":\"#submit\"}")
        assert extract_root_cause(error) == "element_not_found"

    def test_timeout(self):
        error = TimeoutError("Timed out waiting for page to load after 30000ms")
        assert extract_root_cause(error) == "timeout"

    def test_timeout_string(self):
        error = Exception("timeout: failed to load page within 10 seconds")
        assert extract_root_cause(error) == "timeout"

    def test_timed_out(self):
        error = Exception("operation timed out after 5000ms")
        assert extract_root_cause(error) == "timeout"

    def test_assertion_error(self):
        error = Exception("assertion failed: expected 5, got 3")
        assert extract_root_cause(error) == "assertion_error"

    def test_assert_plain(self):
        error = Exception("assert element.visible is True")
        assert extract_root_cause(error) == "assertion_error"

    def test_navigation_error(self):
        error = Exception("net::ERR_CONNECTION_REFUSED at https://example.com")
        assert extract_root_cause(error) == "navigation_error"

    def test_navigation_timeout(self):
        error = Exception("navigation error: failed to navigate to https://example.com")
        assert extract_root_cause(error) == "navigation_error"

    def test_stale_element(self):
        error = Exception("stale element reference: element is not attached to the page document")
        assert extract_root_cause(error) == "stale_element"

    def test_stale_element_reference(self):
        error = Exception("stale element reference: the element is no longer valid")
        assert extract_root_cause(error) == "stale_element"

    def test_unknown_error(self):
        error = Exception("Something completely unexpected happened")
        assert extract_root_cause(error) == "unknown_error"

    def test_empty_message(self):
        error = Exception("")
        assert extract_root_cause(error) == "unknown_error"

    def test_none_error(self):
        with pytest.raises(TypeError):
            extract_root_cause(None)  # type: ignore[arg-type]


# =============================================================================
# Unit Tests: generate_fix_suggestion()
# =============================================================================

class TestGenerateFixSuggestion:
    def test_element_not_found_contains_wait_or_scroll(self):
        suggestion = generate_fix_suggestion("element_not_found")
        assert suggestion and len(suggestion) > 0
        assert any(word in suggestion.lower() for word in ["wait", "scroll"])

    def test_timeout_contains_network_or_timeout(self):
        suggestion = generate_fix_suggestion("timeout")
        assert suggestion and len(suggestion) > 0
        keywords = ["increase timeout", "check network", "timeout", "network"]
        assert any(word in suggestion.lower() for word in keywords)

    def test_assertion_error_returns_suggestion(self):
        suggestion = generate_fix_suggestion("assertion_error")
        assert suggestion and len(suggestion) > 0

    def test_navigation_error_returns_suggestion(self):
        suggestion = generate_fix_suggestion("navigation_error")
        assert suggestion and len(suggestion) > 0

    def test_stale_element_returns_suggestion(self):
        suggestion = generate_fix_suggestion("stale_element")
        assert suggestion and len(suggestion) > 0

    def test_unknown_error_returns_suggestion(self):
        suggestion = generate_fix_suggestion("unknown_error")
        assert suggestion and len(suggestion) > 0

    def test_unrecognized_key_falls_back_to_unknown(self):
        suggestion = generate_fix_suggestion("some_random_error_type")
        assert suggestion and len(suggestion) > 0


# =============================================================================
# Unit Tests: failure_bundle structure
# =============================================================================

class TestBuildFailureBundle:
    def test_full_structure(self):
        bundle = build_failure_bundle(
            dom_snapshot="<html><body>Test</body></html>",
            screenshot="data:image/jpeg;base64,/9j/4AAQSkZJRg==",
            action_history=[
                {"step_number": 1, "url": "https://example.com"},
                {"step_number": 2, "url": "https://example.com/page2"},
            ],
            root_cause="element_not_found",
            fix_suggestion="Try waiting for the element to appear.",
        )

        assert "dom_snapshot" in bundle
        assert "screenshot" in bundle
        assert "action_history" in bundle
        assert "root_cause" in bundle
        assert "fix_suggestion" in bundle

        assert bundle["dom_snapshot"] == "<html><body>Test</body></html>"
        assert bundle["screenshot"] == "data:image/jpeg;base64,/9j/4AAQSkZJRg=="
        assert len(bundle["action_history"]) == 2
        assert bundle["root_cause"] == "element_not_found"
        assert bundle["fix_suggestion"] == "Try waiting for the element to appear."

    def test_null_dom_snapshot(self):
        bundle = build_failure_bundle(
            dom_snapshot=None,
            screenshot="data:image/jpeg;base64,test",
            action_history=[],
            root_cause="timeout",
            fix_suggestion="Increase the timeout duration.",
        )

        assert bundle["dom_snapshot"] is None
        assert bundle["screenshot"] is not None
        assert bundle["action_history"] == []
        assert bundle["root_cause"] == "timeout"

    def test_null_screenshot(self):
        bundle = build_failure_bundle(
            dom_snapshot="<html><body>Error</body></html>",
            screenshot=None,
            action_history=[],
            root_cause="element_not_found",
            fix_suggestion="Try waiting.",
        )

        assert bundle["dom_snapshot"] is not None
        assert bundle["screenshot"] is None

    def test_empty_action_history(self):
        bundle = build_failure_bundle(
            dom_snapshot="<html><body>Error</body></html>",
            screenshot="data:image/jpeg;base64,test",
            action_history=[],
            root_cause="navigation_error",
            fix_suggestion="Check the URL.",
        )

        assert bundle["action_history"] == []

    def test_multiple_actions_in_history(self):
        actions = [{"step_number": i} for i in range(10)]
        bundle = build_failure_bundle(
            dom_snapshot="<html></html>",
            screenshot=None,
            action_history=actions,
            root_cause="timeout",
            fix_suggestion="Increase timeout.",
        )

        assert len(bundle["action_history"]) == 10

    def test_e2e_build_from_real_error(self):
        error = Exception("ElementNotFoundError: button #submit was not found")
        root_cause = extract_root_cause(error)
        fix_suggestion = generate_fix_suggestion(root_cause)

        bundle = build_failure_bundle(
            dom_snapshot="<html><body><button>Submit</button></body></html>",
            screenshot="data:image/jpeg;base64,test",
            action_history=[{"step_number": 1}],
            root_cause=root_cause,
            fix_suggestion=fix_suggestion,
        )

        assert bundle["root_cause"] == "element_not_found"
        assert len(bundle["fix_suggestion"]) > 0
        assert bundle["dom_snapshot"] is not None
        assert bundle["screenshot"] is not None
        assert len(bundle["action_history"]) == 1


# =============================================================================
# Integration Tests: /run/{id}/failure-bundle endpoint
# =============================================================================

@pytest.fixture(autouse=True)
def reset_state():
    state.runs.clear()
    state.agents.clear()
    state.browsers.clear()
    state.tasks.clear()
    state.screenshots.clear()
    state.step_events.clear()
    state.chat_queues.clear()
    state.dom_snapshots.clear()
    state.failure_bundles.clear()


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def auth_headers():
    return {"X-Internal-Secret": "dev-secret-change-in-production"}


class TestFailureBundleEndpoint:
    def test_nonexistent_run_returns_404(self, client, auth_headers):
        response = client.get("/run/nonexistent-id/failure-bundle", headers=auth_headers)
        assert response.status_code == 404

    def test_no_auth_returns_401(self, client):
        response = client.get("/run/test-id/failure-bundle")
        assert response.status_code == 401

    def test_no_bundle_returns_null(self, client, auth_headers):
        run_id = "test-run-no-bundle"
        state.runs[run_id] = {
            "run_id": run_id,
            "status": "completed",
            "success": True,
        }

        response = client.get(f"/run/{run_id}/failure-bundle", headers=auth_headers)
        assert response.status_code == 200
        assert response.json()["failure_bundle"] is None

    def test_with_bundle(self, client, auth_headers):
        run_id = "test-run-with-bundle"
        bundle = {
            "dom_snapshot": "<html><body>Error</body></html>",
            "screenshot": "data:image/jpeg;base64,test",
            "action_history": [{"step_number": 1}],
            "root_cause": "element_not_found",
            "fix_suggestion": "Wait for the element.",
        }

        state.runs[run_id] = {
            "run_id": run_id,
            "status": "failed",
            "success": False,
            "error": "Element not found",
        }
        state.failure_bundles[run_id] = bundle

        response = client.get(f"/run/{run_id}/failure-bundle", headers=auth_headers)
        assert response.status_code == 200
        data = response.json()
        assert data["run_id"] == run_id
        assert data["failure_bundle"]["dom_snapshot"] == "<html><body>Error</body></html>"
        assert data["failure_bundle"]["root_cause"] == "element_not_found"

    def test_successful_run_returns_null_bundle(self, client, auth_headers):
        run_id = "test-successful-run"
        state.runs[run_id] = {
            "run_id": run_id,
            "status": "completed",
            "success": True,
        }

        response = client.get(f"/run/{run_id}/failure-bundle", headers=auth_headers)
        assert response.status_code == 200
        assert response.json()["failure_bundle"] is None

    def test_full_real_data_flow(self, client, auth_headers):
        run_id = "test-real-flow"
        state.step_events[run_id] = [
            {"event": "step", "step_number": 1, "url": "https://example.com"},
            {"event": "step", "step_number": 2, "url": "https://example.com/page2"},
        ]
        state.dom_snapshots[run_id] = "<html><body><button>Submit</button></body></html>"
        state.screenshots[run_id] = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="

        error = Exception("TimeoutError: page did not load within 30000ms")
        root_cause = extract_root_cause(error)
        fix_suggestion = generate_fix_suggestion(root_cause)

        bundle = build_failure_bundle(
            dom_snapshot=state.dom_snapshots.get(run_id),
            screenshot=state.screenshots.get(run_id),
            action_history=state.step_events.get(run_id, []),
            root_cause=root_cause,
            fix_suggestion=fix_suggestion,
        )
        state.failure_bundles[run_id] = bundle
        state.runs[run_id] = {
            "run_id": run_id,
            "status": "failed",
            "error": str(error),
        }

        response = client.get(f"/run/{run_id}/failure-bundle", headers=auth_headers)
        assert response.status_code == 200
        data = response.json()["failure_bundle"]

        assert data["dom_snapshot"] is not None
        assert data["screenshot"] is not None
        assert len(data["action_history"]) == 2
        assert data["root_cause"] == "timeout"
        assert any(w in data["fix_suggestion"].lower() for w in ["timeout", "network"])

    def test_missing_dom_snapshot_is_null(self, client, auth_headers):
        run_id = "test-no-dom"
        state.step_events[run_id] = []
        state.failure_bundles[run_id] = build_failure_bundle(
            dom_snapshot=None,
            screenshot=None,
            action_history=[],
            root_cause="navigation_error",
            fix_suggestion="Check URL.",
        )
        state.runs[run_id] = {"run_id": run_id, "status": "failed"}

        response = client.get(f"/run/{run_id}/failure-bundle", headers=auth_headers)
        assert response.status_code == 200
        data = response.json()["failure_bundle"]
        assert data["dom_snapshot"] is None
