# Simple Mode Settings

This doc explains the simple-mode controls in the Backboard composer: Reasoning, Web, and Image. These controls are not just labels in the UI. They are saved as Backboard settings and sent with each Backboard turn.

## Reasoning

Reasoning controls how much thinking Backboard asks the selected model to do before answering.

Options:

- `Fast`: Default. Prioritizes speed. The bridge sends no extra thinking payload.
- `Balanced`: Asks supported providers for a smaller thinking budget or lower reasoning effort.
- `Deep`: Asks supported providers for a larger thinking budget or higher reasoning effort.

Does it actually work?

Yes, for providers and models that support reasoning controls. The UI saves this as `backboard.intensity`, sends it as `intensity`, and the bridge maps it into provider-specific request fields such as `effort`, `budget_tokens`, or `max_tokens`. If the selected provider/model does not support that style of reasoning, the bridge may send no extra thinking payload.

## Web

Web controls whether Backboard can use web tools during a turn.

Options:

- `Off`: Web tools are normally removed from the available tool list.
- `Auto`: Web search and web fetch tools are allowed for the turn.

Does it actually work?

Yes. The UI saves this as `backboard.webSearch`, sends it as `webSearch`, and uses it when trimming tools before the request is sent. With `Auto`, web tools such as `web_search` and `web_fetch` can be offered. With `Off`, those tools are removed unless the prompt itself looks like it needs web access.

## Image

Image controls whether Backboard can generate images during a turn.

Options:

- `Off`: Image generation is normally disabled.
- `Auto`: Image generation tools and image model settings are enabled for the turn.

Does it actually work?

Yes. The UI saves this as `backboard.imageGeneration`, sends it as `imageGeneration` when enabled, and uses it when trimming tools before the request is sent. With `Auto`, image tools such as `generate_image` or `image_generate` can be offered. With `Off`, Backboard can still auto-enable image generation for prompts that clearly ask to generate, create, draw, render, or make an image.

## Source Map

- UI controls, saved options, and request payload: `extensions/backboard/src/extension.ts`
- Settings contribution keys: `extensions/backboard/package.json`
- Bridge request fields and reasoning mapping: `extensions/backboard/rust/backboard_bridge/src/main.rs`
