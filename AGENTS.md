# TaleSide project instructions

## 1. Project Identity

TaleSide is an application intended to turn written fiction into persistent, interactive simulations that users can participate in.

The long-term goal is to reconstruct fictional settings from their source material with enough understanding of their inhabitants, history, geography, relationships, rules, and ongoing circumstances to support believable events beyond the original narrative.

The original literature provides the foundation for the simulation.

The ultimate objective is a coherent, persistent fictional reality that can evolve through its own internal processes while remaining responsive to user participation.

IMPORTANT: Whenever installing any library, tool etc. Check its license. Then check any libraries or tools or any other similar software it uses and check their license. Repeat the chain. Reasoning is because we do not want to use a dependency that, due to my license, we are not allowed to legally use. Use tools and add them to the repo for current and future use, you can also make your own notes in a dedicated folder for the license checker. Tools such as pip-licenses and @lizenz/checker. However, package metadata scanners only inspect Python/npm packages ,etc. always check the license of external binaries too. Sometimes a safe library (for instance, pypdfium2—which wraps Google's Apache/BSD PDFium) shows up as UNKNOWN or non-standard in automated scanners. That's why using allowlist mode (--allow-only / --onlyAllow) is best: it pauses and forces you to verify UNKNOWN packages once instead of silently letting them pass.

My license is PolyForm Shield 1.0.0 and therefore some licenses that are not allowed include but are not limited to, AGPL, GPL, SSPL, CC-BY-NC / non-commercial, paid/proprietary SDKs while some that are allowed include MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, CC0-1.0, Unlicense, PSF-2.0.

Many Python packages on PyPI declare full text names like "MIT License", "Apache Software License", "BSD License", "ISC License (ISCL)", or "Python Software Foundation License" instead of "MIT" or "Apache-2.0". If your --allow-only list only has short SPDX IDs, pip-licenses will fail on safe packages like FastAPI or uvicorn until you include those standard PyPI strings too.

Additionally, keep everything truly local, everything related to the app if it can be done, remains within TaleSide, so for example, no LOCALAPPDATA folder should be used.

## 2. Changelog Model
Changelog model: [Versioned Releases | Continuous/Dated | None]
This project's model: Versioned Releases
Rules:
- Versioned Releases: notable completed changes go under `## Unreleased` and are moved into a versioned section when a release is created.
- Continuous/Dated: notable completed changes are recorded when they become part of the delivered project. Do not wait for or invent a formal release.
- None: this project does not maintain a changelog unless this policy is explicitly changed.

## 3. Launcher & Terminal UI

The terminal launcher (`Start TaleSide.cmd` and startup output in `src/server/main.ts`) is a quiet power switch and startup safety net—not a dashboard, menu, or log viewer. TaleSide’s real UI lives in the browser.

Rules:
- **Keep `Start TaleSide.cmd` minimal:** Only jump to the TaleSide folder, set the window title (`TaleSide`), check prerequisites that must exist before Node can run (e.g., Node and `node_modules`), launch quietly, and pause on non-zero exit. Put richer checks, formatting, and error messages in Node rather than complex batch scripting.
- **Hide routine tool chatter:** Suppress noisy `npm` / build headers (`> prestart`, `> tsc`) on normal startup. Only show raw build or tool output when a step actually fails.
- **Keep startup output compact and readable:** Aim for a short, calm status block (~4–6 lines: app name, status, local URL, and how to stop it). Briefly announce slow invisible startup/shutdown steps (such as pre-migration database backups or waiting for active tasks to stop) so the window never appears frozen.
- **Keep styling subtle and portable:** Only use ANSI colors on an interactive TTY (respecting `NO_COLOR`); avoid harsh full-screen `cmd` `color` commands, giant ASCII art, and animated spinners that break narrow windows or copy/paste.
- **Do not log runtime activity to the terminal:** Never stream HTTP requests, indexing chunk progress, chat turns, or worker calls to the launcher window; surface live progress and runtime errors in the browser UI.
- **No interactive terminal menus:** Double-clicking `Start TaleSide.cmd` must start the app and open the browser directly without asking the user to pick options in the console.
- **Explain expected failures in plain English:** For common blockers (missing Node/Python, port in use, newer database version), print one clear sentence and how to fix it instead of a raw stack trace.
- **Prune as you go:** Remove redundant messages between `.cmd` and Node, remove temporary debug logs, and remove obsolete prerequisite checks whenever dependencies change.

## 4. Errors, Notifications & Confirmations

Use a calm, three-tier feedback model (Inline, Bottom-right Toast, Confirmation Modal). Default to **no notification** whenever an action’s result is already visibly obvious in place, and never add a top-bar notification bell or inbox icon for app errors or background status.

Rules:
- **Ask before adding new notifications:** Do not silently invent new toasts, banners, status labels, or modals. Whenever work introduces a user-facing event, completion, warning, or error without explicit notification instructions, pause and ask the user first with a quick list covering:
  1. **Trigger:** What action, background event, or failure fires it.
  2. **Type:** Inline, Bottom-right Toast, Confirmation Modal, or None—with a short reason why.
  3. **Lifetime:** Temporary (starts fading after about 4 seconds and becomes persistent on hover) or persistent (stays until dismissed or fixed).
  4. **Conditions & wording:** Suppression/deduplication rules (e.g., skip when the relevant panel is already visible; don’t repeat in polling loops) and whether it forwards a provider error or uses a short static message.
- **Keep errors where they belong:** Keep form/drawer validation errors inline inside that panel, and attach item or message failures directly to the failed item so the reason stays visible until fixed or dismissed.
- **Forward real provider errors:** Pass through the actual error message and status from AI providers cleanly (never exposing API keys or dumping oversized raw error pages) instead of writing per-error-code guesswork.
- **Keep toasts disciplined:** Place dismissible toast cards in the bottom-right corner above open drawers and clear of active inputs. Keep error toasts persistent and deduplicated. Use temporary toasts only for non-obvious completions. Click anywhere on a toast to dismiss it.
- **Don’t use modals as notifications:** Never pop up a modal dialog just to announce errors, warnings, or success notices (use inline feedback or toasts instead). Reserve confirmation modals for destructive or discard checks, and only use other modals for focused tasks or user input (like renaming or image cropping).
