-- The engine entry point: PoB2 loaded once, then one call per build. Used by the wasm worker (web/pob-worker.js),
-- the Node parity test and the native CLI (lua/cli.lua).
--
-- Same per-build logic as Demonad112/upgraded-disco-companion tools/pob2/serve.lua (commit e300acf): the snapshot
-- is taken right after the load, then (only when asked) every skill group is recalculated with groups_lib.lua.
-- Results use services/pob-engine's shape: { snapshot, groups } or { error }, plus timings in ms.
local here = (debug.getinfo(1, "S").source:sub(2)):match("^(.*)[/\\]") or "."
local pob = dofile(here .. "/headless.lua")
local groupsLib = dofile(here .. "/groups_lib.lua")
local autoconfig = dofile(here .. "/autoconfig.lua")
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

-- The main skill's name and its main-hand hit split by damage type (groups_lib's HAND keys). Not in
-- services/pob-engine's shape (its snapshot has no split); added alongside it for the damage-split view.
local HAND = { "PhysicalHitAverage", "LightningHitAverage", "ColdHitAverage", "FireHitAverage", "ChaosHitAverage",
	"TotalMin", "TotalMax" }
local function mainSkillInfo()
	local env = build and build.calcsTab and build.calcsTab.mainEnv
	local ms = env and env.player and env.player.mainSkill
	local ge = ms and ms.activeEffect and ms.activeEffect.grantedEffect
	local out = build.calcsTab.mainOutput or {}
	local info = { skill = ge and ge.name or nil, mainSocketGroup = build.mainSocketGroup }
	for _, hand in ipairs({ "MainHand", "OffHand" }) do
		if type(out[hand]) == "table" then
			local h = {}
			for _, k in ipairs(HAND) do
				if type(out[hand][k]) == "number" and out[hand][k] == out[hand][k] then h[k] = out[hand][k] end
			end
			info[hand == "MainHand" and "mainHand" or "offHand"] = pob.object(h)
		end
	end
	return pob.object(info)
end

-- One decoded PoB2 export XML -> JSON { snapshot, mainSkill, groups|null, autoConfig|null, timings } or { error }.
-- opts.autoConfig: false/nil = off (the build exactly as exported), true or "apply" = enable the Config inputs the
-- build can use (lua/autoconfig.lua), "suggest" = also report each situational toggle's isolated delta.
function M.calc(xml, wantGroups, opts)
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
	local snap, groups, mainSkill
	local ok, err
	-- Auto-config runs inside every load, so groups_lib's reload keeps the same Config as the snapshot.
	local level = opts and opts.autoConfig
	if level == true then level = "apply" end
	local autoInfo
	local plainLoad = pob.load
	if level then
		pob.load = function(x)
			local loadError = plainLoad(x)
			if loadError then return loadError end
			local done, res = pcall(autoconfig.run, pob, level)
			if done then
				autoInfo = autoInfo or res
			elseif not autoInfo then
				autoInfo = { error = pob.strip(tostring(res)), applied = {}, suggested = {} }
			end
			return nil
		end
	end
	if wantGroups then
		local tGroups
		local done, res = pcall(groupsLib.run, pob, xml, function(loadError)
			timings.load = now() - t0
			local ts = now()
			snap = pob.snapshot(loadError)
			if not loadError then mainSkill = mainSkillInfo() end
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
			if not loadError then mainSkill = mainSkillInfo() end
			timings.snapshot = now() - ts
		end)
	end
	pob.load = plainLoad
	timings.total = now() - t0 + (timings.restart or 0)
	collectgarbage("collect")
	timings.luaHeapBytes = collectgarbage("count") * 1024
	if not ok then
		return encode({ error = pob.strip(tostring(err)), timings = pob.object(timings) })
	end
	return encode({
		snapshot = snap,
		mainSkill = mainSkill or require("dkjson").null,
		groups = groups or require("dkjson").null,
		autoConfig = autoInfo and pob.object(autoInfo) or require("dkjson").null,
		timings = pob.object(timings),
	})
end

return M
