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
- Node.js is used solely for offline quality checks: HTML validation (`html-validate`), CSS linting (`stylelint`), and a lightweight `jsdom`-based accessibility audit. No heavy-weight browser-based or online tools should be used.

## Content Tagging

Projects, publications, employment, and education are authored in
`data/hutson.yaml`. Guides and articles are authored as content files under
`content/hutson/<section>/`. Projects, articles, and guides each carry a
`tag` field — front matter for guides and articles, the `projects:` list in
`data/hutson.yaml` for projects — that is either `personal` (the default,
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
