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
from fastapi.responses import StreamingResponse
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
        return ChatOpenAI(
            model=model_id,
            base_url="https://inference.poolside.ai/v1",
            api_key=api_key,
            max_completion_tokens=16384,  # Poolside is a thinking model - needs extra tokens
            timeout=180,  # Poolside thinking model takes longer
            reasoning_models=[model_id, 'o4-mini', 'o3', 'o3-mini', 'o1', 'o1-pro', 'o3-pro', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano'],
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
            result["actions"].append({
                "name": format_action_name(action),
                "raw": action.model_dump(exclude_none=True) if hasattr(action, 'model_dump') else str(action),
            })

    return result


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

        agent = EarlyScreenshotAgent(
            task=task_text,
            llm=llm,
            browser=browser,
            max_actions_per_step=5,
            use_vision=request.use_vision,
            use_thinking=False,  # Disable thinking for speed
            flash_mode=True,  # Skip evaluation/thinking, use memory only
            llm_timeout=180,
            register_new_step_callback=step_callback,
            register_done_callback=done_callback,
            on_initial_screenshot=on_initial_screenshot,
        )

        state.agents[run_id] = agent
        state.runs[run_id]["status"] = "running"
        logger.info("Agent created, starting run...")

        try:
            history = await agent.run(max_steps=request.max_steps)
            logger.info(f"Agent run completed: success={history.is_successful() if hasattr(history, 'is_successful') else 'unknown'}")
            state.runs[run_id]["status"] = "completed"
            state.runs[run_id]["success"] = history.is_successful() if hasattr(history, 'is_successful') else True
        except Exception as e:
            logger.error(f"Agent run failed: {e}", exc_info=True)
            state.runs[run_id]["status"] = "failed"
            state.runs[run_id]["error"] = str(e)
            
            event = {
                "event": "error",
                "message": str(e),
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

        event = {
            "event": "error",
            "message": str(e),
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
