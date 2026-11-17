# better-ui-claude-code-mod

A Claude Code mod that redraws the terminal interface: a side panel for your session, a cleaner transcript, and a matching theme.

Needs Claude Code 2.1.322 or later, in fullscreen mode (`/tui fullscreen`). The panel docks on the right when the terminal is at least 110 columns wide; otherwise it shows above the prompt. WSL runs its own Claude Code, so set fullscreen there too.

## Install

```
/plugin install better-ui --marketplace Yooouuuuuuu/better-ui-claude-code-mod
```

Then restart Claude Code, or pick **Better UI** in `/theme`.

## Use

- `alt+s` moves into the panel and `esc` leaves it. `1`–`5` or `a` / `d` switch tabs, `m` minimizes.
- `/better-ui` shows or minimizes the panel.
- The Control tab runs commands with a click: your pins, recent ones, and every command. It also holds the colors and preferences.

## Notes

- Designed for Fira Code. Every symbol it draws is also in Cascadia Mono.
- The main background comes from your terminal's color scheme, not the theme. If colors look wrong, try a preset in Control → colors.
- On WSL or other Linux terminals, colors look wrong unless full color is declared. Run `echo 'export COLORTERM=truecolor' >> ~/.bashrc` once, then open a new terminal.
- It turns off Claude Code's "← opens agents" setting. With it on, ← at an empty prompt moves the session to the background, where the panel loses the mouse. Control → preferences turns it back on; to do it by hand, run `/config leftArrowOpensAgents=false`.
- If the mouse stops working in the panel, the session is attached to a background copy: run `/stop`, open a new terminal, then `claude --resume`.
- It writes `~/.claude/themes/better-ui.json` (and `better-ui-mine.json` if you save your own colors). In `~/.claude/keybindings.json` it adds `alt+s` and the arrow keys for plugin panes. Turn both off in Control → preferences before uninstalling, or they stay behind.
