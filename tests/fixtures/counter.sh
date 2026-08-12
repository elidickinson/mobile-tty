#!/bin/bash
# A stream where dropped bytes cannot hide: every line carries its own sequence
# number, so a gap in the numbers is a gap in the transport.
#
# The colour sequence is not decoration. Losing the tail of a read splits it,
# and the remainder prints as `55;95;255m` — the corruption this fixture exists
# to catch, in the form it actually appears on screen.
set -u

esc=$'\033'
i=0
while true; do
  printf '%s[38;2;155;95;255mS%09d%s[0m %s\r\n' "$esc" "$i" "$esc" '........................................'
  i=$((i + 1))
done
