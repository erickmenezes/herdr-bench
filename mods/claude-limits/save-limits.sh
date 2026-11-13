#!/usr/bin/env bash
# Saves Claude Code's rate limits for Herdr's Limits panel. Pipe the status line's
# JSON into it: echo "$input" | bash ~/.config/herdr-app/mods/claude-limits/save-limits.sh
# One file per Claude config folder (~/.claude -> claude.json), rewritten when the numbers
# change or at most once a minute, so its "updated" says when a session last saw them.
dir="$HOME/.cache/herdr-claude-limits"
account=$(basename "${CLAUDE_CONFIG_DIR:-$HOME/.claude}")
account=${account#.}
limits=$(jq -c '.rate_limits // empty' 2>/dev/null)
[ -z "$limits" ] && exit 0
file="$dir/$account.json"
now=$(date +%s)
if [ -f "$file" ]; then
  same=$(jq -r --argjson l "$limits" --argjson now "$now" \
    'if .rate_limits == $l and ($now - (.updated // 0)) < 60 then "yes" else "no" end' "$file" 2>/dev/null)
  [ "$same" = "yes" ] && exit 0
fi
mkdir -p "$dir"
tmp="$file.$$"
jq -cn --arg a "$account" --argjson u "$now" --argjson l "$limits" \
  '{account: $a, updated: $u, rate_limits: $l}' > "$tmp" && mv "$tmp" "$file"
