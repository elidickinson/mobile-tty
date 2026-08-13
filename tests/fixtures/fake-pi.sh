#!/bin/bash
# pi's *shape* without pi: bordered input box pinned to the bottom, a cwd line,
# a status line, and scrolling output above. Deterministic, free, and offline,
# so the e2e suite can assert on layout without spending tokens.
set -u

esc=$'\033'
buf=''
size=''
history=('fake-pi ready — type and press enter')

draw() {
  local rows cols box_top i avail start
  read -r rows cols <<< "$size"
  box_top=$((rows - 3))

  printf '%s[H%s[2J' "$esc" "$esc"

  # Output area: the tail of history that fits above the box.
  avail=$((box_top - 1))
  start=$(( ${#history[@]} > avail ? ${#history[@]} - avail : 0 ))
  for ((i = start; i < ${#history[@]}; i++)); do
    printf '%s\r\n' "${history[i]}"
  done

  # Input box, bottom-anchored, with a status line under it.
  printf '%s[%d;1H' "$esc" "$box_top"
  printf '┌'; for ((i = 0; i < cols - 2; i++)); do printf '─'; done; printf '┐\r\n'
  printf '│ %s[36m>%s[0m %-*s│\r\n' "$esc" "$esc" "$((cols - 5))" "$buf"
  printf '└'; for ((i = 0; i < cols - 2; i++)); do printf '─'; done; printf '┘\r\n'
  printf '%s[2m %s  %sx%s%s[0m' "$esc" "${PWD/#$HOME/\~}" "$cols" "$rows" "$esc"

  # Park the cursor inside the box.
  printf '%s[%d;%dH' "$esc" "$((box_top + 1))" "$((${#buf} + 5))"
}

# bash defers a WINCH trap until the blocking `read` returns, so the trap never
# fires while waiting for input. Polling the size is boring and it works.
size=$(stty size)
in_esc=0       # 0 none, 1 after ESC, 2 inside a CSI/SS3 sequence
ttyd=$PPID

# The status strip, once: what the mtty-footer pi extension writes on the real
# program, so the e2e suite can see the strip without pi.
if [[ -n "${MTTY_FOOTER:-}" ]]; then
  printf '{"ts":%s,"text":"fake-pi stats"}\n' "$(date +%s)" > "$MTTY_FOOTER.tmp"
  mv "$MTTY_FOOTER.tmp" "$MTTY_FOOTER"
fi

draw
# macOS ships bash 3.2, so the poll timeout has to be a whole number of seconds.
while true; do
  if IFS= read -rsn1 -t 1 ch; then
    # Escape sequences vary in length — \e[A is three bytes, \e[1;5C is six — so
    # swallow up to the final byte instead of counting a fixed number.
    if (( in_esc == 1 )); then
      case "$ch" in
        '['|O) in_esc=2 ;;
        *) in_esc=0 ;;
      esac
      continue
    fi
    if (( in_esc == 2 )); then
      case "$ch" in [A-Za-z@~]) in_esc=0 ;; esac
      continue
    fi
    # `read` strips the line delimiter, so Enter arrives as an empty string.
    case "${ch:-$'\n'}" in
      $'\r'|$'\n')
        [[ "$buf" == '/quit' ]] && break
        if [[ "$buf" == '/lines' ]]; then
          # Scroll real lines off the top so the client accrues scrollback. The
          # redraw below clears the screen but not the scrollback (no \e[3J),
          # so these survive above the fold.
          for ((i = 0; i < 80; i++)); do printf 'scrollback line %d\r\n' "$i"; done
          buf=''
        else
          history+=("> $buf" "ok: ${#buf} chars")
          buf=''
        fi
        ;;
      $'\177') buf="${buf%?}" ;;
      $'\033') in_esc=1 ;;                                # start of an escape sequence
      *) buf+="$ch" ;;
    esac
    draw
  else
    # bash 3.2 returns 1 for both a read timeout and EOF, so there is nothing to
    # branch on there. Watching the parent instead also stops this outliving a
    # SIGKILLed ttyd.
    kill -0 "$ttyd" 2>/dev/null || break
    current=$(stty size)
    if [[ "$current" != "$size" ]]; then
      size=$current
      draw
    fi
  fi
done

printf '%s[2J%s[H' "$esc" "$esc"
