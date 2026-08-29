#!/usr/bin/env bash

set -euf -o pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_name="$(basename "$(pwd)")"

echo "==================== TESTING ${project_name^^} ===================="
echo "Starting comprehensive code quality checks..."
echo

echo "==================== HADOLINT ======================="
echo "Running hadolint to lint Containerfile..."
hadolint .devcontainer/Containerfile
echo "✓ 'hadolint' passed"
echo

# Our website build must take place before we can validate HTML,
# Styles, and Accessibility.
bash "${script_dir}/build.sh"
echo

echo "==================== NPM INSTALL ==================="
echo "Installing Node.js test dependencies..."
npm ci --no-audit --no-fund --loglevel=error
echo

echo "==================== HTML-VALIDATE ================="
echo "Validating generated HTML..."
npm run test:html
echo "✓ 'html-validate' passed"
echo

echo "==================== STYLELINT ====================="
echo "Linting CSS..."
npm run test:css
echo "✓ 'stylelint' passed"
echo

echo "==================== ACCESSIBILITY ================="
echo "Auditing generated HTML for accessibility..."
npm run test:a11y
echo "✓ 'accessibility' passed"
echo

echo "==================== ALL CHECKS PASSED ============"
echo "✓ Code formatting, linting, and tests completed successfully"
