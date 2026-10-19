# hyper-expanse

This repository contains the source for the [hyper-expanse.net](https://hyper-expanse.net/) website, a static site built with [Hugo](https://gohugo.io/), with the resume page also published as a PDF using [WeasyPrint](https://weasyprint.org/).

## Content Tagging

Author projects, publications, employment, and education in `data/hutson.yaml`, and guides and articles under `content/hutson/<section>/`.

Tag every project, article, and guide `personal` (default) or `professional`, using the `projects:` list in `data/hutson.yaml` for projects and front matter for guides and articles. `professional` items are assembled into `/hutson/resume/` and `/hutson/resume.pdf`; `personal` items appear only on their source page. Projects must also carry `status: active` to appear on the resume; `past` projects appear only on `/hutson/projects/`. Set `tag: professional` to opt a new item into the resume.

Create content with the archetypes so front matter is pre-filled:

```bash
hugo new content --kind guide hutson/guides/<slug>.md
hugo new content --kind article hutson/articles/<slug>.md
```

Use singular `type` (`guide`, `article`) for leaf pages so they resolve to `layouts/<type>/single.html`, and plural (`guides`, `articles`) for section `_index.md` list layouts.

## Running Locally

To start a local development server with live reload, run:

```bash
hugo server
```

## Design Decisions

- One entry point to invoke all tests, quality checks, and security scans; with a requirement that tools be self-contained binaries, with sane defaults, and run offline and deterministically.
- The website is intended to be responsive across screen sizes and devices.
- The site uses raw CSS rather than a preprocessor (such as SCSS) or a CSS framework, and raw HTML and minimal Hugo templates rather than a JavaScript framework. This keeps the dependency surface small and the output easy to inspect.

## Development

Validate changes with this project's single test entry point, `.tools/test.sh`. It runs the static analysis and dynamic tests a change needs, entirely offline and is non-destructive and repeatable. No other commands are necessary to validate a change.

Run it from the repository root, inside the Dev Container:

```bash
bash .tools/test.sh
```

If you are not inside a Dev Container, run it inside one via Devsy:

```bash
devsy ci . -- bash .tools/test.sh
```
