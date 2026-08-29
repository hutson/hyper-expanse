#!/usr/bin/env bash

set -euf -o pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_name="$(basename "$(cd "${script_dir}/.." && pwd)")"

echo "==================== BUILDING ${project_name^^} ==="
echo "Starting site build..."
echo

echo "==================== HUGO ======================="
echo "Running hugo to build the site..."
hugo --minify --gc --cleanDestinationDir --logLevel info
echo "✓ 'hugo' passed"
echo

echo "==================== WEASYPRINT ================="
echo "Running WeasyPrint to generate the resume PDF..."

python3 - <<'PY'
from pathlib import Path
from weasyprint import HTML

public_dir = Path("public")
html_path = public_dir / "hutson" / "resume" / "index.html"
pdf_path = public_dir / "hutson" / "resume.pdf"

if not html_path.exists():
	raise SystemExit(f"error: {html_path} not found; run 'hugo' first")

pdf_path.parent.mkdir(parents=True, exist_ok=True)
HTML(filename=str(html_path)).write_pdf(str(pdf_path))
print(f"wrote {pdf_path}")
PY

echo "✓ 'weasyprint' passed"
echo

echo "✓ All builds complete!"
