Leave `compiler_path` empty to find Typst automatically (including Homebrew on macOS).
If necessary, set it to the full path to the `typst` executable. Restart Anki after changing it.

`vim_enabled` enables real Neovim key handling in the source popup, with Anki's
normal appearance. Set it to `false` for a plain textarea.

Leave `nvim_path` empty to discover Neovim (including Homebrew). Set it to the
full executable path if needed.

Leave `vimrc_path` empty to load your standard Neovim config, including
`~/.config/nvim/init.vim` or `init.lua`. To override it, enter a full config file
path. Your config files are read, never modified. Reopen the popup after changes.
