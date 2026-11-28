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
-- state, Onslaught, charges with no generator found) is only reported, with its isolated DPS/EHP delta when level == "suggest".
-- An input the export already carries (input[k] ~= nil, true or false) is never touched.
local M = {}

local ASSUMED_COMBO = 10 -- no stat gives a realistic Combo count; same value as the reference setup
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

-- Charge generation. Every character has 3 maximum Power/Frenzy/Endurance charges (CalcSetup.lua:39 from
-- Data/Misc.lua characterConstants), so "maximum > 0" says nothing. PoB doesn't model generation either ("gain a
-- Power Charge on Critical Hit" parses to nothing), so the evidence is: a raised maximum, or a line on an allocated
-- passive, an equipped item or a socketed skill/support that grants the charge. Returns a reason or nil.
local function chargeGenerator(env, output, kind)
	local base = data and data.characterConstants and data.characterConstants["max_" .. kind:lower() .. "_charges"] or 3
	local max = output[kind .. "ChargesMax"] or 0
	if max > base then return string.format("Maximum %s Charges %d (base %d)", kind, max, base) end
	local k = kind:lower()
	-- A verb that gives the charge. "Consumes your Frenzy Charges on use" is a consumer and "when you gain a Power
	-- Charge" a trigger, neither a source.
	local pats = { "gain an? " .. k .. " charge", "gains? %d+ " .. k .. " charges?", "grants? you an? " .. k .. " charge",
		"grants? an? " .. k .. " charge", "grant you an? " .. k .. " charge" }
	local function hit(line)
		line = tostring(line or ""):lower():gsub("when you gain an? " .. k .. " charge", "")
		for _, p in ipairs(pats) do if line:find(p) then return true end end
		return false
	end
	for _, node in pairs(build.spec and build.spec.allocNodes or {}) do
		for _, l in ipairs(node.sd or {}) do if hit(l) then return "Passive " .. tostring(node.dn) .. ": " .. l end end
	end
	for slot, item in pairs(env.player.itemList or {}) do
		if type(item) == "table" then
			for _, list in ipairs({ "explicitModLines", "implicitModLines", "enchantModLines", "runeModLines" }) do
				for _, ml in ipairs(item[list] or {}) do if hit(ml.line) then return slot .. ": " .. ml.line end end
			end
		end
	end
	for _, skill in ipairs(env.player.activeSkillList or {}) do
		for _, eff in ipairs(skill.effectList or {}) do
			local ge = eff.grantedEffect
			if ge and hit(ge.description) then return "Skill " .. tostring(ge.name) end
		end
	end
	return nil
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
	local skillModList, mainSkill = statsOf(env)
	local skillCfg = mainSkill and mainSkill.skillCfg -- weapon/skill-flag conditioned chances only count under the skill's cfg
	local rules = {}
	local function add(key, value, source)
		rules[#rules + 1] = { key = key, value = value, source = source, tier = 1 }
	end

	-- Power / Frenzy / Endurance charges: something scales with them (consumer) and something generates them
	-- (chargeGenerator). A consumer without a generator is only suggested (Tier 2, see tier2()).
	for _, kind in ipairs({ "Power", "Frenzy", "Endurance" }) do
		if usedLike(env, kind .. "Charge") then
			local gen = chargeGenerator(env, output, kind)
			if gen then
				add("use" .. kind .. "Charges", true, gen .. "; modifiers scale with them")
			end
		end
	end

	-- Leeching: the main skill leeches (damage as Life/Mana/ES) and a modifier is conditional on leeching. The leech
	-- type decides which of PoB's conditions is set; each of them also implies plain Leeching.
	if skillModList then
		local function leech(kind)
			local names = {}
			for _, t in ipairs({ "", "Physical", "Fire", "Cold", "Lightning", "Chaos", "Elemental", "NonChaos" }) do names[#names + 1] = t .. "Damage" .. kind .. "Leech" end
			return skillModList:Sum("BASE", skillCfg, table.unpack(names)) > 0
		end
		local any = false
		for _, k in ipairs({ { "Life", "conditionLeechingLife", "LeechingLife" }, { "Mana", "conditionLeechingMana", "LeechingMana" }, { "EnergyShield", "conditionLeechingEnergyShield", "LeechingEnergyShield" } }) do
			if leech(k[1]) then
				any = true
				if used(env.conditionsUsed, k[3]) then add(k[2], true, "Main skill leeches " .. k[1] .. " and modifiers need you to be leeching it") end
			end
		end
		if any and used(env.conditionsUsed, "Leeching") then add("conditionLeeching", true, "Main skill leeches and modifiers need you to be leeching") end
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
		-- No assumed Shock effect: with the enemy Shocked, PoB applies the build's own computed Shock and only takes
		-- conditionShockEffect when it is stronger (ConfigOptions.lua:1838), so an assumed value is either inert or an
		-- inflation.
		if used(env.enemyConditionsUsed, "Shocked") and shockChance then
			add("conditionEnemyShocked", true, "Main skill can Shock and modifiers apply against Shocked enemies (PoB's own Shock effect)")
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
	-- Charges with a consumer but no generator found (Tier 1 takes the ones with one).
	for _, kind in ipairs({ "Power", "Frenzy", "Endurance" }) do
		if usedLike(env, kind .. "Charge") and not chargeGenerator(env, output, kind) then
			add("use" .. kind .. "Charges", true, "Modifiers scale with " .. kind .. " Charges, but nothing found that generates them")
		end
	end
	-- Onslaught: PoB already grants it when a granting modifier's own conditions hold (CalcPerform.lua:614), so the
	-- toggle only asserts conditions (on kill, on hit at max Frenzy...) that PoB can't see: situational.
	if used(cu, "Onslaught") and not env.player.modDB:Flag(nil, "Onslaught") then
		add("buffOnslaught", true, "Modifiers need Onslaught; the toggle also adds the buff itself")
	end
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
-- Catalog: every Config option PoB would show for this build (control.shown(), plus anything the export set). Each
-- is listed with its value and state; its effect is measured when it is cheap to (see MAX_TRIALS) or on request
-- (M.measure). Effects are isolated (one change at a time on the configured build), inferred from PoB's own
-- recalculation, not read from a tooltip.
--   check: the stat change of flipping it. list: every alternative vs the selected one. count: +1 vs now (per extra
--   unit) and, when set, now vs 0; or, for the values the caller names, each of them vs now.
local STATS = { "TotalDPS", "CombinedDPS", "TotalEHP", "PhysicalMaximumHitTaken", "FireMaximumHitTaken", "EvadeChance", "EffectiveBlockChance", "PhysicalDamageReduction" }
-- Each trial is a full PoB recalculation (~0.4 s in WASM), so the first response measures only this many; everything
-- else is listed and measured when the page asks (M.measure).
local MAX_TRIALS = 12
-- Measured before everything else: options that change the numbers for every build.
local PRIORITY = { enemyIsBoss = true, enemyLevel = true }

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

-- Set one input, recalculate, read the stats, restore. Returns stats, or nil and PoB's error.
local function trial(pob, key, value, budget)
	local input = build.configTab.input
	local old = input[key]
	input[key] = value
	budget.n = budget.n + 1
	local err = recalc(pob)
	local s = (not err) and snap() or nil
	input[key] = old
	return s, err
end

local TYPES = { check = true, count = true, countAllowZero = true, integer = true, float = true, list = true }

local function entryType(v)
	return v.type == "list" and "list" or (v.type == "check" and "check" or "count")
end

local function optionsOf(v, selected)
	local opts = {}
	for _, o in ipairs(v.list or {}) do opts[#opts + 1] = { val = o.val, label = clean(o.label), selected = o.val == selected } end
	return opts
end

-- Measure option `v` into entry `e` (value, type, options already set) against `base`. At most `limit` trials in
-- total on `budget`. values: for a count, the values to try instead of the +1 / vs-0 pair.
local function measureEntry(pob, v, e, base, budget, limit, values)
	local key = e.key
	local before = budget.n
	local function try(value)
		local st, err = trial(pob, key, value, budget)
		if err then e.error = err end -- kept visible: a failed trial is not "no change"
		return st
	end
	if v.type == "check" then
		if budget.n >= limit then return end
		local on = e.value == true
		local s = try(not on)
		if s then e.effect = on and diff(pob, s, base) or diff(pob, base, s) end
	elseif v.type == "list" then
		for _, o in ipairs(e.options) do
			if not o.selected and budget.n < limit then
				local s = try(o.val)
				if s then o.vsSelected = diff(pob, base, s) end
			end
		end
	elseif values then
		e.trials = {}
		for _, val in ipairs(values) do
			if budget.n < limit and tonumber(val) then
				local s = try(tonumber(val))
				if s then e.trials[#e.trials + 1] = { value = tonumber(val), vs = diff(pob, base, s) } end
			end
		end
	else
		if budget.n >= limit then return end
		local n = tonumber(e.value) or 0
		local s = try(n + 1)
		if s then e.perUnit = diff(pob, base, s) end
		if n > 0 and budget.n < limit then
			local s0 = try(0)
			if s0 then e.total = diff(pob, s0, base) end
		end
	end
	e.measured = budget.n > before -- nothing ran when the budget was already spent
end

local function hasEffect(e)
	if e.error then return true end
	if e.effect and next(e.effect) then return true end
	if e.perUnit and next(e.perUnit) then return true end
	if e.total and next(e.total) then return true end
	for _, o in ipairs(e.options or {}) do if o.vsSelected and next(o.vsSelected) then return true end end
	return false
end

-- applied: set of keys auto-config enabled. overrides: set of keys the caller set. trials: measurement budget.
-- Returns entries (every option shown, in PoB's order) and how many of them are not measured yet.
function M.catalog(pob, applied, overrides, exported, trials)
	local ct = build.configTab
	local input = ct.input
	local entries = {}
	local budget = { n = 0 }
	local ok, varList = pcall(LoadModule, "Modules/ConfigOptions")
	if not ok or type(varList) ~= "table" then return entries, 0 end
	local base = snap()
	local sectionName
	local showAll = ct.toggleConfigs
	ct.toggleConfigs = false -- only options PoB would show for this build, not the 'show all' view
	local cands = {}
	for idx, v in ipairs(varList) do
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
					key = key, label = clean(v.label or key), section = sectionName, order = idx,
					type = entryType(v), value = value, default = def,
					state = overrides[key] and "manual" or applied[key] and "auto" or exported[key] and "export" or "available",
					measured = false,
				}
				if v.tooltip then e.tooltip = clean(v.tooltip) end
				if v.type == "list" then e.options = optionsOf(v, value) end
				cands[#cands + 1] = { e = e, v = v }
			end
		end
	end
	ct.toggleConfigs = showAll
	-- Measure the priority options first, then what the build already uses, then toggles, lists, counts.
	local rank = { manual = 1, auto = 1, export = 1, available = 2 }
	local trank = { check = 0, list = 1, count = 2 }
	local function r(c) return (PRIORITY[c.e.key] and c.e.state == "available") and 0 or rank[c.e.state] end
	local order = {}
	for i, c in ipairs(cands) do order[i] = c end
	table.sort(order, function(a, b)
		local ra, rb = r(a) * 3 + trank[a.e.type], r(b) * 3 + trank[b.e.type]
		if ra ~= rb then return ra < rb end
		return a.e.key < b.e.key
	end)
	local limit = trials or MAX_TRIALS
	for _, c in ipairs(order) do
		if c.e.section ~= "Quest Rewards" then measureEntry(pob, c.v, c.e, base, budget, limit) end
	end
	local unmeasured = 0
	for _, c in ipairs(cands) do
		local e = c.e
		if not e.measured then unmeasured = unmeasured + 1 end
		-- Hide unset options that were measured and change nothing; keep anything set and anything not measured yet.
		if not e.measured or e.state ~= "available" or hasEffect(e) then entries[#entries + 1] = e end
	end
	recalc(pob) -- leave the build as configured
	return entries, unmeasured
end

-- Measure on request against the build as it is now. specs: { { key, values? } ... }. Returns entries with the same
-- measure fields as the catalog's (effect | options[].vsSelected | perUnit/total | trials), measured = true.
function M.measure(pob, specs)
	local ct = build.configTab
	local ok, varList = pcall(LoadModule, "Modules/ConfigOptions")
	if not ok or type(varList) ~= "table" then return {} end
	local byKey = {}
	for _, v in ipairs(varList) do if v.var then byKey[v.var] = v end end
	local base = snap()
	local budget = { n = 0 }
	local res = {}
	for _, sp in ipairs(specs or {}) do
		local v = byKey[sp.key]
		if v and TYPES[v.type] and ct.varControls[sp.key] then
			local cur = ct.input[sp.key]
			local value = cur
			if value == nil then value = ct:GetDefaultState(sp.key, type(cur)) end
			local e = { key = sp.key, type = entryType(v), value = value, measured = false }
			if v.type == "list" then e.options = optionsOf(v, value) end
			measureEntry(pob, v, e, base, budget, math.huge, sp.values)
			res[#res + 1] = e
		end
	end
	recalc(pob) -- the last trial left its value in the calculation
	return res
end

-- Put the Config inputs back to `saved` (a shallow copy taken right after the load) and recalculate, so a new set of
-- overrides starts from the export as it was and auto-config sees the build's own state again.
function M.reset(pob, saved)
	local input = build.configTab.input
	for k in pairs(input) do input[k] = nil end
	for k, v in pairs(saved) do input[k] = v end
	return recalc(pob)
end

-- Apply Tier 1 and recalculate. level: "apply" (default) or "suggest" (also compute each Tier 2 delta and the
-- catalog). opts: { trials = n, catalog = bool, deltas = bool } override what "suggest" implies.
-- Returns a plain table (use pob.object on the way out): { baselineDPS, configuredDPS, applied, suggested, error }.
function M.run(pob, level, overrides, opts)
	overrides = overrides or {}
	opts = opts or {}
	local wantDeltas = opts.deltas
	if wantDeltas == nil then wantDeltas = level == "suggest" end
	local wantCatalog = opts.catalog
	if wantCatalog == nil then wantCatalog = level == "suggest" end
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
		if wantDeltas and baseDPS then
			input[r.key] = r.value
			if not recalc(pob) then
				local dps, ehp = out("TotalDPS"), out("TotalEHP")
				s.dpsDelta = dps and round(dps - baseDPS)
				s.dpsDeltaPct = (dps and baseDPS ~= 0) and round((dps / baseDPS - 1) * 100) or nil
				s.ehpDelta = (ehp and baseEHP) and round(ehp - baseEHP) or nil
			end
			input[r.key] = nil
		end
		-- With deltas, a toggle that changes neither DPS nor EHP is noise.
		local measured = wantDeltas and s.dpsDelta ~= nil
		if not measured or s.dpsDelta ~= 0 or (s.ehpDelta or 0) ~= 0 then
			result.suggested[#result.suggested + 1] = s
		end
	end
	if wantDeltas and #det.suggest > 0 then recalc(pob) end -- leave the build as configured by Tier 1
	if wantCatalog then
		local applied = {}
		for _, a in ipairs(result.applied) do applied[a.key] = true end
		local ok, cat, unmeasured = pcall(M.catalog, pob, applied, manual, exported, opts.trials)
		if ok then result.catalog = cat; result.unmeasured = unmeasured else result.catalogError = pob.strip(tostring(cat)); recalc(pob) end
	end
	return result
end

return M
