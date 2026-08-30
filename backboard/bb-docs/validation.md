# Documentation Validation

Use this checklist when reviewing or updating `bb-docs`.

## Structure Checks

- Every feature folder directly under `bb-docs/` has these four subfolders: `ui`, `ux`, `endpoints`, `features`.
- Every required subfolder contains a `README.md`.
- Every required subfolder also contains three detailed files:
  - `ui/source-inventory.md`, `ui/screen-map.md`, `ui/code-excerpts.md`.
  - `ux/journeys.md`, `ux/states-and-errors.md`, `ux/validation-playbook.md`.
  - `endpoints/endpoint-registry.md`, `endpoints/commands-settings-services.md`, `endpoints/risk-boundaries.md`.
  - `features/implementation-map.md`, `features/ownership-and-files.md`, `features/extension-points.md`.
- Root-level documentation files include `README.md`, `source-crosswalk.md`, `source-file-index.md`, `deep-documentation-matrix.md`, `ascii-architecture-atlas.md`, and `validation.md`.
- Every required subfolder README contains a `BB-DEEP-DIVE` section with absolute source paths, code snippets, diagrams, or source inspection commands.
- Every required subfolder README contains a `BB-VERIFICATION-MATRIX` section with review evidence requirements.
- No feature docs claim a public HTTP endpoint unless a concrete URL or URL-construction path is present in source.

## Current Audit Result

The latest local audit from the repository root returned:

```text
featureDirs: 29
markdownFiles: 526
requiredSubfolderReadmesAndDetailFilesMissingOrSmall: 0
codeBlocks: 2587
textBlocks: 998
shellBlocks: 281
tsBlocks: 1119
diffBlocks: 13
absolutePathMentions: 19235
uniqueAbsolutePaths: 3752
badAbsolutePaths: 0
brokenMarkdownLinks: 0
tripleApostropheFenceLines: 0
markerHits: 0
```

## Source Checks

- Workbench feature folders should be traceable to `src/vs/workbench/contrib/*`.
- Service endpoints should be traceable to `src/vs/workbench/services/*` or `src/vs/platform/*`.
- Built-in extension behavior should be traceable to `extensions/*/package.json` or the extension source under that folder.
- Backboard-specific behavior should be traceable to `extensions/backboard`, `extensions/copilot`, `src/vs/sessions`, or `src/vs/platform/agentHost`.

## Review Commands

Run these from the repository root:

```sh
find bb-docs -mindepth 1 -maxdepth 1 -type d | sort
find bb-docs -type f -name README.md | sort
find src/vs/workbench/contrib -mindepth 1 -maxdepth 1 -type d | sort
node -e 'const fs=require("fs"); const dirs=fs.readdirSync("bb-docs",{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>d.name); for (const d of dirs) for (const s of ["ui","ux","endpoints","features"]) { const p="bb-docs/"+d+"/"+s+"/README.md"; if (!fs.existsSync(p)) throw new Error(p+" missing"); } console.log(dirs.length+" feature folders validated")'
node -e 'const fs=require("fs"); const dirs=fs.readdirSync("bb-docs",{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>d.name); for (const d of dirs) for (const s of ["ui","ux","endpoints","features"]) { const p="bb-docs/"+d+"/"+s+"/README.md"; const text=fs.readFileSync(p,"utf8"); if (!text.includes("BB-DEEP-DIVE:START")) throw new Error(p+" missing deep dive"); if (!text.includes("BB-VERIFICATION-MATRIX:START")) throw new Error(p+" missing verification matrix"); } console.log("deep-dive and verification sections validated")'
node -e 'const fs=require("fs"); const req={ui:["README.md","source-inventory.md","screen-map.md","code-excerpts.md"],ux:["README.md","journeys.md","states-and-errors.md","validation-playbook.md"],endpoints:["README.md","endpoint-registry.md","commands-settings-services.md","risk-boundaries.md"],features:["README.md","implementation-map.md","ownership-and-files.md","extension-points.md"]}; for (const d of fs.readdirSync("bb-docs",{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>d.name)) for (const [sub,files] of Object.entries(req)) for (const file of files) { const p=`bb-docs/${d}/${sub}/${file}`; if (!fs.existsSync(p)) throw new Error(p); } console.log("all detailed feature files validated")'
```

For a strict marker scan, search for unfinished markers without placing the exact marker strings into this file; otherwise the validation instructions become their own false positive.
