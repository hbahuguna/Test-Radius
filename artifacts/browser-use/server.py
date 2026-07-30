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
from contextlib import asynccontextmanager
from typing import Optional, Dict, Any, List
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

from fastapi import FastAPI, HTTPException, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
import uvicorn

from browser_use import Agent, Browser, BrowserProfile
from browser_use.agent.views import AgentOutput, AgentHistoryList


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

logger.info(f"INTERNAL_SECRET loaded: {INTERNAL_SECRET[:10]}..." if INTERNAL_SECRET else "INTERNAL_SECRET NOT SET")
logger.info(f"POOLSIDE_API_KEY loaded: {POOLSIDE_API_KEY[:15]}..." if POOLSIDE_API_KEY else "POOLSIDE_API_KEY NOT SET")


class RunRequest(BaseModel):
    url: str
    goal: str
    model_id: str = Field(default="openai/gpt-4o", description="LLM model ID")
    max_steps: int = Field(default=50, description="Maximum number of steps")
    poolside_api_key: Optional[str] = Field(default=None, description="Poolside API key")
    model_provider: Optional[str] = Field(default=None, description="Model provider override")
    use_vision: bool = Field(default=False, description="Send screenshots to model (set false for text-only models)")
    keep_alive: bool = Field(default=True, description="Keep browser alive for follow-up")


class ChatRequest(BaseModel):
    message: str


class RunResponse(BaseModel):
    run_id: str
    status: str
    message: str


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


def verify_internal_secret(x_internal_secret: str = Header(default="", alias="X-Internal-Secret")) -> bool:
    if x_internal_secret != INTERNAL_SECRET:
        raise HTTPException(status_code=401, detail="Invalid internal secret")
    return True


def get_llm(model_id: str, poolside_api_key: Optional[str] = None):
    from browser_use.llm import ChatOpenAI

    api_key = poolside_api_key or POOLSIDE_API_KEY
    logger.info(f"get_llm: model_id={model_id}, poolside_api_key={'SET' if poolside_api_key else 'None'}, env_key={'SET' if POOLSIDE_API_KEY else 'EMPTY'}, resolved_key={'SET' if api_key else 'EMPTY'}")

    if api_key:
        # If the caller passed the generic default model, pick a Poolside-
        # compatible model instead.
        poolside_model = model_id
        if poolside_model in ('openai/gpt-4o', 'openai/gpt-4o-mini'):
            poolside_model = 'o4-mini'
        return ChatOpenAI(
            model=poolside_model,
            base_url="https://inference.poolside.ai/v1",
            api_key=api_key,
            max_completion_tokens=16384,  # Poolside is a thinking model - needs extra tokens
            timeout=180,  # Poolside thinking model takes longer
            reasoning_models=[poolside_model, 'o4-mini', 'o3', 'o3-mini', 'o1', 'o1-pro', 'o3-pro', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano'],
        )
    elif "openrouter" in model_id.lower():
        return ChatOpenAI(
            model=model_id,
            base_url="https://openrouter.ai/api/v1",
            api_key=OPENROUTER_API_KEY,
        )
    elif model_id.startswith("anthropic/"):
        from browser_use.llm import ChatAnthropic
        return ChatAnthropic(
            model=model_id.split("/")[-1],
            api_key=os.getenv("ANTHROPIC_API_KEY", ""),
        )
    else:
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
    try:
        logger.info(f"Run request: url={request.url}, model_id={request.model_id}, use_vision={request.use_vision}")
        logger.info(f"Creating LLM for model_id={request.model_id}")

        task_text = f"{request.url}\n\nGoal: {request.goal}"
        llm = get_llm(request.model_id, request.poolside_api_key)
        logger.info(f"LLM created: {type(llm).__name__}")

        # Create browser
        # Use Playwright's bundled Chromium if available (avoids conflicts with running Chrome)
        playwright_candidate = None
        try:
            from playwright.sync_api import sync_playwright
            with sync_playwright() as p:
                playwright_candidate = p.chromium.executable_path
        except Exception:
            pass
        browser_profile = BrowserProfile(
            headless=True,
            executable_path=playwright_candidate,
        )
        browser = Browser(browser_profile=browser_profile)
        state.browsers[run_id] = browser

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

            event = {
                "event": "step",
                "step_number": step_num,
                "screenshot": screenshot_b64,
                "model_output": formatted_output,
                "url": browser_state.url if browser_state else None,
                "title": browser_state.title if browser_state else None,
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

            event = {
                "event": "done",
                "success": success,
                "message": final_result or "Task completed",
                "duration": history.total_duration_seconds() if hasattr(history, 'total_duration_seconds') else 0,
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
        is_poolside = bool(request.poolside_api_key or POOLSIDE_API_KEY)

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
            }
            state.add_step_event(run_id, event)

            # Detect navigation failures from browser state
            if browser_state:
                nav_error_keywords = [
                    "err_name_not_resolved", "err_connection_refused",
                    "err_connection_reset", "err_connection_closed",
                    "err_connection_timed_out", "err_timed_out",
                    "dns_probe_finished", "this site can't be reached",
                    "navigation failed", "net::err_",
                ]
                url_lower = (browser_state.url or "").lower()
                title_lower = (browser_state.title or "").lower()
                has_browser_errors = (
                    hasattr(browser_state, 'browser_errors')
                    and isinstance(browser_state.browser_errors, list)
                    and len(browser_state.browser_errors) > 0
                )
                if (
                    has_browser_errors
                    or "chrome-error" in url_lower
                    or any(kw in url_lower for kw in nav_error_keywords)
                    or any(kw in title_lower for kw in nav_error_keywords)
                ):
                    state.runs[run_id]["_nav_failed"] = True

            if run_id in state.chat_queues:
                try:
                    state.chat_queues[run_id].put_nowait(event)
                except asyncio.QueueFull:
                    pass

    except Exception as e:
        logger.error(f"Agent error: {e}", exc_info=True)
        state.runs[run_id]["status"] = "failed"
        state.runs[run_id]["error"] = str(e)

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
        }
        state.add_step_event(run_id, event)

        if run_id in state.chat_queues:
            try:
                state.chat_queues[run_id].put_nowait(event)
            except asyncio.QueueFull:
                pass

    finally:
        if run_id in state.tasks:
            del state.tasks[run_id]


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Browser-use service starting up")
    yield
    logger.info("Browser-use service shutting down")
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
    }

    state.step_events[run_id] = []
    state.chat_queues[run_id] = asyncio.Queue(maxsize=100)

    task = asyncio.create_task(run_agent_task(run_id, request))
    state.tasks[run_id] = task

    return RunResponse(
        run_id=run_id,
        status="pending",
        message="Run started",
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
                event_json = json.dumps(event)
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
        return {"status": "ok", "message": "Task added to agent"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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


@app.get("/run/{run_id}/steps")
async def get_run_steps(
    run_id: str,
    _: bool = Depends(verify_internal_secret),
):
    """Get all step events for a run."""
    if run_id not in state.runs:
        raise HTTPException(status_code=404, detail="Run not found")

    return {"steps": state.get_step_events(run_id)}


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
