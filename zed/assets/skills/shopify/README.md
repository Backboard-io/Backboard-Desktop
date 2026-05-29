# agent-skills

> **Note:** This repo is generated upstream — we do not accept contributions or pull requests here.

A collection of agent skills verified to work with Shopify's development ecosystem. Skills are installable via the `npx skill` CLI and provide Claude Code with API-specific context, documentation search, and code validation for each Shopify surface.

## What are agent skills?

Agent skills are portable instruction sets that extend Claude Code's knowledge for a specific domain. Each skill includes:

- **`SKILL.md`** — instructions and context loaded into Claude's context window
- **`scripts/search_docs.js`** — searches shopify.dev documentation relevant to the skill
- **`scripts/validate.js`** — validates generated code against the API's schema or component library
- **`config.json`** — skill metadata and tool definitions
- **`assets/`** — compressed GraphQL schemas and other offline references

## Available skills

| Skill | Description |
|---|---|
| `shopify-admin` | Admin GraphQL API — queries, mutations, schema validation |
| `shopify-storefront-graphql` | Storefront GraphQL API — headless commerce queries |
| `shopify-customer` | Customer Account API — customer-facing data access |
| `shopify-partner` | Partner API — Partner Dashboard data and app management |
| `shopify-payments-apps` | Payments Apps API — payment provider integrations |
| `shopify-functions` | Shopify Functions — cart, checkout, delivery, discount, fulfillment, payment, and routing customizations |
| `shopify-hydrogen` | Hydrogen — Shopify's React-based headless framework |
| `shopify-liquid` | Liquid & Themes — theme development with Liquid templating |
| `shopify-polaris-admin-extensions` | Admin UI Extensions — custom blocks and actions in the Shopify Admin |
| `shopify-polaris-checkout-extensions` | Checkout UI Extensions — custom UI at checkout |
| `shopify-polaris-customer-account-extensions` | Customer Account UI Extensions — custom UI in customer accounts |
| `shopify-polaris-app-home` | App Home — Shopify App Home surface |
| `shopify-pos-ui` | POS UI Extensions — Shopify Point of Sale app extensions |
| `shopify-custom-data` | Custom Data — metafields, metaobjects, and custom data modeling |
| `shopify-dev` | General Shopify developer documentation search |

## Installation

Install individual skills via the `npx skill` CLI:

```bash
npx skill install shopify-admin
npx skill install shopify-liquid
# etc.
```

## Source

Skills in this repo are generated upstream and verified against their respective APIs using [promptfoo](https://promptfoo.dev) evals.
