# Awesome Design Skills [![Awesome](https://awesome.re/badge.svg)](https://awesome.re)

<img width="1200" height="630" alt="og-awesome-design-skills" src="https://github.com/user-attachments/assets/d392937a-a0a3-408d-b3f8-4d8920f836f9" />

<br>

> A curated registry of 67 design system skill files for AI-powered agentic tools like [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview), [Cursor](https://www.cursor.com/), [Codex](https://openai.com/index/codex/), and others. Pull any skill into your project with a single command.

Each skill now ships as a folder with:
- `SKILL.md` for AI-agent instructions (tokens, component rules, accessibility constraints, quality gates)
- `DESIGN.md` for human-readable design intent, rationale, and implementation notes

**[Preview all design skills on Type UI](https://typeui.sh/design-skills)**

## Quick Start

Pull any design skill directly into your project using the [TypeUI CLI](https://github.com/bergside/typeui.sh):

```bash
npx typeui.sh pull <slug>
```

For example, to pull the Glassmorphism design skill:

```bash
npx typeui.sh pull glassmorphism
```

Or browse all available skills interactively:

```bash
npx typeui.sh list
```

## What is a Design Skill?

A design skill is a folder containing `SKILL.md` and `DESIGN.md`.

`SKILL.md` acts as the instruction source for AI agents and LLMs. It contains:

- **Brand & mission** — the design philosophy and visual identity
- **Style foundations** — typography scale, color palette, spacing system
- **Component families** — buttons, inputs, cards, modals, navigation, and more
- **Accessibility rules** — WCAG 2.2 AA compliance, keyboard-first interactions
- **Writing tone** — content and voice guidelines
- **Do/Don't rules** — explicit patterns and anti-patterns
- **Quality gates** — testable acceptance criteria for code review

`DESIGN.md` is a companion document for human readers and maintainers. It captures:

- **Design overview** — concise summary of the visual direction
- **Rationale and references** — context for why patterns/tokens exist
- **Maintenance notes** — guidance for keeping design decisions aligned over time

When an AI agent reads a skill file, it follows the `SKILL.md` guidelines to generate UI code that is consistent, accessible, and true to the design system.

## Design Skills

Browse all **67** design skills. Click any thumbnail to open the live preview on [typeui.sh/design-skills](https://typeui.sh/design-skills), or copy the pull command underneath to add the skill to your project.

<table>
  <tr>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/agentic"><img src="https://www.typeui.sh/registry-examples/agentic.png" alt="Agentic" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/agentic"><b>Agentic</b></a><br />
      <sub><code>npx typeui.sh pull agentic</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/ant"><img src="https://www.typeui.sh/registry-examples/ant.png" alt="Ant" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/ant"><b>Ant</b></a><br />
      <sub><code>npx typeui.sh pull ant</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/application"><img src="https://www.typeui.sh/registry-examples/application.png" alt="Application" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/application"><b>Application</b></a><br />
      <sub><code>npx typeui.sh pull application</code></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/artistic"><img src="https://www.typeui.sh/registry-examples/artistic.png" alt="Artistic" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/artistic"><b>Artistic</b></a><br />
      <sub><code>npx typeui.sh pull artistic</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/bento"><img src="https://www.typeui.sh/registry-examples/bento.png" alt="Bento" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/bento"><b>Bento</b></a><br />
      <sub><code>npx typeui.sh pull bento</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/bold"><img src="https://www.typeui.sh/registry-examples/bold.png" alt="Bold" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/bold"><b>Bold</b></a><br />
      <sub><code>npx typeui.sh pull bold</code></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/brutalism"><img src="https://www.typeui.sh/registry-examples/brutalism.png" alt="Brutalism" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/brutalism"><b>Brutalism</b></a><br />
      <sub><code>npx typeui.sh pull brutalism</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/cafe"><img src="https://www.typeui.sh/registry-examples/cafe.png" alt="Cafe" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/cafe"><b>Cafe</b></a><br />
      <sub><code>npx typeui.sh pull cafe</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/claymorphism"><img src="https://www.typeui.sh/registry-examples/claymorphism.png" alt="Claymorphism" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/claymorphism"><b>Claymorphism</b></a><br />
      <sub><code>npx typeui.sh pull claymorphism</code></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/claude"><img src="https://www.typeui.sh/registry-examples/claude.png" alt="Claude" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/claude"><b>Claude</b></a><br />
      <sub><code>npx typeui.sh pull claude</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/clean"><img src="https://www.typeui.sh/registry-examples/clean.png" alt="Clean" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/clean"><b>Clean</b></a><br />
      <sub><code>npx typeui.sh pull clean</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/codex"><img src="https://www.typeui.sh/registry-examples/codex.png" alt="Codex" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/codex"><b>Codex</b></a><br />
      <sub><code>npx typeui.sh pull codex</code></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/colorful"><img src="https://www.typeui.sh/registry-examples/colorful.png" alt="Colorful" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/colorful"><b>Colorful</b></a><br />
      <sub><code>npx typeui.sh pull colorful</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/contemporary"><img src="https://www.typeui.sh/registry-examples/contemporary.png" alt="Contemporary" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/contemporary"><b>Contemporary</b></a><br />
      <sub><code>npx typeui.sh pull contemporary</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/corporate"><img src="https://www.typeui.sh/registry-examples/corporate.png" alt="Corporate" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/corporate"><b>Corporate</b></a><br />
      <sub><code>npx typeui.sh pull corporate</code></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/cosmic"><img src="https://www.typeui.sh/registry-examples/cosmic.png" alt="Cosmic" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/cosmic"><b>Cosmic</b></a><br />
      <sub><code>npx typeui.sh pull cosmic</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/creative"><img src="https://www.typeui.sh/registry-examples/creative.png" alt="Creative" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/creative"><b>Creative</b></a><br />
      <sub><code>npx typeui.sh pull creative</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/dashboard"><img src="https://www.typeui.sh/registry-examples/dashboard.png" alt="Dashboard" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/dashboard"><b>Dashboard</b></a><br />
      <sub><code>npx typeui.sh pull dashboard</code></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/dithered"><img src="https://www.typeui.sh/registry-examples/dithered.png" alt="Dithered" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/dithered"><b>Dithered</b></a><br />
      <sub><code>npx typeui.sh pull dithered</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/doodle"><img src="https://www.typeui.sh/registry-examples/hand-drawn.png" alt="Doodle" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/doodle"><b>Doodle</b></a><br />
      <sub><code>npx typeui.sh pull doodle</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/dramatic"><img src="https://www.typeui.sh/registry-examples/dramatic.png" alt="Dramatic" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/dramatic"><b>Dramatic</b></a><br />
      <sub><code>npx typeui.sh pull dramatic</code></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/editorial"><img src="https://www.typeui.sh/registry-examples/editorial.png" alt="Editorial" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/editorial"><b>Editorial</b></a><br />
      <sub><code>npx typeui.sh pull editorial</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/elegant"><img src="https://www.typeui.sh/registry-examples/elegant.png" alt="Elegant" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/elegant"><b>Elegant</b></a><br />
      <sub><code>npx typeui.sh pull elegant</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/energetic"><img src="https://www.typeui.sh/registry-examples/energetic.png" alt="Energetic" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/energetic"><b>Energetic</b></a><br />
      <sub><code>npx typeui.sh pull energetic</code></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/enterprise"><img src="https://www.typeui.sh/registry-examples/enterprise.png" alt="Enterprise" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/enterprise"><b>Enterprise</b></a><br />
      <sub><code>npx typeui.sh pull enterprise</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/expressive"><img src="https://www.typeui.sh/registry-examples/expressive.png" alt="Expressive" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/expressive"><b>Expressive</b></a><br />
      <sub><code>npx typeui.sh pull expressive</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/fantasy"><img src="https://www.typeui.sh/registry-examples/fantasy.png" alt="Fantasy" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/fantasy"><b>Fantasy</b></a><br />
      <sub><code>npx typeui.sh pull fantasy</code></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/fiction"><img src="https://www.typeui.sh/registry-examples/fiction.png" alt="Fiction" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/fiction"><b>Fiction</b></a><br />
      <sub><code>npx typeui.sh pull fiction</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/flat"><img src="https://www.typeui.sh/registry-examples/flat.png" alt="Flat" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/flat"><b>Flat</b></a><br />
      <sub><code>npx typeui.sh pull flat</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/friendly"><img src="https://www.typeui.sh/registry-examples/friendly.png" alt="Friendly" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/friendly"><b>Friendly</b></a><br />
      <sub><code>npx typeui.sh pull friendly</code></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/futuristic"><img src="https://www.typeui.sh/registry-examples/futuristic.png" alt="Futuristic" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/futuristic"><b>Futuristic</b></a><br />
      <sub><code>npx typeui.sh pull futuristic</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/glassmorphism"><img src="https://www.typeui.sh/registry-examples/glassmorphism.png" alt="Glassmorphism" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/glassmorphism"><b>Glassmorphism</b></a><br />
      <sub><code>npx typeui.sh pull glassmorphism</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/gradient"><img src="https://www.typeui.sh/registry-examples/gradient.png" alt="Gradient" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/gradient"><b>Gradient</b></a><br />
      <sub><code>npx typeui.sh pull gradient</code></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/immersive"><img src="https://www.typeui.sh/registry-examples/immersive.png" alt="Immersive" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/immersive"><b>Immersive</b></a><br />
      <sub><code>npx typeui.sh pull immersive</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/impeccable"><img src="https://www.typeui.sh/registry-examples/impeccable.png" alt="Impeccable" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/impeccable"><b>Impeccable</b></a><br />
      <sub><code>npx typeui.sh pull impeccable</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/levels"><img src="https://www.typeui.sh/registry-examples/levels.png" alt="Levels" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/levels"><b>Levels</b></a><br />
      <sub><code>npx typeui.sh pull levels</code></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/lingo"><img src="https://www.typeui.sh/registry-examples/lingo.png" alt="Lingo" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/lingo"><b>Lingo</b></a><br />
      <sub><code>npx typeui.sh pull lingo</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/luxury"><img src="https://www.typeui.sh/registry-examples/luxury.png" alt="Luxury" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/luxury"><b>Luxury</b></a><br />
      <sub><code>npx typeui.sh pull luxury</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/material"><img src="https://www.typeui.sh/registry-examples/material.png" alt="Material" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/material"><b>Material</b></a><br />
      <sub><code>npx typeui.sh pull material</code></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/matrix"><img src="https://www.typeui.sh/registry-examples/matrix.png" alt="Matrix" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/matrix"><b>Matrix</b></a><br />
      <sub><code>npx typeui.sh pull matrix</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/minimal"><img src="https://www.typeui.sh/registry-examples/minimal.png" alt="Minimal" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/minimal"><b>Minimal</b></a><br />
      <sub><code>npx typeui.sh pull minimal</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/modern"><img src="https://www.typeui.sh/registry-examples/modern.png" alt="Modern" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/modern"><b>Modern</b></a><br />
      <sub><code>npx typeui.sh pull modern</code></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/mono"><img src="https://www.typeui.sh/registry-examples/mono.png" alt="Mono" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/mono"><b>Mono</b></a><br />
      <sub><code>npx typeui.sh pull mono</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/neon"><img src="https://www.typeui.sh/registry-examples/neon.png" alt="Neon" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/neon"><b>Neon</b></a><br />
      <sub><code>npx typeui.sh pull neon</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/neobrutalism"><img src="https://www.typeui.sh/registry-examples/neobrutalism.png" alt="Neobrutalism" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/neobrutalism"><b>Neobrutalism</b></a><br />
      <sub><code>npx typeui.sh pull neobrutalism</code></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/neumorphism"><img src="https://www.typeui.sh/registry-examples/neumorphism.png" alt="Neumorphism" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/neumorphism"><b>Neumorphism</b></a><br />
      <sub><code>npx typeui.sh pull neumorphism</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/pacman"><img src="https://www.typeui.sh/registry-examples/pacman.png" alt="Pacman" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/pacman"><b>Pacman</b></a><br />
      <sub><code>npx typeui.sh pull pacman</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/paper"><img src="https://www.typeui.sh/registry-examples/paper.png" alt="Paper" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/paper"><b>Paper</b></a><br />
      <sub><code>npx typeui.sh pull paper</code></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/perspective"><img src="https://www.typeui.sh/registry-examples/perspective.png" alt="Perspective" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/perspective"><b>Perspective</b></a><br />
      <sub><code>npx typeui.sh pull perspective</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/premium"><img src="https://www.typeui.sh/registry-examples/premium.png" alt="Premium" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/premium"><b>Premium</b></a><br />
      <sub><code>npx typeui.sh pull premium</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/professional"><img src="https://www.typeui.sh/registry-examples/professional.png" alt="Professional" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/professional"><b>Professional</b></a><br />
      <sub><code>npx typeui.sh pull professional</code></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/publication"><img src="https://www.typeui.sh/registry-examples/publication.png" alt="Publication" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/publication"><b>Publication</b></a><br />
      <sub><code>npx typeui.sh pull publication</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/refined"><img src="https://www.typeui.sh/registry-examples/refined.png" alt="Refined" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/refined"><b>Refined</b></a><br />
      <sub><code>npx typeui.sh pull refined</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/retro"><img src="https://www.typeui.sh/registry-examples/retro.png" alt="Retro" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/retro"><b>Retro</b></a><br />
      <sub><code>npx typeui.sh pull retro</code></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/riso"><img src="https://www.typeui.sh/registry-examples/riso.png" alt="Riso" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/riso"><b>Riso</b></a><br />
      <sub><code>npx typeui.sh pull riso</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/sega"><img src="https://www.typeui.sh/registry-examples/sega.png" alt="Sega" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/sega"><b>Sega</b></a><br />
      <sub><code>npx typeui.sh pull sega</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/shadcn"><img src="https://www.typeui.sh/registry-examples/shadcn.png" alt="Shadcn" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/shadcn"><b>Shadcn</b></a><br />
      <sub><code>npx typeui.sh pull shadcn</code></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/simple"><img src="https://www.typeui.sh/registry-examples/simple.png" alt="Simple" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/simple"><b>Simple</b></a><br />
      <sub><code>npx typeui.sh pull simple</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/sketch"><img src="https://www.typeui.sh/registry-examples/sketch.png" alt="Sketch" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/sketch"><b>Sketch</b></a><br />
      <sub><code>npx typeui.sh pull sketch</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/skeumorphism"><img src="https://www.typeui.sh/registry-examples/skeumorphism.png" alt="Skeumorphism" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/skeumorphism"><b>Skeumorphism</b></a><br />
      <sub><code>npx typeui.sh pull skeumorphism</code></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/sleek"><img src="https://www.typeui.sh/registry-examples/sleek.png" alt="Sleek" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/sleek"><b>Sleek</b></a><br />
      <sub><code>npx typeui.sh pull sleek</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/spacious"><img src="https://www.typeui.sh/registry-examples/spacious.png" alt="Spacious" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/spacious"><b>Spacious</b></a><br />
      <sub><code>npx typeui.sh pull spacious</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/storytelling"><img src="https://www.typeui.sh/registry-examples/storytelling.png" alt="Storytelling" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/storytelling"><b>Storytelling</b></a><br />
      <sub><code>npx typeui.sh pull storytelling</code></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/terracotta"><img src="https://www.typeui.sh/registry-examples/terracotta.png" alt="Terracotta" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/terracotta"><b>Terracotta</b></a><br />
      <sub><code>npx typeui.sh pull terracotta</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/tetris"><img src="https://www.typeui.sh/registry-examples/tetris.png" alt="Tetris" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/tetris"><b>Tetris</b></a><br />
      <sub><code>npx typeui.sh pull tetris</code></sub>
    </td>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/vibrant"><img src="https://www.typeui.sh/registry-examples/vibrant.png" alt="Vibrant" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/vibrant"><b>Vibrant</b></a><br />
      <sub><code>npx typeui.sh pull vibrant</code></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%" valign="top">
      <a href="https://typeui.sh/design-skills/vintage"><img src="https://www.typeui.sh/registry-examples/vintage.png" alt="Vintage" width="260" /></a><br />
      <a href="https://typeui.sh/design-skills/vintage"><b>Vintage</b></a><br />
      <sub><code>npx typeui.sh pull vintage</code></sub>
    </td>
    <td align="center" width="33%"></td>
    <td align="center" width="33%"></td>
  </tr>
</table>

## Usage

### Pull a skill into your project

Use the [typeui.sh CLI](https://github.com/bergside/typeui.sh) to pull any skill by its slug:

```bash
npx typeui.sh pull <slug>
```

The CLI will fetch the `SKILL.md` file from this registry and write it to your configured provider paths (e.g., `.cursor/skills/`, `.claude/`, etc.). The companion `DESIGN.md` remains in this repo alongside each skill for reference and maintenance.

### Specify providers

Target specific agentic tools when pulling:

```bash
npx typeui.sh pull glassmorphism -p cursor,claude
```

### Preview before writing

Use `--dry-run` to see what would be written without making changes:

```bash
npx typeui.sh pull glassmorphism --dry-run
```

### Browse and pull interactively

List all available skills with preview links, then pull one:

```bash
npx typeui.sh list
```

### Generate a custom skill

Run the interactive prompts to create your own design system skill:

```bash
npx typeui.sh generate
```

## Registry Structure

Each skill lives in its own folder under `skills/`:

```
skills/
├── index.json          # Slug-keyed map for fast CLI lookups
├── glassmorphism/
│   ├── SKILL.md        # AI-agent instruction file
│   └── DESIGN.md       # Human-readable design companion
├── brutalism/
│   ├── SKILL.md
│   └── DESIGN.md
├── minimal/
│   ├── SKILL.md
│   └── DESIGN.md
└── ...
```

The `index.json` file maps each slug to its skill path:

```json
{
  "glassmorphism": {
    "slug": "glassmorphism",
    "name": "Glassmorphism",
    "skillPath": "skills/glassmorphism/SKILL.md"
  }
}
```

When you run `npx typeui.sh pull <slug>`, the CLI reads this index, resolves the skill path, and fetches the corresponding `SKILL.md` file. `DESIGN.md` is stored next to each skill for human-facing documentation.

## Contributing

Contributions are welcome! If you'd like to add a new design skill to the registry:

1. Create a new folder under `skills/` with your slug name
2. Add a `SKILL.md` file following the existing format
3. Add a companion `DESIGN.md` file in the same folder
4. Add an entry to `skills/index.json`
5. Submit a pull request

Please ensure your skill file includes all required sections: mission, brand, style foundations, component families, accessibility rules, writing tone, do/don't rules, and quality gates.

## License

[MIT License](LICENSE) &copy; Built and maintained by [Bergside](https://github.com/bergside).

## Sponsors

A huge thank you to the companies supporting our open-source work.

<table width="100%">
  <tr>
    <td align="center" width="33%">
      <a href="https://www.skybridge.tech/?ref=typeui.sh" target="_blank" rel="noopener noreferrer">
        <img src="https://github.com/user-attachments/assets/88c401ee-b19b-4b78-9a7e-325337dba529" alt="Skybridge" width="300" />
        <br /><b>Skybridge</b>
      </a>
    </td>
  </tr>
</table>

Want to see your logo here? [Become a sponsor](https://www.typeui.sh/sponsor).
