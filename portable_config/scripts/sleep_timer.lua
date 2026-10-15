--[[
Sleep Timer
===========
Puts the PC to sleep after a chosen delay, or after the current file reaches
its real end - a YouTube-style "sleep timer" for falling asleep to something
playing. Driven entirely by the Phone Remote (remote/webapp/index.html's
Sleep Timer buttons -> server.py's sleep_timer_start/sleep_timer_cancel ->
script-message-to here; this script's name is its filename, "sleep_timer",
since it's a flat file directly under scripts/).

Two independent modes (starting one cancels whatever the other was doing):
  "countdown" - mp.add_timeout for N seconds, with a one-time 60s-left OSD
              warning (skipped for short test durations). Fires regardless of
              what's playing (or not playing) - same as YouTube's
              fixed-duration option. Seconds, not minutes, so a phone "Test
              10s" button can exercise the whole path without waiting around.
  "episode" - observes `eof-reached` and sleeps the moment it flips true,
              i.e. the instant the current file finishes. If something
              auto-plays immediately after (next episode), the sleep still
              goes through - that's the point: the user fell asleep during
              *this* episode, so stop at its end regardless of what queues
              next.

Suspend is a real OS call (rundll32 powrprof.dll,SetSuspendState), not
mpv's own `quit`/`stop` - this is about the PC, not just mpv.
]]

local msg = require('mp.msg')

local state = {
    mode = nil,          -- "countdown" | "episode" | nil
    fire_timer = nil,    -- mp.add_timeout handle (countdown mode)
    warn_timer = nil,    -- mp.add_timeout handle (countdown mode, 60s warning)
    observing_eof = false,
    skip_initial_eof = false,
}

local function fmt_duration(seconds)
    if seconds < 60 then
        return string.format("%ds", seconds)
    end
    local m = math.floor(seconds / 60)
    local s = seconds % 60
    if s == 0 then
        return string.format("%d min", m)
    end
    return string.format("%dm %ds", m, s)
end

local on_eof_reached  -- forward declaration; same function instance is used
                       -- to observe/unobserve so mpv can actually remove it

local function clear_timers()
    if state.fire_timer then state.fire_timer:kill(); state.fire_timer = nil end
    if state.warn_timer then state.warn_timer:kill(); state.warn_timer = nil end
end

local function stop_observing()
    if state.observing_eof then
        mp.unobserve_property(on_eof_reached)
        state.observing_eof = false
    end
end

local function do_sleep()
    mp.osd_message("Sleep timer: going to sleep...", 3)
    -- small delay so the OSD actually gets a frame to render before the
    -- display/session goes away
    mp.add_timeout(1.5, function()
        mp.command_native_async({
            name = "subprocess",
            playback_only = false,
            args = { "rundll32.exe", "powrprof.dll,SetSuspendState", "0,1,0" },
        }, function(success, result, error)
            if not success then
                msg.error("sleep-timer: suspend call failed: " .. tostring(error))
            end
        end)
    end)
end

local function cancel(notify)
    local was_active = state.mode ~= nil
    clear_timers()
    stop_observing()
    state.mode = nil
    if notify ~= false and was_active then
        mp.osd_message("Sleep timer cancelled", 2)
    end
end

local function start_countdown(seconds)
    cancel(false)
    seconds = seconds and math.floor(seconds) or 0
    if seconds <= 0 then return end
    state.mode = "countdown"
    mp.osd_message("Sleep timer: " .. fmt_duration(seconds), 3)
    if seconds > 65 then
        state.warn_timer = mp.add_timeout(seconds - 60, function()
            state.warn_timer = nil
            mp.osd_message("Sleeping in 60s...", 10)
        end)
    end
    state.fire_timer = mp.add_timeout(seconds, function()
        state.fire_timer = nil
        state.mode = nil
        do_sleep()
    end)
end

on_eof_reached = function(_, value)
    -- mp.observe_property fires once immediately with the CURRENT value when
    -- registered, not just on future changes. If eof-reached already happens
    -- to be true right now (e.g. sitting on the end card when the timer is
    -- started), skip that first call so we don't sleep instantly - only act
    -- on it actually flipping true from here on.
    if state.skip_initial_eof then
        state.skip_initial_eof = false
        return
    end
    if value == true and state.mode == "episode" then
        stop_observing()
        state.mode = nil
        do_sleep()
    end
end

local function start_episode()
    cancel(false)
    state.mode = "episode"
    state.skip_initial_eof = true
    mp.osd_message("Sleep timer: after this episode", 3)
    mp.observe_property("eof-reached", "bool", on_eof_reached)
    state.observing_eof = true
end

mp.register_script_message("sleep-timer-start", function(mode, seconds_str)
    if mode == "episode" then
        start_episode()
    elseif mode == "countdown" then
        start_countdown(tonumber(seconds_str))
    end
end)

mp.register_script_message("sleep-timer-cancel", function()
    cancel(true)
end)
