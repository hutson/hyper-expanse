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

## Design Decisions

- The website is intended to be responsive across screen sizes and devices.
- The site uses raw CSS rather than a preprocessor (such as SCSS) or a CSS framework, and raw HTML and minimal Hugo templates rather than a JavaScript framework. This keeps the dependency surface small and the output easy to inspect.
- Node.js is used solely for offline quality checks: HTML validation (`html-validate`), CSS linting (`stylelint`), a lightweight `jsdom`-based accessibility audit, and a `jsdom`-based SEO/social-metadata audit (canonical URLs, Open Graph, JSON-LD, h-card microformats, robots.txt, sitemap, feeds). No heavy-weight browser-based or online tools should be used.

## Content Tagging

Author projects, publications, employment, and education in `data/hutson.yaml`, and guides and articles under `content/hutson/<section>/`.

Tag every project, article, and guide `personal` (default) or `professional`, using the `projects:` list in `data/hutson.yaml` for projects and front matter for guides and articles. `professional` items are assembled into `/hutson/resume/` and `/hutson/resume.pdf`; `personal` items appear only on their source page. Set `tag: professional` to opt a new item into the resume.

Create content with the archetypes so front matter is pre-filled:

```bash
hugo new content --kind guide hutson/guides/<slug>.md
hugo new content --kind article hutson/articles/<slug>.md
```

Use singular `type` (`guide`, `article`) for leaf pages so they resolve to `layouts/<type>/single.html`, and plural (`guides`, `articles`) for section `_index.md` list layouts.

## Quarterly Maintenance

- Schedule: the first Monday of January, April, July, and October, against the deployed site at <https://hyper-expanse.net/>.
- Run both checks below by hand; they need Google's live parsers and cannot run locally (the `.tools/` audits cover the offline contract on every build).
- For each regression: open an issue, fix it, re-run the affected check before closing.

### PageSpeed Insights

Analyze each URL at <https://pagespeed.web.dev/>, switching the form-factor toggle between **Desktop** and **Mobile**:

- `https://hyper-expanse.net/`
- `https://hyper-expanse.net/hutson/`
- `https://hyper-expanse.net/hutson/resume/`

Record the four Lighthouse scores (Performance, Accessibility, Best Practices, SEO) against the previous quarter, and copy the Opportunities and Diagnostics lists into the tracking note. Schedule a fix for any score drop over five points, or any new high-impact Opportunity on the resume or about pages. Reference desktop run for the home page: <https://pagespeed.web.dev/analysis/https-hyper-expanse-net/ljrqfr8z2m?form_factor=desktop&hl=en>.

### Rich Results Test

Submit each URL at <https://search.google.com/test/rich-results> and confirm the expected structured-data types are detected without new errors. `layouts/partials/head/seo.html` emits the JSON-LD:

- `https://hyper-expanse.net/` → `Person` (nested `worksFor` `Organization`).
- `https://hyper-expanse.net/hutson/` → `ProfilePage` wrapping `Person`.
- `https://hyper-expanse.net/hutson/resume/` → `Person`.
- `https://hyper-expanse.net/hutson/articles/<slug>/` → `Person`, `BlogPosting`, `BreadcrumbList`.
- `https://hyper-expanse.net/hutson/guides/<slug>/` → `Person`, `TechArticle`, `BreadcrumbList`.
- `https://hyper-expanse.net/hutson/projects/` → `Person`, `CollectionPage` with one `SoftwareSourceCode` per project.

Run `npm run test:seo` (`.tools/audit-seo.js`) whenever structured data changes, then re-verify here. Schedule a fix for any rich result that disappears, or any new Google warning or error against the JSON-LD.
