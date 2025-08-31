#!/usr/bin/env bash

set -euf -o pipefail

trivy filesystem --scanners vuln,misconfig,secret,license --license-full ./
