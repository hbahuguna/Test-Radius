title: GitHub App Integration
description: Automate TIA analysis and test execution on every PR
lastUpdated: 2026-06-04

The TestRadius GitHub App automatically analyzes every pull request, posts TIA results as a PR comment, runs the selected tests, and sets commit status.

---

## Architecture

```
+----------------+          +-------------------+
|  GitHub        |--------->|  GitHub App       |
|  (webhook)     |          |  node app.js      |
+----------------+          |  port 3000        |
        ^                   +--------+----------+
        |                            | HTTP
        |                            v
        |                   +-------------------+
        |                   |  core-ml API      |
        |                   |  port 8000        |
        |                   +-------------------+
        |                            |
        +----------------------------+
          Commit status + comments
```

---

## Setup

### 1. Create a GitHub App

1. Go to GitHub Settings → Developer settings → GitHub Apps → New GitHub App
2. Set the webhook URL to your ngrok URL: `https://your-subdomain.ngrok-free.dev/api/github/webhooks`
3. Set webhook secret (store it for the next step)
4. Permissions needed:
   - Pull requests: Read & Write (for comments)
   - Commit statuses: Read & Write (for status checks)
   - Contents: Read (for PR file listing)
5. Subscribe to events: `Pull request`

### 2. Configure the App

Create `services/github-app/.env`:

```
GITHUB_APP_ID=3922550
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=your_webhook_secret
TESTSQUAD_API_URL=http://core-ml:8000
TESTSQUAD_PROJECT_MAPPING={"owner/repo": 1}
PORT=3000
```

### 3. Start the App

```bash
cd services/github-app
node app.js
```

### 4. Expose with ngrok

```bash
ngrok http 3000
```

Update the webhook URL in GitHub App settings to match the ngrok URL.

### 5. Install the App

1. Go to your GitHub App settings
2. Select "Install App" and choose the target repository
3. The app is now active for all PR events on that repo

---

## Webhook Flow

```
pull_request.opened / synchronize
  │
  ├─► POST /api/github/webhooks
  │     │
  │     ├─► Verify webhook secret
  │     ├─► Generate JWT
  │     ├─► Exchange JWT for installation token
  │     ├─► POST /projects/:id/analyze-pr
  │     │     └─► Returns impacted symbols + tests
  │     ├─► POST comment on PR with TIA results
  │     ├─► POST /projects/:id/execute-tests
  │     │     └─► Runs tests, returns results
  │     ├─► POST comment on PR with test results
  │     └─► Set commit status (success/failure)
```

---

## Key Files

| File | Purpose |
|---|---|
| `services/github-app/app.js` | Express server, webhook handler |
| `services/github-app/.env` | App credentials and mapping |
| `services/core/testsquad_core/github_service.py` | GitHub API client for core-ml |

## Troubleshooting

See the [Troubleshooting](/docs/troubleshooting) page for common GitHub App issues.
