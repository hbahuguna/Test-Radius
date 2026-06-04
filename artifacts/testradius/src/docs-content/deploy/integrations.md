title: CI/CD Integrations
description: Integrate TestRadius into your CI/CD pipeline
lastUpdated: 2026-06-04

Automate TIA analysis and test execution in your CI/CD workflow.

---

## GitHub Actions

Add TestRadius analysis to your GitHub Actions workflow:

```yaml
name: TestRadius Analysis
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  testradius:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run TIA Analysis
        run: |
          curl -X POST ${{ secrets.TESTRADIUS_URL }}/projects/1/analyze-pr \
            -H "Content-Type: application/json" \
            -H "X-GitHub-Token: ${{ secrets.GITHUB_TOKEN }}" \
            -d '{
              "full_name": "${{ github.repository }}",
              "pr_number": ${{ github.event.pull_request.number }},
              "commit_sha": "${{ github.event.pull_request.head.sha }}"
            }'

      - name: Execute Impacted Tests
        run: |
          curl -X POST ${{ secrets.TESTRADIUS_URL }}/projects/1/execute-tests \
            -H "Content-Type: application/json" \
            -H "X-GitHub-Token: ${{ secrets.GITHUB_TOKEN }}" \
            -d '{
              "owner": "${{ github.event.repository.owner.login }}",
              "repo": "${{ github.event.repository.name }}",
              "pr_number": ${{ github.event.pull_request.number }},
              "commit_sha": "${{ github.event.pull_request.head.sha }}",
              "tests": <TIA output tests array>
            }'
```

## Manual Trigger

For local or scripted workflows:

```bash
#!/bin/bash
PROJECT_ID=1
OWNER="owner"
REPO="repo"
PR_NUMBER=$1
COMMIT_SHA=$(git rev-parse HEAD)

# 1. Analyze PR
ANALYSIS=$(curl -s -X POST "http://localhost:8000/projects/$PROJECT_ID/analyze-pr" \
  -H "Content-Type: application/json" \
  -d "{\"full_name\": \"$OWNER/$REPO\", \"pr_number\": $PR_NUMBER, \"commit_sha\": \"$COMMIT_SHA\"}")

echo "Impacted tests: $(echo $ANALYSIS | jq '.tests | length')"

# 2. Execute tests
RESULTS=$(curl -s -X POST "http://localhost:8000/projects/$PROJECT_ID/execute-tests" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Token: $GITHUB_TOKEN" \
  -d "{
    \"owner\": \"$OWNER\",
    \"repo\": \"$REPO\",
    \"pr_number\": $PR_NUMBER,
    \"commit_sha\": \"$COMMIT_SHA\",
    \"tests\": $(echo $ANALYSIS | jq '.tests')
  }")

echo "Passed: $(echo $RESULTS | jq '.passed') / $(echo $RESULTS | jq '.total')"
```

---

## Webhook-based (GitHub App)

For fully automated operation, the GitHub App handles the entire flow:

1. PR created/synchronized → webhook fires
2. App calls `analyze-pr` → posts comment
3. App calls `execute-tests` → posts results
4. App sets commit status

No CI/CD YAML changes needed — just install the GitHub App.

See the [GitHub App](/docs/usage/github-app) page for setup instructions.
