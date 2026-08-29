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
- All build, test, and tooling logic is kept inside the `.tools/` directory so that configuration and interactions are easy to reason about and remain in one place.
- The site uses raw CSS rather than a preprocessor (such as SCSS) or a CSS framework, and raw HTML and minimal Hugo templates rather than a JavaScript framework. This keeps the dependency surface small and the output easy to inspect.
- Node.js is used solely for offline quality checks: HTML validation (`html-validate`), CSS linting (`stylelint`), and a lightweight `jsdom`-based accessibility audit. No heavy-weight browser-based or online tools should be used.
