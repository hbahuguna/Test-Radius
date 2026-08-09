---
name: Playwright Chromium on Replit
description: How to get Playwright/browser-use Chromium working in the Replit NixOS environment
---

## Problem
Playwright downloads its own Chromium binary, but it crashes immediately on Replit because system libraries are missing from the NixOS environment. `ldd` on the Chromium binary reveals which ones are absent.

## Fix — confirmed working
1. Run `ldd <chromium-binary> | grep "not found"` to see missing libs.
2. Install missing system deps via `installSystemDependencies`. The full set needed for headless Chromium is:
   - Already in replit.nix: `chromium`, `nss`, `nspr`, `atk`, `at-spi2-atk`, `xorg.libX11`, `xorg.libxcb`, `dbus`, `glib`, `alsa-lib`, `cups`, `xorg.libXcomposite`, `xorg.libXdamage`, `xorg.libXext`, `xorg.libXfixes`, `xorg.libXrandr`, `expat`, `libdrm`, `mesa`
   - **Also required (were missing):** `libxkbcommon`, `cairo`, `pango`, `systemd` (provides libudev), `libgbm`
3. No need to set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` — browser-use finds the Playwright-downloaded Chromium automatically once the system libs are present.
4. browser-use passes `--no-sandbox` and `--headless` internally; no extra flags needed in server code.

**Why:** Replit's NixOS sandbox doesn't ship libxkbcommon, cairo, pango, libudev, or libgbm by default; `playwright install-deps` is blocked (no apt). Adding via Nix is the correct path.

**How to apply:** Any time a browser-use or Playwright run times out on `BrowserStartEvent` / `BrowserLaunchEvent`, check `ldd` first — it's almost always a missing system lib. Install the specific missing ones rather than guessing.
