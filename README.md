# Files in Tabs

A [Herdr](https://herdr.dev) layout: Herdr's own window, except that clicking
a file in the Files panel opens it in its own tab. Code shows with syntax
colors and line numbers, and Markdown shows rendered. Clicking the same file
again goes back to its tab. Files and folders get colour icons (VS Code's
Material Icon Theme, through the bundled Better Icons mod). Above Agents, a
Limits panel shows how much of Claude's session (5-hour) and weekly limits
you've used, per account. And a note button at the end of the tab bar (or `cmd-shift-n`) opens a Scratchpad:
an empty tab for quick plain-text notes that stays until you close it.

![Files in Tabs](preview.png)

## Install

Give your agent this line:

```
Add the Herdr layout at github.com/erickmenezes/herdr-files-tabs
```

Or copy `layouts/Files-Tabs.json` and `layouts/Files-Tabs.svg` into
`~/.config/herdr-app/layouts/`, and the four folders in `mods/`
(`files-tabs`, `better-icons`, `claude-limits`, `scratchpad`) into
`~/.config/herdr-app/mods/`. If you already have Better Icons installed, keep
yours: other mods read it by the same path. Add the key in
`keys.json` (`cmd-shift-n`, a new scratchpad) to your own `keys.json`, unless
you already use that key. Then pick "Files-Tabs" in Settings → Look.
`ctrl-shift-l` switches back to your usual layout.

The Limits panel gets its numbers from Claude Code's status line, which is
the only place Claude Code shares them. Add this line to your status line
script, right after it reads its input into `$input`:

```sh
printf '%s' "$input" | bash ~/.config/herdr-app/mods/claude-limits/save-limits.sh
```

It needs `jq`. Each Claude config folder (`~/.claude`, or whatever
`CLAUDE_CONFIG_DIR` points to) gets its own row. Without a status line, the
panel says so and stays empty.

What it touches: the Files panel runs `sh` (to list folders) and `git status`
and reads the files you click. The Limits panel runs `sh` to read
`~/.cache/herdr-claude-limits/`, which `save-limits.sh` writes. None of them
reaches the network or reads your Claude login. Scratchpad notes are kept
in Herdr's own storage for that mod, not in files. Better Icons (about 5 MB of
icons) only reads its own folder.

## License

Apache-2.0. Based on the `main` layout and the Files mod that ship with
Herdr; the changes are listed in [RECIPE.md](RECIPE.md). Bundles
[Better Icons](https://github.com/munza/herdr-mods/tree/main/better-icons)
(Apache-2.0) and its Material Icon Theme icons (MIT); see [NOTICE](NOTICE).
