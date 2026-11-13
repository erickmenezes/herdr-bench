#!/usr/bin/env bash
# Saves Claude Code's rate limits for Herdr's Limits panel. Pipe the status line's
# JSON into it: echo "$input" | bash ~/.config/herdr-app/mods/claude-limits/save-limits.sh
# One file per Claude config folder (~/.claude -> claude.json), rewritten when the numbers
# change or at most once a minute, so its "updated" says when a session last saw them.
# The plan (Pro, Max 5x, Team...) comes from that folder's .claude.json.
dir="$HOME/.cache/herdr-claude-limits"
config="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
account=$(basename "$config")
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
cfg="$config/.claude.json"
[ -f "$cfg" ] || cfg="$HOME/.claude.json"
# claude_max + ..._max_5x -> "Max 5x", claude_pro -> "Pro", nothing known -> "".
plan=$(jq -r '.oauthAccount // {}
  | (.organizationType // "" | sub("^claude_"; "")) as $t
  | (first((.organizationRateLimitTier // "") | capture("_(?<x>[0-9]+x)$").x) // "") as $x
  | if $t == "" then "" else ($t[0:1] | ascii_upcase) + $t[1:] + (if $x != "" then " " + $x else "" end) end' \
  "$cfg" 2>/dev/null)
mkdir -p "$dir"
tmp="$file.$$"
jq -cn --arg a "$account" --arg p "$plan" --argjson u "$now" --argjson l "$limits" \
  '{account: $a, plan: $p, updated: $u, rate_limits: $l}' > "$tmp" && mv "$tmp" "$file"
