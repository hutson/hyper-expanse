#!/usr/bin/env bash

set -o errexit -o nounset -o noglob -o pipefail
readonly _trace_start_time_us=${EPOCHREALTIME//./}
PS4='[DEBUGLEVEL:${SHLVL} SUBSHELL:${BASH_SUBSHELL} LINE:${LINENO} DIFF:$(us=$(( ${EPOCHREALTIME//./} - _trace_start_time_us )); ms=$(( us / 1000 )); printf "%d.%03d" $((ms / 1000)) $((ms % 1000)) )s SOURCE:${BASH_SOURCE}] '

project_name="$(basename "$(pwd)")"

echo "==================== TESTING ${project_name^^} ===================="
echo "Starting comprehensive code quality checks..."
echo

echo "==================== HADOLINT ======================="
echo "Running hadolint to lint Containerfile..."
hadolint \
	.devcontainer/Containerfile
echo "✓ 'hadolint' passed"
echo

# Our website build must take place before we can validate HTML,
# Styles, and Accessibility.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

echo "==================== SEO ==========================="
echo "Auditing generated HTML for SEO and social metadata..."
npm run test:seo
echo "✓ 'seo' passed"
echo

echo "==================== ALL CHECKS PASSED ============"
