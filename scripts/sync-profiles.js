#!/usr/bin/env node

"use strict";

// Profile sync tool. `audit` compares the canonical profile in
// data/hutson.yaml against every public surface and prints a summary table
// with one block of findings per platform; `apply` updates the surfaces that
// have a usable CLI, prints copy-paste instructions for the ones that do not,
// and records what it produced in snapshot files under the OS temp directory.
//
// One-way sync rule: edit data/hutson.yaml, then run apply. Downstream
// surfaces are only ever hand-edited by following the instructions apply
// prints for them.
//
// Snapshots live in the OS temp directory rather than the repository, so
// they are ephemeral: after a reboot or temp cleanup, audit reports manual
// surfaces as missing a snapshot that apply must refresh. That is deliberate:
// the worst case is reprinted instructions, and the repository stays free of
// generated bookkeeping files.
//
// TODO: Wire `audit` into a scheduled CI job once we decide how gh, fj, and
// npm credentials reach the Codeberg Actions runner. Preflight failures
// should fail that job so a missing login is never mistaken for drift. This
// must stay out of .tools/test.sh, which is offline and deterministic.
//
// Output split: the audit report, the manual copy-paste blocks, and the
// usage text go to stdout (the blocks are content the operator copies);
// errors, progress notes, and preflight failures go to stderr, unchanged from
// the original check-profiles.js.

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile: execFileCallback } = require("node:child_process");
const { promisify } = require("node:util");
const YAML = require("yaml");
const { JSDOM } = require("jsdom");

const execFile = promisify(execFileCallback);

const FAILURE_EXIT_CODE = 1;
const SUCCESS_EXIT_CODE = 0;
const FETCH_TIMEOUT_MS = 15000;
const CLI_TIMEOUT_MS = 60000;
const GIT_TIMEOUT_MS = 120000;
const USER_AGENT = "hyper-expanse-profile-check";
const MIN_PREFIX_LENGTH = 20;

// GitHub rejects bios longer than 160 characters and Forgejo (Codeberg) user
// descriptions beyond roughly 255, so apply writes a word-boundary prefix of
// the canonical description; compareDescription's prefix tolerance accepts it
// back on the next audit.
const GITHUB_BIO_LIMIT = 160;
const CODEBERG_BIO_LIMIT = 255;

const CODEBERG_HOST = "codeberg.org";

// The legacy /<slug>.json endpoint and the rendered page are both read for
// Open Collective because the legacy endpoint omits profile metadata for
// user accounts. PyPI is checked by page existence only; its profile exposes
// just a display name, which no API serves back, so it rides on the
// snapshot. The npm and Codeberg profile reads moved to `npm profile get`
// and `fj user view`, which avoid npm's automated-request blocking and keep
// every Codeberg call on fj.
const ENDPOINTS = {
	openCollectiveLegacy: "https://opencollective.com/hutson.json",
	openCollectivePage: "https://opencollective.com/hutson",
	pypi: "https://pypi.org/user/hutson/",
};

// LinkedIn gives personal profiles no official write API and its terms
// prohibit unofficial ones, so the LinkedIn block always comes from apply's
// printed instructions. contact.linkedin in data/hutson.yaml is still empty,
// so this is the fallback profile URL for the checklist until that key is
// filled in.
const DEFAULT_LINKEDIN_PROFILE_URL = "https://www.linkedin.com/in/hutson/";

const STATUS = {
	ok: "OK",
	mismatch: "MISMATCH",
	// Avatar digests that differ are reported for visual confirmation rather
	// than as drift, because every host we sync resizes or re-encodes uploads.
	verify: "VERIFY",
	error: "ERROR",
};

function normalizeText(value) {
	return String(value).replace(/\s+/g, " ").trim();
}

function excerpt(value, maxLength = 60) {
	const text = normalizeText(value);
	return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

// Show each value around the first differing character instead of from the
// start: with fixed prefixes two long descriptions can look identical in the
// report while differing far past the excerpt, which hides the very
// difference the report exists to show. Both windows share one start offset
// so the differing characters line up vertically in the report.
function diffExcerpts(expected, actual, radius = 16, max = 52) {
	const shared = Math.min(expected.length, actual.length);
	let offset = 0;
	while (offset < shared && expected[offset] === actual[offset]) {
		offset += 1;
	}
	const start = Math.max(0, offset - radius);
	const window = (value) =>
		`${start > 0 ? "…" : ""}${value.slice(start, start + max)}${start + max < value.length ? "…" : ""}`;
	return { expected: window(expected), actual: window(actual) };
}

// Word-wrap to the report's 78-column budget so a long message (for example
// a CLI error string) never recreates the wrapping this report format
// exists to avoid. Long tokens such as URLs are not split; a slightly long
// line is better than a chopped URL.
function wrapLines(text, initialIndent, continuationIndent, width = 78) {
	const words = String(text).split(/\s+/).filter((word) => word !== "");
	const lines = [];
	let indent = initialIndent;
	let line = "";
	for (const word of words) {
		if (line === "") {
			line = `${indent}${word}`;
			continue;
		}
		if (line.length + 1 + word.length <= width) {
			line += ` ${word}`;
		} else {
			lines.push(line);
			indent = continuationIndent;
			line = `${indent}${word}`;
		}
	}
	if (line !== "") {
		lines.push(line);
	}
	return lines;
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

// Reduce markdown to plain text before comparing against the canonical
// description: fj echoes user bios as stored markdown, and surfaces like
// Open Collective round-trip through HTML. This removes only the markup that
// actually shows up in data/hutson.yaml-derived text (emphasis, inline
// code, headings, and link targets), leaving the words intact.
function stripMarkdown(text) {
	return String(text)
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/[*_`~]/g, "");
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

// Run an external CLI without a shell so field values containing spaces or
// quotes pass through intact. A missing binary and a non-zero exit both
// become errors with the CLI's own stderr in the message, so preflight can
// tell "not installed" from "not logged in".
async function runCli(binary, args, { timeoutMs = CLI_TIMEOUT_MS } = {}) {
	try {
		const result = await execFile(binary, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
		return result.stdout;
	} catch (err) {
		if (err.code === "ENOENT") {
			throw new Error(`${binary} is not installed (or not on PATH)`);
		}
		const detail = normalizeText(err.stderr || err.stdout || err.message || "");
		throw new Error(`${binary} ${args.join(" ")} failed: ${excerpt(detail, 240)}`);
	}
}

// Every Codeberg call pins the host explicitly so fj never resolves the
// instance from the working directory's git remote, and requests the
// minimal style so output is plain text (fj also forces minimal when stdout
// is a pipe, but we do not rely on how it detects terminals).
async function fj(args) {
	const stdout = await runCli("fj", ["--style", "minimal", "--host", CODEBERG_HOST, ...args]);
	// fj decorates every printed value with Unicode bidi isolates (U+2066 to
	// U+2069) so mixed-direction text renders correctly in a terminal. The
	// characters are invisible but part of the string, so a value as simple
	// as the whoami login fails exact comparison until they are stripped.
	// Doing it once here keeps every parser downstream honest.
	return stdout.replace(/[\u2066-\u2069]/g, "");
}

async function gh(args) {
	return runCli("gh", args);
}

// gh and fj report a missing repository with a 404 (or "could not resolve");
// any other failure (auth, rate limit, network) means the account state is
// unknown, so callers must surface it rather than treat the repository as
// absent.
function isNotFound(err) {
	return /404|not found|could not resolve/i.test(err.message);
}

// A write that fails because the repository is archived: the same frozen-
// mirror case the isArchived check catches up front on GitHub, kept as the
// backstop for hosts that only report it at write time (fj has no archived
// flag in `repo view` output).
function isArchivedError(err) {
	return /archiv|read-only/i.test(err.message);
}

// fj writes always target the authenticated user, so apply verifies the
// identity before touching anything: parsing `fj whoami`
// ("currently signed into <name>@<host>") prevents patching the wrong
// Codeberg account if the stored key belongs to someone else.
async function codebergIdentity() {
	const match = /signed into (\S+)@/.exec(await fj(["whoami"]));
	return match ? match[1] : null;
}

function sha256(buffer) {
	return crypto.createHash("sha256").update(buffer).digest("hex");
}

// `notes` holds finding objects ({ fix, message, subject?, expected?, actual? })
// on audit rows and plain strings on apply rows. That is safe because apply
// renders only the strings it pushed itself, and drifted() discards the
// collector array, so the pushed element type never crosses between the two.
function makeResult(platform, ok, notes, needsVisualVerify = false) {
	let status = ok ? (needsVisualVerify ? STATUS.verify : STATUS.ok) : STATUS.mismatch;
	return { platform, status, notes };
}

function errorResult(platform, err) {
	return { platform, status: STATUS.error, notes: [err.message] };
}

function compareDescription(notes, actual, expected, fix = "apply") {
	if (actual === null || actual === undefined || normalizeText(actual) === "") {
		notes.push({ fix, message: "bio/description missing" });
		return false;
	}
	const normalized = normalizeText(actual);
	// Platforms with bio length limits (e.g. GitHub) only ever hold the
	// leading sentence of the canonical description, so a substantial prefix
	// is treated as aligned.
	if (normalized === expected || (expected.startsWith(normalized) && normalized.length >= MIN_PREFIX_LENGTH)) {
		return true;
	}
	// The char counts move out of the quoted excerpts into a compact suffix
	// because two full quotes on one line are what caused the wrapping.
	notes.push({
		fix,
		message: `description differs (${expected.length} vs ${normalized.length} chars)`,
		...diffExcerpts(expected, normalized),
	});
	return false;
}

// Repository descriptions are rendered, complete documents rather than
// length-limited bios, so they compare exactly. Prefix tolerance would
// accept a GitHub mirror missing its "Mirror of" suffix, and apply would
// never rewrite it.
function compareRepoDescription(notes, actual, expected, fix = "apply") {
	if (actual === null || actual === undefined || normalizeText(actual) === "") {
		notes.push({ fix, message: "description missing" });
		return false;
	}
	const normalized = normalizeText(actual);
	if (normalized === expected) {
		return true;
	}
	notes.push({
		fix,
		message: `description differs (${expected.length} vs ${normalized.length} chars)`,
		...diffExcerpts(expected, normalized),
	});
	return false;
}

function compareName(notes, actual, expected, fix = "apply") {
	if (normalizeText(actual ?? "") === "") {
		notes.push({ fix, message: "name missing" });
		return false;
	}
	if (normalizeText(actual) === normalizeText(expected)) {
		return true;
	}
	notes.push({
		fix,
		message: "name differs",
		...diffExcerpts(normalizeText(expected), normalizeText(actual)),
	});
	return false;
}

async function checkAvatar(notes, avatarUrl, avatar) {
	if (!avatarUrl) {
		notes.push({ fix: "manual", message: "avatar missing" });
		return { ok: false, verify: false };
	}
	if (!avatar?.digest) {
		notes.push({ fix: "manual", message: "avatar source image missing; check the picture key in data/hutson.yaml" });
		return { ok: false, verify: false };
	}
	let bytes;
	try {
		const res = await fetchWithTimeout(avatarUrl);
		if (!res.ok) {
			throw new Error(`HTTP ${res.status}`);
		}
		bytes = Buffer.from(await res.arrayBuffer());
	} catch (err) {
		// The "; verify visually" clause stays because it states the specific
		// action and file the manual tag alone does not.
		notes.push({ fix: "manual", message: `avatar could not be fetched (${err.message}); verify visually against ${avatar.fileName}` });
		return { ok: true, verify: true };
	}
	if (sha256(bytes) === avatar.digest) {
		return { ok: true, verify: false };
	}
	// GitHub, Open Collective, and Gravatar all resize or re-encode uploads,
	// so a byte mismatch cannot prove the wrong image is in place; only an
	// absent avatar is treated as drift. This closes the presence-only gap
	// while staying honest about what a digest comparison can show.
	notes.push({ fix: "manual", message: `avatar bytes differ from ${avatar.fileName}; verify visually` });
	return { ok: true, verify: true };
}

function compareLink(notes, label, actual, expected, fix = "apply") {
	if (!expected) {
		return true;
	}
	if (!actual) {
		notes.push({ fix, message: `${label} link missing` });
		return false;
	}
	if (normalizeUrl(actual) !== expected) {
		// Links carry their full values (no windowing) because a URL
		// difference is usually an encoding or trailing-slash issue that must
		// be seen in full; values are quoted at render time.
		notes.push({ fix, message: `${label} link differs`, expected, actual: normalizeUrl(actual) });
		return false;
	}
	return true;
}

// Truncate to a word boundary so the result stays a prefix of the canonical
// description, which is what compareDescription tolerates.
function truncateBio(text, limit) {
	if (text.length <= limit) {
		return text;
	}
	const cut = text.slice(0, limit + 1);
	const lastSpace = cut.lastIndexOf(" ");
	return (lastSpace > MIN_PREFIX_LENGTH ? cut.slice(0, lastSpace) : cut.slice(0, limit)).trimEnd();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatMonthYear(value) {
	const match = /^(\d{4})-(\d{2})$/.exec(String(value ?? "").trim());
	if (!match) {
		return normalizeText(value ?? "");
	}
	const month = Number(match[2]) - 1;
	return `${MONTHS[month]} ${match[1]}`;
}

// --- fj output parsers -----------------------------------------------------
//
// In minimal style fj prefixes body text (user bios, repo descriptions,
// README files) with "> " per line, and those prefixed lines are the only
// lines so decorated before the trailing stats. Parsing on the prefix keeps
// this independent of the localized label wording. The parser is pinned
// against fj's source behavior (forgejo-contrib/forgejo-cli); if fj changes
// its output format this breaks loudly on unprefixed content rather than
// silently comparing the wrong text. Once tests land, captured fj output
// should be pinned as fixtures.

function parseFjBody(output) {
	const bodyLines = [];
	for (const line of String(output).split("\n")) {
		if (line.startsWith(">")) {
			bodyLines.push(line.replace(/^>\s?/, ""));
		} else if (bodyLines.length > 0) {
			break;
		}
	}
	return bodyLines.join("\n").trim();
}

// `fj user view` prints: login line, followers line, then an optional
// website (and public email) line, then the raw markdown bio as "> "-prefixed
// lines, then "Joined on ...". It exposes neither the full name nor the
// avatar, so those two ride on the snapshot instead.
function parseFjUserView(output) {
	let website = null;
	for (const line of String(output).split("\n")) {
		if (line.startsWith(">")) {
			break;
		}
		const candidate = line.match(/https?:\/\/\S+/);
		if (candidate) {
			website = candidate[0];
			break;
		}
	}
	return { website, bio: parseFjBody(output) };
}

// --- snapshots --------------------------------------------------------------

function snapshotDir() {
	return path.join(os.tmpdir(), "hyper-expanse-profile-sync");
}

async function readSnapshot(surface) {
	try {
		return JSON.parse(await fs.readFile(path.join(snapshotDir(), `${surface}.json`), "utf8"));
	} catch {
		return null;
	}
}

async function writeSnapshot(surface, canonical, fields, manual = []) {
	// Owner-only modes: the snapshot directory name is predictable, so on a
	// shared /tmp the umask default would let another user pre-create the
	// path or swap the JSON that audit trusts for snapshot-backed fields.
	await fs.mkdir(snapshotDir(), { recursive: true, mode: 0o700 });
	const snapshot = {
		surface,
		sourceHash: canonical.sourceHash,
		appliedAt: new Date().toISOString(),
		fields,
		manual,
	};
	await fs.writeFile(
		path.join(snapshotDir(), `${surface}.json`),
		`${JSON.stringify(snapshot, null, 2)}\n`,
		{ mode: 0o600 },
	);
}

// Audit cannot read these fields back from any API, so the snapshot is the
// only record: an absent snapshot means apply has never run on this machine,
// and a stale source hash means the instructions the operator was given no
// longer match data/hutson.yaml.
async function checkSnapshot(notes, surface, canonical, label = "snapshot-backed fields") {
	const snapshot = await readSnapshot(surface);
	if (!snapshot) {
		notes.push({ fix: "apply", message: `${label}: no snapshot` });
		return false;
	}
	if (snapshot.sourceHash !== canonical.sourceHash) {
		notes.push({ fix: "apply", message: `${label}: snapshot is older than data/hutson.yaml` });
		return false;
	}
	return true;
}

// --- canonical model --------------------------------------------------------

function loginFromUrl(url, stripPrefix = "") {
	if (!url) {
		return null;
	}
	const segments = new URL(url).pathname.split("/").filter(Boolean);
	const last = segments[segments.length - 1] ?? "";
	return last.startsWith(stripPrefix) ? last.slice(stripPrefix.length) : last;
}

// GitHub counterparts of the Codeberg-first projects: list are mirrored by
// repository name under the canonical GitHub login (the same repositories,
// published from Codeberg to GitHub under identical names). Entries without
// a parseable URL, or whose mirror does not exist on GitHub, are skipped
// with a note rather than failing the run.
function githubMirrorOf(repositoryUrl, githubLogin) {
	if (!repositoryUrl || !githubLogin) {
		return null;
	}
	const segments = new URL(repositoryUrl).pathname.split("/").filter(Boolean);
	if (segments.length < 2) {
		return null;
	}
	return { login: githubLogin, repo: segments[segments.length - 1] };
}

// GitHub counterparts of the Codeberg-first projects advertise their origin:
// mirror descriptions end with "Mirror of <Codeberg URL>.", a sentence the
// operator keeps on purpose, so the text audit expects and apply writes is
// the canonical description plus that suffix. Codeberg originals and the
// profile READMEs keep the bare canonical description.
function githubMirrorDescription(project) {
	return `${project.description} Mirror of ${project.repository}.`;
}

// Build the canonical profile from data/hutson.yaml. Links from contact,
// follow, and sponsor are merged into a single normalized lookup keyed by a
// lowercase label.
async function loadCanonical(sourceDir) {
	const rawBuffer = await fs.readFile(path.join(sourceDir, "data", "hutson.yaml"));
	const data = YAML.parse(rawBuffer.toString("utf8"));
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
	// Empty contact keys (email, phone, mastodon, fedora, debian, kde) parse
	// to null; when they are filled in they flow through links and the
	// logins lookup without any further changes.
	const logins = {
		github: loginFromUrl(links.github),
		codeberg: loginFromUrl(links.codeberg),
		npm: loginFromUrl(links.npmjs, "~"),
		pypi: loginFromUrl(links.pypi),
	};
	const pictureName = normalizeText(data.picture ?? "");
	const picturePath = pictureName ? path.join(sourceDir, "assets", "images", pictureName) : null;
	const avatar = {
		fileName: pictureName || "(unset)",
		path: picturePath,
		digest: picturePath ? sha256(await fs.readFile(picturePath)) : null,
	};
	const projects = (data.projects ?? [])
		.filter((project) => typeof project?.repository === "string" && project.repository.startsWith("http"))
		.map((project) => ({
			title: normalizeText(project.title ?? ""),
			description: normalizeText(project.description ?? ""),
			repository: normalizeUrl(project.repository),
			github: githubMirrorOf(project.repository, logins.github),
			tag: project.tag ?? "personal",
			status: project.status ?? "active",
		}));
	return {
		name: normalizeText(data.name ?? ""),
		title: normalizeText(data.title ?? ""),
		descriptionSeo: normalizeText(data.description_seo ?? ""),
		descriptionPersonal: normalizeText(data.description_personal ?? ""),
		descriptionProfessional: normalizeText(data.description_professional ?? ""),
		// The bio compared against every surface: the professional description
		// is the wording the live profiles already carry, so this stays the
		// reference for prefix-tolerant comparison.
		description: normalizeText(data.description_professional ?? ""),
		skills: (data.skills ?? []).map((group) => ({
			category: normalizeText(group?.category ?? ""),
			items: (group?.items ?? []).map(normalizeText),
		})),
		projects,
		employment: data.employment ?? [],
		publications: data.publications ?? [],
		contact: data.contact ?? {},
		follow: data.follow ?? [],
		sponsor: data.sponsor ?? [],
		links,
		logins,
		avatar,
		sourceHash: sha256(rawBuffer),
	};
}

// --- rendered artifacts ------------------------------------------------------

function collectLinkUrls(canonical) {
	const urls = [];
	const seen = new Set();
	const push = (url) => {
		const key = normalizeUrl(url);
		if (!seen.has(key)) {
			seen.add(key);
			urls.push(url);
		}
	};
	for (const value of Object.values(canonical.contact)) {
		if (typeof value === "string" && value.startsWith("http")) {
			push(value);
		}
	}
	for (const section of ["follow", "sponsor"]) {
		for (const entry of canonical[section]) {
			if (typeof entry?.url === "string") {
				push(entry.url);
			}
		}
	}
	return urls;
}

// One Markdown document, pushed unchanged to both profile README repos, so
// the two forges show identical content rendered from the same model the
// comparisons use.
function renderProfileReadme(canonical) {
	const lines = [
		`# ${canonical.name}`,
		"",
		`**${canonical.title}**`,
		"",
		canonical.description,
		"",
		"## Projects",
		"",
	];
	for (const project of canonical.projects) {
		lines.push(`- [${project.title}](${project.repository}): ${project.description}`);
	}
	lines.push("", "## Links", "");
	for (const url of collectLinkUrls(canonical)) {
		lines.push(`- ${url}`);
	}
	return `${lines.join("\n")}\n`;
}

function renderLinkedInExperience(canonical) {
	return canonical.employment
		.map((job) =>
			(job.roles ?? [])
				.filter((role) => (role.contributions ?? []).length > 0)
				.map((role) =>
					[
						`${formatMonthYear(role.start)} - ${formatMonthYear(role.end)}`,
						`${job.title} at ${job.company}`,
						"",
						...role.contributions.map((contribution) => `- ${normalizeText(contribution)}`),
					].join("\n"),
				)
				.join("\n\n"),
		)
		.join("\n\n");
}

// LinkedIn offers no official write API for personal profiles, and unofficial
// automation violates its terms, so this generates copy-paste blocks next to
// the profile URL instead. The About text uses the personal description (the
// website profile page voice) and falls back to the professional one.
function linkedinBlocks(canonical) {
	const profileUrl = canonical.links.linkedin || DEFAULT_LINKEDIN_PROFILE_URL;
	return [
		{ field: "Headline", value: canonical.descriptionSeo || canonical.title },
		{ field: "About", value: canonical.descriptionPersonal || canonical.description },
		{ field: "Experience", value: renderLinkedInExperience(canonical) },
		{
			field: "Skills",
			value: canonical.skills.map((group) => `${group.category}: ${group.items.join(", ")}`).join("\n"),
		},
		{ field: "Featured links", value: collectLinkUrls(canonical).join("\n") },
		{ field: "Photo", value: `Upload ${canonical.avatar.path}` },
	].map((block) => ({ ...block, url: profileUrl }));
}

function sponsorsItems(canonical) {
	return [
		{ field: "Profile blurb", value: canonical.descriptionSeo || canonical.description },
		{ field: "Links", value: collectLinkUrls(canonical).join("\n") },
	];
}

function openCollectiveItems(canonical, account) {
	const currentDescription = account?.longDescription
		? stripHtml(account.longDescription)
		: account?.description;
	const items = [
		{ field: "Long description", value: canonical.description },
		{ field: "Website", value: canonical.links.website ?? "" },
		{ field: "GitHub handle", value: canonical.logins.github ?? "" },
		{ field: "Avatar", value: `Upload ${canonical.avatar.path}` },
	];
	if (account) {
		items.unshift({
			field: "(current long description)",
			value: excerpt(currentDescription ?? "(empty)", 200),
		});
	}
	return items;
}

function pypiItems(canonical) {
	return [{ field: "Display name", value: canonical.name }];
}

// Avatars are manual everywhere: the GitHub API has no avatar upload, fj has
// no user avatar command, and npm renders the avatar from Gravatar rather
// than accepting an upload.
function avatarItems(canonical) {
	return [
		{
			surface: "GitHub avatar",
			url: "https://github.com/settings/profile",
			field: "Profile Image",
			value: `Upload ${canonical.avatar.path}`,
		},
		{
			surface: "Codeberg avatar",
			url: "https://codeberg.org/user/settings",
			field: "Profile picture",
			value: `Upload ${canonical.avatar.path}`,
		},
		{
			surface: "npm avatar",
			url: "https://gravatar.com",
			field: "Gravatar",
			value: `npm renders avatars from Gravatar; make sure the account email's Gravatar is ${canonical.avatar.path}`,
		},
	];
}

function printManual({ surface, url, items, note }) {
	console.log(`\nManual: ${surface}\nURL: ${url}`);
	if (note) {
		console.log(`Note: ${note}`);
	}
	for (const item of items) {
		console.log(`\n${item.field}:`);
		for (const line of String(item.value).split("\n")) {
			console.log(`  ${line}`);
		}
	}
}

// --- access preflight --------------------------------------------------------

// Validate access to every surface that has a CLI or API before any read or
// write, so a missing login is never reported as drift and apply never
// leaves a surface half synced. PyPI and LinkedIn are skipped: they have
// nothing to validate. A missing CLI binary counts as a failed surface.
async function preflight() {
	const checks = [
		{
			surface: "GitHub",
			remediation: "Install the GitHub CLI and run: gh auth login",
			run: () => gh(["auth", "status"]),
		},
		{
			surface: "Codeberg",
			remediation: `Install forgejo-cli (https://codeberg.org/forgejo-contrib/forgejo-cli) and run: fj auth login --host ${CODEBERG_HOST}`,
			run: () => fj(["whoami"]),
		},
		{
			surface: "npm",
			remediation: "Run: npm login",
			run: () => runCli("npm", ["whoami"]),
		},
		{
			surface: "Open Collective",
			remediation: "Check network access to opencollective.com",
			// Any HTTP response proves reachability; audit decides whether the
			// payload is usable.
			run: () => fetchWithTimeout(ENDPOINTS.openCollectivePage).then(() => undefined),
		},
	];
	const settled = await Promise.allSettled(checks.map((check) => check.run()));
	const failures = settled
		.map((outcome, index) => (outcome.status === "rejected" ? { ...checks[index], reason: outcome.reason } : null))
		.filter(Boolean);
	for (const failure of failures) {
		console.error(`preflight: ${failure.surface}: ${failure.reason.message}. ${failure.remediation}`);
	}
	return failures.length === 0;
}

// --- audit --------------------------------------------------------------------

function requireLogin(notes, canonical, key, linkKey) {
	if (canonical.logins[key]) {
		return true;
	}
	// Manual: the human must fill the contact key; apply cannot guess the
	// account behind an empty field.
	notes.push({ fix: "manual", message: `contact.${linkKey} is empty in data/hutson.yaml; cannot locate the ${key} account` });
	return false;
}

async function checkGitHubProfile(canonical) {
	const notes = [];
	let ok = true;
	if (!requireLogin(notes, canonical, "github", "github")) {
		return makeResult("GitHub profile", false, notes);
	}
	const user = await gh(["api", "user"]);
	const profile = JSON.parse(user);
	if (profile.login !== canonical.logins.github) {
		// Manual: the human must log out and back in as the canonical
		// account, or fix data/hutson.yaml.
		notes.push({ fix: "manual", message: `authenticated GitHub account is "${profile.login}", canonical profile is "${canonical.logins.github}"` });
		return makeResult("GitHub profile", false, notes);
	}
	ok = compareName(notes, profile.name, canonical.name) && ok;
	ok = compareDescription(notes, profile.bio, canonical.description) && ok;
	ok = compareLink(notes, "website", profile.blog, canonical.links.website) && ok;
	const avatar = await checkAvatar(notes, profile.avatar_url, canonical.avatar);
	ok = avatar.ok && ok;
	return makeResult("GitHub profile", ok, notes, avatar.verify);
}

// description plus the archived flag in one call: an archived repository is
// read-only, which decides whether drifted descriptions are an apply fix or a
// manual step.
async function ghRepoInfo(github) {
	const stdout = await gh(["repo", "view", `${github.login}/${github.repo}`, "--json", "description,isArchived"]);
	const info = JSON.parse(stdout);
	return { description: info.description ?? "", archived: Boolean(info.isArchived) };
}

async function checkGitHubRepositories(canonical) {
	const notes = [];
	let ok = true;
	let checked = 0;
	for (const project of canonical.projects) {
		if (!project.github) {
			continue;
		}
		let repo;
		try {
			repo = await ghRepoInfo(project.github);
		} catch {
			console.error(`note: GitHub mirror ${project.github.login}/${project.github.repo} not found; skipping its description`);
			continue;
		}
		checked += 1;
		const before = notes.length;
		// An archived mirror is read-only and unarchiving is an operator
		// decision, so its drift is a manual step even though writable
		// mirrors on the same surface stay automated.
		const fix = repo.archived ? "manual" : "apply";
		ok = compareRepoDescription(notes, repo.description, githubMirrorDescription(project), fix) && ok;
		// Keep the repo name as structured data on each finding instead of a
		// string prefix, which is what lets the renderer align it.
		for (let i = before; i < notes.length; i += 1) {
			notes[i].subject = project.github.repo;
			if (repo.archived) {
				notes[i].message += "; repository is archived (read-only)";
			}
		}
	}
	if (checked === 0) {
		notes.push({ fix: "manual", message: "no GitHub mirrors found for the projects list" });
	}
	return makeResult("GitHub repositories", ok, notes);
}

async function readGithubReadme(canonical) {
	if (!canonical.logins.github) {
		throw new Error("contact.github is empty in data/hutson.yaml");
	}
	return gh([
		"api",
		`repos/${canonical.logins.github}/${canonical.logins.github}/readme`,
		"--jq",
		".content | @base64d",
	]);
}

async function readCodebergReadme(canonical) {
	if (!canonical.logins.codeberg) {
		throw new Error("contact.codeberg is empty in data/hutson.yaml");
	}
	const output = await fj(["repo", "readme", `${canonical.logins.codeberg}/${canonical.logins.codeberg}`]);
	return parseFjBody(output);
}

// Compare normalized-to-trailing-whitespace text; the rendered README and the
// remote copy should be byte-identical apart from trailing newlines.
function readmeMatches(actual, rendered) {
	return String(actual).replace(/\s+$/, "") === rendered.replace(/\s+$/, "");
}

async function checkProfileReadme(platform, canonical, reader) {
	const notes = [];
	const rendered = renderProfileReadme(canonical);
	let actual;
	try {
		actual = await reader(canonical);
	} catch (err) {
		// apply pushes a fresh copy when the remote README is unreadable, but
		// a not-found usually means the profile repository itself is absent
		// (as on Codeberg): only apply's manual "create the repository"
		// instructions can resolve that, so the finding is tagged manual.
		const fix = isNotFound(err) ? "manual" : "apply";
		notes.push({ fix, message: `could not read profile README (${err.message})` });
		return makeResult(`${platform} profile README`, false, notes);
	}
	const ok = readmeMatches(actual, rendered);
	if (!ok) {
		notes.push({ fix: "apply", message: "README differs from the generated document" });
	}
	return makeResult(`${platform} profile README`, ok, notes);
}

async function checkCodebergProfile(canonical) {
	const notes = [];
	let ok = true;
	if (!requireLogin(notes, canonical, "codeberg", "codeberg")) {
		return makeResult("Codeberg profile", false, notes);
	}
	const output = await fj(["user", "view", canonical.logins.codeberg]);
	const parsed = parseFjUserView(output);
	ok = compareDescription(notes, stripMarkdown(parsed.bio), canonical.description) && ok;
	ok = compareLink(notes, "website", parsed.website, canonical.links.website) && ok;
	// fj user view exposes neither the full name nor the avatar.
	ok = (await checkSnapshot(notes, "codeberg", canonical, "name and avatar")) && ok;
	return makeResult("Codeberg profile", ok, notes);
}

async function checkCodebergRepositories(canonical) {
	const notes = [];
	let ok = true;
	for (const project of canonical.projects) {
		const repoPath = new URL(project.repository).pathname.split("/").filter(Boolean).join("/");
		let output;
		try {
			output = await fj(["repo", "view", repoPath]);
		} catch {
			console.error(`note: Codeberg repository ${repoPath} not found; skipping its description`);
			continue;
		}
		const before = notes.length;
		ok = compareRepoDescription(notes, parseFjBody(output), project.description) && ok;
		// Keep the repo path as structured data on each finding instead of a
		// string prefix, which is what lets the renderer align it.
		for (let i = before; i < notes.length; i += 1) {
			notes[i].subject = repoPath;
		}
	}
	return makeResult("Codeberg repositories", ok, notes);
}

async function checkOpenCollective(canonical) {
	const notes = [];
	const account = await fetchOpenCollectiveProfile();
	let ok = true;
	// longDescription holds the full profile body (HTML); description is the
	// short summary shown when the long form is unset.
	const description = account.longDescription && normalizeText(stripHtml(account.longDescription)) !== ""
		? stripHtml(account.longDescription)
		: account.description;
	// Open Collective has no write API for personal profiles: apply prints
	// these values as manual instructions, so findings here must not claim
	// that running apply fixes them.
	ok = compareDescription(notes, description, canonical.description, "manual") && ok;
	const avatar = await checkAvatar(notes, account.image ?? account.imageUrl, canonical.avatar);
	ok = avatar.ok && ok;
	ok = compareLink(notes, "website", account.website, canonical.links.website, "manual") && ok;
	ok = compareLink(
		notes,
		"github",
		account.githubHandle ? `https://github.com/${account.githubHandle}` : null,
		canonical.links.github,
		"manual",
	) && ok;
	return makeResult("Open Collective", ok, notes, avatar.verify);
}

async function fetchOpenCollectiveProfile() {
	// The legacy /<slug>.json endpoint omits profile metadata for user
	// accounts, so fall back to scraping the rendered page when it lacks the
	// fields we need.
	const legacy = await fetchJson(ENDPOINTS.openCollectiveLegacy).catch(() => null);
	if (legacy && (legacy.description !== undefined || legacy.website !== undefined)) {
		return legacy;
	}
	const res = await fetchWithTimeout(ENDPOINTS.openCollectivePage);
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

async function readNpmProfile() {
	const stdout = await runCli("npm", ["profile", "get", "--json"]);
	return JSON.parse(stdout);
}

// npm profile fields per the npm docs: name is the login, fullname the
// display name, homepage the website, and github the GitHub handle. There is
// no avatar field; npm renders the avatar from Gravatar, so the avatar rides
// on the snapshot like the Codeberg one does.
// npm restricts tokens that bypass 2FA for account changes, so profile
// writes demand a one-time passcode a non-interactive tool cannot supply;
// reads stay automated for verification, but findings are tagged manual.
async function checkNpm(canonical) {
	const notes = [];
	let ok = true;
	if (!requireLogin(notes, canonical, "npm", "npmjs")) {
		return makeResult("npm", false, notes);
	}
	const profile = await readNpmProfile();
	if (profile.name !== canonical.logins.npm) {
		// Manual: the human must log out and back in as the canonical
		// account, or fix data/hutson.yaml.
		notes.push({ fix: "manual", message: `authenticated npm account is "${profile.name}", canonical profile is "${canonical.logins.npm}"` });
		return makeResult("npm", false, notes);
	}
	ok = compareName(notes, profile.fullname, canonical.name, "manual") && ok;
	ok = compareLink(
		notes,
		"github",
		profile.github ? `https://github.com/${profile.github}` : null,
		canonical.links.github,
		"manual",
	) && ok;
	ok = compareLink(notes, "website", profile.homepage || null, canonical.links.website, "manual") && ok;
	ok = (await checkSnapshot(notes, "npm", canonical, "avatar (Gravatar)")) && ok;
	return makeResult("npm", ok, notes);
}

// PyPI user profiles expose only a display name and project list; there is no
// bio, avatar, or link metadata to compare, and the display name has no read
// API, so it rides on the snapshot. The page-existence title check is
// advisory only: pypi.org serves a "Client Challenge" page to automated
// agents, so a surprising title means "look yourself", not drift. Reporting
// it as drift would make audit fail forever, the same trap the old npm page
// scrape fell into.
async function checkPypi(canonical) {
	const notes = [];
	let verify = false;
	let title = "";
	try {
		const res = await fetchWithTimeout(ENDPOINTS.pypi);
		if (!res.ok) {
			throw new Error(`HTTP ${res.status}`);
		}
		title = parsePypiTitle(await res.text());
	} catch (err) {
		notes.push({ fix: "manual", message: `profile page not readable (${err.message}); verify manually at ${ENDPOINTS.pypi}` });
		verify = true;
	}
	if (!verify && !title.toLowerCase().includes((canonical.logins.pypi ?? "hutson").toLowerCase())) {
		// Manual: pypi.org serves a bot challenge, so only a human browser
		// resolves it.
		notes.push({ fix: "manual", message: `unexpected profile page title: "${normalizeText(title)}"; verify manually (pypi.org blocks automated requests)` });
		verify = true;
	}
	const ok = await checkSnapshot(notes, "pypi", canonical, "display name");
	return makeResult("PyPI", ok, notes, verify);
}

function parsePypiTitle(html) {
	const dom = new JSDOM(html);
	return dom.window.document.querySelector("title")?.textContent ?? "";
}

async function checkSnapshotOnly(platform, surface, canonical) {
	const notes = [];
	const ok = await checkSnapshot(notes, surface, canonical, `${platform} content`);
	return makeResult(platform, ok, notes);
}

async function runAudit(canonical) {
	const checkers = [
		checkGitHubProfile,
		checkGitHubRepositories,
		(canonical2) => checkProfileReadme("GitHub", canonical2, readGithubReadme),
		checkCodebergProfile,
		checkCodebergRepositories,
		(canonical2) => checkProfileReadme("Codeberg", canonical2, readCodebergReadme),
		checkOpenCollective,
		checkNpm,
		checkPypi,
		(canonical2) => checkSnapshotOnly("LinkedIn", "linkedin", canonical2),
		(canonical2) => checkSnapshotOnly("GitHub Sponsors", "github-sponsors", canonical2),
	];
	const settled = await Promise.allSettled(checkers.map((check) => check(canonical)));
	const results = settled.map((outcome, index) => {
		if (outcome.status === "fulfilled") {
			return outcome.value;
		}
		const platform = AUDIT_LABELS[index];
		console.error(`error: ${platform}: ${outcome.reason.message}`);
		// Inline row instead of errorResult so audit rows hold only finding
		// objects; errorResult stays untouched for apply, whose renderer
		// joins plain strings.
		return { platform, status: STATUS.error, notes: [{ fix: "manual", message: outcome.reason.message }] };
	});
	renderAudit(results);
	const failed = results.some((r) => r.status === STATUS.mismatch || r.status === STATUS.error);
	process.exit(failed ? FAILURE_EXIT_CODE : SUCCESS_EXIT_CODE);
}

const AUDIT_LABELS = [
	"GitHub profile",
	"GitHub repositories",
	"GitHub profile README",
	"Codeberg profile",
	"Codeberg repositories",
	"Codeberg profile README",
	"Open Collective",
	"npm",
	"PyPI",
	"LinkedIn",
	"GitHub Sponsors",
];

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

// --- audit report rendering ---------------------------------------------------

const REPORT_WIDTH = 78;
const MANUAL_SECTION_HEADER = "Manual follow-up (nothing here is fixed by apply)";

// Renders the audit report as a summary table (counts only, so every row is
// short), a detail block with one line per finding, and a closing checklist
// of the findings apply cannot fix. The manual checklist exists because
// "what must I do by hand" is the question an operator asks the report, and
// an explicit "none" answers it when apply covers everything.
function renderAudit(results) {
	// Fallback for safety only: audit rows hold finding objects after the
	// compare helpers were converted, but a stray string renders as manual
	// rather than crashing the report.
	const findingOf = (item) => (typeof item === "string" ? { fix: "manual", message: item } : item);
	const rows = results.map((r) => ({ ...r, findings: r.notes.map(findingOf) }));
	const platformWidth = Math.max("Platform".length, ...rows.map((r) => r.platform.length));
	const statusWidth = Math.max("Status".length, ...rows.map((r) => r.status.length));
	const lines = [];
	const header = `${"Platform".padEnd(platformWidth)}  ${"Status".padEnd(statusWidth)}  Findings`;
	lines.push(header);
	lines.push("-".repeat(header.length));
	for (const row of rows) {
		const applyCount = row.findings.filter((finding) => finding.fix === "apply").length;
		const manualCount = row.findings.length - applyCount;
		const counts = [];
		if (applyCount > 0) {
			counts.push(`${applyCount} apply`);
		}
		if (manualCount > 0) {
			counts.push(`${manualCount} manual`);
		}
		lines.push(`${row.platform.padEnd(platformWidth)}  ${row.status.padEnd(statusWidth)}  ${counts.length > 0 ? counts.join(", ") : "-"}`);
	}
	const countByStatus = (status) => rows.filter((row) => row.status === status).length;
	lines.push(`${countByStatus(STATUS.ok)} OK, ${countByStatus(STATUS.mismatch)} MISMATCH, ${countByStatus(STATUS.verify)} VERIFY, ${countByStatus(STATUS.error)} ERROR`);
	if (rows.some((row) => row.findings.some((finding) => finding.fix === "apply"))) {
		lines.push('fix everything tagged "apply" by running: npm run sync:profiles');
	}
	for (const row of rows) {
		if (row.findings.length === 0) {
			continue;
		}
		lines.push("");
		lines.push(`${row.platform} (${row.status})`);
		for (const finding of row.findings) {
			const subject = finding.subject ? `${finding.subject}: ` : "";
			// The 7-column tag pad aligns apply and manual messages at column
			// 10; the 9-space continuation aligns wrapped text under the
			// message.
			lines.push(...wrapLines(`${subject}${finding.message}`, `  ${finding.fix.padEnd(7)}`, " ".repeat(9), REPORT_WIDTH));
			// The label lives in the indent so its spacing survives wrapping:
			// both labels are 10 characters (three spaces after "actual:")
			// and the quoted values line up under each other.
			if (finding.expected !== undefined) {
				lines.push(...wrapLines(`"${finding.expected}"`, " ".repeat(12) + "expected: ", " ".repeat(12), REPORT_WIDTH));
			}
			if (finding.actual !== undefined) {
				lines.push(...wrapLines(`"${finding.actual}"`, " ".repeat(12) + "actual:   ", " ".repeat(12), REPORT_WIDTH));
			}
		}
	}
	lines.push("");
	lines.push(MANUAL_SECTION_HEADER);
	const manualFindings = rows.flatMap((row) =>
		row.findings.filter((finding) => finding.fix === "manual").map((finding) => ({ platform: row.platform, finding })),
	);
	if (manualFindings.length === 0) {
		lines.push("  none");
	}
	for (const { platform, finding } of manualFindings) {
		const subject = finding.subject ? `${finding.subject}: ` : "";
		lines.push(...wrapLines(`${subject}${finding.message}`, `  ${platform.padEnd(platformWidth)}  `, " ".repeat(2 + platformWidth + 2), REPORT_WIDTH));
	}
	// Build one array and print once so the blank-line structure is explicit
	// and testable.
	console.log(lines.join("\n"));
}

// --- apply --------------------------------------------------------------------

// apply keeps no separate read logic: it reuses the audit reads and writes a
// field only when the audit comparison says it drifted, so a second apply
// with no data/hutson.yaml change is a no-op apart from refreshed snapshot
// timestamps.
function drifted(compare, ...args) {
	return !compare([], ...args);
}

async function applyGitHubProfile(canonical) {
	const notes = [];
	const user = JSON.parse(await gh(["api", "user"]));
	// Refuse to patch an account that is not the one data/hutson.yaml
	// describes, rather than syncing the wrong identity across the web.
	if (user.login !== canonical.logins.github) {
		notes.push(`authenticated GitHub account is "${user.login}", canonical profile is "${canonical.logins.github ?? "(empty)"}"; refusing to write`);
		return { ...makeResult("GitHub profile", false, notes), refused: true };
	}
	const writes = [];
	if (drifted(compareName, user.name, canonical.name)) {
		writes.push(["name", canonical.name]);
	}
	if (drifted(compareDescription, user.bio, canonical.description)) {
		writes.push(["bio", truncateBio(canonical.description, GITHUB_BIO_LIMIT)]);
	}
	if (drifted(compareLink, "website", user.blog, canonical.links.website)) {
		writes.push(["blog", canonical.links.website]);
	}
	const args = ["api", "user", "-X", "PATCH"];
	for (const [key, value] of writes) {
		args.push("-f", `${key}=${value}`);
	}
	if (writes.length > 0) {
		await gh(args);
		notes.push(`updated ${writes.map(([key]) => key).join(", ")}`);
	} else {
		notes.push("name, bio, website already aligned");
	}
	notes.push("avatar is a manual step (the API has no avatar upload)");
	await writeSnapshot("github", canonical, {
		name: canonical.name,
		bio: truncateBio(canonical.description, GITHUB_BIO_LIMIT),
		website: canonical.links.website,
	});
	return { platform: "GitHub profile", status: writes.length ? "UPDATED" : STATUS.ok, notes };
}

// One manual block per drifted, archived mirror: the settings URL plus the
// exact description, printed after the automated steps run.
function archivedRepositoryBlock(platform, repoPath, description) {
	const host = platform === "GitHub" ? "github.com" : CODEBERG_HOST;
	return {
		surface: `${platform} repository description (${repoPath})`,
		url: `https://${host}/${repoPath}/settings`,
		note: "The repository is archived, so its description cannot be saved until it is unarchived; unarchive it, apply the description, then re-archive it.",
		items: [{ field: "Description", value: description }],
	};
}

async function applyGitHubRepositories(canonical) {
	const notes = [];
	const manual = [];
	let updated = 0;
	for (const project of canonical.projects) {
		if (!project.github) {
			continue;
		}
		const repoPath = `${project.github.login}/${project.github.repo}`;
		let repo;
		try {
			repo = await ghRepoInfo(project.github);
		} catch (err) {
			if (!isNotFound(err)) {
				throw err;
			}
			console.error(`note: GitHub mirror ${repoPath} not found; skipping`);
			continue;
		}
		const expected = githubMirrorDescription(project);
		if (!drifted(compareRepoDescription, repo.description, expected)) {
			continue;
		}
		if (repo.archived) {
			// gh repo edit can never write an archived repository, and
			// unarchiving is an operator decision; skipping here also keeps
			// one frozen mirror from failing the surface and marking the
			// whole GitHub group identity-unverified.
			notes.push(`${project.github.repo}: archived; manual instructions printed`);
			manual.push(archivedRepositoryBlock("GitHub", repoPath, expected));
			continue;
		}
		try {
			await gh(["repo", "edit", repoPath, "--description", expected]);
			notes.push(`${project.github.repo}: description updated`);
			updated += 1;
		} catch (err) {
			if (!isArchivedError(err)) {
				throw err;
			}
			notes.push(`${project.github.repo}: archived; manual instructions printed`);
			manual.push(archivedRepositoryBlock("GitHub", repoPath, expected));
		}
	}
	if (updated === 0 && manual.length === 0) {
		notes.push("all repository descriptions already aligned");
	}
	const status = updated ? "UPDATED" : manual.length ? "MANUAL" : STATUS.ok;
	return { platform: "GitHub repositories", status, notes, manual };
}

// Clone into an OS temp directory, replace README.md, commit, and push with
// the operator's existing git credentials. Skipped entirely when the remote
// copy already matches the rendered document, so repeat runs push nothing.
// A not-found clone means the profile repository itself does not exist yet:
// apply cannot create it, so it prints a one-time manual step instead of
// erroring, and every later run is automated.
function profileReadmeManualRow(platform, login) {
	const createUrl = platform === "GitHub"
		? `https://github.com/new?name=${login}&owner=${login}`
		: `https://${CODEBERG_HOST}/repo/create`;
	return {
		platform: `${platform} profile README`,
		status: "MANUAL",
		notes: ["profile repository is missing; manual instructions printed"],
		manual: [
			{
				surface: `${platform} profile README repository (${login}/${login})`,
				url: createUrl,
				note: `Create an empty public repository named "${login}" under your own account, with no README, .gitignore, or license; then re-run apply and it will push the generated README.`,
				items: [{ field: "Repository name", value: login }],
			},
		],
	};
}

async function pushProfileReadme(platform, canonical, reader, { cloneUrl, label, requiredLogin }) {
	if (!requiredLogin) {
		const notes = [`${platform} profile README: contact.${platform.toLowerCase()} is empty in data/hutson.yaml; cannot push`];
		return makeResult(`${platform} profile README`, false, notes);
	}
	const rendered = renderProfileReadme(canonical);
	let actual = null;
	try {
		actual = await reader(canonical);
	} catch {
		console.error(`note: ${platform} profile README not readable yet; pushing a fresh copy`);
	}
	if (actual !== null && readmeMatches(actual, rendered)) {
		await writeSnapshot(label, canonical, { readme: rendered });
		return { platform: `${platform} profile README`, status: STATUS.ok, notes: ["README already aligned"] };
	}
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hyper-expanse-profile-readme-"));
	const repoDir = path.join(dir, "repo");
	try {
		await runCli("git", ["clone", "--depth", "1", cloneUrl, repoDir], { timeoutMs: GIT_TIMEOUT_MS });
		const readmePath = path.join(repoDir, "README.md");
		const exists = await fs.stat(readmePath).then(() => true, () => false);
		await fs.writeFile(readmePath, rendered);
		if (!exists) {
			await runCli("git", ["-C", repoDir, "add", "README.md"]);
		}
		await runCli("git", ["-C", repoDir, "commit", "-m", "Sync profile README from data/hutson.yaml"]);
		await runCli("git", ["-C", repoDir, "push"], { timeoutMs: GIT_TIMEOUT_MS });
		console.error(`note: pushed generated README to ${cloneUrl}`);
	} catch (err) {
		if (!isNotFound(err)) {
			throw err;
		}
		return profileReadmeManualRow(platform, requiredLogin);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
	await writeSnapshot(label, canonical, { readme: rendered });
	return { platform: `${platform} profile README`, status: "UPDATED", notes: ["pushed generated README"] };
}

async function applyCodebergProfile(canonical) {
	const notes = [];
	const identity = await codebergIdentity();
	if (identity !== canonical.logins.codeberg) {
		notes.push(`authenticated Codeberg account is "${identity ?? "(unknown)"}", canonical profile is "${canonical.logins.codeberg ?? "(empty)"}"; refusing to write`);
		return { ...makeResult("Codeberg profile", false, notes), refused: true };
	}
	const parsed = parseFjUserView(await fj(["user", "view", canonical.logins.codeberg]));
	if (drifted(compareDescription, stripMarkdown(parsed.bio), canonical.description)) {
		await fj(["user", "edit", "bio", truncateBio(canonical.description, CODEBERG_BIO_LIMIT)]);
		notes.push("updated bio");
	}
	if (drifted(compareLink, "website", parsed.website, canonical.links.website)) {
		await fj(["user", "edit", "website", canonical.links.website]);
		notes.push("updated website");
	}
	// The name is not readable back through fj, so write it unconditionally
	// (the edit is idempotent server-side) and record it in the snapshot.
	await fj(["user", "edit", "name", canonical.name]);
	notes.push("name written (not readable via fj; verified from snapshot)");
	notes.push("avatar is a manual step (fj has no user avatar command)");
	await writeSnapshot("codeberg", canonical, {
		name: canonical.name,
		bio: truncateBio(canonical.description, CODEBERG_BIO_LIMIT),
		website: canonical.links.website,
		avatar: `Upload ${canonical.avatar.path}`,
	});
	return { platform: "Codeberg profile", status: "UPDATED", notes };
}

async function applyCodebergRepositories(canonical) {
	const notes = [];
	const manual = [];
	let updated = 0;
	for (const project of canonical.projects) {
		const repoPath = new URL(project.repository).pathname.split("/").filter(Boolean).join("/");
		let output;
		try {
			output = await fj(["repo", "view", repoPath]);
		} catch (err) {
			if (!isNotFound(err)) {
				throw err;
			}
			console.error(`note: Codeberg repository ${repoPath} not found; skipping`);
			continue;
		}
		if (drifted(compareRepoDescription, parseFjBody(output), project.description)) {
			try {
				await fj(["repo", "edit", repoPath, "--description", project.description]);
				notes.push(`${repoPath}: description updated`);
				updated += 1;
			} catch (err) {
				// `fj repo view` shows no archived flag, so a frozen
				// repository surfaces only at write time; degrade to manual
				// instructions rather than failing the surface and marking
				// the whole Codeberg group identity-unverified.
				if (!isArchivedError(err)) {
					throw err;
				}
				notes.push(`${repoPath}: archived; manual instructions printed`);
				manual.push(archivedRepositoryBlock("Codeberg", repoPath, project.description));
			}
		}
	}
	if (updated === 0 && manual.length === 0) {
		notes.push("all repository descriptions already aligned");
	}
	const status = updated ? "UPDATED" : manual.length ? "MANUAL" : STATUS.ok;
	return { platform: "Codeberg repositories", status, notes, manual };
}

// npm restricts account changes to sessions with a one-time passcode, which
// a non-interactive tool cannot supply, so npm is a manual surface like
// Open Collective: apply prints the exact values (with the live profile's
// current values for comparison) and refreshes the snapshot.
function npmItems(canonical, profile) {
	const items = [
		{ field: "Display name", value: canonical.name },
		{ field: "GitHub handle", value: canonical.logins.github ?? "" },
		{ field: "Website", value: canonical.links.website ?? "" },
		{ field: "Avatar", value: `npm renders avatars from Gravatar; make sure the account email's Gravatar is ${canonical.avatar.path}` },
	];
	if (profile) {
		items.unshift({
			field: "(current values)",
			value: normalizeText(
				`fullname=${profile.fullname ?? "(empty)"} github=${profile.github ?? "(empty)"} homepage=${profile.homepage ?? "(empty)"}`,
			),
		});
	}
	return items;
}

async function runApply(canonical) {
	const rows = [];
	// Each entry carries a platform group: when a step refuses to write
	// because the authenticated account is not the canonical identity, or
	// fails before that check can run, the identity state is unknown, so the
	// remaining steps for that platform are skipped rather than attempted
	// with unverified credentials.
	const automated = [
		["GitHub profile", applyGitHubProfile, "GitHub"],
		["GitHub repositories", applyGitHubRepositories, "GitHub"],
		[
			"GitHub profile README",
			(canonical2) =>
				pushProfileReadme("GitHub", canonical2, readGithubReadme, {
					cloneUrl: `https://github.com/${canonical2.logins.github}/${canonical2.logins.github}.git`,
					label: "github-readme",
					requiredLogin: canonical2.logins.github,
				}),
			"GitHub",
		],
		["Codeberg profile", applyCodebergProfile, "Codeberg"],
		["Codeberg repositories", applyCodebergRepositories, "Codeberg"],
		[
			"Codeberg profile README",
			(canonical2) =>
				pushProfileReadme("Codeberg", canonical2, readCodebergReadme, {
					cloneUrl: `https://${CODEBERG_HOST}/${canonical2.logins.codeberg}/${canonical2.logins.codeberg}.git`,
					label: "codeberg-readme",
					requiredLogin: canonical2.logins.codeberg,
				}),
			"Codeberg",
		],
	];
	const unverifiedGroups = new Set();
	for (const [label, step, group] of automated) {
		if (unverifiedGroups.has(group)) {
			console.error(`skipped: ${label} (${group} identity unverified)`);
			rows.push(makeResult(label, false, [`skipped: ${group} identity unverified by an earlier step; fix the failure and re-run apply`]));
			continue;
		}
		try {
			const row = await step(canonical);
			if (row.refused) {
				unverifiedGroups.add(group);
			}
			rows.push(row);
		} catch (err) {
			console.error(`error: ${label}: ${err.message}`);
			rows.push(errorResult(label, err));
			// Fail closed: a step can throw before its identity check runs
			// (for example a transient gh/fj read failure right after
			// preflight passed), which leaves the authenticated account
			// unverified for this platform.
			unverifiedGroups.add(group);
		}
	}

	// Automated steps that discovered drift they cannot write (archived
	// mirrors, a missing profile repository) collect their instructions on
	// the row; print them here so all manual copy-paste content appears
	// after the writes, in one block per surface.
	for (const block of rows.flatMap((row) => row.manual ?? [])) {
		printManual(block);
	}

	// Manual surfaces still get real work: the exact expected values are
	// printed and snapshotted. What apply cannot do is verify the operator
	// made the edit, so audit treats these as snapshot-freshness checks.
	const account = await fetchOpenCollectiveProfile().catch(() => null);
	const npmProfile = await readNpmProfile().catch(() => null);
	const manualSections = [
		{ surface: "Open Collective", url: "https://opencollective.com/hutson/edit", items: openCollectiveItems(canonical, account), snapshot: "open-collective" },
		{
			surface: "npm",
			url: canonical.logins.npm ? `https://www.npmjs.com/settings/${canonical.logins.npm}/profile` : "https://www.npmjs.com/settings",
			items: npmItems(canonical, npmProfile),
			snapshot: "npm",
			note: "npm requires a one-time passcode for profile changes, so these fields are updated by hand.",
		},
		{ surface: "PyPI", url: "https://pypi.org/manage/account/", items: pypiItems(canonical), snapshot: "pypi" },
		{ surface: "LinkedIn", url: canonical.links.linkedin || DEFAULT_LINKEDIN_PROFILE_URL, items: linkedinBlocks(canonical), snapshot: "linkedin", note: "open each section's edit control on your profile" },
		{ surface: "GitHub Sponsors", url: canonical.links["github-sponsors"] ?? "https://github.com/sponsors/hutson/profile", items: sponsorsItems(canonical), snapshot: "github-sponsors" },
	];
	for (const section of manualSections) {
		printManual(section);
		await writeSnapshot(section.snapshot, canonical, Object.fromEntries(section.items.map((item) => [item.field, item.value])), section.items.map((item) => `${item.field}: ${excerpt(item.value, 80)}`));
		rows.push({ platform: section.surface, status: "MANUAL", notes: ["instructions printed above; verified against snapshot only"] });
	}
	printManual({
		surface: "Avatars (every host: GitHub, Codeberg, npm/Gravatar)",
		url: "see per-surface links below",
		items: avatarItems(canonical).map((entry) => ({ field: `${entry.surface} (${entry.url})`, value: entry.value })),
	});

	renderTable(rows);
	const failed = rows.some((r) => r.status === STATUS.error || r.status === STATUS.mismatch);
	process.exit(failed ? FAILURE_EXIT_CODE : SUCCESS_EXIT_CODE);
}

// --- command interface ---------------------------------------------------------

function usage() {
	return [
		"usage: node scripts/sync-profiles.js <audit|apply> [--source <path>]",
		"",
		"  audit  compare data/hutson.yaml against every surface and print a summary and per-platform findings",
		"  apply  update automated surfaces, print manual instructions, refresh snapshots",
		"",
		"  --source <path>  website checkout holding data/hutson.yaml",
		"                     (env: PROFILE_SYNC_SOURCE; default: current directory)",
	].join("\n");
}

function parseArgs(argv) {
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log(usage());
		process.exit(SUCCESS_EXIT_CODE);
	}
	const command = argv[0];
	if (command !== "audit" && command !== "apply") {
		console.error(`error: unknown command "${command ?? ""}"\n${usage()}`);
		process.exit(FAILURE_EXIT_CODE);
	}
	let sourceDir = process.env.PROFILE_SYNC_SOURCE || process.cwd();
	for (let index = 1; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--source") {
			const value = argv[index + 1];
			if (!value) {
				throw new Error("--source requires a path");
			}
			sourceDir = value;
			index += 1;
		} else if (arg.startsWith("--source=")) {
			sourceDir = arg.slice("--source=".length);
		} else {
			throw new Error(`unknown argument "${arg}"`);
		}
	}
	return { command, sourceDir: path.resolve(sourceDir) };
}

async function main() {
	const { command, sourceDir } = parseArgs(process.argv.slice(2));
	const canonical = await loadCanonical(sourceDir);
	if (!(await preflight())) {
		console.error("preflight: fix the failures above and re-run; no surface was contacted.");
		process.exit(FAILURE_EXIT_CODE);
	}
	if (command === "apply") {
		await runApply(canonical);
	} else {
		await runAudit(canonical);
	}
}

module.exports = {
	checkAvatar,
	compareDescription,
	compareLink,
	compareName,
	compareRepoDescription,
	diffExcerpts,
	excerpt,
	fetchJson,
	fetchWithTimeout,
	formatMonthYear,
	githubMirrorDescription,
	loadCanonical,
	makeResult,
	normalizeText,
	normalizeUrl,
	parseFjBody,
	parseFjUserView,
	parseOpenCollectiveProfile,
	parsePypiTitle,
	renderAudit,
	renderLinkedInExperience,
	renderProfileReadme,
	linkedinBlocks,
	stripHtml,
	stripMarkdown,
	truncateBio,
	usage,
	wrapLines,
};

if (require.main === module) {
	main().catch((err) => {
		console.error(err);
		process.exit(FAILURE_EXIT_CODE);
	});
}
