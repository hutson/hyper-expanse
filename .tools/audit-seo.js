#!/usr/bin/env node

"use strict";

// SEO metadata audit for the generated site: verifies the search-engine and
// social-sharing contract (canonical URLs, descriptions, Open Graph, JSON-LD,
// h-card microformats, robots.txt, sitemap, feeds) against the cross-checked
// source of truth in data/hutson.yaml. Social metadata stays on open
// standards: X and Slack build their previews from Open Graph, so proprietary
// twitter:* tags must never appear. Dormant tags (fediverse:creator,
// verification tokens) must be absent while their data fields are empty, and
// present once they are populated.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const YAML = require("yaml");

const PUBLIC_DIR = path.join(process.cwd(), "public");
const DATA_FILE = path.join(process.cwd(), "data", "hutson.yaml");
const BASE_URL = "https://hyper-expanse.net/";
const MAX_DESCRIPTION_LENGTH = 320;
const FAILURE_EXIT_CODE = 1;
const SUCCESS_EXIT_CODE = 0;

const EXPECTED_TITLES = {
	"index.html": "hyper-expanse",
	[path.join("hutson", "index.html")]: "Hutson Betts - About",
	[path.join("hutson", "resume", "index.html")]: "Hutson Betts - Principal Software Engineer",
};

function loadCanonicalProfile() {
	const data = YAML.parse(fs.readFileSync(DATA_FILE, "utf8"));
	const sameAs = [];
	for (const key of ["linkedin", "mastodon"]) {
		const value = data.contact?.[key];
		if (value) {
			sameAs.push(value);
		}
	}
	for (const section of ["follow", "sponsor"]) {
		for (const entry of data[section] ?? []) {
			if (entry.url) {
				sameAs.push(entry.url);
			}
		}
	}
	return {
		name: data.name,
		jobTitle: data.title,
		url: data.contact?.website,
		description: data.description_seo,
		sameAs: [...new Set(sameAs)],
		knowsAbout: (data.skills ?? []).flatMap((group) => group.items ?? []),
		employer: data.employment?.[0]?.company ?? "",
		projectCount: (data.projects ?? []).length,
		mastodon: data.contact?.mastodon ?? "",
	};
}

// Expected canonical URL for a generated page, derived from its on-disk path
// the same way Hugo derives permalinks (directory URLs end with a slash).
function expectedUrlFor(relPath) {
	if (relPath === "404.html") {
		return `${BASE_URL}404.html`;
	}
	const dir = path.dirname(relPath);
	const suffix = dir === "." ? "" : `${dir.split(path.sep).join("/")}/`;
	return `${BASE_URL}${suffix}`;
}

function textAttr(document, selector, attribute = "content") {
	const el = document.querySelector(selector);
	return el ? (el.getAttribute(attribute) ?? "").trim() : "";
}

function hasMeta(document, name) {
	return Boolean(document.querySelector(`meta[name="${name}"]`));
}

function findLdJson(document) {
	const blocks = [];
	for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
		try {
			blocks.push(JSON.parse(script.textContent));
		} catch {
			blocks.push({ "@type": "__invalid__" });
		}
	}
	return blocks;
}

function personFrom(blocks) {
	for (const block of blocks) {
		if (block["@type"] === "Person") {
			return block;
		}
		if (block["@type"] === "ProfilePage" && block.mainEntity?.["@type"] === "Person") {
			return block.mainEntity;
		}
	}
	return null;
}

function auditPerson(person, profile, issues) {
	const eq = (key, expected) => {
		if (expected && person[key] !== expected) {
			issues.push({ rule: "jsonld-person", message: `Person.${key} is "${person[key]}", expected "${expected}"` });
		}
	};
	eq("name", profile.name);
	eq("jobTitle", profile.jobTitle);
	eq("url", profile.url);
	if (!person.image || !String(person.image).startsWith("https://")) {
		issues.push({ rule: "jsonld-person", message: "Person.image must be an absolute https URL" });
	}
	const sameAs = Array.isArray(person.sameAs) ? person.sameAs : [];
	for (const url of profile.sameAs) {
		if (!sameAs.includes(url)) {
			issues.push({ rule: "jsonld-person", message: `Person.sameAs is missing "${url}"` });
		}
	}
	for (const url of sameAs) {
		if (!url.startsWith("https://")) {
			issues.push({ rule: "jsonld-person", message: `Person.sameAs entry "${url}" is not https` });
		}
	}
	const knowsAbout = Array.isArray(person.knowsAbout) ? person.knowsAbout : [];
	if (knowsAbout.length !== profile.knowsAbout.length || !profile.knowsAbout.every((s) => knowsAbout.includes(s))) {
		issues.push({ rule: "jsonld-person", message: `Person.knowsAbout ${JSON.stringify(knowsAbout)} does not match data/hutson.yaml skills` });
	}
	if (profile.employer && person.worksFor?.name !== profile.employer) {
		issues.push({ rule: "jsonld-person", message: `Person.worksFor.name is "${person.worksFor?.name}", expected "${profile.employer}"` });
	}
}

function auditHCard(document, canonical, profile, issues) {
	const card = document.querySelector(".h-card");
	if (!card) {
		issues.push({ rule: "microformats", message: "The profile page must publish a representative h-card" });
		return;
	}
	if (card.querySelector(".p-name")?.textContent.trim() !== profile.name) {
		issues.push({ rule: "microformats", message: "h-card p-name must match the profile name" });
	}
	if (!card.querySelector("img.u-photo[src]")) {
		issues.push({ rule: "microformats", message: "h-card is missing a u-photo image" });
	}
	// A representative h-card's u-url is implicit on the page it describes
	// (the page's canonical URL is the profile URL). We accept that case, and
	// we also accept an explicit <a class="u-url" href="..."> when present,
	// requiring it to match the canonical.
	const urls = card.querySelectorAll(".u-url");
	if (urls.length > 1) {
		issues.push({ rule: "microformats", message: `Representative h-card must declare at most one u-url, got ${urls.length}` });
	} else if (urls.length === 1 && urls[0].getAttribute("href") !== canonical) {
		issues.push({
			rule: "microformats",
			message: `h-card u-url "${urls[0].getAttribute("href")}" does not match the canonical URL "${canonical}"`,
		});
	}
	if (!card.querySelector('a[rel~="me"]')) {
		issues.push({ rule: "microformats", message: "h-card is missing rel=\"me\" identity links" });
	}
}

function auditArticlePages(relPath, document, blocks, profile, issues) {
	// Hugo pretty URLs render every leaf page as <slug>/index.html, so only
	// the section list pages themselves are excluded.
	const isSectionList =
		relPath === path.join("hutson", "guides", "index.html") ||
		relPath === path.join("hutson", "articles", "index.html");
	const isContentPage =
		(relPath.startsWith(`hutson${path.sep}guides${path.sep}`) || relPath.startsWith(`hutson${path.sep}articles${path.sep}`)) &&
		!isSectionList;
	if (!isContentPage) {
		return;
	}
	if (textAttr(document, 'meta[property="og:type"]') !== "article") {
		issues.push({ rule: "og-article", message: 'Content pages must set og:type to "article"' });
	}
	for (const key of ["article:published_time", "article:modified_time"]) {
		const value = textAttr(document, `meta[property="${key}"]`);
		if (!/^\d{4}-\d{2}-\d{2}/.test(value) || value.startsWith("0001-")) {
			issues.push({ rule: "og-article", message: `${key} is "${value}", expected a real ISO 8601 date (zero dates indicate lost git info)` });
		}
	}
	const article = blocks.find((b) => ["TechArticle", "BlogPosting"].includes(b["@type"]));
	if (!article) {
		issues.push({ rule: "jsonld-article", message: "Content pages must carry a TechArticle or BlogPosting JSON-LD block" });
	} else {
		if (!article.headline?.trim()) {
			issues.push({ rule: "jsonld-article", message: "Article.headline is missing" });
		}
		if (article.author?.name !== profile.name) {
			issues.push({ rule: "jsonld-article", message: "Article.author.name does not match the profile name" });
		}
		for (const key of ["datePublished", "dateModified"]) {
			if (!/^\d{4}/.test(article[key] ?? "") || article[key]?.startsWith("0001")) {
				issues.push({ rule: "jsonld-article", message: `Article.${key} is "${article[key]}", expected a real date` });
			}
		}
	}
	const crumbs = blocks.find((b) => b["@type"] === "BreadcrumbList");
	if (!crumbs) {
		issues.push({ rule: "jsonld-breadcrumb", message: "Content pages must carry a BreadcrumbList JSON-LD block" });
	} else {
		const items = crumbs.itemListElement ?? [];
		if (items.length < 3 || items[0].name !== "hyper-expanse") {
			issues.push({ rule: "jsonld-breadcrumb", message: `BreadcrumbList must start at home and have >=3 levels, got ${items.length}` });
		}
		const last = items.at(-1);
		if (last && last.name !== textAttr(document, 'meta[property="og:title"]')) {
			issues.push({ rule: "jsonld-breadcrumb", message: `Last crumb "${last.name}" does not match og:title` });
		}
	}
}

function auditProjectsPage(relPath, document, blocks, profile, issues) {
	if (relPath !== path.join("hutson", "projects", "index.html")) {
		return;
	}
	const collection = blocks.find((b) => b["@type"] === "CollectionPage");
	if (!collection) {
		issues.push({ rule: "jsonld-projects", message: "Projects page must carry a CollectionPage JSON-LD block" });
		return;
	}
	const items = collection.mainEntity?.itemListElement ?? [];
	if (items.length !== profile.projectCount) {
		issues.push({ rule: "jsonld-projects", message: `CollectionPage lists ${items.length} items, data/hutson.yaml has ${profile.projectCount}` });
	}
	for (const [index, entry] of items.entries()) {
		const code = entry.item;
		if (code?.["@type"] !== "SoftwareSourceCode" || !code.name) {
			issues.push({ rule: "jsonld-projects", message: `Item ${index + 1} is not a SoftwareSourceCode` });
		} else if (!String(code.codeRepository ?? "").startsWith("https://")) {
			issues.push({ rule: "jsonld-projects", message: `Item "${code.name}" lacks an https codeRepository` });
		}
	}
}

function auditDormantTags(document, profile, issues) {
	// fediverse:creator is driven by contact.mastodon in data/hutson.yaml, so
	// its presence must mirror the field: absent while empty, present once an
	// account exists. The hugo.toml verification params are not read here (no
	// TOML dependency); tags are only sanity-checked for a non-empty token
	// when present, which also catches accidental "content=""" renders.
	if (profile.mastodon) {
		if (!hasMeta(document, "fediverse:creator")) {
			issues.push({ rule: "dormant-tags", message: "contact.mastodon is set but fediverse:creator is missing" });
		}
	} else if (hasMeta(document, "fediverse:creator")) {
		issues.push({ rule: "dormant-tags", message: "fediverse:creator is present but contact.mastodon is empty" });
	}
	for (const name of ["google-site-verification", "msvalidate.01"]) {
		const el = document.querySelector(`meta[name="${name}"]`);
		if (el && !(el.getAttribute("content") ?? "").trim()) {
			issues.push({ rule: "dormant-tags", message: `<meta ${name}> rendered with an empty content value` });
		}
	}
}

function auditPage(relPath, html, profile) {
	const dom = new JSDOM(html);
	const { document } = dom.window;
	const issues = [];
	const isAliasPage = Boolean(document.querySelector('meta[http-equiv="refresh"]'));

	// Alias redirect pages are intentionally minimal (noindex + canonical to
	// the target); their redirect correctness is owned by audit-a11y.js.
	if (isAliasPage) {
		if (!document.querySelector('link[rel="canonical"]')) {
			issues.push({ rule: "canonical", message: "Alias page is missing a canonical link" });
		}
		return issues;
	}

	const title = document.querySelector("title")?.textContent?.trim() ?? "";
	if (!title) {
		issues.push({ rule: "title", message: "Page is missing a <title>" });
	}
	const expectedTitle = EXPECTED_TITLES[relPath];
	if (expectedTitle && title !== expectedTitle) {
		issues.push({ rule: "title", message: `<title> is "${title}", expected "${expectedTitle}"` });
	}

	const expectedUrl = expectedUrlFor(relPath);
	const canonical = textAttr(document, 'link[rel="canonical"]', "href");
	if (!canonical) {
		issues.push({ rule: "canonical", message: "Page is missing a canonical link" });
	} else if (canonical !== expectedUrl) {
		issues.push({ rule: "canonical", message: `Canonical "${canonical}" does not match page URL "${expectedUrl}"` });
	}

	const description = textAttr(document, 'meta[name="description"]');
	if (!description) {
		issues.push({ rule: "description", message: "Page is missing a meta description" });
	} else if (description.length > MAX_DESCRIPTION_LENGTH) {
		issues.push({ rule: "description", message: `Meta description is ${description.length} chars, exceeds ${MAX_DESCRIPTION_LENGTH}` });
	}
	if (textAttr(document, 'meta[name="author"]') !== profile.name) {
		issues.push({ rule: "description", message: "meta author does not match the profile name" });
	}

	const ogType = textAttr(document, 'meta[property="og:type"]');
	const isProfilePage =
		relPath === path.join("hutson", "index.html") || relPath === path.join("hutson", "resume", "index.html");
	if (isProfilePage && ogType !== "profile") {
		issues.push({ rule: "open-graph", message: `Profile pages must set og:type "profile", got "${ogType}"` });
	}
	const og = {
		"og:title": textAttr(document, 'meta[property="og:title"]'),
		"og:url": textAttr(document, 'meta[property="og:url"]'),
		"og:site_name": textAttr(document, 'meta[property="og:site_name"]'),
		"og:locale": textAttr(document, 'meta[property="og:locale"]'),
		"og:image": textAttr(document, 'meta[property="og:image"]'),
		"og:image:alt": textAttr(document, 'meta[property="og:image:alt"]'),
	};
	if (!og["og:title"]) {
		issues.push({ rule: "open-graph", message: "og:title is missing" });
	}
	if (!["website", "article", "profile"].includes(ogType)) {
		issues.push({ rule: "open-graph", message: `Invalid og:type "${ogType}"` });
	}
	if (og["og:url"] && og["og:url"] !== canonical) {
		issues.push({ rule: "open-graph", message: `og:url "${og["og:url"]}" does not match canonical "${canonical}"` });
	}
	if (og["og:site_name"] !== "hyper-expanse") {
		issues.push({ rule: "open-graph", message: `og:site_name is "${og["og:site_name"]}"` });
	}
	if (!/^[a-z]{2}_[A-Z]{2}$/.test(og["og:locale"])) {
		issues.push({ rule: "open-graph", message: `og:locale "${og["og:locale"]}" must look like en_US` });
	}
	if (!og["og:image"].startsWith(BASE_URL)) {
		issues.push({ rule: "open-graph", message: `og:image "${og["og:image"]}" must be an absolute URL under ${BASE_URL}` });
	} else if (!fs.existsSync(path.join(PUBLIC_DIR, new URL(og["og:image"]).pathname.slice(1)))) {
		issues.push({ rule: "open-graph", message: `og:image "${og["og:image"]}" does not resolve to a built file` });
	}
	if (!og["og:image:alt"].includes(profile.name)) {
		issues.push({ rule: "open-graph", message: "og:image:alt should name the person in the photo" });
	}
	if (isProfilePage && description && textAttr(document, 'meta[property="og:description"]') !== description) {
		issues.push({ rule: "open-graph", message: "og:description and meta description differ on profile pages" });
	}
	if (isProfilePage && description !== profile.description) {
		issues.push({ rule: "description", message: `Profile page description "${description}" does not match data/hutson.yaml description_seo` });
	}

	// X renders the preview card from og:title/og:description/og:image and
	// defaults to the summary layout even when twitter:card is absent, and
	// Slack's classic unfurler reads the same Open Graph tags. twitter:*
	// metadata is therefore redundant here, and open standards are the
	// site's contract.
	if (document.querySelector('meta[name^="twitter:"], meta[property^="twitter:"]')) {
		issues.push({ rule: "open-standards", message: "twitter:* metadata found; social previews must rely on Open Graph" });
	}

	if (document.querySelectorAll('meta[name="theme-color"]').length < 2) {
		issues.push({ rule: "icons", message: "Expected dark and light theme-color metas" });
	}

	const blocks = findLdJson(document);
	if (blocks.some((b) => b["@type"] === "__invalid__")) {
		issues.push({ rule: "jsonld-parse", message: "A JSON-LD block failed to parse" });
	}
	const person = personFrom(blocks);
	if (!person) {
		issues.push({ rule: "jsonld-person", message: "Page is missing a Person (or ProfilePage > Person) JSON-LD block" });
	} else {
		auditPerson(person, profile, issues);
	}
	if (relPath === path.join("hutson", "index.html")) {
		if (!blocks.some((b) => b["@type"] === "ProfilePage")) {
			issues.push({ rule: "jsonld-person", message: "The profile page must wrap its Person in a ProfilePage" });
		}
		auditHCard(document, canonical, profile, issues);
	}
	auditArticlePages(relPath, document, blocks, profile, issues);
	auditProjectsPage(relPath, document, blocks, profile, issues);
	auditDormantTags(document, profile, issues);

	return issues;
}

async function walkHtmlFiles(dir) {
	const entries = await fsp.readdir(dir, { withFileTypes: true });
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

function auditRobotsAndSitemap(profile) {
	const issues = [];
	const robotsPath = path.join(PUBLIC_DIR, "robots.txt");
	if (!fs.existsSync(robotsPath)) {
		issues.push({ rule: "robots", message: "public/robots.txt is missing (enableRobotsTXT?)" });
	} else {
		const robots = fs.readFileSync(robotsPath, "utf8");
		if (!/User-agent:\s*\*/.test(robots)) {
			issues.push({ rule: "robots", message: "robots.txt must allow all user agents" });
		}
		if (/Disallow:\s*\/\S*hutson/.test(robots)) {
			issues.push({ rule: "robots", message: "robots.txt must not disallow the profile pages" });
		}
		if (!robots.includes(`Sitemap: ${BASE_URL}sitemap.xml`)) {
			issues.push({ rule: "robots", message: `robots.txt is missing "Sitemap: ${BASE_URL}sitemap.xml"` });
		}
	}
	const sitemapPath = path.join(PUBLIC_DIR, "sitemap.xml");
	if (!fs.existsSync(sitemapPath)) {
		issues.push({ rule: "sitemap", message: "public/sitemap.xml is missing" });
	} else {
		const sitemap = fs.readFileSync(sitemapPath, "utf8");
		for (const url of [BASE_URL, `${BASE_URL}hutson/`, `${BASE_URL}hutson/resume/`]) {
			if (!sitemap.includes(`<loc>${url}</loc>`)) {
				issues.push({ rule: "sitemap", message: `sitemap.xml is missing <loc>${url}</loc>` });
			}
		}
	}
	for (const feed of [path.join("index.xml"), path.join("hutson", "guides", "index.xml"), path.join("hutson", "articles", "index.xml")]) {
		if (!fs.existsSync(path.join(PUBLIC_DIR, feed))) {
			issues.push({ rule: "feeds", message: `${feed} is missing` });
		}
	}
	return issues;
}

async function main() {
	if (!fs.existsSync(DATA_FILE)) {
		console.error(`error: cannot read ${DATA_FILE}`);
		process.exit(FAILURE_EXIT_CODE);
	}
	const profile = loadCanonicalProfile();

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
	for (const file of htmlFiles) {
		const rel = path.relative(PUBLIC_DIR, file);
		const issues = auditPage(rel, await fsp.readFile(file, "utf8"), profile);
		if (issues.length === 0) {
			console.log(`✓ public/${rel.split(path.sep).join("/")}`);
		} else {
			totalIssues += issues.length;
			console.log(`✗ public/${rel.split(path.sep).join("/")}`);
			for (const issue of issues) {
				console.log(`  [${issue.rule}] ${issue.message}`);
			}
		}
	}

	const infraIssues = auditRobotsAndSitemap(profile);
	for (const issue of infraIssues) {
		totalIssues += 1;
		console.log(`  [${issue.rule}] ${issue.message}`);
	}
	if (infraIssues.length === 0) {
		console.log("✓ robots.txt, sitemap.xml, and section feeds");
	}

	console.log();
	process.exit(totalIssues === 0 ? SUCCESS_EXIT_CODE : FAILURE_EXIT_CODE);
}

main().catch((err) => {
	console.error(err);
	process.exit(FAILURE_EXIT_CODE);
});
