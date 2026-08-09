#!/bin/bash
# Start the Browser-Use service

set -e

cd "$(dirname "$0")"

# Use Replit's managed Python env (uv redirects venv creation there automatically)
PYTHON_BIN="/home/runner/workspace/.pythonlibs/bin"
export PATH="$PYTHON_BIN:$PATH"

# Install dependencies into the Replit Python env
echo "Installing dependencies..."
uv pip install --quiet fastapi uvicorn pydantic python-dotenv langchain-openai langchain-anthropic 'playwright==1.55.0' psutil pydantic-settings pyotp pillow zstandard aiohttp anyio httpx google-genai anthropic groq ollama google-api-python-client google-auth google-auth-oauthlib mcp pypdf reportlab cloudpickle markdownify python-docx bubus cdp-use rich

# Install playwright browsers
echo "Installing Playwright browsers..."
python3 -m playwright install chromium 2>/dev/null || true

# Create .env file if it doesn't exist
if [ ! -f .env ]; then
    echo "Creating .env file..."
    cat > .env << EOF
BROWSER_USE_INTERNAL_SECRET=${BROWSER_USE_INTERNAL_SECRET:-dev-secret-change-in-production}
OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-}
BROWSER_USE_API_KEY=${BROWSER_USE_API_KEY:-}
PORT=${PORT:-8001}
EOF
fi

# Start the server
echo "Starting Browser-Use service on port ${PORT:-8001}..."
exec python3 -m uvicorn server:app --host 0.0.0.0 --port ${PORT:-8001}
