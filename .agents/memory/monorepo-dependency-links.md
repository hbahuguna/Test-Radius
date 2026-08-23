---
name: Monorepo dependency links
description: Workspace installs can be structurally incomplete even when package manifests and the frozen lockfile are correct.
---

When a package is declared in an artifact manifest and present in pnpm-lock.yaml but Vite or esbuild reports it cannot resolve, check the artifact's node_modules symlink before changing source code. A filtered install can restore one artifact while leaving another artifact's links missing; reinstall the full workspace with the frozen lockfile to restore all workspace links.

**Why:** The TestRadius preview lost its posthog-js link even though the dependency was already declared and locked. A full workspace install restored it, and also repaired missing API links such as express.

**How to apply:** Prefer the workspace-aware package installation flow. For this pnpm monorepo, use a full `pnpm install --frozen-lockfile` when multiple artifact links are missing, then restart the affected workflows.