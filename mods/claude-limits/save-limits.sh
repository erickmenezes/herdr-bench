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
# Claude Code keeps its config in $CLAUDE_CONFIG_DIR/.claude.json, or ~/.claude.json without it.
if [ -n "$CLAUDE_CONFIG_DIR" ]; then cfg="$CLAUDE_CONFIG_DIR/.claude.json"; else cfg="$HOME/.claude.json"; fi
# claude_pro -> "Pro", claude_max + ..._max_5x -> "Max 5x", claude_team whose seat tier is
# ..._max_5x -> "Team Max 5x", else "Team"; nothing known -> "".
plan=$(jq -r '.oauthAccount // {}
  | (.organizationType // "" | sub("^claude_"; "")) as $t
  | (first((.userRateLimitTier // ""), (.organizationRateLimitTier // "") | capture("_(?<x>[0-9]+x)$").x) // "") as $x
  | (first((.userRateLimitTier // "") | capture("_(?<x>[0-9]+x)$").x) // "") as $seat
  | ($t[0:1] | ascii_upcase) + $t[1:] as $name
  | if $t == "" then ""
    elif $t == "team" then $name + (if $seat != "" then " Max " + $seat else "" end)
    elif $x != "" then $name + " " + $x
    else $name end' \
  "$cfg" 2>/dev/null)
mkdir -p "$dir"
tmp="$file.$$"
jq -cn --arg a "$account" --arg p "$plan" --argjson u "$now" --argjson l "$limits" \
  '{account: $a, plan: $p, updated: $u, rate_limits: $l}' > "$tmp" && mv "$tmp" "$file"
