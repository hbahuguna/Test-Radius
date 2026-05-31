title: Building a GitHub App from Scratch: Our Journey to Posting Our First Comment
date: 2026-05-31
description: A deep dive into building our GitHub App, handling OAuth, webhooks, and the GitHub API.
imageUrl: /blog-assets/build-testradius-github-app.png

---

Every engineering team faces the same tension: you want your CI pipeline to provide fast feedback, but integrating a new GitHub App can feel like deciphering an ancient scroll. OAuth flows, webhooks, signature verification, local tunnels — it's a maze of moving parts where one misconfiguration breaks everything.

https://youtu.be/eB0nUzAI7M8

We chose to build anyway. We built a GitHub App that watches for new pull requests and posts a comment — automatically, securely, and in real time. This post walks through our journey: the steps we took, the errors we encountered, and the fixes that made it work.

---

## Architecture Overview

*“The system is a pipeline with three independently testable layers.”*

```
GitHub Repository → Webhook POST → Node.js/Express Server (localhost:3000)
                                           ↓
                              Signature Verification (HMAC‑SHA256)
                                           ↓
                              ngrok Tunnel (public HTTPS URL)
                                           ↓
                              GitHub API Call → Post Comment on PR
```

We built an Express server in Node.js to handle incoming webhooks, used ngrok to expose our local environment to the internet, and authenticated with GitHub's APIs using OAuth and installation access tokens.

---

## Step 1: Creating the GitHub App in Developer Settings

The first step was registering a new GitHub App in the GitHub Developer Settings. We navigated to **Settings → Developer settings → GitHub Apps → New GitHub App** and filled in the required fields:

- **App name**: `testradius-dev` (you'll need the slug later)
- **Callback URL**: `http://localhost:3000/api/github/callback`
- **Webhook URL**: placeholder for now (we updated it after setting up ngrok)
- **Webhook secret**: a random string (kept in `.env` as `GITHUB_WEBHOOK_SECRET`)
- **Permissions**: pull requests (read & write), contents (read), metadata (read-only)
- **Events**: subscribed to `pull_request` events

After creation, we saved the **App ID**, **Client ID**, **Client Secret**, and **Private Key** (`.pem` file) — these were stored securely in `.env`.

---

## Step 2: Node.js + Express Server Setup

We initialized a Node.js project and installed the required dependencies:

```bash
npm init -y
npm install express dotenv nodemon axios @octokit/rest @octokit/auth-app
```

The basic server structure (`app.js`) included environment variables, middleware for raw body parsing (critical for signature verification), and a test route:

```javascript
const express = require('express');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({
  verify: (req, res, buf, encoding) => {
    req.rawBody = buf.toString();
  }
}));

app.get('/', (req, res) => {
  res.send('TestRadius GitHub App is running!');
});

app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});
```

The `verify` middleware preserves the raw request body — essential for calculating the HMAC signature that GitHub sends in the `x-hub-signature-256` header.

---

## Step 3: OAuth Flow for App Installation

To allow users to install the GitHub App on their repositories, we implemented the OAuth flow with two routes: one to initiate installation, and one to handle the callback after installation.

**Route: `/api/github/install`** — redirected the user to the GitHub App installation page:

```javascript
app.get('/api/github/install', (req, res) => {
  const appName = process.env.GITHUB_APP_NAME;
  const installUrl = `https://github.com/apps/${appName}/installations/new`;
  res.send(`<a href="${installUrl}">Install the app</a>`);
});
```

**Route: `/api/github/callback`** — received the temporary `code` from GitHub after installation, exchanged it for an installation access token using `axios`, and stored it for future API calls:

```javascript
const tokenResponse = await axios.post(
  'https://github.com/login/oauth/access_token',
  {
    client_id: process.env.GITHUB_CLIENT_ID,
    client_secret: process.env.GITHUB_CLIENT_SECRET,
    code: code,
  },
  { headers: { Accept: 'application/json' } }
);
```

This token allowed the app to authenticate as the installation and make API calls on behalf of the user.

---

## Step 4: The Webhook Receiver (and the "Invalid Signature" Nightmare)

The core of the app is the webhook endpoint — the URL GitHub sends `POST` requests to when a pull request is opened.

We implemented the endpoint as follows:

```javascript
app.post('/api/github/webhooks', async (req, res) => {
  res.status(200).send('Webhook received');  // Immediate acknowledgment

  const rawPayload = req.rawBody;
  const signature = req.headers['x-hub-signature-256'];
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  const hmac = crypto.createHmac('sha256', secret);
  const expectedSignature = `sha256=${hmac.update(rawPayload).digest('hex')}`;

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    console.error('Invalid signature - possible spoofed webhook');
    return;
  }

  setImmediate(async () => {
    const payload = JSON.parse(rawPayload);
    const eventType = req.headers['x-github-event'];
    if (eventType === 'pull_request' && payload.action === 'opened') {
      console.log(`Processing opened PR #${payload.pull_request.number}`);
      // Post comment logic here
    }
  });
});
```

### The "Invalid Signature" Error

When we first tested this, the server logged a relentless stream of errors:

```
Invalid signature - possible spoofed webhook
Invalid signature - possible spoofed webhook
...
```

The issue was that `express.json()` middleware was parsing the incoming JSON payload into a JavaScript object **before** our webhook endpoint could access the raw body. The signature verification requires the exact raw byte stream that GitHub sent — any modification breaks the HMAC.

**Fix**: We added the `verify` middleware to preserve `req.rawBody`:

```javascript
app.use(express.json({
  verify: (req, res, buf, encoding) => {
    req.rawBody = buf.toString();
  }
}));
```

This stored the raw body as a string before any parsing, allowing the signature to be verified correctly.

---

## Step 5: Ngrok — Exposing Localhost to the Internet

GitHub needs a public HTTPS URL to send webhooks to. For local development, we used **ngrok**, a tunneling tool that exposes a local server to the internet.

### Setup

1. Installed ngrok (using `brew install ngrok` on macOS)
2. Created a free account and added the authtoken: `ngrok config add-authtoken <your-token>`
3. Started the tunnel: `ngrok http 3000`

This generated a public URL like `https://abc123.ngrok-free.app`. We then went back to the GitHub App settings and set the **Webhook URL** to `https://abc123.ngrok-free.app/api/github/webhooks`.

### Debugging with ngrok's Traffic Inspector

ngrok provides a local web interface at `http://localhost:4040` where we could inspect every incoming webhook delivery — headers, payload, response status, and any errors. This was invaluable for debugging signature mismatches and payload structure.

---

## Step 6: Posting a Static Comment on the PR

Once the webhook was receiving events, we added the logic to post a static comment using the GitHub API.

We installed `@octokit/rest` and `@octokit/auth-app`:

```bash
npm install @octokit/rest @octokit/auth-app
```

Inside the `pull_request.opened` handler, we:

1. Extracted the repository owner, repository name, PR number, and installation ID from the payload.
2. Generated an installation access token using the app's private key.
3. Created an Octokit instance and called `octokit.issues.createComment`.

```javascript
const auth = createAppAuth({
  appId: process.env.GITHUB_APP_ID,
  privateKey: process.env.GITHUB_PRIVATE_KEY,
  clientId: process.env.GITHUB_CLIENT_ID,
  clientSecret: process.env.GITHUB_CLIENT_SECRET,
});
const installationAuth = await auth({ type: 'installation', installationId });
const octokit = new Octokit({ auth: installationAuth.token });

await octokit.issues.createComment({
  owner: repoOwner,
  repo: repoName,
  issue_number: prNumber,
  body: '**TestRadius (shadow mode)** – would run recommended tests here. No tests were actually executed.',
});
```

After restarting the server and opening a new pull request, we finally saw the comment appear on GitHub — our first end‑to‑end success.

---

## Three Generations of Webhook Development

*“The final working endpoint is the third iteration — each error taught us something the previous one couldn't.”*

- **Gen 1 — Missing raw body**: The Express `json()` middleware consumed the body, making signature verification impossible. We learned that webhook handlers must access the raw, unparsed request body.
- **Gen 2 — Incorrect secret format**: The private key stored in `.env` must be a single line with `\n` for newlines. Copying the raw PEM file directly breaks authentication.
- **Gen 3 — Proper installation token generation**: Using `@octokit/auth-app` instead of manually constructing JWTs reduced boilerplate and eliminated authentication errors.

---

## The Result

Instead of guessing which webhook configuration works or copy‑pasting scripts that fail with opaque errors, we now have a deterministic, working GitHub App that:

- Listens for `pull_request.opened` events via a public ngrok tunnel
- Verifies every incoming request using HMAC‑SHA256 signatures
- Authenticates with GitHub's API using an installation access token
- Posts a comment on the pull request — automatically, securely, and in real time

The pipeline turned from a black box of logs into a surgical instrument we can confidently extend with test selection intelligence.

---


## Next Steps: From Static Comment to Intelligent Test Selection

The static comment is only the beginning. The next phase of TestRadius involves:

1. **Dynamic test selection** – replacing the placeholder message with a list of test files impacted by the code change, using an AST‑based dependency graph.
2. **Explainability** – showing *why* each test was selected (e.g., “because `auth.py` changed”).
3. **GitHub Marketplace listing** – making the app discoverable to thousands of engineering teams.

The foundation is now solid. The webhook receiver is battle‑tested, the authentication flow is clean, and the ngrok tunnel gives us a production‑like debugging environment. Every engineering team that struggles with flaky tests and slow CI feedback loops is one step closer to a solution that doesn't guess — it knows.

Final code for a github app that can comment on a github PR can be found here https://github.com/hbahuguna/testradius-github-app/tree/main