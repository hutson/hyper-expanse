# hyper-expanse

This repository contains the source for the [hyper-expanse.net](https://hyper-expanse.net/) website, a static site built with [Hugo](https://gohugo.io/), with the resume page also published as a PDF using [WeasyPrint](https://weasyprint.org/).

## Development

To start a local development server with live reload, run:

```bash
hugo server
```

To build the site, run:

```bash
bash .tools/build.sh
```

To test your changes to ensure they meet the requirements of this project, run:

```bash
bash .tools/test.sh
```

To check whether external profile pages (GitHub, Codeberg, Open Collective,
npm, PyPI) still match the canonical profile in `data/hutson.yaml`, run:

```bash
npm run check:profiles
```

## Design Decisions

- The website is intended to be responsive across screen sizes and devices.
- All build, test, and tooling logic is kept inside the `.tools/` directory so that configuration and interactions are easy to reason about and remain in one place.
- The site uses raw CSS rather than a preprocessor (such as SCSS) or a CSS framework, and raw HTML and minimal Hugo templates rather than a JavaScript framework. This keeps the dependency surface small and the output easy to inspect.
- Node.js is used solely for offline quality checks: HTML validation (`html-validate`), CSS linting (`stylelint`), a lightweight `jsdom`-based accessibility audit, and a `jsdom`-based SEO/social-metadata audit (canonical URLs, Open Graph, JSON-LD, h-card microformats, robots.txt, sitemap, feeds). No heavy-weight browser-based or online tools should be used.

## Content Tagging

Projects, publications, employment, and education are authored in
`data/hutson.yaml`. Guides and articles are authored as content files under
`content/hutson/<section>/`. Projects, articles, and guides each carry a
`tag` field (front matter for guides and articles, the `projects:` list in
`data/hutson.yaml` for projects) that is either `personal` (the default,
when omitted) or `professional`. Content tagged `professional` is assembled
into `/hutson/resume/` and the generated `/hutson/resume.pdf`; content
tagged `personal` is excluded from the resume but still appears on its
source page. When authoring new content, opt in to the resume by setting
`tag: professional`.

Create new content with the project's archetypes so the front matter is
pre-filled:

```bash
hugo new content --kind guide hutson/guides/<slug>.md
hugo new content --kind article hutson/articles/<slug>.md
```

Leaf pages use a singular `type` (`guide`, `article`) so they resolve to
`layouts/<type>/single.html`; section `_index.md` files use the plural
(`guides`, `articles`) for their list layouts.

## Quarterly Maintenance

The offline audits in `.tools/` cover the static HTML, CSS, accessibility,
and structured-data contract on every build. The two Google tools below
validate the live site against Google's own parsers and cannot be reproduced
locally, so they run by hand. This is the only place online tools are used
for this project; everything else stays in `.tools/`.

Run this section on the first Monday of January, April, July, and October
against the deployed site at <https://hyper-expanse.net/>. Open an issue
(or add a follow-up under section 1 of `preperation.md`) for any regression,
fix it, and re-run the affected check before closing.

### PageSpeed Insights

Open <https://pagespeed.web.dev/> and analyze each of these URLs, switching
the form-factor toggle between **Desktop** and **Mobile**:

- `https://hyper-expanse.net/`
- `https://hyper-expanse.net/hutson/`
- `https://hyper-expanse.net/hutson/resume/`

For each run, record the four Lighthouse scores (Performance, Accessibility,
Best Practices, SEO) alongside the previous quarter's numbers, and copy the
Opportunities and Diagnostics lists into the tracking note so they can be
diffed across quarters. Treat any score that drops by more than five points,
or any new high-impact Opportunity on the resume or about pages, as a fix to
schedule. The reference desktop run for the home page is
<https://pagespeed.web.dev/analysis/https-hyper-expanse-net/ljrqfr8z2m?form_factor=desktop&hl=en>.

### Rich Results Test

Open each URL through the Rich Results Test
(<https://search.google.com/test/rich-results>) by entering the URL in the
form, and confirm the expected structured-data types are still detected
without new errors. The site emits JSON-LD from
`layouts/partials/head/seo.html`, so the expected block per page is:

- `https://hyper-expanse.net/` → `Person` (with the employer as a nested
  `worksFor` `Organization`).
- `https://hyper-expanse.net/hutson/` → `ProfilePage` wrapping `Person`.
- `https://hyper-expanse.net/hutson/resume/` → `Person`.
- `https://hyper-expanse.net/hutson/articles/<slug>/` → `Person` plus
  `BlogPosting` and `BreadcrumbList`.
- `https://hyper-expanse.net/hutson/guides/<slug>/` → `Person` plus
  `TechArticle` and `BreadcrumbList`.
- `https://hyper-expanse.net/hutson/projects/` → `Person` plus
  `CollectionPage` listing one `SoftwareSourceCode` per project.

The offline equivalent of this check lives in `.tools/audit-seo.js`, which
parses every `application/ld+json` block in `public/` and compares it against
`data/hutson.yaml`; run `npm run test:seo` locally whenever structured data
changes, then re-verify on the live URL here. Treat any rich result that
previously appeared and has since disappeared, or any new Google-emitted
warning or error against the JSON-LD, as a fix to schedule.
