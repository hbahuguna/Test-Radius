# Browser Agent UI - Design & Implementation Plan

## Overview
Create a new route `/browser-agent` that replicates the browser-use web UI experience: live browser activity, human-readable actions, agent reasoning, and chat interaction — all free without credits.

## Key Features from Browser-Use Web UI

### What Browser-Use Shows at Each Step:
1. **Step Number** (Step 1, Step 2, ...)
2. **Screenshot** of the browser at that moment
3. **Agent Output** (JSON formatted):
   - `thinking` (optional) - Model's internal reasoning
   - `evaluation_previous_goal` - Success/failure assessment
   - `memory` - What the agent remembers
   - `next_goal` - What it plans to do next
4. **Actions Taken** - Human-readable actions like:
   - "Clicked on element [15] 'Sign in'"
   - "Typed 'hello' into input field"
   - "Navigated to https://example.com"
   - "Scrolled down the page"

### Chat Interaction:
- Agent can ask for user assistance
- User can provide follow-up tasks mid-run
- User can respond to agent questions

## Architecture

### New Python Server Endpoints

#### Enhanced `/run` with Step Streaming
```python
POST /run
{
    "url": "https://example.com",
    "goal": "Extract product prices",
    "model_id": "poolside/laguna-xs-2.1",
    "max_steps": 30,
    "use_vision": false,
    "keep_alive": true  # Keep browser for follow-up
}

Response: Run ID
```

#### Enhanced `/run/{run_id}/stream`
SSE events with rich step data:
```json
{
    "event": "step",
    "step_number": 1,
    "screenshot": "base64...",
    "model_output": {
        "thinking": "I need to find the login button",
        "evaluation_previous_goal": "Page loaded successfully",
        "memory": "Found the homepage with navigation menu",
        "next_goal": "Click the sign-in button",
        "actions": [
            {"name": "click", "element": "[15] 'Sign in'", "status": "success"}
        ]
    }
}
```

#### New `/chat` Endpoint
```python
POST /run/{run_id}/chat
{
    "message": "Now search for 'laptop' in the search box"
}
```

### New API Server Route

#### `/api/browser-agent/*` (No Credit Checks)
```typescript
router.use(requireSignedUp);  // Auth only, no credits

// POST /api/browser-agent/run - Start agent
// GET /api/browser-agent/run/:id/stream - SSE stream
// POST /api/browser-agent/run/:id/chat - Follow-up message
// POST /api/browser-agent/run/:id/stop - Stop agent
// GET /api/browser-agent/run/:id/screenshot - Current screenshot
```

### Frontend: `/browser-agent` Page

#### Layout (3-panel design)
```
┌─────────────────────────────────────────────────────────────┐
│  Header: Browser Agent                              [Stop]  │
├─────────────────────┬───────────────────────────────────────┤
│                     │                                       │
│   Agent Chat        │        Live Browser View              │
│   (Step-by-step)    │        (Screenshot updates)           │
│                     │                                       │
│   Step 1:           │   ┌─────────────────────────────┐    │
│   [Screenshot]      │   │                             │    │
│   Action: Clicked   │   │   Current browser state     │    │
│   "Sign in"         │   │                             │    │
│                     │   └─────────────────────────────┘    │
│   Step 2:           │                                       │
│   [Screenshot]      │                                       │
│   Action: Typed     │                                       │
│   "hello"           │                                       │
│                     │                                       │
├─────────────────────┴───────────────────────────────────────┤
│  [Type a follow-up task...]              [Send] [Stop]      │
└─────────────────────────────────────────────────────────────┘
```

#### Components:
1. **AgentChatPanel** - Left side, shows steps as chat messages
2. **LiveBrowserView** - Right side, shows current screenshot
3. **ChatInput** - Bottom, for follow-up tasks
4. **ControlBar** - Start/Stop/Pause buttons

## Implementation Steps

### Phase 1: Python Server Enhancements

#### 1.1 Modify `server.py` to Capture Per-Step Screenshots
- Store screenshots in `runs_store` at each step
- Return step_number, screenshot, model_output in stream events

#### 1.2 Add Chat Endpoint
- New `/run/{run_id}/chat` endpoint
- Inject new task into running agent via `agent.add_new_task()`

#### 1.3 Keep Browser Alive
- Use `keep_alive=True` on Browser
- Don't reset browser between follow-up tasks

### Phase 2: API Server New Route

#### 2.1 Create `browser-agent.ts` Route
- Copy structure from `browser-auto.ts`
- Remove all credit checks
- Add chat endpoint proxy

#### 2.2 Update `browser-use-client.ts`
- Add `streamBrowserAgentRun()` function
- Add `sendBrowserAgentChat()` function
- Parse rich step events with screenshots

### Phase 3: Frontend Components

#### 3.1 Create New Components
```
src/components/browser-agent/
├── AgentChatPanel.tsx      # Step-by-step chat display
├── StepMessage.tsx          # Individual step with screenshot
├── LiveBrowserView.tsx      # Current browser state
├── ChatInput.tsx            # Follow-up message input
├── ControlBar.tsx           # Start/Stop/Pause
└── AgentReasoning.tsx       # Thinking/Evaluation/Memory display
```

#### 3.2 Create New Page
```
src/pages/BrowserAgent.tsx  # Main page component
```

#### 3.3 Update Router
- Add `/browser-agent` route

### Phase 4: Integration & Polish

#### 4.1 Real-time Updates
- WebSocket or SSE for live screenshots
- Smooth transitions between steps

#### 4.2 Error Handling
- Graceful handling of agent failures
- Clear error messages

#### 4.3 Responsive Design
- Mobile-friendly layout
- Collapsible panels

## File Changes Required

### Python Service
- `artifacts/browser-use/server.py` - Add step screenshots, chat endpoint

### API Server
- `artifacts/api-server/src/routes/browser-agent.ts` - New route (no credits)
- `artifacts/api-server/src/lib/browser-use-client.ts` - Add agent functions
- `artifacts/api-server/src/index.ts` - Register new route

### Frontend
- `artifacts/testradius/src/pages/BrowserAgent.tsx` - New page
- `artifacts/testradius/src/components/browser-agent/*.tsx` - New components
- `artifacts/testradius/src/lib/browser-agent-api.ts` - API client
- `artifacts/testradius/src/App.tsx` - Add route

## Example User Flow

1. User navigates to `/browser-agent`
2. Enters URL: `https://example.com`
3. Enters goal: "Find the pricing page and extract all plan names"
4. Clicks "Start Agent"
5. Sees live browser view on right
6. Agent chat shows:
   - Step 1: Navigated to example.com
   - Step 2: Found "Pricing" link in navigation
   - Step 3: Clicked "Pricing" link
   - Step 4: Extracted 3 plan names: Basic, Pro, Enterprise
7. Agent asks: "Should I also extract the prices?"
8. User types: "Yes, extract all prices too"
9. Agent continues and completes task
10. User can start a new task or close

## Technical Notes

### Screenshot Handling
- Python server captures screenshots at each step via `browser_context.take_screenshot()`
- Screenshots sent as base64 in SSE events
- Frontend displays them in both step cards and live view

### Chat/Follow-up
- Browser-use's `agent.add_new_task()` allows injecting new tasks
- Agent continues from current state
- User can provide guidance mid-run

### Performance
- Screenshots are ~50-100KB base64
- At 1 step/second, that's ~50-100KB/s bandwidth
- Consider JPEG quality reduction for faster streaming

### Text-Only Models
- When `use_vision=false`, screenshots won't be captured
- UI should show "Screenshots require vision mode" message
- Actions and reasoning still work with text-only models
