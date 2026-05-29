# AI IDE Onboarding Flow

The onboarding experience for an AI-native IDE should feel fast, lightweight, clean, and exciting. More like opening a creative app than configuring infrastructure.

The goal is to get users to their first useful AI-assisted coding moment as quickly as possible.

---

# 1. Welcome Screen

Short, visual, and logo-forward.

Primary copy:

> Backboard Studio

Minimal UI:
- Logo
- Get Started
- Very short supporting line

Avoid:
- Header chrome
- Logo cards or boxed logo containers
- Feature lists
- Setup explanations
- Dense onboarding text

---

# 2. Choose How You Work

Keep the choice simple. Two paths only.

The mode choices should be flat image selections, not boxed setup cards:
- no nested screenshot containers
- no bullet/checkmark rows
- no logo mark in the mode heading
- short text under each mode title
- rounded "Continue with..." buttons
- the whole mode block is also clickable

## Simple

For users who want a prompt-first, preview-first experience.

UI should communicate:
- Natural conversation
- Instant preview
- No setup required

Use `zed/assets/onboarding/simple.png` as the card preview.
Use `zed/assets/onboarding/simple_dark.png` when the active theme is dark.

This mode should feel friendly, bubbly, visual, and low-friction.

## Developer

For users who want the full editor experience.

UI should communicate:
- Full code editor
- Agent workspace
- Terminal and tools

Use `zed/assets/onboarding/dev.png` as the card preview.
Use `zed/assets/onboarding/dev_dark.png` when the active theme is dark.

This mode should still feel lightweight. Do not make it feel like an advanced configuration screen.

---

# 3. Pick a Look

Use theme selection as a quick visual personalization step.

Default:

> Lofi White

Copy should stay short:

> Start bright. Change it anytime.

Keep this page visual:
- Large theme previews
- Minimal labels
- No long descriptions

---

# 4. Bring Your Setup

Offer import settings as its own lightweight page.

Options:
- VS Code
- Cursor

Use the real app icon assets instead of generic text buttons:
- `zed/assets/onboarding/Visual_Studio_Code_1.35_icon.svg.png`
- `zed/assets/onboarding/cursor-logo-png_seeklogo-611587.png`

The app icons should be large and flat on the page:
- no bordered card container around each import option
- no padded shell around the logo
- include a visible Skip action

Copy:

> One click. Skip it if you want a fresh start.

This should feel optional. Never block forward motion.

---

# 5. Connect Backboard

After import settings, show a lightweight API key setup page.

UI:
- API key input
- Open Backboard Dashboard
- Save and Finish
- Skip for now

Copy:

> Add your API key now, or skip and do it later.

Keep it short and optional. The user should never feel stuck on this page.

---

# 6. First Magic Moment

The user should immediately see the AI do something useful after setup.

Examples:
- Explain this repository
- Generate a README
- Find bugs
- Create a feature
- Ask questions about the codebase

The onboarding is not complete until the user sees real value.

---

# 7. Lightweight Feature Hints

Avoid long tutorials.

Use tiny contextual hints while the user works:
- `Cmd + K` for AI actions
- `@repo` for repository context
- `/agent` for autonomous workflows

Hints should appear naturally inside the editor.

---

# 8. Advanced Setup

Never force advanced setup upfront.

Move these to Settings:
- MCP servers
- SSH connections
- Sandboxing
- Custom providers
- Cloud runners
- Indexing settings

Default should always feel like:

> Start instantly.

---

# Core Philosophy

The biggest mistake most IDEs make is treating onboarding like infrastructure setup.

Backboard Studio onboarding should feel:
- fast
- modern
- fun
- bubbly
- clean
- visual
- creator-focused

Use more assets and fewer words. Users should feel momentum within the first minute.

Asset-heavy onboarding pages should preload their images in the background so screenshots and app logos are ready before the user reaches each step.
