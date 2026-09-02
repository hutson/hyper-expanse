#!/usr/bin/env node

"use strict";

// TODO: This is a lightweight jsdom-based accessibility audit. If
// production accessibility issues surface that this script does not catch,
// evaluate adopting axe-core with a real headless browser (puppeteer or
// playwright) for a more authoritative WCAG audit.

const fs = require("node:fs/promises");
const path = require("path");
const { JSDOM } = require("jsdom");

const PUBLIC_DIR = path.join(process.cwd(), "public");
const FAILURE_EXIT_CODE = 1;
const SUCCESS_EXIT_CODE = 0;

function hexToRgb(hex) {
	const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
	if (!m) {
		return null;
	}
	return {
		r: Number.parseInt(m[1], 16),
		g: Number.parseInt(m[2], 16),
		b: Number.parseInt(m[3], 16),
	};
}

function relativeLuminance({ r, g, b }) {
	const channel = (c) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(fg, bg) {
	const l1 = relativeLuminance(fg);
	const l2 = relativeLuminance(bg);
	const lighter = Math.max(l1, l2);
	const darker = Math.min(l1, l2);
	return (lighter + 0.05) / (darker + 0.05);
}

// Resolve named colors used by this site's CSS. jsdom does not expand named
// CSS colors, so we map the ones our styles actually use to RGB values.
function resolveColor(value, background) {
	if (!value) {
		return background;
	}
	const v = value.trim().toLowerCase();
	if (v === "transparent" || v === "inherit" || v === "initial" || v === "unset") {
		return background;
	}
	if (v.startsWith("#")) {
		return hexToRgb(v) ?? background;
	}
	const rgbMatch = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v);
	if (rgbMatch) {
		return {
			r: Number.parseInt(rgbMatch[1], 10),
			g: Number.parseInt(rgbMatch[2], 10),
			b: Number.parseInt(rgbMatch[3], 10),
		};
	}
	if (v === "white" || v === "#fff" || v === "#ffffff") {
		return { r: 255, g: 255, b: 255 };
	}
	if (v === "black" || v === "#000" || v === "#000000") {
		return { r: 0, g: 0, b: 0 };
	}
	if (v === "lightblue" || v === "#add8e6") {
		return { r: 173, g: 216, b: 230 };
	}
	if (v === "gray" || v === "grey" || v === "#808080") {
		return { r: 128, g: 128, b: 128 };
	}
	return background;
}

function getEffectiveBackgroundColor(element, win) {
	let bg = { r: 255, g: 255, b: 255 };
	let node = element;
	while (node) {
		if (node.nodeType === 1) {
			const color = win.getComputedStyle(node).backgroundColor;
			if (color) {
				const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(color);
				if (m) {
					const alpha = m[4] !== undefined ? Number.parseFloat(m[4]) : 1;
					if (alpha > 0) {
						bg = {
							r: Number.parseInt(m[1], 10),
							g: Number.parseInt(m[2], 10),
							b: Number.parseInt(m[3], 10),
						};
						break;
					}
				}
			}
		}
		node = node.parentNode;
	}
	return bg;
}

async function walkHtmlFiles(dir) {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await walkHtmlFiles(full)));
		} else if (entry.isFile() && entry.name.endsWith(".html")) {
			files.push(full);
		}
	}
	return files;
}

function auditHtml(file, html) {
	const dom = new JSDOM(html);
	const { document, window } = dom.window;
	const issues = [];

	// Check: <html lang> attribute.
	const htmlEl = document.documentElement;
	if (!htmlEl.getAttribute("lang")) {
		issues.push({ rule: "html-has-lang", message: "<html> is missing the lang attribute" });
	}

	// Check: <meta name="viewport"> for responsive design.
	const viewport = document.querySelector('meta[name="viewport"]');
	if (!viewport) {
		issues.push({ rule: "viewport", message: 'Missing <meta name="viewport"> for responsive design' });
	}

	// Check: <button> with accessible text.
	for (const btn of document.querySelectorAll("button")) {
		const text = btn.textContent.trim();
		const ariaLabel = btn.getAttribute("aria-label");
		if (!text && !ariaLabel) {
			issues.push({ rule: "button-name", message: "<button> has no accessible text" });
		}
	}

	// Check: landmark roles — ensure <main> exists.
	if (!document.querySelector("main") && !document.querySelector('[role="main"]')) {
		issues.push({ rule: "landmark-main", message: "Page is missing a <main> landmark" });
	}

	// Check: in-page fragment links resolve to an existing element id.
	for (const a of document.querySelectorAll('a[href^="#"]')) {
		const href = a.getAttribute("href");
		if (href === "#" || href.length <= 1) {
			continue;
		}
		const id = href.slice(1);
		if (!document.getElementById(id)) {
			issues.push({
				rule: "fragment-target",
				message: `<a href="${href}"> target element with id "${id}" not found`,
			});
		}
	}

	// Check: alias redirect pages have a valid refresh target that resolves
	// to an existing file and matches the canonical link.
	const refresh = document.querySelector('meta[http-equiv="refresh"]');
	if (refresh) {
		const content = refresh.getAttribute("content") || "";
		const match = /url=(.+)$/.exec(content);
		const targetUrl = match ? match[1].trim().replace(/^['"]|['"]$/g, "") : "";
		if (targetUrl) {
			const targetPath = resolvePublicFilePath(targetUrl);
			if (targetPath && !publicFileExists(targetPath)) {
				issues.push({
					rule: "alias-target",
					message: `Meta refresh target "${targetUrl}" does not resolve to a generated file`,
				});
			}
			const canonical = document.querySelector('link[rel="canonical"]');
			const canonicalHref = canonical ? canonical.getAttribute("href") : "";
			if (canonicalHref !== targetUrl) {
				issues.push({
					rule: "alias-canonical",
					message: `Meta refresh target "${targetUrl}" does not match canonical "${canonicalHref}"`,
				});
			}
		}
	}

	// Check: color contrast for text elements.
	for (const el of document.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, a, span, td, th, dt, dd")) {
		const style = window.getComputedStyle(el);
		const color = resolveColor(style.color, { r: 0, g: 0, b: 0 });
		const bg = getEffectiveBackgroundColor(el, window);
		const ratio = contrastRatio(color, bg);
		const fontSize = Number.parseFloat(style.fontSize);
		const isLargeText = fontSize >= 24 || (fontSize >= 18.66 && (style.fontWeight === "bold" || Number.parseInt(style.fontWeight, 10) >= 700));
		const minRatio = isLargeText ? 3 : 4.5;
		if (ratio < minRatio) {
			const text = el.textContent.trim().slice(0, 40);
			issues.push({
				rule: "color-contrast",
				message: `Insufficient color contrast (${ratio.toFixed(2)}:1, need ${minRatio}:1) for text "${text}"`,
			});
		}
	}

	return issues;
}

// Map a URL to a path under PUBLIC_DIR. Returns null for non-file URLs.
function resolvePublicFilePath(url) {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return null;
		}
		let pathname = decodeURIComponent(parsed.pathname);
		if (pathname.endsWith("/")) {
			pathname = path.join(pathname, "index.html");
		} else if (path.extname(pathname) === "") {
			pathname = path.join(pathname, "index.html");
		}
		return path.join(PUBLIC_DIR, pathname);
	} catch {
		return null;
	}
}

// Cache of which files exist under PUBLIC_DIR across the audit run.
const _existsCache = new Map();
function publicFileExists(targetPath) {
	if (_existsCache.has(targetPath)) {
		return _existsCache.get(targetPath);
	}
	let exists = false;
	try {
		require("node:fs").accessSync(targetPath);
		exists = true;
	} catch {
		exists = false;
	}
	_existsCache.set(targetPath, exists);
	return exists;
}

async function main() {
	let htmlFiles;
	try {
		htmlFiles = await walkHtmlFiles(PUBLIC_DIR);
	} catch (err) {
		console.error(`error: cannot read ${PUBLIC_DIR}: ${err.message}`);
		process.exit(FAILURE_EXIT_CODE);
	}

	if (htmlFiles.length === 0) {
		console.error(`error: no HTML files found in ${PUBLIC_DIR}; run 'hugo' first`);
		process.exit(FAILURE_EXIT_CODE);
	}

	let totalIssues = 0;
	let failedFiles = 0;

	for (const file of htmlFiles) {
		const html = await fs.readFile(file, "utf8");
		const issues = auditHtml(file, html);
		const rel = path.relative(process.cwd(), file);
		if (issues.length === 0) {
			console.log(`✓ ${rel}`);
		} else {
			failedFiles++;
			totalIssues += issues.length;
			console.log(`✗ ${rel}`);
			for (const issue of issues) {
				console.log(`  [${issue.rule}] ${issue.message}`);
			}
		}
	}

	console.log();
	if (totalIssues === 0) {
		process.exit(SUCCESS_EXIT_CODE);
	} else {
		process.exit(FAILURE_EXIT_CODE);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(FAILURE_EXIT_CODE);
});
