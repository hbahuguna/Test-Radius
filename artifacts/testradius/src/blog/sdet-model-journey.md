title: Building and Deploying a Specialized SDET Model at Minimal Cost - From Synthetic Data to Serverless Deployment using Kaggle, HuggingFace, and Modal
date: 2026-06-28
description: How we fine-tuned Qwen3-8B on thousands of synthetic SDET conversations, deployed it serverlessly on Modal, and built an AI assistant that generates production-quality Playwright tests.
imageUrl: /blog-assets/sdet-model-journey.jpg

---


We built **TestRadius** as a test impact analysis platform to answer a critical question: *which tests does this PR actually affect?* But we didn't want to stop there. We also wanted to help teams *write* better tests, faster. That meant building an AI assistant capable of generating production-quality Playwright tests from natural language descriptions.

While existing large language models (like GPT-4 or Claude) can write tests, they lack crucial domain-specific knowledge. They struggle with modern Playwright locator strategies, proper page object patterns, flakiness hardening, and the structured conversation flows that mirror how real Software Development Engineers in Test (SDETs) think. We realized we needed something highly specialized.

## The Approach

Rather than relying on complex prompt engineering with a general-purpose model, we decided to fine-tune **Qwen3-8B** on thousands of synthetic SDET conversations. Here is the full story of our journey—from synthetic data generation to serverless deployment.

---

## Step 1: Synthetic Data Generation

We wrote two data generation pipelines to create training data that mimics real SDET workflows.

### V1: Template-Based Generation

The first script (`scripts/generate-sdet-training-data.py`) used 13 scenario templates across 8 page object types (LoginPage, DashboardPage, PaymentPage, etc.) and 10 utility functions. Each example was a JSONL entry with a user request and an assistant Playwright code response:

```
Feature: Login with valid credentials
Scenario: User logs in with valid email and password
Given the user is on the login page
When the user enters "user@example.com" and "validpassword"
And clicks the login button
Then the user should be redirected to the dashboard
```

Which generated:

```typescript
import { test, expect } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';
import { DashboardPage } from '../pages/DashboardPage';
import { loginAs } from '../utils/auth';

test('Login with valid credentials', async ({ page }) => {
    const loginPage = new LoginPage(page);
    const dashboardPage = new DashboardPage(page);
    await loginPage.goto();
    await loginAs(page, 'user@example.com', 'validpassword');
    await expect(dashboardPage.welcomeMessage).toBeVisible();
    await expect(dashboardPage.welcomeMessage).toContainText('Welcome');
});
```

We also generated negative variants (invalid credentials, error handling) and raw Playwright variants (no page objects).

### V2: Combinatorial Generation

The second script (`scripts/generate-sdet-training-data-v2.py`) was more ambitious. It permuted across:

- **12 families**: login, login_error, logout, profile, signup, search, payment, payment_error, settings, admin, navigation, raw boundary tests
- **Page object combinations**: which POs are "available" in the repo
- **Utility combinations**: which utils are "available"
- **Data variants**: different credentials, search queries, card numbers, themes, languages
- **Single-turn vs. multi-turn**: full conversations following our conversation graph

The multi-turn data followed 3 path variants through a 16-node conversation graph:

1. **No-Clarify/Accept** (5 turns): Clear requirement -> proceed -> generate -> accept
2. **Clarify/Accept** (6 turns): Vague -> clarify -> clarified -> proceed -> generate -> accept
3. **No-Clarify/Revise/Accept** (6 turns): Clear -> generate -> request revision -> revised -> accept

Each user message included repo context (available page objects, utility functions, base URL) so the model learned to use existing abstractions rather than generating standalone scripts.

The system prompt was concise:

> *"You are an expert Senior SDET. Given automation repo context and a test scenario, output only the Playwright test code. Be concise. No reasoning, no explanation."*

Output: 2000+ training examples in ShareGPT conversation format.

---

## Step 2: Fine-Tuning on Kaggle

We trained on **Kaggle GPUs** (dual T4) using **Unsloth** with QLoRA 4-bit quantization.

### Model
- **Base**: `Qwen/Qwen3-8B`
- **Quantization**: 4-bit NormalFloat (QLoRA) via BitsAndBytes
- **LoRA rank**: 16 (alpha=16, dropout=0)
- **Target modules**: `q_proj, k_proj, v_proj, o_proj, gate_proj, up_proj, down_proj`

### Training
- **Sequence length**: 8192 tokens
- **Batch**: 2 per GPU, 4 gradient accumulation steps
- **Learning rate**: 2e-5 (cosine scheduler)
- **Optimizer**: AdamW 8-bit
- **Epochs**: 10
- **Loss masking**: Response-only (masked user messages, trained only on assistant tokens)
- **Estimated runtime**: ~1.2 hours on T4, ~20 minutes on A100

The loss masking was critical we used `<|im_start|>assistant` as the response delimiter token so the model learned to generate Playwright code, not parrot back user messages.

### Key Insight

The conversation template preserved the full multi-turn dialogue structure. The model learned not just *what code to write* but *when to ask clarifying questions*, *how to handle revisions*, and *when to confirm the user's intent* mirroring the 16-node graph that our SDET Workbench application uses.

### Saving

After training, the LoRA adapter was merged and pushed to Hugging Face Hub:

```python
model.save_pretrained_merged(
    "hbahuguna/qwen-3-8B-sdet",
    tokenizer,
    save_method="lora",
    push_to_hub=True
)
```

---

## Step 3: Serverless Deployment on Modal

We deployed the fine-tuned model as a **serverless GPU endpoint** on [Modal](https://modal.com). No VMs to manage, no always-on costs, auto-scaling to zero.

### The Deploy File

```python
import modal
from transformers import AutoModelForCausalLM, AutoTokenizer
import torch

app = modal.App("qwen-3-8b-sdet")

image = (
    modal.Image.debian_slim()
    .pip_install("torch", "transformers", "accelerate", "huggingface_hub", "fastapi[standard]")
)

@app.cls(
    gpu="T4",
    image=image,
    scaledown_window=300,
    secrets=[modal.Secret.from_name("hf-token")]
)
class QwenSDET:
    def __init__(self):
        self.model = AutoModelForCausalLM.from_pretrained(
            "hbahuguna/qwen-3-8B-sdet",
            torch_dtype=torch.float16,
            device_map="auto",
        )
        self.tokenizer = AutoTokenizer.from_pretrained("hbahuguna/qwen-3-8B-sdet")

    @modal.fastapi_endpoint(method="POST")
    def generate(self, body: dict):
        prompt = body["prompt"]
        max_tokens = body.get("max_tokens", 512)
        temperature = body.get("temperature", 0.7)
        inputs = self.tokenizer(prompt, return_tensors="pt").to("cuda")
        outputs = self.model.generate(
            **inputs,
            max_new_tokens=max_tokens,
            temperature=temperature,
            do_sample=True,
        )
        return {
            "response": self.tokenizer.decode(
                outputs[0], skip_special_tokens=True
            )
        }
```

### Deployment

```bash
modal secret create hf-token HF_TOKEN=hf_your_token_here
modal deploy modal_deploy.py
```

A few minutes later:

```
✓ Created Web Function URL for QwenSDET.generate =>
   https://hbahuguna--qwen-3-8b-sdet-qwensdet-generate.modal.run
```

### Key Design Decisions

- **Cold start**: First call takes ~5-10 minutes (downloads 8B model weights). Modal caches the image for subsequent calls.
- **Scale-to-zero**: After 5 minutes idle, the container shuts down. Next call cold-starts again. No hourly billing waste.
- **T4 GPU**: 16GB VRAM holds a fp16 8B model comfortably. For lower latency, we could upgrade to A10G.
- **HF token secret**: The model is hosted at `hbahuguna/qwen-3-8B-sdet` on Hugging Face. Modal needs the token to download gated models.

Cost: ~$0.43/hr on T4, but with auto-scaling, actual usage cost is minimal.

---

## Step 4: Results

### API in Action

```python
import requests

resp = requests.post(
    "https://hbahuguna--qwen-3-8b-sdet-qwensdet-generate.modal.run",
    json={
        "prompt": "Write a Playwright test that logs in with user@example.com, "
                  "searches for 'laptop', and verifies results appear",
        "max_tokens": 512,
        "temperature": 0.7
    }
)

print(resp.json()["response"])
```

Output:

```typescript
import { test, expect } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';
import { SearchResultsPage } from '../pages/SearchResultsPage';
import { loginAs } from '../utils/auth';

test.describe('Product Search', () => {
    test('search for laptop and verify results', async ({ page }) => {
        const loginPage = new LoginPage(page);
        const searchPage = new SearchResultsPage(page);

        await loginPage.goto();
        await loginAs(page, 'user@example.com', 'validpassword');
        await expect(page).toHaveURL(/dashboard/);

        await searchPage.searchInput.fill('laptop');
        await searchPage.searchButton.click();
        await expect(searchPage.resultsContainer).toBeVisible();
        await expect(searchPage.resultsContainer).toContainText('laptop');
        await expect(searchPage.resultItems).not.toHaveCount(0);
    });
});
```

### Comparison

| Dimension | Before (Base Qwen3-8B) | After (Fine-Tuned) |
|---|---|---|
| Uses page objects | Rarely | Consistently |
| Uses utilities (loginAs) | No | Yes |
| Playwright best practices | Inconsistent | Always |
| Proper assertions | Generates generic `page.waitForSelector` | Generates `expect().toBeVisible()` |
| Multi-turn conversation | Struggles | Follows graph naturally |
| Handles revision requests | Rephrases from scratch | Modifies specific sections |

### Integration with SDET Workbench

The fine-tuned model plugs into our conversation state machine a 16-node graph that mirrors the training data structure:

```
UserRequest -> ParseRequirement -> ClarifyHub ->
  DetermineIntent -> IntentHub ->
    IdentifyJourney -> FeatureHub ->
      IdentifyElements -> DetermineLocators ->
        PlanActions -> DesignAssertions ->
          AddReliability -> GenerateCode -> ReviewHub
```

The model handles the "thinking" at each node while the graph enforces structural constraints: max 2 clarify iterations, max 2 revise iterations, max 35 total turns. This hybrid approach (structured graph + LLM intelligence) gives us the best of both worlds.

---

## Key Takeaways

1. **Synthetic data is effective for domain specialization.** Our template-based approach produced consistent training data, while the combinatorial V2 pipeline expanded our coverage without manual effort.

2. **Conversation structure matters as much as code.** By embedding our full multi-turn graph structure into the training data, the model learned interaction patterns (like clarifying ambiguity or handling revisions)—not just raw code generation.

3. **QLoRA on Kaggle is practical.** Using 4-bit quantization allowed us to fine-tune an 8B model on dual T4 GPUs in approximately one hour. The resulting quality is competitive with full-parameter fine-tuning.

4. **Serverless GPU deployment is a good fit.** For an API that handles bursty workloads like test generation, paying per-call rather than per-hour is more cost-effective. Modal's scale-to-zero architecture ensures we pay $0 when the service is idle.

5. **The hybrid graph + model approach is useful.** Combining a structured state machine with LLM intelligence at each node provides reliability that pure LLM approaches lack. The graph enforces boundaries, and the model provides intelligence within them.

---

*Built with TestRadius. Model: [hbahuguna/qwen-3-8B-sdet](https://huggingface.co/hbahuguna/qwen-3-8B-sdet).*
