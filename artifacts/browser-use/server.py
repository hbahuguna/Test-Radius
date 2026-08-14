#!/usr/bin/env python3
"""
TestRadius Browser-Use Service
A FastAPI wrapper around browser-use with TestRadius authentication.
Supports per-step screenshots, agent reasoning, and chat interaction.
"""

import os
import sys
import uuid
import asyncio
import logging
import json
import base64
import shutil
import re
from contextlib import asynccontextmanager
from typing import Optional, Dict, Any, List
from datetime import datetime
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

from fastapi import FastAPI, HTTPException, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
import uvicorn

from browser_use import Agent, Browser, BrowserProfile
from browser_use.agent.views import AgentHistory, AgentOutput, AgentHistoryList


class EarlyScreenshotAgent(Agent):
    """Agent subclass that emits a screenshot right after initial navigation."""

    def __init__(self, *args, on_initial_screenshot=None, **kwargs):
        super().__init__(*args, **kwargs)
        self._on_initial_screenshot = on_initial_screenshot

    async def _execute_initial_actions(self):
        await super()._execute_initial_actions()
        if self._on_initial_screenshot:
            try:
                page = await self.browser_session.get_current_page()
                if page:
                    raw_b64 = await page.screenshot(format='jpeg', quality=70)
                    screenshot_b64 = f"data:image/jpeg;base64,{raw_b64}"
                    await self._on_initial_screenshot(screenshot_b64)
            except Exception as e:
                self.logger.warning(f'Failed to capture early screenshot: {e}')

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

INTERNAL_SECRET = os.getenv("BROWSER_USE_INTERNAL_SECRET", "dev-secret-change-in-production")
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
POOLSIDE_API_KEY = os.getenv("POOLSIDE_API_KEY", "")

VIDEO_ROOT = Path(os.getenv("BROWSER_VIDEO_DIR", "/tmp/browser-agent-videos")).expanduser().resolve()
VIDEO_ENABLED = os.getenv("BROWSER_VIDEO_ENABLED", "true").lower() not in {"0", "false", "no"}
VIDEO_TTL_SECONDS = int(os.getenv("BROWSER_VIDEO_TTL_SECONDS", "3600"))
VIDEO_CLEANUP_INTERVAL_SECONDS = int(os.getenv("BROWSER_VIDEO_CLEANUP_INTERVAL_SECONDS", "900"))
VIDEO_WIDTH = int(os.getenv("BROWSER_VIDEO_WIDTH", "1280"))
VIDEO_HEIGHT = int(os.getenv("BROWSER_VIDEO_HEIGHT", "720"))
VIDEO_FRAMERATE = int(os.getenv("BROWSER_VIDEO_FPS", "30"))
VIDEO_FINALIZE_TIMEOUT_SECONDS = int(os.getenv("BROWSER_VIDEO_FINALIZE_TIMEOUT", "15"))

if VIDEO_TTL_SECONDS <= 0 or VIDEO_CLEANUP_INTERVAL_SECONDS <= 0:
    raise ValueError("BROWSER_VIDEO_TTL_SECONDS and BROWSER_VIDEO_CLEANUP_INTERVAL_SECONDS must be positive")
if VIDEO_WIDTH <= 0 or VIDEO_HEIGHT <= 0 or VIDEO_FRAMERATE <= 0:
    raise ValueError("BROWSER_VIDEO_WIDTH, BROWSER_VIDEO_HEIGHT, and BROWSER_VIDEO_FPS must be positive")

if VIDEO_ENABLED:
    VIDEO_ROOT.mkdir(parents=True, exist_ok=True)

logger.info(f"INTERNAL_SECRET loaded: {INTERNAL_SECRET[:10]}..." if INTERNAL_SECRET else "INTERNAL_SECRET NOT SET")
logger.info(f"POOLSIDE_API_KEY loaded: {POOLSIDE_API_KEY[:15]}..." if POOLSIDE_API_KEY else "POOLSIDE_API_KEY NOT SET")


class RunRequest(BaseModel):
    url: str
    goal: str
    model_id: str = Field(default="openai/gpt-4o", description="LLM model ID")
    max_steps: int = Field(default=50, description="Maximum number of steps")
    poolside_api_key: Optional[str] = Field(default=None, description="Poolside API key")
    opencode_api_key: Optional[str] = Field(default=None, description="OpenCode Zen API key")
    model_provider: Optional[str] = Field(default=None, description="Model provider override")
    use_vision: bool = Field(default=False, description="Send screenshots to model (set false for text-only models)")
    keep_alive: bool = Field(default=True, description="Keep browser alive for follow-up")
    cdp_url: Optional[str] = Field(default=None, description="CDP URL to connect to an existing browser instead of launching one (e.g. ws://127.0.0.1:9222)")
    redact_values: bool = Field(default=True, description="Redact sensitive input values in action traces (set false for recording)")
    api_key: Optional[str] = Field(default=None, description="Generic API key for any OpenAI-compatible provider")
    base_url: Optional[str] = Field(default=None, description="Generic Base URL for any OpenAI-compatible provider")


class ChatRequest(BaseModel):
    message: str


class RunResponse(BaseModel):
    run_id: str
    status: str
    message: str
    cdp_url: Optional[str] = None  # CDP WebSocket URL for shadow recorder


class AgentStateManager:
    """Manages agent, browser, and run state."""
    def __init__(self):
        self.runs: Dict[str, Dict[str, Any]] = {}
        self.agents: Dict[str, Agent] = {}
        self.browsers: Dict[str, Browser] = {}
        self.tasks: Dict[str, asyncio.Task] = {}
        self.screenshots: Dict[str, str] = {}
        self.step_events: Dict[str, List[Dict]] = {}
        self.chat_queues: Dict[str, asyncio.Queue] = {}
        self.dom_snapshots: Dict[str, str] = {}
        self.failure_bundles: Dict[str, Dict] = {}
        self.video_paths: Dict[str, Path] = {}
        self.video_dirs: Dict[str, Path] = {}

    def get_run(self, run_id: str) -> Optional[Dict]:
        return self.runs.get(run_id)

    def set_screenshot(self, run_id: str, screenshot_b64: str):
        self.screenshots[run_id] = screenshot_b64

    def get_screenshot(self, run_id: str) -> Optional[str]:
        return self.screenshots.get(run_id)

    def add_step_event(self, run_id: str, event: Dict):
        if run_id not in self.step_events:
            self.step_events[run_id] = []
        self.step_events[run_id].append(event)

    def get_step_events(self, run_id: str) -> List[Dict]:
        return self.step_events.get(run_id, [])

    def set_dom_snapshot(self, run_id: str, snapshot: Optional[str]):
        if not hasattr(self, 'dom_snapshots'):
            self.dom_snapshots: Dict[str, str] = {}
        self.dom_snapshots[run_id] = snapshot

    def get_dom_snapshot(self, run_id: str) -> Optional[str]:
        if not hasattr(self, 'dom_snapshots'):
            self.dom_snapshots: Dict[str, str] = {}
        return self.dom_snapshots.get(run_id)

    def set_failure_bundle(self, run_id: str, bundle: Optional[Dict]):
        if not hasattr(self, 'failure_bundles'):
            self.failure_bundles: Dict[str, Dict] = {}
        self.failure_bundles[run_id] = bundle

    def get_failure_bundle(self, run_id: str) -> Optional[Dict]:
        if not hasattr(self, 'failure_bundles'):
            self.failure_bundles: Dict[str, Dict] = {}
        return self.failure_bundles.get(run_id)


state = AgentStateManager()


def video_directory(run_id: str) -> Path:
    """Return the isolated recording directory for a Python run."""
    return VIDEO_ROOT / run_id


def is_safe_run_id(run_id: str) -> bool:
    return bool(run_id) and run_id.replace("-", "").isalnum() and "/" not in run_id and "\\" not in run_id


async def finalize_video(run_id: str, browser: Optional[Browser]) -> Optional[Path]:
    """Stop the recorder and retain only a non-empty, in-root MP4 file."""
    if not VIDEO_ENABLED or run_id in state.video_paths:
        return state.video_paths.get(run_id)

    video_path: Optional[Path] = None
    try:
        watchdog = getattr(browser, "_recording_watchdog", None)
        if watchdog is not None:
            video_path = await watchdog.stop_recording()

        run_dir = state.video_dirs.get(run_id, video_directory(run_id)).resolve()
        if video_path is None:
            candidates = sorted(run_dir.glob("*.mp4"), key=lambda path: path.stat().st_mtime, reverse=True)
            video_path = candidates[0] if candidates else None

        if video_path is None:
            return None

        resolved = Path(video_path).resolve()
        if run_dir not in resolved.parents or resolved.suffix.lower() != ".mp4":
            logger.warning("Ignoring video outside run directory for %s", run_id)
            return None
        if not resolved.is_file() or resolved.stat().st_size == 0:
            return None

        state.video_paths[run_id] = resolved
        state.runs.setdefault(run_id, {})["video_path"] = str(resolved)
        return resolved
    except Exception as exc:
        logger.warning("Video finalization failed for %s: %s", run_id, exc)
        return None


async def finalize_video_safe(run_id: str, browser: Optional[Browser]) -> Optional[Path]:
    """Finalize the run video but never block the run/stream past a hard cap.

    A stuck mp4 encoder (run_in_executor ffmpeg save) must not stall the run task:
    when it does, the `/run/{id}/stream` endpoint keepalives forever and the UI
    appears frozen at the last step even though the agent already finished.
    """
    try:
        return await asyncio.wait_for(finalize_video(run_id, browser), timeout=VIDEO_FINALIZE_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        logger.warning("Video finalization timed out after %ss for %s", VIDEO_FINALIZE_TIMEOUT_SECONDS, run_id)
        return None
    except Exception as exc:
        logger.warning("Video finalization failed for %s: %s", run_id, exc)
        return None


def cleanup_expired_videos(now: Optional[float] = None) -> int:
    """Delete expired, inactive run directories without leaving the configured root."""
    if not VIDEO_ENABLED or not VIDEO_ROOT.exists():
        return 0

    current_time = now if now is not None else datetime.now().timestamp()
    cutoff = current_time - VIDEO_TTL_SECONDS
    deleted = 0
    for candidate in VIDEO_ROOT.iterdir():
        run = state.runs.get(candidate.name)
        if (
            not candidate.is_dir()
            or candidate.name in state.tasks
            or run is not None and run.get("status") in {"pending", "running"}
        ):
            continue
        try:
            if candidate.resolve().parent != VIDEO_ROOT or candidate.stat().st_mtime >= cutoff:
                continue
            shutil.rmtree(candidate)
            state.video_paths.pop(candidate.name, None)
            state.video_dirs.pop(candidate.name, None)
            deleted += 1
        except OSError as exc:
            logger.warning("Failed to clean video directory %s: %s", candidate, exc)
    return deleted


async def video_cleanup_loop() -> None:
    while True:
        try:
            deleted = await asyncio.to_thread(cleanup_expired_videos)
            if deleted:
                logger.info("Cleaned up %s expired browser videos", deleted)
            await asyncio.sleep(VIDEO_CLEANUP_INTERVAL_SECONDS)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Video cleanup iteration failed")


def verify_internal_secret(x_internal_secret: str = Header(default="", alias="X-Internal-Secret")) -> bool:
    if x_internal_secret != INTERNAL_SECRET:
        raise HTTPException(status_code=401, detail="Invalid internal secret")
    return True


def get_llm(
    model_id: str,
    poolside_api_key: Optional[str] = None,
    opencode_api_key: Optional[str] = None,
    model_provider: Optional[str] = None,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
):
    from browser_use.llm import ChatOpenAI

    # Generic base_url and api_key override
    if base_url and api_key:
        logger.info(f"get_llm: using custom base_url={base_url} and api_key={'SET' if api_key else 'None'}")
        return ChatOpenAI(
            model=model_id,
            base_url=base_url,
            api_key=api_key,
            timeout=180,
        )

    # OpenCode Zen
    if model_provider == "opencode" or opencode_api_key:
        return ChatOpenAI(
            model=model_id.removeprefix("opencode/"),
            base_url=os.getenv("OPENCODE_BASE_URL", "https://opencode.ai/zen/v1"),
            api_key=opencode_api_key or os.getenv("OPENCODE_API_KEY", ""),
            add_schema_to_system_prompt=True,
            dont_force_structured_output=True,
        )

    # OpenRouter
    if model_provider == "openrouter" or "openrouter" in model_id.lower():
        return ChatOpenAI(
            model=model_id,
            base_url="https://openrouter.ai/api/v1",
            api_key=OPENROUTER_API_KEY,
        )

    # Poolside
    api_key = poolside_api_key or POOLSIDE_API_KEY
    logger.info(f"get_llm: model_id={model_id}, poolside_api_key={'SET' if poolside_api_key else 'None'}, env_key={'SET' if POOLSIDE_API_KEY else 'EMPTY'}, resolved_key={'SET' if api_key else 'EMPTY'}")

    if api_key:
        poolside_model = model_id
        if poolside_model in ('openai/gpt-4o', 'openai/gpt-4o-mini'):
            poolside_model = 'o4-mini'
        return ChatOpenAI(
            model=poolside_model,
            base_url="https://inference.poolside.ai/v1",
            api_key=api_key,
            max_completion_tokens=16384,
            timeout=180,
            reasoning_models=[poolside_model, 'o4-mini', 'o3', 'o3-mini', 'o1', 'o1-pro', 'o3-pro', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano'],
        )

    # Fallback: OpenAI env or Poolside
    return ChatOpenAI(
        model=model_id,
        api_key=os.getenv("OPENAI_API_KEY", "") or POOLSIDE_API_KEY,
    )


def format_action_name(action_model) -> str:
    """Format action model into human-readable description."""
    action_dict = action_model.model_dump(exclude_none=True) if hasattr(action_model, 'model_dump') else action_model
    for key, value in action_dict.items():
        if key == "interacted_element":
            continue
        if isinstance(value, dict):
            params = []
            for k, v in value.items():
                if v is not None:
                    params.append(f"{k}={repr(v)}")
            return f"{key}({', '.join(params)})"
        elif value is not None:
            return f"{key}({repr(value)})"
    return str(action_dict)


def format_model_output(output) -> Dict[str, Any]:
    """Format AgentOutput into structured event data."""
    if output is None:
        return {}

    result = {
        "thinking": getattr(output, 'thinking', None),
        "evaluation_previous_goal": getattr(output, 'evaluation_previous_goal', None),
        "memory": getattr(output, 'memory', None),
        "next_goal": getattr(output, 'next_goal', None),
        "actions": [],
    }

    if hasattr(output, 'action') and output.action:
        for action in output.action:
            raw = str(action)
            if hasattr(action, 'model_dump'):
                try:
                    raw = action.model_dump(mode='json', exclude_none=True)
                except Exception:
                    raw = str(action)
            result["actions"].append({
                "name": format_action_name(action),
                "raw": raw,
            })

    return result


def _snake_case(name: str) -> str:
    """Convert a CamelCase class name to snake_case (ClickElementAction -> click_element)."""
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def format_action_trace(model_output: Any, browser_state: Any, redact_values: bool = True) -> List[Dict[str, Any]]:
    """Serialize model actions with the DOM elements Browser-use resolved."""
    if not model_output or not getattr(model_output, "action", None):
        return []

    dom_state = getattr(browser_state, "dom_state", None)
    selector_map = getattr(dom_state, "selector_map", {}) if dom_state else {}
    try:
        interacted = AgentHistory.get_interacted_element(model_output, selector_map)
    except Exception:
        interacted = [None] * len(model_output.action)

    trace: List[Dict[str, Any]] = []
    for index, action in enumerate(model_output.action):
        raw = action.model_dump(mode="json", exclude_none=True) if hasattr(action, "model_dump") else str(action)
        # Browser-use 2.x builds every action as an instance of ONE dynamic
        # union class whose __name__ is literally "ActionModel", so class-name
        # snake_casing is useless. Each individual action model carries exactly
        # one field named after the action (e.g. {"click": {...}}), so derive
        # the name from the dump keys instead.
        action_name = ""
        if isinstance(raw, dict):
            action_keys = [k for k in raw if k != "interacted_element"]
            if len(action_keys) == 1:
                action_name = action_keys[0]
        if not action_name:
            # Fallback for older browser-use versions whose action classes have
            # distinct names (e.g. ClickElementAction -> click_element).
            action_name = _snake_case(action.__class__.__name__)
        if redact_values and isinstance(raw, dict) and any(token in action_name.lower() for token in ("input", "type", "fill")):
            raw = dict(raw)
            for key, value in raw.items():
                if isinstance(value, dict):
                    value = dict(value)
                    for k in ("text", "value", "input"):
                        if k in value:
                            value[k] = "{{TEST_VALUE}}"
                    raw[key] = value
                elif key in ("text", "value", "input"):
                    raw[key] = "{{TEST_VALUE}}"
        element = interacted[index].to_dict() if index < len(interacted) and interacted[index] else None
        if element and isinstance(element.get("attributes"), dict):
            element = dict(element)
            element["attributes"] = {
                key: value
                for key, value in element["attributes"].items()
                if key not in {"value", "data-value", "data-token"}
            }
        trace.append({
            "action": action_name,
            "raw": raw,
            "element": element,
        })
    return trace


def extract_root_cause(error: Exception) -> str:
    """Extract a machine-readable root cause string from an exception."""
    if error is None:
        raise TypeError("extract_root_cause requires a non-None exception")
    error_str = str(error).lower()

    if "stale element" in error_str:
        return "stale_element"
    if "element not found" in error_str or "no such element" in error_str or "elementnotfound" in error_str:
        return "element_not_found"
    if "timeout" in error_str or "timed out" in error_str:
        return "timeout"
    if "assertion" in error_str or "assert " in error_str:
        return "assertion_error"
    if "navigation" in error_str or "net::err" in error_str or "net_err" in error_str:
        return "navigation_error"
    return "unknown_error"


def generate_fix_suggestion(root_cause: str) -> str:
    """Generate a human-readable fix suggestion based on root cause."""
    suggestions = {
        "element_not_found": "Wait for the element to appear using an explicit wait, or check if the element is inside an iframe/shadow DOM. Consider scrolling the element into view before interacting.",
        "timeout": "Increase the timeout duration or check network connectivity. The page may be loading slowly. Consider simplifying the task or adding wait steps.",
        "assertion_error": "Verify the expected value against the actual page content. The page structure may have changed. Check for dynamic content that may not have loaded.",
        "navigation_error": "Check that the URL is correct and accessible. The page may require authentication or may be temporarily down.",
        "stale_element": "The element was removed from the DOM. Refresh the page reference and retry the interaction.",
        "unknown_error": "Review the agent configuration and page compatibility. Check the browser console for JavaScript errors.",
    }
    return suggestions.get(root_cause, suggestions["unknown_error"])


def build_failure_bundle(
    dom_snapshot: Optional[str],
    screenshot: Optional[str],
    action_history: List[Dict],
    root_cause: str,
    fix_suggestion: str,
) -> Dict:
    """Build a failure bundle dict from the given components."""
    return {
        "dom_snapshot": dom_snapshot,
        "screenshot": screenshot,
        "action_history": action_history,
        "root_cause": root_cause,
        "fix_suggestion": fix_suggestion,
    }


async def run_agent_task(run_id: str, request: RunRequest):
    """Run the browser-use agent with step callbacks."""
    nav_failed = False
    try:
        logger.info(f"Run request: url={request.url}, model_id={request.model_id}, use_vision={request.use_vision}")
        logger.info(f"Creating LLM for model_id={request.model_id}")

        task_text = f"{request.url}\n\nGoal: {request.goal}"
        llm = get_llm(
            model_id=request.model_id,
            poolside_api_key=request.poolside_api_key,
            opencode_api_key=request.opencode_api_key,
            model_provider=request.model_provider,
            api_key=request.api_key,
            base_url=request.base_url,
        )
        logger.info(f"LLM created: {type(llm).__name__}")

        # Create browser
        # Use Playwright's bundled Chromium if available (avoids conflicts with running Chrome)
        playwright_candidate = os.getenv("BROWSER_USE_EXECUTABLE_PATH")
        if not playwright_candidate:
            try:
                from playwright.async_api import async_playwright
                async with async_playwright() as p:
                    playwright_candidate = p.chromium.executable_path
            except Exception as e:
                logger.warning(f"Could not resolve Playwright Chromium path: {e}")
        logger.info(f"Using browser executable: {playwright_candidate or 'browser-use default discovery'}")
        run_video_dir = video_directory(run_id)
        if VIDEO_ENABLED:
            run_video_dir.mkdir(parents=True, exist_ok=True)
            state.video_dirs[run_id] = run_video_dir

        # Create browser — either launch a new one or connect to an existing CDP url
        playwright_candidate = os.getenv("BROWSER_USE_EXECUTABLE_PATH")
        if not playwright_candidate:
            try:
                from playwright.async_api import async_playwright
                async with async_playwright() as p:
                    playwright_candidate = p.chromium.executable_path
            except Exception as e:
                logger.warning(f"Could not resolve Playwright Chromium path: {e}")
        logger.info(f"Using browser executable: {playwright_candidate or 'browser-use default discovery'}")
        run_video_dir = video_directory(run_id)
        if VIDEO_ENABLED:
            run_video_dir.mkdir(parents=True, exist_ok=True)
            state.video_dirs[run_id] = run_video_dir

        browser_profile_kwargs: dict = {
            "headless": True,
            "record_video_dir": run_video_dir if VIDEO_ENABLED else None,
            "record_video_size": {"width": VIDEO_WIDTH, "height": VIDEO_HEIGHT} if VIDEO_ENABLED else None,
            "record_video_framerate": VIDEO_FRAMERATE,
        }
        # If cdp_url is provided, connect to an existing browser instead of launching
        if request.cdp_url:
            browser_profile_kwargs["cdp_url"] = request.cdp_url
            logger.info(f"Connecting to existing browser via CDP: {request.cdp_url}")
        else:
            browser_profile_kwargs["executable_path"] = playwright_candidate

        browser_profile = BrowserProfile(**browser_profile_kwargs)
        browser = Browser(browser_profile=browser_profile)
        state.browsers[run_id] = browser
        # Store the CDP HTTP URL for the shadow recorder to connect to
        # browser_use sets browser_profile.cdp_url when launching or connecting;
        # for launched browsers it's set to the ws URL after chrome starts.
        # We expose the http base URL via GET /run/{run_id}/cdp-url
        state.runs[run_id]["cdp_url"] = browser.cdp_url

        step_count = [0]
        last_screenshot = [None]
        logger.info(f"Creating agent with task: {task_text[:100]}...")

        async def step_callback(browser_state, model_output, step_num):
            """Called after each step with browser state and model output."""
            step_count[0] = step_num
            logger.info(f"Step callback called: step_num={step_num}, url={browser_state.url if browser_state else 'N/A'}")

            # Capture screenshot directly from Playwright page (independent of use_vision)
            screenshot_b64 = None
            try:
                page = await browser.get_current_page()
                if page:
                    # browser_use Page.screenshot() returns base64 directly
                    raw_b64 = await page.screenshot(format='jpeg', quality=70)
                    screenshot_b64 = f"data:image/jpeg;base64,{raw_b64}"
                    state.set_screenshot(run_id, screenshot_b64)
                    last_screenshot[0] = screenshot_b64
                    logger.info(f"Screenshot captured for step {step_num}: {len(raw_b64)} chars base64")
                else:
                    logger.warning(f"No page available for step {step_num}, using last screenshot")
                    screenshot_b64 = last_screenshot[0]
            except Exception as e:
                logger.warning(f"Failed to capture screenshot for step {step_num}: {e}, using last screenshot")
                screenshot_b64 = last_screenshot[0]

            # Validate screenshot: must be a non-trivial data URL
            if screenshot_b64 and len(screenshot_b64) < 200:
                logger.warning(f"Step {step_num} screenshot too small ({len(screenshot_b64)} chars), using null")
                screenshot_b64 = None

            formatted_output = format_model_output(model_output)
            action_trace = format_action_trace(model_output, browser_state, redact_values=request.redact_values)

            event = {
                "event": "step",
                "step_number": step_num,
                "screenshot": screenshot_b64,
                "model_output": formatted_output,
                "url": browser_state.url if browser_state else None,
                "title": browser_state.title if browser_state else None,
                "action_trace": action_trace,
            }

            # Capture DOM snapshot for failure bundle
            try:
                page = await browser.get_current_page()
                if page:
                    dom_content = await page.content()
                    state.set_dom_snapshot(run_id, dom_content)
            except Exception:
                pass

            state.add_step_event(run_id, event)

            if run_id in state.chat_queues:
                try:
                    state.chat_queues[run_id].put_nowait(event)
                except asyncio.QueueFull:
                    pass

        async def done_callback(history: AgentHistoryList):
            """Called when agent finishes."""
            success = history.is_successful() if hasattr(history, 'is_successful') else True
            final_result = history.final_result() if hasattr(history, 'final_result') else None
            logger.info(f"Done callback called: success={success}, result={final_result}")

            # Finalize the video FIRST (time-boxed by finalize_video_safe) so it is
            # ready and its path is baked into the done event before serialization —
            # otherwise the stream receives video_path=null and the video never shows.
            video_path = await finalize_video_safe(run_id, browser)

            all_steps = state.get_step_events(run_id)
            aggregated_trace: List[Dict[str, Any]] = []
            for step_event in all_steps:
                step_trace = step_event.get("action_trace")
                if step_trace and isinstance(step_trace, list) and len(step_trace) > 0:
                    aggregated_trace.append({
                        "stepNumber": step_event.get("step_number"),
                        "url": step_event.get("url"),
                        "title": step_event.get("title"),
                        "actions": step_trace,
                    })
            logger.info(f"Done callback: aggregated {len(aggregated_trace)} action trace entries from {len(all_steps)} step events")

            event = {
                "event": "done",
                "success": success,
                "message": final_result or "Task completed",
                "duration": history.total_duration_seconds() if hasattr(history, 'total_duration_seconds') else 0,
                "video_path": f"/run/{run_id}/video" if video_path else None,
                "action_trace": aggregated_trace,
            }

            state.add_step_event(run_id, event)

            if run_id in state.chat_queues:
                try:
                    state.chat_queues[run_id].put_nowait(event)
                except asyncio.QueueFull:
                    pass

        async def on_initial_screenshot(screenshot_b64: str):
            """Called right after browser navigates to URL (~2-3s)."""
            # Validate screenshot: must be a non-trivial data URL
            if not screenshot_b64 or len(screenshot_b64) < 200:
                logger.warning(f"Initial screenshot too small ({len(screenshot_b64) if screenshot_b64 else 0} chars), skipping")
                return
            state.set_screenshot(run_id, screenshot_b64)
            last_screenshot[0] = screenshot_b64
            event = {
                "event": "loading",
                "step_number": 0,
                "screenshot": screenshot_b64,
                "model_output": None,
                "url": request.url,
                "title": None,
            }
            state.add_step_event(run_id, event)
            if run_id in state.chat_queues:
                try:
                    state.chat_queues[run_id].put_nowait(event)
                except asyncio.QueueFull:
                    pass

        # Poolside is a thinking model — it does internal reasoning, so skip
        # agent-level thinking/flash to avoid redundant LLM calls per step.
        is_poolside = request.model_provider == "poolside" or (
            request.model_provider is None and bool(request.poolside_api_key or POOLSIDE_API_KEY)
        )

        # Flash-mode prompt is minimal and omits completion guidance the model
        # needs. This string is appended regardless of which prompt template is
        # loaded, so it works for both flash and full modes.
        completion_guide = (
            'CRITICAL COMPLETION RULES:\n'
            '- When you find the information the user asked for in the browser '
            'state, call done(action_result="...") to report it and finish. '
            'Do NOT try to save to files or click random elements.\n'
            '- If the text is already visible in <browser_state>, use it '
            'directly. You do not need to call extract.\n'
            '- Put ALL findings in the "text" field of the done action.\n'
            '- The only action you need is: read what the user asked for from '
            'the page, then call done to report it.'
        )

        agent = EarlyScreenshotAgent(
            task=task_text,
            llm=llm,
            browser=browser,
            max_actions_per_step=5,
            use_vision=request.use_vision,
            use_thinking=not is_poolside,
            flash_mode=is_poolside,
            llm_timeout=180,
            extend_system_message=completion_guide,
            register_new_step_callback=step_callback,
            register_done_callback=done_callback,
            on_initial_screenshot=on_initial_screenshot,
        )

        state.agents[run_id] = agent
        state.runs[run_id]["status"] = "running"
        logger.info("Agent created, starting run...")

        try:
            history = await agent.run(max_steps=request.max_steps)
            success = history.is_successful() if hasattr(history, 'is_successful') else True
            has_errors = history.has_errors() if hasattr(history, 'has_errors') else False
            judgement = history.judgement() if hasattr(history, 'judgement') else None
            judge_failed = judgement is not None and isinstance(judgement, dict) and not judgement.get("verdict", True)
            logger.info(f"Agent run completed: success={success}, has_errors={has_errors}, judge_failed={judge_failed}, nav_failed={nav_failed}")
            state.runs[run_id]["status"] = "completed"
            state.runs[run_id]["success"] = success

            nav_failed = state.runs[run_id].get("_nav_failed", False)
            if not success or has_errors or judge_failed or nav_failed:
                history_errors = history.errors() if hasattr(history, 'errors') else []
                first_error = next((e for e in history_errors if e is not None), None)
                judge_reason = judgement.get("failure_reason", "") or judgement.get("reasoning", "") if isinstance(judgement, dict) else ""
                nav_fail_msg = "Navigation failed: the target URL could not be loaded" if nav_failed else ""
                error_msg = first_error or judge_reason or nav_fail_msg or "Task failed: the agent was unable to complete the goal"
                error_for_bundle = Exception(error_msg)
                state.runs[run_id]["status"] = "failed"
                state.runs[run_id]["error"] = str(error_for_bundle)
                root_cause = extract_root_cause(error_for_bundle)
                fix_suggestion = generate_fix_suggestion(root_cause)
                failure_bundle = build_failure_bundle(
                    dom_snapshot=state.get_dom_snapshot(run_id),
                    screenshot=state.screenshots.get(run_id),
                    action_history=state.get_step_events(run_id),
                    root_cause=root_cause,
                    fix_suggestion=fix_suggestion,
                )
                state.set_failure_bundle(run_id, failure_bundle)

                event = {
                    "event": "error",
                    "message": str(error_for_bundle),
                    "failure_bundle": failure_bundle,
                }
                state.add_step_event(run_id, event)
                if run_id in state.chat_queues:
                    try:
                        state.chat_queues[run_id].put_nowait(event)
                    except asyncio.QueueFull:
                        pass
        except Exception as e:
            logger.error(f"Agent run failed: {e}", exc_info=True)
            state.runs[run_id]["status"] = "failed"
            state.runs[run_id]["error"] = str(e)

            video_path = await finalize_video_safe(run_id, browser)

            # Capture DOM snapshot for failure bundle
            try:
                page = await browser.get_current_page()
                if page:
                    dom_content = await page.content()
                    state.set_dom_snapshot(run_id, dom_content)
            except Exception:
                pass

            # Build failure bundle
            root_cause = extract_root_cause(e)
            fix_suggestion = generate_fix_suggestion(root_cause)
            failure_bundle = build_failure_bundle(
                dom_snapshot=state.get_dom_snapshot(run_id),
                screenshot=state.screenshots.get(run_id),
                action_history=state.get_step_events(run_id),
                root_cause=root_cause,
                fix_suggestion=fix_suggestion,
            )
            state.set_failure_bundle(run_id, failure_bundle)

            event = {
                "event": "error",
                "message": str(e),
                "failure_bundle": failure_bundle,
                "video_path": f"/run/{run_id}/video" if video_path else None,
            }
            state.add_step_event(run_id, event)

            if run_id in state.chat_queues:
                try:
                    state.chat_queues[run_id].put_nowait(event)
                except asyncio.QueueFull:
                    pass

    except Exception as e:
        logger.error(f"Agent error: {e}", exc_info=True)
        state.runs[run_id]["status"] = "failed"
        state.runs[run_id]["error"] = str(e)

        video_path = await finalize_video_safe(run_id, browser if "browser" in locals() else None)

        # Build failure bundle (browser may not be available at this level)
        root_cause = extract_root_cause(e)
        fix_suggestion = generate_fix_suggestion(root_cause)
        failure_bundle = build_failure_bundle(
            dom_snapshot=state.get_dom_snapshot(run_id),
            screenshot=state.screenshots.get(run_id),
            action_history=state.get_step_events(run_id),
            root_cause=root_cause,
            fix_suggestion=fix_suggestion,
        )
        state.set_failure_bundle(run_id, failure_bundle)

        event = {
            "event": "error",
            "message": str(e),
            "failure_bundle": failure_bundle,
            "video_path": f"/run/{run_id}/video" if video_path else None,
        }
        state.add_step_event(run_id, event)

        if run_id in state.chat_queues:
            try:
                state.chat_queues[run_id].put_nowait(event)
            except asyncio.QueueFull:
                pass

    finally:
        await finalize_video_safe(run_id, browser if "browser" in locals() else None)
        if run_id in state.tasks:
            del state.tasks[run_id]


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Browser-use service starting up")
    cleanup_task = asyncio.create_task(video_cleanup_loop()) if VIDEO_ENABLED else None
    yield
    logger.info("Browser-use service shutting down")
    if cleanup_task:
        cleanup_task.cancel()
        await asyncio.gather(cleanup_task, return_exceptions=True)
    for run_id, task in state.tasks.items():
        task.cancel()
    state.tasks.clear()


app = FastAPI(
    title="Browser-Use Service",
    version="0.2.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "browser-use", "version": "0.2.0"}


@app.post("/run", response_model=RunResponse)
async def start_run(
    request: RunRequest,
    _: bool = Depends(verify_internal_secret),
):
    run_id = str(uuid.uuid4())

    state.runs[run_id] = {
        "run_id": run_id,
        "status": "pending",
        "url": request.url,
        "goal": request.goal,
        "model_id": request.model_id,
        "created_at": datetime.utcnow().isoformat(),
        "success": None,
        "error": None,
        "request": request,
    }

    state.step_events[run_id] = []
    state.chat_queues[run_id] = asyncio.Queue(maxsize=100)

    task = asyncio.create_task(run_agent_task(run_id, request))
    state.tasks[run_id] = task

    return RunResponse(
        run_id=run_id,
        status="pending",
        message="Run started",
        cdp_url=request.cdp_url,  # Echo back; full CDP URL set after browser launch, query /run/{run_id}/cdp-url for updates
    )


@app.get("/run/{run_id}/stream")
async def stream_run(
    run_id: str,
    _: bool = Depends(verify_internal_secret),
):
    if run_id not in state.runs:
        raise HTTPException(status_code=404, detail="Run not found")

    async def event_generator():
        queue = state.chat_queues.get(run_id)
        if not queue:
            return

        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=30.0)
                event_json = json.dumps(_safe_json(event), default=str)
                yield f"data: {event_json}\n\n"

                if event.get("event") in ("done", "error"):
                    break
            except asyncio.TimeoutError:
                yield f": keepalive\n\n"
                if run_id not in state.tasks:
                    break
            except Exception as e:
                logger.error(f"Stream error: {e}")
                break

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def follow_up_task(run_id: str) -> None:
    """Re-run the same agent/agent object to execute a follow-up message.

    Runs when a chat message arrives after the original run finished, so the
    follow-up actually gets processed instead of just mutating the agent's task
    history. The agent keeps keep_alive=True (browser/CDP stay alive), and the
    still-registered step/done callbacks keep streaming events to the queue.
    """
    agent = state.agents.get(run_id)
    browser = state.browsers.get(run_id)
    req = state.runs.get(run_id, {}).get("request")
    if agent is None or req is None:
        logger.warning(f"Follow-up skipped for {run_id}: agent or request missing")
        if run_id in state.tasks:
            del state.tasks[run_id]
        return

    # The previous run already cached a final video path; clear it so the
    # follow-up video is picked up when done_callback finalizes it again.
    state.video_paths.pop(run_id, None)
    state.runs[run_id]["status"] = "running"
    state.runs[run_id]["error"] = None
    logger.info(f"Follow-up run starting for {run_id} (max_steps={req.max_steps})")

    try:
        history = await agent.run(max_steps=req.max_steps)
        success = history.is_successful() if hasattr(history, 'is_successful') else True
        has_errors = history.has_errors() if hasattr(history, 'has_errors') else False
        judgement = history.judgement() if hasattr(history, 'judgement') else None
        judge_failed = judgement is not None and isinstance(judgement, dict) and not judgement.get("verdict", True)
        logger.info(f"Follow-up run completed for {run_id}: success={success}, has_errors={has_errors}, judge_failed={judge_failed}")

        state.runs[run_id]["success"] = success
        if not success or has_errors or judge_failed:
            history_errors = history.errors() if hasattr(history, 'errors') else []
            first_error = next((e for e in history_errors if e is not None), None)
            judge_reason = judgement.get("failure_reason", "") or judgement.get("reasoning", "") if isinstance(judgement, dict) else ""
            error_msg = first_error or judge_reason or "Task failed: the agent was unable to complete the goal"
            error_for_bundle = Exception(error_msg)
            state.runs[run_id]["status"] = "failed"
            state.runs[run_id]["error"] = str(error_for_bundle)

            root_cause = extract_root_cause(error_for_bundle)
            fix_suggestion = generate_fix_suggestion(root_cause)
            failure_bundle = build_failure_bundle(
                dom_snapshot=state.get_dom_snapshot(run_id),
                screenshot=state.screenshots.get(run_id),
                action_history=state.get_step_events(run_id),
                root_cause=root_cause,
                fix_suggestion=fix_suggestion,
            )
            state.set_failure_bundle(run_id, failure_bundle)

            event = {
                "event": "error",
                "message": str(error_for_bundle),
                "failure_bundle": failure_bundle,
            }
            state.add_step_event(run_id, event)
            if run_id in state.chat_queues:
                try:
                    state.chat_queues[run_id].put_nowait(event)
                except asyncio.QueueFull:
                    pass
        else:
            state.runs[run_id]["status"] = "completed"
    except Exception as e:
        logger.error(f"Follow-up run failed for {run_id}: {e}", exc_info=True)
        state.runs[run_id]["status"] = "failed"
        state.runs[run_id]["error"] = str(e)

        video_path = await finalize_video_safe(run_id, browser)

        root_cause = extract_root_cause(e)
        fix_suggestion = generate_fix_suggestion(root_cause)
        failure_bundle = build_failure_bundle(
            dom_snapshot=state.get_dom_snapshot(run_id),
            screenshot=state.screenshots.get(run_id),
            action_history=state.get_step_events(run_id),
            root_cause=root_cause,
            fix_suggestion=fix_suggestion,
        )
        state.set_failure_bundle(run_id, failure_bundle)

        event = {
            "event": "error",
            "message": str(e),
            "failure_bundle": failure_bundle,
            "video_path": f"/run/{run_id}/video" if video_path else None,
        }
        state.add_step_event(run_id, event)
        if run_id in state.chat_queues:
            try:
                state.chat_queues[run_id].put_nowait(event)
            except asyncio.QueueFull:
                pass
    finally:
        await finalize_video_safe(run_id, browser)
        if run_id in state.tasks:
            del state.tasks[run_id]


@app.post("/run/{run_id}/chat")
async def chat_with_agent(
    run_id: str,
    request: ChatRequest,
    _: bool = Depends(verify_internal_secret),
):
    """Send a follow-up message to the running agent."""
    if run_id not in state.agents:
        raise HTTPException(status_code=404, detail="Agent not found or not running")

    agent = state.agents.get(run_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    try:
        agent.add_new_task(request.message)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    # If the agent already finished, there is no active run loop to process the
    # follow-up. Revive it: re-run the same agent so the message is actually
    # executed and its events are streamed again.
    if run_id not in state.tasks and run_id in state.runs:
        state.runs[run_id]["status"] = "running"
        logger.info(f"Reviving completed agent {run_id} for follow-up task")
        follow_task = asyncio.create_task(follow_up_task(run_id))
        state.tasks[run_id] = follow_task

    return {"status": "ok", "message": "Task added to agent"}


@app.post("/run/{run_id}/stop")
async def stop_run(
    run_id: str,
    _: bool = Depends(verify_internal_secret),
):
    if run_id in state.tasks:
        task = state.tasks[run_id]
        task.cancel()
        del state.tasks[run_id]

    agent = state.agents.get(run_id)
    if agent:
        agent.state.stopped = True

    if run_id in state.runs:
        state.runs[run_id]["status"] = "stopped"

    return {"status": "stopped", "run_id": run_id}


@app.get("/run/{run_id}/status")
async def get_run_status(
    run_id: str,
    _: bool = Depends(verify_internal_secret),
):
    if run_id not in state.runs:
        raise HTTPException(status_code=404, detail="Run not found")

    run_data = state.runs[run_id]
    return {
        "run_id": run_id,
        "status": run_data["status"],
        "url": run_data.get("url"),
        "goal": run_data.get("goal"),
        "success": run_data.get("success"),
        "error": run_data.get("error"),
    }


@app.get("/run/{run_id}/cdp-url")
async def get_run_cdp_url(
    run_id: str,
    _: bool = Depends(verify_internal_secret),
):
    """Return the CDP WebSocket URL for the browser used by this run.

    The api-server's shadow recorder connects a second CDP client to the same
    Chrome instance so it can capture recording metadata (page signatures,
    locators, fingerprints) while browser-use drives the agent.
    """
    if run_id not in state.runs:
        raise HTTPException(status_code=404, detail="Run not found")

    cdp_url = state.runs[run_id].get("cdp_url")
    if not cdp_url:
        raise HTTPException(status_code=404, detail="CDP URL not available — browser may not have started yet")

    return {"cdp_url": cdp_url}


@app.get("/run/{run_id}/steps")
async def get_run_steps(
    run_id: str,
    _: bool = Depends(verify_internal_secret),
):
    """Get all step events for a run."""
    if run_id not in state.runs:
        raise HTTPException(status_code=404, detail="Run not found")

    return {"steps": _safe_json(state.get_step_events(run_id))}


def _safe_json(v, depth=0):
    """Recursively convert a value to a JSON-safe form, truncating at depth 20."""
    if depth > 20:
        return str(v)[:500]
    if v is None or isinstance(v, (bool, int, float)):
        return v
    if isinstance(v, str):
        return v
    if isinstance(v, (list, tuple)):
        return [_safe_json(i, depth + 1) for i in v]
    if isinstance(v, dict):
        return {str(k): _safe_json(val, depth + 1) for k, val in v.items()}
    return str(v)[:500]


@app.get("/run/{run_id}/failure-bundle")
async def get_failure_bundle(
    run_id: str,
    _: bool = Depends(verify_internal_secret),
):
    """Get the failure bundle for a run, if one was generated."""
    if run_id not in state.runs:
        raise HTTPException(status_code=404, detail="Run not found")

    bundle = state.get_failure_bundle(run_id)
    safe = _safe_json({
        "run_id": run_id,
        "failure_bundle": bundle,
    })
    return Response(
        content=json.dumps(safe, ensure_ascii=False),
        media_type="application/json",
    )


@app.get("/run/{run_id}/video")
async def get_video(
    run_id: str,
    _: bool = Depends(verify_internal_secret),
):
    """Stream a finalized MP4 without exposing arbitrary filesystem paths."""
    if not is_safe_run_id(run_id) or run_id not in state.runs:
        raise HTTPException(status_code=404, detail="Run not found")

    video_path = state.video_paths.get(run_id)
    if video_path is None:
        await finalize_video_safe(run_id, state.browsers.get(run_id))
        video_path = state.video_paths.get(run_id)

    if video_path is None or not video_path.is_file():
        raise HTTPException(status_code=404, detail="Video not found")

    return FileResponse(
        path=video_path,
        media_type="video/mp4",
        filename="browser-agent.mp4",
        headers={"Accept-Ranges": "bytes"},
    )


@app.get("/screenshot")
async def get_screenshot(
    run_id: Optional[str] = None,
    _: bool = Depends(verify_internal_secret),
):
    """Get the current screenshot, optionally for a specific run."""
    if run_id:
        screenshot = state.get_screenshot(run_id)
        if screenshot:
            return {"screenshot": screenshot}

    for rid, screenshot in state.screenshots.items():
        if screenshot:
            return {"screenshot": screenshot, "run_id": rid}

    return {"screenshot": None, "message": "No screenshot available"}


@app.get("/runs")
async def list_runs(
    _: bool = Depends(verify_internal_secret),
):
    """List all runs."""
    runs = []
    for run_id, run_data in state.runs.items():
        runs.append({
            "run_id": run_id,
            "status": run_data["status"],
            "url": run_data.get("url"),
            "goal": run_data.get("goal"),
            "created_at": run_data.get("created_at"),
            "success": run_data.get("success"),
        })
    return {"runs": runs}


def main():
    port = int(os.getenv("PORT", 8001))
    uvicorn.run(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()
