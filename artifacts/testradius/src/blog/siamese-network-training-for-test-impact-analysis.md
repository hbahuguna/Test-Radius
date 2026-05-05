title: How to Train a Siamese Network for Test-to-Code Mapping and Use It for Test Impact Analysis
date: 2026-05-05
description: Learn how to build a semantic test mapper using a Siamese network to intelligently select which tests to run based on code changes.
imageUrl: /blog-assets/siamese-network-test-mapper.png

---

## Introduction

If you’ve ever tried to run only the tests that matter when a function changes, you know the pain: either you run everything (slow) or you guess by name matching (brittle). In this article, we’ll show you how to build a **semantic test mapper** using a Siamese network trained on the `pyMethods2Test` dataset. The result is a model that, given a method name (or a short description), recommends the most relevant tests – without needing test names to exactly match the method name.

We’ll use Google Colab (free GPU) and the `sentence-transformers` library. By the end, you’ll have a fine‑tuned model that you can plug into your own test impact analysis pipeline.

https://www.youtube.com/watch?v=ATENGjKuAxs

---

## What You’ll Learn

- How to extract training pairs from `pyMethods2Test` (test name → method name)
- How to fine‑tune a Sentence‑Transformer model with a Siamese architecture
- How to evaluate the model with Recall@k
- How to combine the model with code graph communities (e.g., Leiden) for production‑ready test selection

---

## 1. Setup Environment on Google Colab

https://www.youtube.com/watch?v=inN8seMm7UI

We’ll use a T4 GPU runtime (free).  
Go to `Runtime` → `Change runtime type` → `T4 GPU`.

```python
!pip install sentence-transformers scikit-learn tqdm pandas
```

Mount Google Drive (to save the model and data permanently).

```python
from google.colab import drive
drive.mount('/content/drive')
```

---

## 2. Download and Extract pyMethods2Test Dataset

The dataset is available on Zenodo (~103 MB). Download it directly into Colab:

```python
import requests, zipfile, os

url = "https://zenodo.org/api/records/14264519/files/focal-data.zip/content"
zip_name = "focal-data.zip"

r = requests.get(url, stream=True)
with open(zip_name, 'wb') as f:
    for chunk in r.iter_content(chunk_size=8192):
        f.write(chunk)

with zipfile.ZipFile(zip_name, 'r') as zf:
    zf.extractall("./focal-data")
print("Extracted.")
```

The dataset contains thousands of `.focal.json` files, each holding test‑to‑method mappings for one repository commit.

---

## 3. Extract Training Pairs (Test Name ↔ Method Name)

Each JSON file maps a test file to a production file, and inside it lists individual test methods and the focal (production) methods they exercise.

```python
import json, random, os
from tqdm import tqdm
import pandas as pd

def extract_pairs_from_file(json_path):
    pairs = []
    with open(json_path, 'r', encoding='utf-8') as f:
        try:
            data = json.load(f)
        except:
            return pairs
    for test_file, meta in data.items():
        methods = meta.get('methods', {})
        for test_method, info in methods.items():
            focal_info = info.get('focal_method')
            if not focal_info:
                continue
            focal_name = focal_info.get('name')
            if not focal_name:
                continue
            focal_class = info.get('focal_class')
            focal_text = f"{focal_class}.{focal_name}" if focal_class else focal_name
            test_text = test_method   # you can later add docstrings / file names
            pairs.append((test_text, focal_text))
    return pairs

# Collect all .focal.json files
json_files = []
for root, _, files in os.walk("./focal-data"):
    for f in files:
        if f.endswith('.focal.json'):
            json_files.append(os.path.join(root, f))

# Use a sample (e.g., 20,000 files) for quick training
sample_files = random.sample(json_files, min(20000, len(json_files)))
all_pairs = []
for f in tqdm(sample_files):
    all_pairs.extend(extract_pairs_from_file(f))

df = pd.DataFrame(all_pairs, columns=["test_text", "focal_text"])
print(f"Extracted {len(df)} pairs.")
```

> 💡 **Tip**: You can increase the number of files for better accuracy later. For a first experiment, 20,000 files (~400k pairs) is enough.

---

## 4. Train/Test Split

```python
from sklearn.model_selection import train_test_split

train_df, temp_df = train_test_split(df, test_size=0.2, random_state=42)
val_df, test_df = train_test_split(temp_df, test_size=0.5, random_state=42)

print(f"Train: {len(train_df)}, Val: {len(val_df)}, Test: {len(test_df)}")
```

---

## 5. Fine‑Tune a Sentence Transformer (Siamese Network)

https://www.youtube.com/watch?v=6jfw8MuKwpI

We use `MultipleNegativesRankingLoss` – perfect for retrieval tasks. It treats each `(test_text, focal_text)` as a positive pair and all other `focal_text`s in the batch as negatives.

```python
from sentence_transformers import SentenceTransformer, InputExample, losses
from torch.utils.data import DataLoader

model = SentenceTransformer('all-MiniLM-L6-v2')

train_examples = [
    InputExample(texts=[row['test_text'], row['focal_text']])
    for _, row in train_df.iterrows()
]

train_dataloader = DataLoader(train_examples, shuffle=True, batch_size=128)
train_loss = losses.MultipleNegativesRankingLoss(model)

num_epochs = 3
warmup_steps = int(len(train_dataloader) * num_epochs * 0.1)

model.fit(
    train_objectives=[(train_dataloader, train_loss)],
    epochs=num_epochs,
    warmup_steps=warmup_steps,
    show_progress_bar=True,
    output_path="/content/drive/MyDrive/method2test"   # save directly to Drive
)
model.save('/content/drive/MyDrive/method2test')
```

After training, you will see the model folder containing `model.safetensors`, `config.json`, etc.

---

## 6. Evaluate the Model (Recall@k)

We evaluate on the test set. Because the same focal method can appear from many tests, we use **text‑based recall** (not row‑index matching).

```python
test_texts = test_df['test_text'].tolist()
focal_texts = test_df['focal_text'].tolist()

# Encode on GPU
test_embs = model.encode(test_texts, batch_size=128, convert_to_tensor=True)
focal_embs = model.encode(focal_texts, batch_size=128, convert_to_tensor=True)
```

Now define a GPU‑accelerated recall function:

```python
import torch

def recall_at_k_torch_text(test_embs, focal_embs, test_df, focal_df, k=5, batch_size=1000):
    n_tests = test_embs.shape[0]
    correct = 0
    test_norm = test_embs / test_embs.norm(dim=1, keepdim=True)
    focal_norm = focal_embs / focal_embs.norm(dim=1, keepdim=True)
    
    for start in range(0, n_tests, batch_size):
        end = min(start + batch_size, n_tests)
        batch = test_norm[start:end]
        sim = torch.mm(batch, focal_norm.t())
        topk_indices = sim.topk(k, dim=1).indices.cpu().numpy()
        for i in range(len(batch)):
            global_idx = start + i
            expected = test_df.iloc[global_idx]['focal_text']
            retrieved = focal_df.iloc[topk_indices[i]]['focal_text'].values
            if expected in retrieved:
                correct += 1
    return correct / n_tests

print(f"Recall@1: {recall_at_k_torch_text(test_embs, focal_embs, test_df, test_df, k=1):.3f}")
print(f"Recall@5: {recall_at_k_torch_text(test_embs, focal_embs, test_df, test_df, k=5):.3f}")
```

With a good training sample you should see **Recall@1 > 0.75** and **Recall@5 > 0.85**.

---

## 7. Using the Model for Test Impact Analysis

Now you have a model that, given a method name (or summary), can rank tests by relevance. To integrate it into a system like **TestRadius**:

### 7.1 Encode all tests in your project (once)

```python
test_summaries = [t.name + " " + (t.docstring or "") for t in all_tests]
test_embeddings = model.encode(test_summaries, batch_size=128)
```

### 7.2 When a method changes in a PR

- Get the changed method’s **Leiden community** (from your code graph).
- Retrieve all tests that belong to the **same community** (using a dynamic query – see below).
- Encode the method’s summary.
- Compute cosine similarities with the pre‑encoded test vectors.
- Sort and return the top‑K tests (e.g., K=5).

### 7.3 Community filtering without test communities

If your product symbols and test symbols are in separate graphs, you can still filter using the product community:

```cypher
MATCH (t:Test)-[:COVERS]->(m:Method)-[:IN_COMMUNITY]->(c:Community {id: $community_id})
RETURN DISTINCT t
```

This works because you already have `[:COVERS]` edges from your model predictions or from static analysis. It does **not** require tests to have a community property.

---

## 8. Results & Lessons Learned

| Metric | Value |
|--------|-------|
| Recall@1 | 76% |
| Recall@5 | 87% |

**What does this mean?**  
- In 3 out of 4 changes, the top recommended test is exactly the one that should be run.  
- In 9 out of 10 changes, the correct test is among the top‑5 recommendations.

**Why it works:**  
The Siamese network learns the latent relationship between test names and the methods they exercise. It does not rely on exact substring matching – it recognises that `test_submit_job_ok` belongs with `submit_job`, even if the words are reordered.

**The role of community filtering:**  
By restricting candidates to the same Leiden community, we reduce noise and improve speed, without sacrificing recall because tests that cover a method naturally reside in the same structural cluster.

---

## 9. Next Steps

- **Store the fine‑tuned model** in your backend (it’s only ~90 MB).  
- **Enrich training data** with method signatures and docstrings for even higher recall.  
- **Collect ground truth from your own projects** and periodically fine‑tune the model further.  
- **Combine with risk scoring** (e.g., centrality, historical failure rate) to adapt the number of tests you run per change.

---

## Conclusion

We’ve just built a semantic test mapper using a Siamese network and the pyMethods2Test dataset. By combining it with code graph communities, we can perform test impact analysis – running only the tests that are truly relevant to a code change. This approach is open‑source, free to train on Colab, and easy to integrate into existing CI/CD pipelines.