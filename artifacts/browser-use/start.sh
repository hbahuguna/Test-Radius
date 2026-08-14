#!/bin/bash
# Start the Browser-Use service

set -e

cd "$(dirname "$0")"

# Use Replit's managed Python env (uv redirects venv creation there automatically)
PYTHON_BIN="/home/runner/workspace/.pythonlibs/bin"
export PATH="$PYTHON_BIN:$PATH"

# Install dependencies into the Replit Python env
echo "Installing dependencies..."
uv pip install --quiet fastapi uvicorn pydantic python-dotenv langchain-openai langchain-anthropic 'playwright==1.55.0' psutil pydantic-settings pyotp pillow zstandard aiohttp anyio httpx google-genai anthropic groq ollama google-api-python-client google-auth google-auth-oauthlib mcp pypdf reportlab cloudpickle markdownify python-docx bubus cdp-use rich posthog

# Skip playwright browser download — use the system Chromium installed via Nix (pkgs.chromium).
# This avoids the ~3-minute cold-start download on every new instance.
# server.py reads BROWSER_USE_EXECUTABLE_PATH to use a custom binary.
SYSTEM_CHROMIUM=$(which chromium 2>/dev/null || echo "")
if [ -n "$SYSTEM_CHROMIUM" ]; then
    export BROWSER_USE_EXECUTABLE_PATH="$SYSTEM_CHROMIUM"
    echo "Using system Chromium: $SYSTEM_CHROMIUM"
else
    # Fallback: download Playwright Chromium if system one is missing
    echo "System Chromium not found, downloading via Playwright..."
    python3 -m playwright install chromium 2>/dev/null || true
fi

# Create .env file if it doesn't exist
if [ ! -f .env ]; then
    echo "Creating .env file..."
    cat > .env << EOF
BROWSER_USE_INTERNAL_SECRET=${BROWSER_USE_INTERNAL_SECRET:-dev-secret-change-in-production}
OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-}
BROWSER_USE_API_KEY=${BROWSER_USE_API_KEY:-}
PORT=${BROWSER_USE_PORT:-8001}
EOF
fi

# Start the server — always on BROWSER_USE_PORT (default 8001), never on the main $PORT
LISTEN_PORT="${BROWSER_USE_PORT:-8001}"
echo "Starting Browser-Use service on port ${LISTEN_PORT}..."
exec python3 -m uvicorn server:app --host 0.0.0.0 --port "${LISTEN_PORT}"
