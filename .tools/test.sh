#!/usr/bin/env bash

set -o errexit -o nounset -o noglob -o pipefail
readonly _trace_start_time_us=${EPOCHREALTIME//./}
PS4='[DEBUGLEVEL:${SHLVL} SUBSHELL:${BASH_SUBSHELL} LINE:${LINENO} DIFF:$(us=$(( ${EPOCHREALTIME//./} - _trace_start_time_us )); ms=$(( us / 1000 )); printf "%d.%03d" $((ms / 1000)) $((ms % 1000)) )s SOURCE:${BASH_SOURCE}] '

project_name="$(basename "$(pwd)")"

echo "==================== TESTING ${project_name^^} ====================="
echo "Starting comprehensive code quality checks..."
echo

echo "==================== HADOLINT ======================="
echo "Running hadolint to lint Containerfile..."
hadolint \
	.devcontainer/Containerfile
echo "✓ 'hadolint' passed"
echo

echo "==================== SHELL FORMAT CHECK ==============="
echo "Checking if shell files are properly formatted..."
unformatted_files=$(find . -path ./.git -prune -o -type f -exec sh -c 'file "$1" | grep -q "shell script" && shfmt -d "$1"' _ {} \; 2>&1 | grep -v "No such file or directory" || true)
if [ -n "$unformatted_files" ]; then
	echo "✗ Some files were not properly formatted:"
	echo "$unformatted_files"
	echo "Files need to be formatted with 'shfmt -w'"
	exit 1
fi
echo "✓ All shell files are properly formatted"
echo

echo "==================== SHELLCHECK ======================"
echo "Running shellcheck for static analysis..."
shellcheck_errors=$(find . -path ./.git -prune -o -type f -exec sh -c 'file "$1" | grep -q "shell script" && shellcheck -x "$1"' _ {} \; 2>&1 || true)
if [ -n "$shellcheck_errors" ]; then
	echo "✗ 'shellcheck' reported issues:"
	echo "$shellcheck_errors"
	exit 1
fi
echo "✓ 'shellcheck' passed"
echo

echo "==================== SECRET SCANNING ==================="
echo "Running gitleaks to scan the working tree for leaked secrets..."
gitleaks dir . --no-banner
echo "✓ 'gitleaks' passed"
echo

# Our website build must take place before we can validate HTML,
# Styles, and Accessibility.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "${script_dir}/build.sh"
echo

echo "==================== NPM INSTALL ==================="
echo "Installing Node.js test dependencies from the container's primed npm cache..."
npm ci --offline --no-audit --no-fund --loglevel=error
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

# Delete `node_modules/` directory as it causes `devsy` to fail with an error about too many files.
rm -rf "node_modules/"
echo

echo "==================== ALL CHECKS PASSED ==============="
