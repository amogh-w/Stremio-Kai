--[[
  @name Remote Control (Phone Remote supervisor)
  @description Spawns and supervises portable_config/remote/server.py - the LAN
               HTTP hub that lets a phone browser control Stremio Kai.
  @version 1.0.0
  @author allecsc / Stremio Kai

  @changelog
    v1.0.0 - Initial: spawn/supervise/kill server.py, config push from Settings UI,
             input-ipc-server sanity check + runtime fallback.

  Architecture:
    - server.py talks to mpv over the named pipe from mpv.conf (input-ipc-server).
    - The webmod (window.KaiRemote) pushes {enabled,port,host,token,pipe_name} here
      via the `remote-control-config` script-message whenever Settings change.
    - This script owns the Python process lifecycle only. It never opens a socket
      and never writes config files.

  @requires
    - portable_config/remote/server.py
    - script-opts/remote_control.conf (fallback defaults)
    - mpv.conf: input-ipc-server=\\.\pipe\kai-mpv
--]]

local mp = require 'mp'
local msg = require 'mp.msg'
local options = require 'mp.options'
local utils = require 'mp.utils'

--============================================================================--
--                              CONFIG                                         --
--============================================================================--

local opts = {
    enabled     = false,
    host        = "0.0.0.0",
    port        = 5000,
    pipe_name   = "kai-mpv",
    token       = "",
    python_path = "",  -- override if auto-detection fails (see LOG.txt)
}
options.read_options(opts, "remote_control")

--============================================================================--
--                           PATH RESOLUTION                                   --
--============================================================================--

-- scripts/remote-control/main.lua -> walk up 3 dirs (remote-control, scripts,
-- portable_config) to the Stremio Kai root, where python.exe lives. Mirrors
-- scripts/notify_skip/main.lua.
local script_dir = debug.getinfo(1, 'S').source:match('@(.*[/\\])') or './'
local norm_dir = script_dir:gsub("\\", "/")
local stremio_root = norm_dir:match("(.+/)[^/]+/[^/]+/[^/]+/$") or norm_dir

local function file_exists(path)
    local info = utils.file_info(path)
    return info ~= nil and info.is_file
end

-- python.exe location. The portable_config folder is often a junction/symlink,
-- so debug.getinfo may resolve to the repo path rather than the install root.
-- Try several bases; the install's working dir is usually the best bet.
local function resolve_python()
    if opts.python_path ~= "" and file_exists(opts.python_path) then
        return opts.python_path
    end
    local cwd = utils.getcwd() or "."
    local candidates = {
        stremio_root .. "python.exe",
        cwd .. "/python.exe",
        cwd .. "/../python.exe",
        norm_dir .. "../../../python.exe",
        norm_dir .. "../../../../python.exe",
    }
    for _, c in ipairs(candidates) do
        if file_exists(c) then
            msg.info("python.exe found: " .. c)
            return c
        end
    end
    msg.warn("python.exe not auto-detected; tried: " .. table.concat(candidates, " | "))
    return candidates[1]
end

local PYTHON_EXE = resolve_python()
-- server.py sits at portable_config/remote/ - derive it from this script's own
-- dir (scripts/remote-control/) so it's correct even through a junction.
local SERVER_PY = norm_dir .. "../../remote/server.py"
if not file_exists(SERVER_PY) then
    SERVER_PY = stremio_root .. "portable_config/remote/server.py"
end
local PIDFILE    = mp.command_native({ "expand-path", "~~/cache/remote-control.pid" })
local LOCKFILE   = mp.command_native({ "expand-path", "~~/cache/remote-control.lock" })

--============================================================================--
--                         IPC SERVER SANITY CHECK                             --
--============================================================================--

-- The server talks to mpv over input-ipc-server (set in mpv.conf). If the C++
-- shell already provided its own pipe we adopt that name rather than fighting it;
-- we only set the property ourselves when nothing is configured.
local function ensure_ipc_server()
    local want = "\\\\.\\pipe\\" .. opts.pipe_name
    local have = mp.get_property("input-ipc-server", "")
    if have == nil or have == "" then
        msg.warn("input-ipc-server is empty, setting " .. want)
        mp.set_property("input-ipc-server", want)
    elseif have ~= want then
        -- Adopt whatever mpv is already listening on.
        local name = have:gsub("^\\\\%.\\pipe\\", ""):gsub("^/.*/", "")
        msg.info(string.format("input-ipc-server already set to %q - adopting pipe %q", have, name))
        opts.pipe_name = name
    else
        msg.info("input-ipc-server OK: " .. have)
    end
end

--============================================================================--
--                        PROCESS SUPERVISION                                  --
--============================================================================--

local proc = {
    handle = nil,       -- abort handle from command_native_async
    running = false,
    shutting_down = false,
    restarts = {},      -- timestamps of recent restarts
    debounce = nil,
}

local function kill_by_pidfile()
    local fh = io.open(PIDFILE, "r")
    if not fh then return end
    local pid = fh:read("*n")
    fh:close()
    if pid and pid > 0 then
        msg.info("taskkill stale pid " .. pid)
        mp.command_native_async({
            name = "subprocess", playback_only = false, capture_stdout = true,
            args = { "taskkill", "/F", "/T", "/PID", tostring(pid) },
        }, function() end)
    end
    os.remove(PIDFILE)
end

local function too_many_restarts()
    local now = os.time()
    local recent = {}
    for _, t in ipairs(proc.restarts) do
        if now - t < 60 then recent[#recent + 1] = t end
    end
    proc.restarts = recent
    return #recent >= 5
end

local function stop_server()
    proc.shutting_down = true
    if proc.handle then
        mp.abort_async_command(proc.handle)
        proc.handle = nil
    end
    kill_by_pidfile()
    proc.running = false
end

local start_server  -- fwd decl

local function on_exit(success, result, err)
    proc.running = false
    proc.handle = nil
    if proc.shutting_down then
        msg.info("server stopped")
        return
    end

    local status = (result and result.status) or -1
    local stderr = (result and result.stderr) or ""
    msg.warn(string.format("server.py exited (status=%s) %s", tostring(status), stderr:gsub("%s+$", "")))

    if stderr:find("FATAL bind") or status == 2 then
        msg.error("Remote server could not bind the port - not retrying. Change the port in Settings.")
        return
    end

    if not opts.enabled then return end
    if too_many_restarts() then
        msg.error("Remote server crashed 5x in 60s - giving up until re-enabled.")
        return
    end

    proc.restarts[#proc.restarts + 1] = os.time()
    mp.add_timeout(3.0, function()
        if opts.enabled and not proc.running then start_server() end
    end)
end

start_server = function()
    if proc.running then
        msg.info("server already running")
        return
    end
    if not file_exists(SERVER_PY) then
        msg.error("server.py not found at " .. SERVER_PY)
        return
    end
    if not file_exists(PYTHON_EXE) then
        msg.error("python.exe not found at " .. PYTHON_EXE .. " - remote disabled")
        return
    end

    kill_by_pidfile()  -- clear any orphan from a hard crash
    proc.shutting_down = false

    local args = {
        PYTHON_EXE, SERVER_PY,
        "--host", opts.host,
        "--port", tostring(opts.port),
        "--pipe", opts.pipe_name,
        "--token", opts.token or "",
        "--pidfile", PIDFILE,
        -- libmpv runs in-process, so this is the Stremio Kai window's process id;
        -- server.py uses it to foreground the window before phone key commands.
        "--host-pid", tostring(utils.getpid()),
    }
    msg.info(string.format("starting remote server: %s:%s  (python=%s)", opts.host, tostring(opts.port), PYTHON_EXE))

    proc.running = true
    proc.handle = mp.command_native_async({
        name = "subprocess",
        playback_only = false,
        capture_stdout = true,
        capture_stderr = true,
        args = args,
    }, on_exit)
end

local function apply_state()
    if opts.enabled then
        ensure_ipc_server()
        if not proc.running then start_server() end
    else
        if proc.running then
            msg.info("remote disabled - stopping server")
            stop_server()
        end
    end
end

--============================================================================--
--                       SETTINGS-UI CONFIG PUSH                               --
--============================================================================--

-- {enabled, port, host, token, pipe_name} from webmods/Settings/mpv-settings.js
mp.register_script_message("remote-control-config", function(json)
    local data = utils.parse_json(json)
    if not data then return end

    local changed = false
    local function set(key, val)
        if val ~= nil and opts[key] ~= val then opts[key] = val; changed = true end
    end
    if data.enabled ~= nil then set("enabled", data.enabled and true or false) end
    if data.port then set("port", math.floor(tonumber(data.port) or opts.port)) end
    if data.host then set("host", tostring(data.host)) end
    if data.token ~= nil then set("token", tostring(data.token)) end
    if data.pipe_name then set("pipe_name", tostring(data.pipe_name)) end

    if not changed then return end
    msg.info(string.format("config update: enabled=%s port=%s host=%s token=%s",
        tostring(opts.enabled), tostring(opts.port), opts.host, opts.token ~= "" and "set" or "none"))

    -- Debounce rapid toggles; a port/token change needs a full restart.
    if proc.debounce then proc.debounce:kill() end
    proc.debounce = mp.add_timeout(0.4, function()
        proc.debounce = nil
        if proc.running then stop_server() end
        mp.add_timeout(0.3, apply_state)
    end)
end)

mp.register_script_message("remote-control-restart", function()
    msg.info("manual restart requested")
    if proc.running then stop_server() end
    mp.add_timeout(0.3, apply_state)
end)

--============================================================================--
--                              LIFECYCLE                                      --
--============================================================================--

mp.register_event("shutdown", function()
    stop_server()
end)

-- Give the shell a moment to finish wiring mpv, then honour the .conf default.
mp.add_timeout(1.0, apply_state)

msg.info("Remote Control supervisor loaded (server=" .. SERVER_PY .. ")")
