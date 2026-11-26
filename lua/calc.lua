-- The engine entry point: PoB2 loaded once, then one call per build. Used by the wasm worker (web/pob-worker.js),
-- the Node parity test and the native CLI (lua/cli.lua).
--
-- Same per-build logic as Demonad112/upgraded-disco-companion tools/pob2/serve.lua (commit e300acf): the snapshot
-- is taken right after the load, then (only when asked) every skill group is recalculated with groups_lib.lua.
-- Results use services/pob-engine's shape: { snapshot, groups } or { error }, plus timings in ms.
local here = (debug.getinfo(1, "S").source:sub(2)):match("^(.*)[/\\]") or "."
local pob = dofile(here .. "/headless.lua")
local groupsLib = dofile(here .. "/groups_lib.lua")
local now = pobhost.now

local M = { pob = pob }

local function encode(t)
	return pob.encode(pob.object(t), true)
end

-- Start PoB. opts: { vendor, pinCommit, gcPause }. Returns JSON { ready, pobVersion, pinCommit, ms }.
function M.init(opts)
	local t0 = now()
	pob.init(opts)
	return encode({
		ready = true,
		pobVersion = launch and launch.versionNumber or nil,
		pinCommit = pob.pinCommit,
		ms = now() - t0,
		luaHeapBytes = collectgarbage("count") * 1024,
	})
end

-- One decoded PoB2 export XML -> JSON { snapshot, groups|null, timings } or { error }.
function M.calc(xml, wantGroups)
	if type(xml) ~= "string" or not xml:find("<PathOfBuilding2", 1, true) then
		return encode({ error = "not a PoB2 export XML" })
	end
	local timings = {}
	local t0 = now()
	local restarted = pob.needsRestart()
	if restarted then
		pob.init()
		timings.restart = now() - t0
		t0 = now()
	end
	local snap, groups
	local ok, err
	if wantGroups then
		local tGroups
		local done, res = pcall(groupsLib.run, pob, xml, function(loadError)
			timings.load = now() - t0
			local ts = now()
			snap = pob.snapshot(loadError)
			timings.snapshot = now() - ts
			tGroups = now()
		end)
		ok, err = done, res
		if done then
			groups = res
			timings.groups = tGroups and (now() - tGroups) or nil
		end
	else
		ok, err = pcall(function()
			local loadError = pob.load(xml)
			timings.load = now() - t0
			local ts = now()
			snap = pob.snapshot(loadError)
			timings.snapshot = now() - ts
		end)
	end
	timings.total = now() - t0 + (timings.restart or 0)
	collectgarbage("collect")
	timings.luaHeapBytes = collectgarbage("count") * 1024
	if not ok then
		return encode({ error = pob.strip(tostring(err)), timings = pob.object(timings) })
	end
	return encode({
		snapshot = snap,
		groups = groups or require("dkjson").null,
		timings = pob.object(timings),
	})
end

return M
