/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Exports the cli-ts curated MCP catalog (src/core/mcp/catalog.ts) into the
 * workbench marketplace catalog consumed by the Skills Library modal:
 *
 *   src/vs/workbench/contrib/chat/browser/widget/input/mcpMarketplaceCatalog.generated.ts
 *
 * Run from the vscode repo root:
 *   bun cli-ts/scripts/export-marketplace-catalog.ts
 *
 * Each entry carries two configs:
 *  - `installServerConfig`: the workbench mcp.json shape, with `${VAR}` env
 *    references rewritten to `${input:VAR}` prompts so the workbench asks for
 *    credentials on first start.
 *  - `cliConfig`: the raw cli-ts shape, written verbatim to .backboard/mcp.json
 *    so backboard-cli-ts chat sessions get the same server.
 */
import path from "node:path";
import { writeFileSync } from "node:fs";
import { CURATED_MCP_SERVERS, type McpCatalogServer } from "../src/core/mcp/catalog.ts";

const OUT = path.join(
	import.meta.dir,
	"../../src/vs/workbench/contrib/chat/browser/widget/input/mcpMarketplaceCatalog.generated.ts",
);

const CATEGORY_SLUGS: Record<string, string> = {
	"Development & Testing": "development-testing",
	"Project Management & Documentation": "project-management-docs",
	"Payments & Commerce": "payments-commerce",
	"Design & Media": "design-media",
	"Infrastructure & DevOps": "infrastructure-devops",
	"Additional Stdio Servers": "stdio-utilities",
	"Remote Servers": "remote-servers",
};

// Favicon domains for stdio servers (remotes derive theirs from the URL host).
const STDIO_LOGO_DOMAINS: Record<string, string> = {
	socket: "socket.dev",
	playwright: "playwright.dev",
	context7: "context7.com",
	monday: "monday.com",
	stripe: "stripe.com",
	paypal: "paypal.com",
	twelvelabs: "twelvelabs.io",
	netlify: "netlify.com",
	airtable: "airtable.com",
	clickup: "clickup.com",
	hubspot: "hubspot.com",
	mongodb: "mongodb.com",
};

/**
 * Remotes that answered a live MCP initialize probe (2026-07-10) with an OAuth
 * challenge but whose authorization server offers no dynamic client
 * registration. Until Backboard is pre-registered with each vendor (set
 * IMcpRemoteServerOAuthConfiguration.clientId), sign-in cannot complete, so
 * these are hidden from the marketplace.
 */
const NO_DCR_REMOTES = new Set([
	"adobe-for-creativity", "adobe-marketing-agent", "airwallex-developer", "audible",
	"bigdata-com", "biorender", "booking-com", "box", "chronograph",
	"dandb-risk-analytics", "directbooker", "docuseal", "everlaw", "expedia", "fmp",
	"g2", "glovo", "govtribe", "guidepoint", "guru", "ice-data-services", "instacart",
	"interactive-brokers-ibkr", "intercom", "intuit-quickbooks", "intuit-turbotax",
	"jentic", "learning-commons-knowledge-graph", "lumin", "make", "microsoft-365",
	"mixpanel", "owkin", "pagerduty", "playmcp", "polar-analytics", "razorpay",
	"resy", "shopify", "slack", "solve-intelligence", "spotify", "stubhub",
	"thoughtspot-spotter", "thumbtack", "ticket-tailor", "topcounsel-by-the-l-suite",
	"trellis", "uber", "uber-eats", "vibe-prospecting", "wyndham-hotels-and-resorts",
	"xero", "zoom-for-claude",
]);

/** Endpoints that failed the same probe outright. */
const BROKEN_REMOTES: Record<string, string> = {
	"intuit-credit-karma": "The endpoint currently serves a non-MCP response.",
	"airops": "The endpoint currently does not respond.",
};

const ENV_REF = /\$\{([A-Z][A-Z0-9_]*)\}/g;

function collectInputIds(server: McpCatalogServer): string[] {
	const ids = new Set<string>(server.requiredEnv);
	const scan = (value: string) => {
		for (const match of value.matchAll(ENV_REF)) {
			ids.add(match[1]!);
		}
	};
	for (const value of Object.values(server.config.env ?? {})) {
		scan(String(value));
	}
	for (const arg of server.config.args ?? []) {
		scan(arg);
	}
	return [...ids];
}

function toInputRefs(value: string): string {
	return value.replace(ENV_REF, (_, name) => `\${input:${name}}`);
}

function quote(value: string): string {
	return JSON.stringify(value).replace(/\$\{/g, "\\${");
}

function emitEntry(server: McpCatalogServer): string {
	const category = CATEGORY_SLUGS[server.category];
	if (!category) {
		throw new Error(`Unmapped cli catalog category: ${server.category}`);
	}
	const lines: string[] = ["\t{"];
	lines.push(`\t\tid: ${quote(server.name)},`);
	lines.push(`\t\tlabel: ${quote(server.title)},`);
	lines.push(`\t\tcategory: ${quote(category)},`);
	lines.push(`\t\texpectedNames: [${quote(server.name)}],`);
	lines.push(`\t\tsearchTerms: [${[server.title, server.name].map(quote).join(", ")}],`);

	const logoDomain = server.config.url
		? new URL(server.config.url).hostname.replace(/^mcp\./, "").replace(/^www\./, "")
		: STDIO_LOGO_DOMAINS[server.name];
	lines.push(`\t\tofficialPublisherHints: [${logoDomain ? quote(logoDomain) : ""}],`);
	lines.push(`\t\tdescription: ${quote(server.description)},`);

	const brokenReason = BROKEN_REMOTES[server.name];
	if (server.disabledReason || brokenReason) {
		lines.push(`\t\tinstallability: 'disabled',`);
		lines.push(`\t\tdisabledReason: ${quote(server.disabledReason ?? brokenReason!)},`);
	} else if (NO_DCR_REMOTES.has(server.name)) {
		lines.push(`\t\tinstallability: 'unsupportedAuth',`);
	} else {
		lines.push(`\t\tinstallability: 'installable',`);
	}

	const inputIds = collectInputIds(server);
	if (server.config.url) {
		lines.push(`\t\tinstallServerConfig: { type: McpServerType.REMOTE, url: ${quote(server.config.url)}${server.config.headers ? `, headers: ${JSON.stringify(server.config.headers)}` : ""} },`);
	} else if (server.config.command) {
		const args = (server.config.args ?? []).map(arg => quote(toInputRefs(arg)));
		const envEntries = Object.entries(server.config.env ?? {})
			.map(([key, value]) => `${quote(key)}: ${quote(toInputRefs(String(value)))}`);
		lines.push(`\t\tinstallServerConfig: { type: McpServerType.LOCAL, command: ${quote(server.config.command)}${args.length ? `, args: [${args.join(", ")}]` : ""}${envEntries.length ? `, env: { ${envEntries.join(", ")} }` : ""} },`);
	}

	if (inputIds.length) {
		const inputs = inputIds.map(id =>
			`{ id: ${quote(id)}, type: McpServerVariableType.PROMPT, description: ${quote(`${server.title} credential (${id})`)}, password: true }`);
		lines.push(`\t\tinstallInputs: [${inputs.join(", ")}],`);
	}

	lines.push(`\t\tcliConfig: ${JSON.stringify(server.config)},`);
	lines.push("\t},");
	return lines.join("\n");
}

const header = `/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GENERATED FILE - DO NOT EDIT.
// Source: cli-ts/src/core/mcp/catalog.ts
// Regenerate with: bun cli-ts/scripts/export-marketplace-catalog.ts

import { McpServerType, McpServerVariableType } from '../../../../../../platform/mcp/common/mcpPlatformTypes.js';
import type { IMcpMarketplaceCatalogEntry } from './mcpMarketplaceCatalog.js';

export const GENERATED_CLI_MCP_CATALOG: readonly IMcpMarketplaceCatalogEntry[] = [
`;

const body = CURATED_MCP_SERVERS.map(emitEntry).join("\n");
writeFileSync(OUT, `${header}${body}\n];\n`);
console.log(`Wrote ${CURATED_MCP_SERVERS.length} entries to ${OUT}`);
