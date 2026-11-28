-- Auto-configuration of PoB2's Config tab for builds that were exported without combat state.
--
-- Two passes: the build is already calculated (headless.load runs two frames), so PoB knows what the build can use.
-- detect() reads that state, apply() writes the matching Config inputs, rebuilds configTab.modList and recalculates.
--
-- "Consumer" checks reuse PoB's own bookkeeping, the same tables Classes/ConfigTab.lua uses to decide which options
-- to show: mainEnv.conditionsUsed / enemyConditionsUsed / multipliersUsed / perStatsUsed (Modules/Calcs.lua:587-690)
-- and the main skill's flags. "Generator" checks read computed output (PowerChargesMax, MaximumRage, DazeChance...).
--
-- Policy: Tier 1 (generator and consumer both present, and the state holds in steady combat) is applied; every applied
-- input is then measured leave-one-out and dropped when it moves none of TotalDPS / FullDPS / TotalEHP. Tier 2
-- (situational, or chance-based with low uptime) is only reported, with its isolated delta when level == "suggest".
-- Chance-based states are judged by uptime against PoB's configured enemy (its threshold/boss setting): the chance
-- per hit PoB computes for the main skill, its use rate (output.Speed, a lower bound: one hit per use) and the
-- ailment's duration (or the 4 s of "Recently"). Uptime >= MIN_UPTIME is Tier 1.
-- In "suggest" mode candidates also come from PoB's own Config definitions: every check option PoB shows because a modifier in the
-- build is conditional on it (ifCond / ifEnemyCond / ifMinionCond / ifMult / ifFlag gates) is at least suggested,
-- so the detection covers every class, ascendancy and minion build without a per-class list.
-- An input the export already carries (input[k] ~= nil, true or false) is never touched.
local M = {}

local FALLBACK_COMBO = 10 -- only when no skill states a required or maximum Combo count (then Tier 2)
local MIN_UPTIME = 0.9 -- probability the state holds at a random moment of steady combat
local RECENT = 4 -- seconds: PoE's "Recently"
local DAZE_DURATION = 8 -- s (ConfigOptions.lua conditionEnemyDazed tooltip)
local DEFAULT_AILMENT_DURATION = 4
local INERT_PCT = 0.01 -- % change below which an applied input counts as doing nothing
local MEASURE_STATS = { "TotalDPS", "FullDPS", "TotalEHP" }

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

-- Lines of the build's sources: allocated passives, equipped items, socketed skills. fn(line, where) returns truthy
-- to stop; that value is returned.
local function scanLines(env, fn)
	for _, node in pairs(build.spec and build.spec.allocNodes or {}) do
		for _, l in ipairs(node.sd or {}) do local r = fn(l, "Passive " .. tostring(node.dn)) if r then return r end end
	end
	for slot, item in pairs(env.player.itemList or {}) do
		if type(item) == "table" then
			for _, list in ipairs({ "explicitModLines", "implicitModLines", "enchantModLines", "runeModLines" }) do
				for _, ml in ipairs(item[list] or {}) do local r = fn(ml.line, slot) if r then return r end end
			end
		end
	end
	for _, skill in ipairs(env.player.activeSkillList or {}) do
		for _, eff in ipairs(skill.effectList or {}) do
			local ge = eff.grantedEffect
			if ge then local r = fn(ge.description, "Skill " .. tostring(ge.name)) if r then return r end end
		end
	end
	return nil
end

-- Charge generation. Every character has 3 maximum Power/Frenzy/Endurance charges (CalcSetup.lua:39 from
-- Data/Misc.lua characterConstants), so "maximum > 0" says nothing. PoB doesn't model generation either ("gain a
-- Power Charge on Critical Hit" parses to nothing), so the evidence is: a raised maximum, or a line on an allocated
-- passive, an equipped item or a socketed skill/support that grants the charge. Returns a reason or nil, and
-- whether the source is only a random-type charge (a weaker, Tier 2 source).
local function chargeGenerator(env, output, kind)
	local base = data and data.characterConstants and data.characterConstants["max_" .. kind:lower() .. "_charges"] or 3
	local max = output[kind .. "ChargesMax"] or 0
	if max > base then return string.format("Maximum %s Charges %d (base %d)", kind, max, base) end
	local k = kind:lower()
	-- A verb that gives the charge. "Consumes your Frenzy Charges on use" is a consumer and "when you gain a Power
	-- Charge" a trigger, neither a source.
	local pats = { "gain an? " .. k .. " charge", "gains? %d+ " .. k .. " charges?", "grants? you an? " .. k .. " charge",
		"grants? an? " .. k .. " charge", "grant you an? " .. k .. " charge" }
	local function norm(line)
		return tostring(line or ""):lower():gsub("when you gain an? " .. k .. " charge", ""):gsub("when you gain an? charge", "")
	end
	local r = scanLines(env, function(line, where)
		local l = norm(line)
		for _, p in ipairs(pats) do if l:find(p) then return where .. ": " .. line end end
	end)
	if r then return r, false end
	-- "gain a Charge" / "gain a random Charge" (not "an additional ... Charge", which needs another source first).
	r = scanLines(env, function(line, where)
		local l = norm(line)
		if (l:find("gain an? random charge") or l:find("gain an? charge")) and not l:find("additional") then return where .. ": " .. line end
	end)
	if r then return r, true end
	return nil
end

local function statsOf(env)
	local ms = env.player and env.player.mainSkill
	return ms and ms.skillModList, ms
end

-- Skills Full DPS adds up (plus the main skill): where an ailment or state may come from besides the main skill.
local function fullDpsSkills(env)
	local list = {}
	for _, s in ipairs(env.player.activeSkillList or {}) do
		local sg = s.socketGroup
		if s == env.player.mainSkill or (sg and sg.includeInFullDPS and sg.enabled ~= false) then list[#list + 1] = s end
	end
	return list
end

local function skillName(s)
	return tostring(s.activeEffect and s.activeEffect.grantedEffect and s.activeEffect.grantedEffect.name or "?")
end

-- P(at least one success in n tries at chance p), p in 0..1.
local function atLeastOnce(p, n)
	if p <= 0 or n <= 0 then return 0 end
	if p >= 1 then return 1 end
	return 1 - (1 - p) ^ n
end

-- Combo the build's Combo skills ask for: the largest required count (active_skill_required_number_of_combo_stacks)
-- or maximum (Multiplier:ComboStacksMax) among its active skills. nil when no skill states one.
local function comboTarget(env)
	local best, who
	for _, s in ipairs(env.player.activeSkillList or {}) do
		for _, eff in ipairs(s.effectList or {}) do
			local ge = eff.grantedEffect
			for _, set in pairs(ge and ge.statSets or {}) do
				for _, st in ipairs(type(set) == "table" and set.constantStats or {}) do
					if st[1] == "active_skill_required_number_of_combo_stacks" and tonumber(st[2]) and (not best or st[2] > best) then
						best, who = tonumber(st[2]), "required by " .. tostring(ge.name)
					end
				end
			end
		end
		local mx = s.skillModList and s.skillModList:Sum("BASE", s.skillCfg, "Multiplier:ComboStacksMax") or 0
		if mx > 0 and (not best or mx > best) then best, who = mx, "maximum of " .. skillName(s) end
	end
	return best, who
end

-- Recalculate the main output the way groups_lib.select does. Returns an error string or nil.
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

-- Rules. Returns a list of { key, value, source, tier } (tier 1 = apply, 2 = report).
local function rules(env, output)
	local skillModList, mainSkill = statsOf(env)
	local skillCfg = mainSkill and mainSkill.skillCfg -- weapon/skill-flag conditioned chances only count under the skill's cfg
	local flags = mainSkill and mainSkill.skillFlags or {}
	local cu, eu = env.conditionsUsed, env.enemyConditionsUsed
	local speed = output.Speed or 0
	local res = {}
	local function add(tier, key, value, source)
		res[#res + 1] = { key = key, value = value, source = source, tier = tier }
	end
	local function byUptime(key, uptime, source)
		add(uptime >= MIN_UPTIME and 1 or 2, key, true, string.format("%s; uptime %.0f%%", source, uptime * 100))
	end

	-- Charges: something scales with them (consumer) and something generates them.
	for _, kind in ipairs({ "Power", "Frenzy", "Endurance" }) do
		if usedLike(env, kind .. "Charge") then
			local gen, randomOnly = chargeGenerator(env, output, kind)
			if gen and not randomOnly then
				add(1, "use" .. kind .. "Charges", true, gen .. "; modifiers scale with them")
			elseif gen then
				add(2, "use" .. kind .. "Charges", true, "Only a random-type Charge source: " .. gen)
			else
				add(2, "use" .. kind .. "Charges", true, "Modifiers scale with " .. kind .. " Charges, but nothing found that generates them")
			end
		end
	end

	-- Leeching: the main skill leeches and a modifier is conditional on leeching.
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
				if used(cu, k[3]) then add(1, k[2], true, "Main skill leeches " .. k[1] .. " and modifiers need you to be leeching it") end
			end
		end
		if any and used(cu, "Leeching") then add(1, "conditionLeeching", true, "Main skill leeches and modifiers need you to be leeching") end
	end

	-- Rage: PoB only evaluates Rage when the build can gain it (CalcPerform.lua:777); at maximum (measured below).
	if output.MaximumRage and output.MaximumRage > 0 then
		add(1, "multiplierRage", output.MaximumRage, "Build can gain Rage, maximum " .. output.MaximumRage)
	end

	-- Combo: only when something queries Multiplier:ComboStacks (the option's own ifMult gate), at the count a skill asks for.
	if used(env.multipliersUsed, "ComboStacks") then
		local n, who = comboTarget(env)
		if n then add(1, "multiplierCombo", n, "Combo " .. n .. " (" .. who .. ")")
		else add(2, "multiplierCombo", FALLBACK_COMBO, "A modifier uses Combo but no skill states a count (assumed " .. FALLBACK_COMBO .. ")") end
	end

	if used(cu, "HaveEnergyShield") and (output.EnergyShield or 0) > 0 then
		add(1, "conditionHaveEnergyShield", true, "Energy Shield " .. math.floor(output.EnergyShield) .. " and modifiers conditional on it")
	end

	-- Recent crits / non-crits: at least one in the last 4 s of the main skill's hits.
	local crit = output.CritChance
	if crit then
		local n = speed * RECENT
		if used(cu, "CritRecently") then
			byUptime("conditionCritRecently", atLeastOnce(crit / 100, n), string.format("Crit chance %.1f%% at %.2f uses/s", crit, speed))
		end
		if used(cu, "NonCritRecently") then
			byUptime("conditionNonCritRecently", atLeastOnce(1 - crit / 100, n), string.format("Non-crit chance %.1f%% at %.2f uses/s", 100 - crit, speed))
		end
	end

	-- Your own actions: steady state while the main skill is used.
	if mainSkill then
		if used(cu, "UsedSkillRecently") then add(1, "conditionUsedSkillRecently", true, "Main skill " .. skillName(mainSkill) .. " is used") end
		if used(cu, "AttackedRecently") and flags.attack then add(1, "conditionAttackedRecently", true, "Main skill is an Attack") end
		if used(cu, "CastSpellRecently") and flags.spell then add(1, "conditionCastSpellRecently", true, "Main skill is a Spell") end
		if used(cu, "HitRecently") and flags.hit and (output.HitChance or 0) > 0 then add(1, "conditionHitRecently", true, "Main skill hits") end
	end

	-- Enemy ailments and states from the main skill's per-hit chance and the ailment's duration. When the main skill
	-- can't inflict it, a Full DPS skill that can only makes it a suggestion (its rate isn't known here).
	local function otherSource(ailment, chanceMods)
		for _, s in ipairs(fullDpsSkills(env)) do
			if s ~= mainSkill and s.skillModList and not s.skillModList:Flag(s.skillCfg, "Cannot" .. ailment) then
				if s.skillModList:Sum("BASE", s.skillCfg, table.unpack(chanceMods)) > 0 then return skillName(s) end
			end
		end
	end
	local cannot = function(a) return skillModList and skillModList:Flag(skillCfg, "Cannot" .. a) end
	local ailments = {
		-- name, enemy condition, config key, "recently" condition + key, per-hit chance (0..100), duration
		{ "Shock", "Shocked", "conditionEnemyShocked", "ShockedEnemyRecently", "conditionShockedEnemyRecently", output.ShockChancePerHit or output.ShockChance, output.ShockDuration },
		{ "Chill", "Chilled", "conditionEnemyChilled", "ChilledEnemyRecently", "conditionChilledEnemyRecently", output.ChillChanceOnHit, output.ChillDuration },
		{ "Ignite", "Ignited", "conditionEnemyIgnited", "IgnitedEnemyRecently", "conditionIgnitedEnemyRecently", output.IgniteChancePerHit or output.IgniteChance, output.IgniteDuration },
		{ "Bleed", "Bleeding", "conditionEnemyBleeding", nil, nil, output.BleedChancePerHit or output.BleedChance, output.BleedDuration },
		{ "Poison", "Poisoned", "conditionEnemyPoisoned", nil, nil, output.PoisonChancePerHit or output.PoisonChance, output.PoisonDuration },
	}
	if skillModList then
		ailments[#ailments + 1] = { "Daze", "Dazed", "conditionEnemyDazed", nil, nil,
			math.min(100, skillModList:Sum("BASE", skillCfg, "DazeChance")), DAZE_DURATION }
	end
	for _, a in ipairs(ailments) do
		local name, cond, key, rcond, rkey, chance, dur = a[1], a[2], a[3], a[4], a[5], tonumber(a[6]) or 0, tonumber(a[7]) or DEFAULT_AILMENT_DURATION
		local wantState, wantRecent = used(eu, cond), rcond and used(cu, rcond)
		if wantState or wantRecent then
			if chance > 0 and not cannot(name) then
				local src = string.format("%s: %.1f%% %s chance per hit at %.2f uses/s", skillName(mainSkill), chance, name, speed)
				if wantState then byUptime(key, atLeastOnce(chance / 100, speed * dur), src .. string.format(", %.1f s duration", dur)) end
				if wantRecent then byUptime(rkey, atLeastOnce(chance / 100, speed * RECENT), src) end
			else
				local other = otherSource(name, { "Enemy" .. name .. "Chance", name .. "Chance" })
				local why = other and ("Only " .. other .. " in Full DPS can inflict " .. name .. "; the main skill can't")
				if why then
					if wantState then add(2, key, true, why) end
					if wantRecent then add(2, rkey, true, why) end
				end
			end
		end
	end

	-- Buildup states (Freeze, Electrocute, Heavy Stun): time to fill the enemy's bar at the main skill's average
	-- buildup per hit. The state itself is never assumed (bosses gain buildup resistance); "Recently" is Tier 1 when
	-- the bar fills within 4 s.
	for _, b in ipairs({
		{ "Freeze", "Frozen", "conditionEnemyFrozen", "FrozenEnemyRecently", "conditionFrozenEnemyRecently", output.FreezeBuildupAvg },
		{ "Electrocute", "Electrocuted", "conditionEnemyElectrocuted", nil, nil, output.ElectrocuteBuildupAvg },
		{ "Heavy Stun", "HeavyStunned", "conditionEnemyHeavyStunned", "StunnedEnemyRecently", "conditionStunnedEnemyRecently", output.HeavyStunBuildupAvg },
	}) do
		local name, cond, key, rcond, rkey, buildup = b[1], b[2], b[3], b[4], b[5], tonumber(b[6]) or 0
		local t = (buildup > 0 and speed > 0) and 100 / (buildup * speed) or math.huge
		local src = buildup > 0 and string.format("%s builds %.2f%% %s per hit: about %.0f s to fill", skillName(mainSkill), buildup, name, t) or ("Main skill builds no " .. name)
		if used(eu, cond) and buildup > 0 then add(2, key, true, src) end
		if rcond and used(cu, rcond) and buildup > 0 then add(t <= RECENT and 1 or 2, rkey, true, src) end
	end

	-- Situational, always Tier 2.
	if used(cu, "BeenHitRecently") then add(2, "conditionBeenHitRecently", true, "Modifiers conditional on being hit recently") end
	if used(cu, "CritInPast8Sec") then add(2, "conditionCritInPast8Sec", true, "Modifiers conditional on a crit in the past 8s") end
	if used(cu, "KilledRecently") then add(2, "conditionKilledRecently", true, "Needs kills (none on a single boss)") end
	if used(cu, "KilledShockedLast3Seconds") then add(2, "conditionKilledShockedLast3Seconds", true, "Needs a Shocked kill every 3s (adds)") end
	-- Onslaught: PoB already grants it when a granting modifier's own conditions hold (CalcPerform.lua:614).
	if used(cu, "Onslaught") and not env.player.modDB:Flag(nil, "Onslaught") then
		add(2, "buffOnslaught", true, "Modifiers need Onslaught; the toggle also adds the buff itself")
	end
	return res
end

-- Never applied or suggested by the generic pass: an assumed Shock effect is either inert or above what the build
-- applies, and these are calculation modes, not combat state.
local NEVER = { conditionShockEffect = true, DisableEHPGainOnBlock = true, EVBypass = true, ignoreItemDisablers = true, ignoreJewelLimits = true }
local GATES = { "ifCond", "ifEnemyCond", "ifMinionCond", "ifMult", "ifFlag", "ifEnemyMult", "ifMinionFlag" }

-- Generic pass: every check option PoB shows because a modifier in this build depends on it. Covers class- and
-- skill-specific state (minion conditions, ascendancy buffs, skill toggles) the rules above don't name.
local function discovered(seen)
	local res = {}
	local ct = build.configTab
	local ok, varList = pcall(LoadModule, "Modules/ConfigOptions")
	if not ok or type(varList) ~= "table" then return res end
	local showAll = ct.toggleConfigs
	ct.toggleConfigs = false
	for _, v in ipairs(varList) do
		local key = v.var
		local ctl = key and ct.varControls[key]
		if key and ctl and v.type == "check" and not seen[key] and not NEVER[key] then
			local gated = false
			for _, g in ipairs(GATES) do if v[g] then gated = true break end end
			if gated then
				local sok, shown = pcall(function() return type(ctl.shown) == "function" and ctl.shown() or ctl.shown end)
				if sok and shown then
					local label = tostring(v.label or key):gsub("%^x%x%x%x%x%x%x", ""):gsub("%^%d", "")
					res[#res + 1] = { key = key, value = true, tier = 2, source = "A modifier in the build depends on it (" .. label .. ")" }
				end
			end
		end
	end
	ct.toggleConfigs = showAll
	return res
end

-- Detect against the currently loaded, calculated build.
-- Returns { apply = {rule...}, suggest = {rule...} } with already-configured inputs removed.
function M.detect(generic)
	local env = envOf()
	if not (env and env.player and env.player.modDB and build.configTab) then
		return { apply = {}, suggest = {} }
	end
	local output = build.calcsTab.mainOutput or {}
	local input = build.configTab.input
	local res = { apply = {}, suggest = {} }
	local seen = {}
	local all = rules(env, output)
	for _, r in ipairs(all) do seen[r.key] = true end
	if generic then for _, r in ipairs(discovered(seen)) do all[#all + 1] = r end end
	for _, r in ipairs(all) do
		if input[r.key] == nil then
			if r.tier == 1 then res.apply[#res.apply + 1] = r else res.suggest[#res.suggest + 1] = r end
		end
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
	local det = level and M.detect(wantDeltas) or { apply = {}, suggest = {} }
	local result = {
		baselineDPS = out("TotalDPS"), configuredDPS = out("TotalDPS"),
		baselineEHP = out("TotalEHP"), configuredEHP = out("TotalEHP"),
		applied = {}, suggested = {},
	}
	local input = build.configTab.input
	local baseFull = out("FullDPS")
	result.baselineFullDPS, result.configuredFullDPS = baseFull, baseFull
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
		-- Leave-one-out: each applied input's contribution on top of the others. One that moves none of TotalDPS /
		-- FullDPS / TotalEHP is taken back out (reported in `inert`): the build has a consumer for it on paper only.
		local full = {}
		for _, k in ipairs(MEASURE_STATS) do full[k] = out(k) end
		local kept = {}
		result.inert = {}
		for _, r in ipairs(det.apply) do
			input[r.key] = nil
			local e = recalc(pob)
			local entry = { key = r.key, value = r.value, source = r.source, tier = 1 }
			local moved = e ~= nil -- a failed trial is kept (not proof of "no change") and shown
			if e then entry.error = e else
				entry.contribution = {}
				for _, k in ipairs(MEASURE_STATS) do
					local a, b = out(k), full[k]
					if a and b then
						local pct = a ~= 0 and (b / a - 1) * 100 or (b ~= 0 and math.huge or 0)
						if math.abs(pct) >= INERT_PCT then moved = true; entry.contribution[k] = round(pct) end
					end
				end
				entry.contribution = pob.object(entry.contribution)
			end
			input[r.key] = r.value
			if moved then kept[#kept + 1] = entry else result.inert[#result.inert + 1] = entry; input[r.key] = nil end
		end
		local err2 = recalc(pob)
		if err2 then result.error = err2 end
		result.configuredDPS = out("TotalDPS")
		result.configuredEHP = out("TotalEHP")
		result.baselineFullDPS, result.configuredFullDPS = baseFull, out("FullDPS")
		result.applied = kept
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
		-- With deltas, a toggle that changes neither DPS nor EHP is noise, and one that only lowers them is a debuff on
		-- you (Are you Frozen? / on Low Life?), not a state worth enabling.
		local measured = wantDeltas and s.dpsDelta ~= nil
		if not measured or s.dpsDelta > 0 or (s.ehpDelta or 0) > 0 then
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
