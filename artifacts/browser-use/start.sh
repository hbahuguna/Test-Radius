#!/bin/bash
# Start the Browser-Use service

set -e

cd "$(dirname "$0")"

# Create venv if it doesn't exist
if [ ! -d ".venv" ]; then
    echo "Creating Python 3.12 virtual environment..."
    uv venv --python 3.12
fi

# Activate venv
source .venv/bin/activate

# Install dependencies
echo "Installing dependencies..."
uv pip install --quiet fastapi uvicorn pydantic python-dotenv langchain-openai langchain-anthropic playwright psutil pydantic-settings pyotp pillow zstandard aiohttp anyio httpx google-genai anthropic groq ollama google-api-python-client google-auth google-auth-oauthlib mcp pypdf reportlab cloudpickle markdownify python-docx bubus cdp-use rich

# Install playwright browsers
echo "Installing Playwright browsers..."
python -m playwright install chromium 2>/dev/null || true

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
exec uvicorn server:app --host 0.0.0.0 --port ${PORT:-8001}