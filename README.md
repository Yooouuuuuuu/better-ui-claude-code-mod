# better-ui-claude-code-mod

A Claude Code mod that redraws the terminal interface: a side panel for your session, a cleaner transcript, and a matching theme.

Needs Claude Code 2.1.322 or later, in fullscreen mode (`/tui fullscreen`).

## Install

```
/plugin install better-ui --marketplace Yooouuuuuuu/better-ui-claude-code-mod
```

Then restart Claude Code, or pick **Better UI** in `/theme`.

## Use

- `alt+s` moves into the panel and `esc` leaves it. `1`–`6` or `a` / `d` switch tabs, `m` minimizes.
- `/better-ui` shows or minimizes the panel.

## Notes

- Designed for Fira Code. Every symbol it draws is also in Cascadia Mono.
- The main background comes from your terminal's color scheme, not the theme.
- It writes `~/.claude/themes/better-ui.json` and adds `alt+s` to `~/.claude/keybindings.json`. Turn the key off in Settings before uninstalling.
