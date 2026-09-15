#!/usr/bin/env node

"use strict";

// TODO: This script is currently intended to be run manually. Future work:
// wire it into CI as a separate scheduled or manually-triggered job (not as
// part of .tools/test.sh, which must remain offline/deterministic). Note that
// npm blocks automated requests, so decide whether npm failures should fail
// the job or warn only.
//
// Compares the canonical profile in data/hutson.yaml against public profile
// data from external platforms and prints a summary table to stdout. HTTP
// request failures are written to stderr and never abort the remaining
// platform checks.

const fs = require("node:fs/promises");
const path = require("path");
const YAML = require("yaml");
const { JSDOM } = require("jsdom");

const FAILURE_EXIT_CODE = 1;
const SUCCESS_EXIT_CODE = 0;
const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT = "hyper-expanse-profile-check";
const MIN_PREFIX_LENGTH = 20;

const ENDPOINTS = {
	github: "https://api.github.com/users/hutson",
	codeberg: "https://codeberg.org/api/v1/users/hutson",
	openCollectiveLegacy: "https://opencollective.com/hutson.json",
	openCollectivePage: "https://opencollective.com/hutson",
	npm: "https://www.npmjs.com/~hutson",
	pypi: "https://pypi.org/user/hutson/",
};

function normalizeText(value) {
	return String(value).replace(/\s+/g, " ").trim();
}

function excerpt(value, maxLength = 60) {
	const text = normalizeText(value);
	return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

// Strip HTML tags for comparison against the canonical plain-text bio.
function stripHtml(html) {
	return String(html).replace(/<[^>]*>/g, "");
}

// Normalize URLs for comparison by stripping the fragment and trailing slash,
// lowercasing the entire result, and falling back to a trimmed lowercased
// string for invalid input. This intentionally does not normalize scheme or
// www subdomains; all known profile URLs are already lowercase and canonical.
function normalizeUrl(url) {
	try {
		const parsed = new URL(url);
		parsed.hash = "";
		let normalized = parsed.toString();
		if (normalized.endsWith("/")) {
			normalized = normalized.slice(0, -1);
		}
		return normalized.toLowerCase();
	} catch {
		return String(url).trim().toLowerCase();
	}
}

async function fetchWithTimeout(url, { fetchImpl = fetch, headers = {} } = {}) {
	try {
		return await fetchImpl(url, {
			headers: { "User-Agent": USER_AGENT, ...headers },
			redirect: "follow",
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
	} catch (err) {
		if (err.name === "TimeoutError") {
			throw new Error(`request timed out after ${FETCH_TIMEOUT_MS}ms: ${url}`);
		}
		throw err;
	}
}

async function fetchJson(url, { fetchImpl = fetch, headers = {} } = {}) {
	const res = await fetchWithTimeout(url, { fetchImpl, headers });
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} from ${url}`);
	}
	return res.json();
}

function makeResult(platform, ok, notes) {
	return { platform, status: ok ? "OK" : "MISMATCH", notes };
}

function compareDescription(notes, actual, expected) {
	if (actual === null || actual === undefined || normalizeText(actual) === "") {
		notes.push("bio/description missing");
		return false;
	}
	const normalized = normalizeText(actual);
	// Platforms with bio length limits (e.g. GitHub) only ever hold the
	// leading sentence of the canonical description, so a substantial prefix
	// is treated as aligned.
	if (normalized === expected || (expected.startsWith(normalized) && normalized.length >= MIN_PREFIX_LENGTH)) {
		return true;
	}
	notes.push(`description differs: expected "${excerpt(expected)}", actual "${excerpt(normalized)}"`);
	return false;
}

// TODO: Compare the avatar image itself against assets/images/hutson-profile.png
// (fetch the remote image and compare content hashes); for now we only check
// that a non-empty avatar URL is present.
function checkAvatar(notes, avatarUrl) {
	if (!avatarUrl) {
		notes.push("avatar missing");
		return false;
	}
	return true;
}

function compareLink(notes, label, actual, expected) {
	if (!expected) {
		return true;
	}
	if (!actual) {
		notes.push(`${label} link missing`);
		return false;
	}
	if (normalizeUrl(actual) !== expected) {
		notes.push(`${label} link differs: expected ${expected}, actual ${normalizeUrl(actual)}`);
		return false;
	}
	return true;
}

async function checkGitHub(canonical, fetchImpl = fetch) {
	const notes = [];
	const user = await fetchJson(ENDPOINTS.github, {
		fetchImpl,
		headers: { Accept: "application/vnd.github+json" },
	});
	let ok = true;
	ok = compareDescription(notes, user.bio, canonical.description) && ok;
	ok = checkAvatar(notes, user.avatar_url) && ok;
	ok = compareLink(notes, "website", user.blog, canonical.links.website) && ok;
	return makeResult("GitHub", ok, notes);
}

async function checkCodeberg(canonical, fetchImpl = fetch) {
	const notes = [];
	const user = await fetchJson(ENDPOINTS.codeberg, { fetchImpl });
	let ok = true;
	ok = compareDescription(notes, user.description ?? user.bio, canonical.description) && ok;
	ok = checkAvatar(notes, user.avatar_url) && ok;
	ok = compareLink(notes, "website", user.website, canonical.links.website) && ok;
	return makeResult("Codeberg", ok, notes);
}

async function checkOpenCollective(canonical, fetchImpl = fetch) {
	const notes = [];
	const account = await fetchOpenCollectiveProfile(fetchImpl);
	let ok = true;
	// longDescription holds the full profile body (HTML); description is the
	// short summary shown when the long form is unset.
	const description = account.longDescription && normalizeText(stripHtml(account.longDescription)) !== ""
		? stripHtml(account.longDescription)
		: account.description;
	ok = compareDescription(notes, description, canonical.description) && ok;
	ok = checkAvatar(notes, account.image ?? account.imageUrl) && ok;
	ok = compareLink(notes, "website", account.website, canonical.links.website) && ok;
	ok = compareLink(
		notes,
		"github",
		account.githubHandle ? `https://github.com/${account.githubHandle}` : null,
		canonical.links.github,
	) && ok;
	return makeResult("Open Collective", ok, notes);
}

async function fetchOpenCollectiveProfile(fetchImpl = fetch) {
	// The legacy /<slug>.json endpoint omits profile metadata for user
	// accounts, so fall back to scraping the rendered page when it lacks the
	// fields we need.
	const legacy = await fetchJson(ENDPOINTS.openCollectiveLegacy, { fetchImpl }).catch(() => null);
	if (legacy && (legacy.description !== undefined || legacy.website !== undefined)) {
		return legacy;
	}
	const res = await fetchWithTimeout(ENDPOINTS.openCollectivePage, { fetchImpl });
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} from Open Collective profile page`);
	}
	return parseOpenCollectiveProfile(await res.text());
}

// The Open Collective profile page embeds the account record in the Apollo
// client state inside the Next.js __NEXT_DATA__ script tag.
function parseOpenCollectiveProfile(html) {
	const dom = new JSDOM(html);
	const el = dom.window.document.querySelector("script#__NEXT_DATA__");
	if (!el) {
		throw new Error("could not find profile data in Open Collective page");
	}
	const nextData = JSON.parse(el.textContent);
	const apolloState = nextData?.props?.pageProps?.__APOLLO_STATE__;
	if (!apolloState) {
		throw new Error("profile data missing from Open Collective page");
	}
	const individualKey = Object.keys(apolloState).find((key) => key.startsWith("Individual:") || key.startsWith("User:"));
	if (!individualKey) {
		throw new Error("no Individual or User record in Open Collective page data");
	}
	return apolloState[individualKey];
}

async function checkNpm(canonical, fetchImpl = fetch) {
	const notes = [];
	const res = await fetchWithTimeout(ENDPOINTS.npm, { fetchImpl });
	if (!res.ok) {
		throw new Error(
			`HTTP ${res.status} from npm profile page; npm blocks automated requests, verify manually at ${ENDPOINTS.npm}`,
		);
	}
	const html = await res.text();
	const profile = extractNpmProfile(html);
	let ok = true;
	ok = compareDescription(notes, profile.bio, canonical.description) && ok;
	ok = checkAvatar(notes, profile.avatars?.large ?? profile.avatar) && ok;
	ok = compareLink(
		notes,
		"github",
		profile.github ? `https://github.com/${profile.github}` : null,
		canonical.links.github,
	) && ok;
	ok = compareLink(notes, "website", profile.homepage ?? null, canonical.links.website) && ok;
	return makeResult("npm", ok, notes);
}

// The npm profile page embeds its initial render data as a JSON document
// assigned to window.__context__ inside a script tag.
function extractNpmProfile(html) {
	const dom = new JSDOM(html);
	for (const script of dom.window.document.querySelectorAll("script")) {
		const text = script.textContent;
		const marker = text.indexOf("__context__");
		if (marker === -1) {
			continue;
		}
		const start = text.indexOf("{", marker);
		if (start === -1) {
			continue;
		}
		const json = extractBalancedJson(text, start);
		if (!json) {
			continue;
		}
		const context = JSON.parse(json);
		const user = context?.context?.user ?? context?.user;
		if (user && typeof user === "object") {
			return user;
		}
	}
	throw new Error("could not extract profile data from npm page (client-rendered); manual verification needed");
}

// Extract a balanced {...} JSON object starting at `start`, ignoring braces
// inside string literals.
function extractBalancedJson(text, start) {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\" && inString) {
			escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) {
			continue;
		}
		if (ch === "{") {
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0) {
				return text.slice(start, i + 1);
			}
		}
	}
	return null;
}

// PyPI user profiles expose only a display name and project list; there is no
// bio, avatar, or link metadata to compare, so this check only verifies that
// the profile page exists and renders the expected username.
async function checkPypi(fetchImpl = fetch) {
	const res = await fetchWithTimeout(ENDPOINTS.pypi, { fetchImpl });
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} from PyPI profile page`);
	}
	const html = await res.text();
	const title = parsePypiTitle(html);
	const notes = [];
	const ok = title.toLowerCase().includes("hutson");
	if (!ok) {
		notes.push(`unexpected profile page title: "${normalizeText(title)}"`);
	}
	return makeResult("PyPI", ok, notes);
}

function parsePypiTitle(html) {
	const dom = new JSDOM(html);
	return dom.window.document.querySelector("title")?.textContent ?? "";
}

// Build the canonical profile from data/hutson.yaml. Links from contact,
// follow, and sponsor are merged into a single normalized lookup keyed by a
// lowercase label.
async function loadCanonical() {
	const raw = await fs.readFile(path.join(process.cwd(), "data", "hutson.yaml"), "utf8");
	const data = YAML.parse(raw);
	const links = {};
	for (const [key, value] of Object.entries(data.contact ?? {})) {
		if (typeof value === "string" && value.startsWith("http")) {
			links[key] = normalizeUrl(value);
		}
	}
	for (const section of ["follow", "sponsor"]) {
		for (const entry of data[section] ?? []) {
			if (typeof entry?.text !== "string" || typeof entry?.url !== "string") {
				console.error(`warning: ignoring malformed ${section} entry: ${JSON.stringify(entry)}`);
				continue;
			}
			links[normalizeText(entry.text).toLowerCase().replace(/\s+/g, "-")] = normalizeUrl(entry.url);
		}
	}
	return {
		name: data.name,
		description: normalizeText(data.description_professional ?? ""),
		links,
	};
}

function renderTable(results) {
	const rows = results.map((r) => [r.platform, r.status, r.notes.join("; ")]);
	const platformWidth = Math.max("Platform".length, ...rows.map((r) => r[0].length));
	const statusWidth = Math.max("Status".length, ...rows.map((r) => r[1].length));
	const header = `${"Platform".padEnd(platformWidth)}  ${"Status".padEnd(statusWidth)}  Notes`;
	console.log(header);
	console.log("-".repeat(header.length));
	for (const [platform, status, notes] of rows) {
		console.log(`${platform.padEnd(platformWidth)}  ${status.padEnd(statusWidth)}  ${notes}`);
	}
}

async function main() {
	const canonical = await loadCanonical();
	const checkers = [
		["GitHub", checkGitHub],
		["Codeberg", checkCodeberg],
		["Open Collective", checkOpenCollective],
		["npm", checkNpm],
		["PyPI", checkPypi],
	];
	const settled = await Promise.allSettled(checkers.map(([, fn]) => fn(canonical)));
	const results = settled.map((outcome, index) => {
		if (outcome.status === "fulfilled") {
			return outcome.value;
		}
		const platform = checkers[index][0];
		console.error(`error: ${platform}: ${outcome.reason.message}`);
		return { platform, status: "ERROR", notes: [outcome.reason.message] };
	});
	renderTable(results);
	const failed = results.some((r) => r.status !== "OK");
	process.exit(failed ? FAILURE_EXIT_CODE : SUCCESS_EXIT_CODE);
}

module.exports = {
	checkAvatar,
	compareDescription,
	compareLink,
	excerpt,
	extractBalancedJson,
	fetchJson,
	fetchWithTimeout,
	loadCanonical,
	makeResult,
	normalizeText,
	normalizeUrl,
	parseOpenCollectiveProfile,
	parsePypiTitle,
	stripHtml,
};

if (require.main === module) {
	main().catch((err) => {
		console.error(err);
		process.exit(FAILURE_EXIT_CODE);
	});
}
