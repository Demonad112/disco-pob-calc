-- Auto-configuration of PoB2's Config tab for builds that were exported without combat state.
--
-- Two passes: the build is already calculated (headless.load runs two frames), so PoB knows what the build can use.
-- detect() reads that state, apply() writes the matching Config inputs, rebuilds configTab.modList and recalculates.
--
-- "Consumer" checks reuse PoB's own bookkeeping, the same tables Classes/ConfigTab.lua uses to decide which options
-- to show: mainEnv.conditionsUsed / enemyConditionsUsed / multipliersUsed / perStatsUsed (Modules/Calcs.lua:587-690)
-- and the main skill's flags. "Generator" checks read computed output (PowerChargesMax, MaximumRage, DazeChance...).
--
-- Policy: Tier 1 (generator and consumer both present) is applied. Tier 2 (situational: recent kills, been hit, boss
-- state, other charges) is only reported, with its isolated DPS/EHP delta when level == "suggest".
-- An input the export already carries (input[k] ~= nil, true or false) is never touched.
local M = {}

local ASSUMED_COMBO = 10 -- no stat gives a realistic Combo count; same value as the reference setup
local ASSUMED_SHOCK = 20 -- conservative shock effect (%) when only a chance source exists
local MIN_CRIT_FOR_RECENT = 25 -- % effective crit chance to treat "Crit Recently" as inherent
local MAX_CRIT_FOR_NONCRIT = 95

local function envOf()
	return build.calcsTab and build.calcsTab.mainEnv
end

local function used(tbl, key)
	return tbl ~= nil and tbl[key] ~= nil
end

-- Any key containing `needle` (plain) in one of PoB's "used" tables: charges show up as PowerCharge, RemovablePowerCharge,
-- HavePowerCharge, PowerCharges (perStat) and so on, depending on the modifier.
local function usedLike(env, needle)
	for _, name in ipairs({ "multipliersUsed", "conditionsUsed", "perStatsUsed" }) do
		for k in pairs(env[name] or {}) do
			if type(k) == "string" and k:find(needle, 1, true) then return true end
		end
	end
	return false
end

local function statsOf(env)
	local ms = env.player and env.player.mainSkill
	return ms and ms.skillModList, ms
end

-- Run a frame the way groups_lib.select does. Returns an error string or nil.
local function recalc(pob)
	launch.promptMsg = nil
	build.configTab:BuildModList()
	build.modFlag = true
	build.buildFlag = true
	local ok, err = pcall(runCallback, "OnFrame")
	if not ok then return pob.strip(tostring(err)) end
	if launch.promptMsg then return pob.strip(launch.promptMsg) end
	return nil
end

local function out(k)
	local o = build.calcsTab.mainOutput
	local v = o and o[k]
	return type(v) == "number" and v == v and v or nil
end

-- Tier 1 rules. Each returns nil (not applicable) or a list of { key, value, source }.
local function tier1(env, output)
	local modDB = env.player.modDB
	local skillModList, mainSkill = statsOf(env)
	local skillCfg = mainSkill and mainSkill.skillCfg -- weapon/skill-flag conditioned chances only count under the skill's cfg
	local rules = {}
	local function add(key, value, source)
		rules[#rules + 1] = { key = key, value = value, source = source, tier = 1 }
	end

	-- Power charges: a generator (maximum > 0) and something that scales with them.
	if (output.PowerChargesMax or 0) > 0 and usedLike(env, "PowerCharge") then
		add("usePowerCharges", true, "Maximum Power Charges " .. output.PowerChargesMax .. " and modifiers that scale with them")
	end

	-- Rage: PoB only evaluates Rage when the build can gain it (CalcPerform.lua:777); inherent More Attack Damage.
	if output.MaximumRage and output.MaximumRage > 0 then
		add("multiplierRage", output.MaximumRage, "Build can gain Rage (Condition:CanGainRage / RageRegen), maximum " .. output.MaximumRage)
	end

	-- Combo: only when something queries Multiplier:ComboStacks (the option's own ifMult gate).
	if used(env.multipliersUsed, "ComboStacks") then
		add("multiplierCombo", ASSUMED_COMBO, "A skill or modifier uses Combo stacks (assumed " .. ASSUMED_COMBO .. ")")
	end

	if used(env.conditionsUsed, "HaveEnergyShield") and (output.EnergyShield or 0) > 0 then
		add("conditionHaveEnergyShield", true, "Energy Shield " .. math.floor(output.EnergyShield) .. " and modifiers conditional on it")
	end

	-- Recent crits: crit chance of the main skill decides which of the two is the steady state.
	local crit = output.CritChance
	if crit then
		if used(env.conditionsUsed, "CritRecently") and crit >= MIN_CRIT_FOR_RECENT then
			add("conditionCritRecently", true, string.format("Main skill crit chance %.1f%%", crit))
		end
		if used(env.conditionsUsed, "NonCritRecently") and crit < MAX_CRIT_FOR_NONCRIT then
			add("conditionNonCritRecently", true, string.format("Main skill crit chance %.1f%% (non-crits happen)", crit))
		end
	end

	-- Enemy ailments: a chance source on the main skill and a modifier that cares.
	if skillModList then
		if used(env.enemyConditionsUsed, "Dazed") and skillModList:Sum("BASE", skillCfg, "DazeChance") > 0 then
			add("conditionEnemyDazed", true, "Main skill has a chance to Daze")
		end
		local shockChance = (output.ShockChance or 0) > 0 or skillModList:Sum("BASE", skillCfg, "EnemyShockChance") > 0
		if used(env.enemyConditionsUsed, "Shocked") and shockChance then
			add("conditionEnemyShocked", true, "Main skill can Shock and modifiers apply against Shocked enemies")
			add("conditionShockEffect", ASSUMED_SHOCK, "Assumed shock effect")
		end
	end
	return rules
end

-- Tier 2: reported only. { key, value, why } if the build has a consumer for it.
local function tier2(env, output)
	local c = {}
	local function add(key, value, why) c[#c + 1] = { key = key, value = value, source = why, tier = 2 } end
	local cu, eu = env.conditionsUsed, env.enemyConditionsUsed
	if used(cu, "BeenHitRecently") then add("conditionBeenHitRecently", true, "Modifiers conditional on being hit recently") end
	if used(cu, "CritInPast8Sec") then add("conditionCritInPast8Sec", true, "Modifiers conditional on a crit in the past 8s") end
	if used(cu, "KilledShockedLast3Seconds") then add("conditionKilledShockedLast3Seconds", true, "Needs a Shocked kill every 3s (adds)") end
	if used(cu, "FrozenEnemyRecently") then add("conditionFrozenEnemyRecently", true, "Needs a freeze (bosses resist)") end
	if used(cu, "ChilledEnemyRecently") then add("conditionChilledEnemyRecently", true, "Modifiers conditional on chilling recently") end
	if used(cu, "ShockedEnemyRecently") then add("conditionShockedEnemyRecently", true, "Modifiers conditional on shocking recently") end
	if used(eu, "Chilled") then add("conditionEnemyChilled", true, "Modifiers against Chilled enemies") end
	if (output.FrenzyChargesMax or 0) > 0 and usedLike(env, "FrenzyCharge") then add("useFrenzyCharges", true, "Frenzy Charges available (" .. output.FrenzyChargesMax .. ")") end
	if (output.EnduranceChargesMax or 0) > 0 and usedLike(env, "EnduranceCharge") then add("useEnduranceCharges", true, "Endurance Charges available (" .. output.EnduranceChargesMax .. ")") end
	return c
end

-- Detect against the currently loaded, calculated build.
-- Returns { apply = {rule...}, suggest = {rule...} } with already-configured inputs removed.
function M.detect()
	local env = envOf()
	if not (env and env.player and env.player.modDB and build.configTab) then
		return { apply = {}, suggest = {} }
	end
	local output = build.calcsTab.mainOutput or {}
	local input = build.configTab.input
	local function unset(r) return input[r.key] == nil end
	local res = { apply = {}, suggest = {} }
	for _, r in ipairs(tier1(env, output)) do
		if unset(r) then res.apply[#res.apply + 1] = r end
	end
	for _, r in ipairs(tier2(env, output)) do
		if unset(r) then res.suggest[#res.suggest + 1] = r end
	end
	return res
end

local function round(v)
	return v and math.floor(v * 100 + 0.5) / 100 or nil
end


-- ---------------------------------------------------------------------------------------------------------------
-- Catalog: every Config option PoB would show for this build (control.shown(), plus anything the export set), each
-- with its measured effect. check: state off vs on. list: every alternative vs the selected one. count: +1 vs now
-- (per extra unit) and, when set, now vs 0. Effects are isolated (one change at a time on the configured build), so
-- they are inferred from PoB's own recalculation, not read from a tooltip.
local STATS = { "TotalDPS", "CombinedDPS", "TotalEHP", "PhysicalMaximumHitTaken", "FireMaximumHitTaken", "EvadeChance", "EffectiveBlockChance", "PhysicalDamageReduction" }
local MAX_TRIALS = 60 -- each trial is a full PoB recalculation (~1 s native, more in WASM); unmeasured options are still listed

local function snap()
	local t = {}
	for _, k in ipairs(STATS) do t[k] = out(k) end
	return t
end

local function diff(pob, base, now)
	local d = {}
	for _, k in ipairs(STATS) do
		local a, b = base[k], now[k]
		if a and b and math.abs(b - a) > 1e-9 * math.max(1, math.abs(a)) then
			d[k] = { from = round(a), to = round(b), pct = a ~= 0 and round((b / a - 1) * 100) or nil }
		end
	end
	return pob.object(d)
end

local function clean(s)
	return (tostring(s or ""):gsub("%^x%x%x%x%x%x%x", ""):gsub("%^%d", ""))
end

-- Set one input, recalculate, read the stats, restore. Returns stats or nil on a PoB error.
local function trial(pob, key, value, budget)
	local input = build.configTab.input
	local old = input[key]
	input[key] = value
	budget.n = budget.n + 1
	local err = recalc(pob)
	local s = (not err) and snap() or nil
	input[key] = old
	return s
end

local TYPES = { check = true, count = true, countAllowZero = true, integer = true, float = true, list = true }

-- applied: set of keys auto-config enabled. overrides: set of keys the caller set.
function M.catalog(pob, applied, overrides, exported)
	local ct = build.configTab
	local input = ct.input
	local entries = {}
	local budget = { n = 0 }
	local ok, varList = pcall(LoadModule, "Modules/ConfigOptions")
	if not ok or type(varList) ~= "table" then return entries end
	local base = snap()
	local unmeasured = 0
	local sectionName
	local showAll = ct.toggleConfigs
	ct.toggleConfigs = false -- only options PoB would show for this build, not the 'show all' view
	local cands = {}
	for _, v in ipairs(varList) do
		if v.section then sectionName = clean(v.section) end
		local key = v.var
		local ctl = key and ct.varControls[key]
		if key and ctl and TYPES[v.type] then
			local cur = input[key]
			local def = ct:GetDefaultState(key, type(cur))
			local sok, sres = pcall(function() return type(ctl.shown) == "function" and ctl.shown() or ctl.shown end)
			local isSet = cur ~= nil and cur ~= def
			if (sok and sres) or isSet then
				local value = cur
				if value == nil then value = def end
				local e = {
					key = key, label = clean(v.label or key), section = sectionName,
					type = v.type == "list" and "list" or (v.type == "check" and "check" or "count"),
					value = value, default = def,
					state = overrides[key] and "manual" or applied[key] and "auto" or exported[key] and "export" or "available",
				}
				if v.tooltip then e.tooltip = clean(v.tooltip) end
				cands[#cands + 1] = { e = e, v = v, cur = cur }
			end
		end
	end
	ct.toggleConfigs = showAll
	-- Measure what the build already uses first, then toggles, lists, counts, until the trial budget is spent.
	local rank = { manual = 0, auto = 0, export = 0, available = 1 }
	local trank = { check = 0, list = 1, count = 2 }
	table.sort(cands, function(a, b)
		local ra, rb = rank[a.e.state] * 3 + trank[a.e.type], rank[b.e.state] * 3 + trank[b.e.type]
		if ra ~= rb then return ra < rb end
		return a.e.key < b.e.key
	end)
	for _, c in ipairs(cands) do
		local e, v, cur, key = c.e, c.v, c.cur, c.e.key
		if e.section == "Quest Rewards" then
			e.measured = false -- one-off rewards, no per-build effect worth a recalculation
		elseif budget.n >= MAX_TRIALS then
			e.measured = false
			unmeasured = unmeasured + 1
		elseif v.type == "check" then
			local on = cur == true
			local s = trial(pob, key, not on, budget)
			if s then e.effect = on and diff(pob, s, base) or diff(pob, base, s) end
		elseif v.type == "list" then
			e.options = {}
			for _, o in ipairs(v.list or {}) do
				local o_ = { val = o.val, label = clean(o.label), selected = o.val == e.value }
				if not o_.selected and budget.n < MAX_TRIALS then
					local s = trial(pob, key, o.val, budget)
					if s then o_.vsSelected = diff(pob, base, s) end
				end
				e.options[#e.options + 1] = o_
			end
		else
			local n = tonumber(cur) or 0
			local s = trial(pob, key, n + 1, budget)
			if s then e.perUnit = diff(pob, base, s) end
			if n > 0 and budget.n < MAX_TRIALS then
				local s0 = trial(pob, key, 0, budget)
				if s0 then e.total = diff(pob, s0, base) end
			end
		end
		local has = e.effect or e.perUnit or e.total
		local hasOpt = false
		for _, o in ipairs(e.options or {}) do if o.vsSelected and next(o.vsSelected) then hasOpt = true end end
		-- Hide unset options that measurably change nothing; keep anything set and anything not measured.
		if e.measured ~= false and (has and next(has)) or hasOpt or e.state ~= "available" then
			entries[#entries + 1] = e
		end
	end
	recalc(pob) -- leave the build as configured
	return entries, unmeasured
end

-- Apply Tier 1 and recalculate. level: "apply" (default) or "suggest" (also compute each Tier 2 delta).
-- Returns a plain table (use pob.object on the way out): { baselineDPS, configuredDPS, applied, suggested, error }.
function M.run(pob, level, overrides)
	overrides = overrides or {}
	local ct = build.configTab
	local exported = {}
	for k, v in pairs(ct.input) do
		if v ~= ct:GetDefaultState(k, type(v)) then exported[k] = true end
	end
	local manual = {}
	for k, v in pairs(overrides) do
		if v ~= nil and not (type(v) == "table") then ct.input[k] = v; manual[k] = true end
	end
	if next(manual) then
		local err = recalc(pob)
		if err then
			for k in pairs(manual) do ct.input[k] = nil end
			recalc(pob)
			manual = {}
		end
	end
	local det = level and M.detect() or { apply = {}, suggest = {} }
	local result = {
		baselineDPS = out("TotalDPS"), configuredDPS = out("TotalDPS"),
		baselineEHP = out("TotalEHP"), configuredEHP = out("TotalEHP"),
		applied = {}, suggested = {},
	}
	local input = build.configTab.input
	if #det.apply > 0 then
		for _, r in ipairs(det.apply) do input[r.key] = r.value end
		local err = recalc(pob)
		if err then
			-- Roll back so a bad toggle can't leave the build half-configured.
			for _, r in ipairs(det.apply) do input[r.key] = nil end
			recalc(pob)
			result.error = err
			return result
		end
		result.configuredDPS = out("TotalDPS")
		result.configuredEHP = out("TotalEHP")
		for _, r in ipairs(det.apply) do
			result.applied[#result.applied + 1] = { key = r.key, value = r.value, source = r.source, tier = 1 }
		end
	end
	local baseDPS, baseEHP = result.configuredDPS, result.configuredEHP
	for _, r in ipairs(det.suggest) do
		local s = { key = r.key, value = r.value, source = r.source, tier = 2 }
		if level == "suggest" and baseDPS then
			input[r.key] = r.value
			if not recalc(pob) then
				local dps, ehp = out("TotalDPS"), out("TotalEHP")
				s.dpsDelta = dps and round(dps - baseDPS)
				s.dpsDeltaPct = (dps and baseDPS ~= 0) and round((dps / baseDPS - 1) * 100) or nil
				s.ehpDelta = (ehp and baseEHP) and round(ehp - baseEHP) or nil
			end
			input[r.key] = nil
		end
		-- In suggest mode a toggle that changes neither DPS nor EHP is noise.
		local measured = level == "suggest" and s.dpsDelta ~= nil
		if not measured or s.dpsDelta ~= 0 or (s.ehpDelta or 0) ~= 0 then
			result.suggested[#result.suggested + 1] = s
		end
	end
	if level == "suggest" and #det.suggest > 0 then recalc(pob) end -- leave the build as configured by Tier 1
	if level == "suggest" then
		local applied = {}
		for _, a in ipairs(result.applied) do applied[a.key] = true end
		local ok, cat, unmeasured = pcall(M.catalog, pob, applied, manual, exported)
		if ok then result.catalog = cat; result.unmeasured = unmeasured else result.catalogError = pob.strip(tostring(cat)); recalc(pob) end
	end
	return result
end

return M
