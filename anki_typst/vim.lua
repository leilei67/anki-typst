-- Neovim handles keys and mappings; Anki keeps its native textarea presentation.
local revision = 0

local function snapshot(id)
  local position = vim.api.nvim_win_get_cursor(0)
  local visual = vim.fn.getpos('v')
  vim.rpcnotify(1, 'anki-typst-state', {
    id = id,
    source = table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), '\n'),
    cursor = position,
    visual = { visual[2], math.max(0, visual[3] - 1) },
    mode = vim.fn.mode(1),
    command = vim.fn.getcmdline(),
  })
end

-- Buffer-local pairing leaves the user's configuration files untouched.
vim.keymap.set('i', '$', function()
  local col = vim.api.nvim_win_get_cursor(0)[2]
  local line = vim.api.nvim_get_current_line()
  local backslashes = #(line:sub(1, col):match('\\*$') or '')
  if backslashes % 2 == 1 then return '$' end
  if line:sub(col + 1, col + 1) == '$' then return '<Right>' end
  return '$$<Left>'
end, { buffer = true, expr = true, replace_keycodes = true })
vim.keymap.set('i', '<BS>', function()
  local col = vim.api.nvim_win_get_cursor(0)[2]
  if vim.api.nvim_get_current_line():sub(col, col + 1) == '$$' then return '<BS><Del>' end
  return '<BS>'
end, { buffer = true, expr = true, replace_keycodes = true })

_G.anki_typst_request = function(request)
  local ok, error = pcall(function()
    if request.source then
      vim.api.nvim_buf_set_lines(0, 0, -1, false, vim.split(request.source, '\n', { plain = true }))
      vim.api.nvim_win_set_cursor(0, request.cursor or { 1, 0 })
      vim.cmd('startinsert')
    end
    if request.paste then vim.api.nvim_paste(request.paste, true, -1) end
    if request.cursor then vim.api.nvim_win_set_cursor(0, request.cursor) end
    revision = revision + 1
    local current = revision
    vim.defer_fn(function() snapshot(request.id) end, 10)
    -- An insert mapping may wait for another key (e.g. the user's `jk`). Publish
    -- the final state when timeoutlen expires, even if no further key is typed.
    vim.defer_fn(function()
      if revision == current then snapshot(0) end
    end, vim.o.timeoutlen + 30)
  end)
  if not ok then vim.rpcnotify(1, 'anki-typst-state', { id = request.id, error = tostring(error) }) end
end
