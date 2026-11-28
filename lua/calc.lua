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

-- The Config inputs as the last load left them (before auto-config or overrides touched them), kept while that
-- build stays loaded so setConfig can start from the export again without decoding and loading it a second time.
-- nil when nothing is loaded or the build was last used by the all-groups run (which switches skills under it).
local pristine

local function copyInputs(t)
	local c = {}
	for k, v in pairs(t) do c[k] = v end
	return c
end

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
	local overrides = opts and opts.overrides
	local plainLoad = pob.load
	pristine = nil
	pob.load = function(x)
		local loadError = plainLoad(x)
		if loadError then return loadError end
		if not wantGroups and build.configTab then pristine = copyInputs(build.configTab.input) end
		if level or overrides then
			local done, res = pcall(autoconfig.run, pob, level, overrides, opts)
			if done then
				autoInfo = autoInfo or res
			elseif not autoInfo then
				autoInfo = { error = pob.strip(tostring(res)), applied = {}, suggested = {} }
			end
		end
		return nil
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
		pristine = nil
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

-- Change the Config of the build that is already loaded (the last M.calc without groups) and recalculate; no decode,
-- no load. opts: { autoConfig, overrides, trials, catalog }: as for M.calc, starting again from the export's own inputs.
-- Same result shape as M.calc minus groups. Returns { error } when no build is loaded (call M.calc first).
function M.setConfig(opts)
	opts = opts or {}
	if not pristine or pob.needsRestart() then
		return encode({ error = "no build loaded: calculate it first" })
	end
	local timings = {}
	local t0 = now()
	local level = opts.autoConfig
	if level == true then level = "apply" end
	local snap, mainSkill, autoInfo
	local ok, err = pcall(function()
		local resetErr = autoconfig.reset(pob, pristine)
		if resetErr then error(resetErr, 0) end
		if level or opts.overrides then
			local done, res = pcall(autoconfig.run, pob, level, opts.overrides, opts)
			autoInfo = done and res or { error = pob.strip(tostring(res)), applied = {}, suggested = {} }
		end
		timings.load = now() - t0
		local ts = now()
		snap = pob.snapshot(nil)
		mainSkill = mainSkillInfo()
		timings.snapshot = now() - ts
	end)
	timings.total = now() - t0
	if not ok then
		pristine = nil -- PoB errored mid-way: the build is in an unknown state
		return encode({ error = pob.strip(tostring(err)), timings = pob.object(timings) })
	end
	return encode({
		snapshot = snap,
		mainSkill = mainSkill or require("dkjson").null,
		autoConfig = autoInfo and pob.object(autoInfo) or require("dkjson").null,
		timings = pob.object(timings),
	})
end

-- Measure Config options on the loaded build as it is now (see autoconfig.measure). specs: { { key, values? } ... }.
-- Returns { measured = { entry... } } or { error }.
function M.measure(specs)
	if not pristine or pob.needsRestart() then
		return encode({ error = "no build loaded: calculate it first" })
	end
	local t0 = now()
	local ok, res = pcall(autoconfig.measure, pob, specs)
	if not ok then
		pristine = nil
		return encode({ error = pob.strip(tostring(res)) })
	end
	return encode({ measured = pob.array(res), ms = now() - t0 })
end

return M
