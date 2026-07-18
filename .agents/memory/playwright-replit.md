---
name: Playwright Chromium on Replit
description: How to get Playwright Chromium working in the Replit NixOS environment
---

## Problem
Playwright downloads its own Chromium binary, but it crashes immediately on Replit because system libraries (libglib, libnss, libX11, etc.) are missing.

## Fix
1. Install system Chromium via `installSystemDependencies`:
   - packages: `["chromium", "nss", "nspr", "atk", "at-spi2-atk", "xorg.libX11", "xorg.libxcb", "dbus", "glib", "alsa-lib", "cups", "xorg.libXcomposite", "xorg.libXdamage", "xorg.libXext", "xorg.libXfixes", "xorg.libXrandr", "expat", "libdrm", "mesa"]`
2. Find the Nix Chromium path: `ls /nix/store/*/bin/chromium`
3. Set env var `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to the Nix path
4. In `browserStart()`, pass `executablePath` and these required args:
   ```
   --no-sandbox, --disable-setuid-sandbox, --disable-dev-shm-usage, --disable-gpu, --single-process
   ```

**Why:** Replit's NixOS sandbox doesn't have the glibc/X11/NSS libraries that Playwright's bundled Chromium needs, and `playwright install-deps` is blocked (no apt/brew). The system Nix chromium package has everything self-contained.

**How to apply:** Any time Playwright browser tests fail with "Executable doesn't exist" or "libglib-2.0.so.0: cannot open shared object file", apply this fix.
