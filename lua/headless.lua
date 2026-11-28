-- Adapter around PoB2's own HeadlessWrapper (vendor/pob2 is never edited).
-- Loads PoB once per Lua state, then load(xml) / snapshot() any number of builds.
--
-- Ported from Demonad112/upgraded-disco-companion tools/pob2/headless.lua (commit e300acf). Changes:
--   * runs on PUC Lua 5.2.4 + our patches (native/), not LuaJIT: no ffi (chdir/getcwd come from `pobhost`),
--     and a `jit` stub because Launch.lua calls jit.opt.start;
--   * installs real zlib Inflate/Deflate right after HeadlessWrapper defines its stubs (_SimpleGraphic.def.lua);
--   * the vendor directory and pin come from init(opts) instead of this file's location / PIN.json;
--   * lowers the GC pause after start (PoB sets 400, which costs ~4x the live heap; memory matters in a browser).
local host = pobhost

local M = {}

local loaded = false
M.pinCommit = nil
M.gcPause = 200

-- dkjson writes an empty table as []; maps keyed by stat name must stay {} when empty.
local function object(t)
	return setmetatable(t or {}, { __jsontype = "object" })
end
local function array(t)
	return setmetatable(t or {}, { __jsontype = "array" })
end

-- LuaJIT's `jit` library, as far as PoB touches it (Launch.lua: jit.opt.start; Main.lua: require("jit").off()).
-- version_num is left out on purpose: sha2.lua reads a `jit` table with version_num as LuaJIT.
local function installJitStub()
	local noop = function() end
	local jitStub = { on = noop, off = noop, flush = noop, status = function() return false end,
		opt = { start = noop }, version = "PUC " .. _VERSION .. " (pobcalc)", os = "Other", arch = "wasm32" }
	_G.jit = jitStub
	package.loaded.jit = jitStub
end

-- HeadlessWrapper runs dofile("_SimpleGraphic.def.lua"), whose Inflate/Deflate return "". Swap in zlib right after.
local function hookDefFile()
	local realDofile = dofile
	dofile = function(name, ...)
		local r = table.pack(realDofile(name, ...))
		if name == "_SimpleGraphic.def.lua" then
			Inflate = function(data)
				local out, err = host.inflate(data)
				return out, err
			end
			Deflate = function(data, isGzip)
				local out, err = host.deflate(data, isGzip)
				return out, err
			end
			dofile = realDofile
		end
		return table.unpack(r, 1, r.n)
	end
end

-- Mirrors PoB's own CI: LUA_PATH=../runtime/lua/?.lua, cwd = src/, HeadlessWrapper with no argv.
-- opts.vendor: directory holding PoB2's src/ and runtime/ (default "vendor/pob2"); opts.pinCommit: shown in output.
function M.init(opts)
	if loaded then
		return
	end
	opts = opts or {}
	local vendor = opts.vendor or M.vendor or "vendor/pob2"
	if vendor:sub(1, 1) ~= "/" then
		vendor = host.getcwd() .. "/" .. vendor
	end
	M.vendor = vendor
	M.pinCommit = opts.pinCommit or M.pinCommit
	if opts.gcPause then M.gcPause = opts.gcPause end
	package.path = vendor .. "/runtime/lua/?.lua;" .. vendor .. "/runtime/lua/?/init.lua;" .. package.path
	local ok, err = host.chdir(vendor .. "/src")
	if not ok then
		error("cannot chdir to " .. vendor .. "/src: " .. tostring(err))
	end
	-- Console output from PoB (print/ConPrintf) goes to stderr so stdout stays clean for JSON.
	print = function(...)
		local parts = {}
		for i = 1, select("#", ...) do
			parts[i] = tostring((select(i, ...)))
		end
		io.stderr:write(table.concat(parts, "\t"), "\n")
	end
	installJitStub()
	hookDefFile()
	-- Always use the committed ModCache, as PoB desktop does. HeadlessWrapper skips it when CI is set.
	-- opts.keepCI leaves CI alone (PoB's own spec runs set it, so mods are parsed instead of read from the cache).
	local getenv = os.getenv
	os.getenv = function(name)
		if name == "CI" and not opts.keepCI then
			return nil
		end
		return getenv(name)
	end
	-- On a startup error HeadlessWrapper prints it and waits on io.read; never block on stdin.
	local ioRead = io.read
	io.read = function() return nil end
	local savedArg = arg
	arg = {}
	local ok, startErr = pcall(dofile, "HeadlessWrapper.lua")
	arg = savedArg
	os.getenv = getenv
	io.read = ioRead
	if not ok then
		error("PoB failed to start: " .. tostring(startErr))
	end
	if launch and launch.promptMsg then
		error("PoB failed to start: " .. M.strip(tostring(launch.promptMsg)))
	end
	if not build then
		error("PoB failed to start: " .. M.strip(tostring(launch and launch.promptMsg)))
	end
	collectgarbage("setpause", M.gcPause)
	loaded = true
end

-- Remove PoB colour codes (^0-^9, ^xRRGGBB).
function M.strip(s)
	return (s:gsub("%^x%x%x%x%x%x%x", ""):gsub("%^%d", ""))
end

local function pendingError()
	local msg = launch.promptMsg
	if msg then
		-- PoB's state is unreliable after an error (the failed build stays in BUILD mode): restart it on next use.
		loaded = false
		msg = M.strip(msg)
		-- launch:ShowErrMsg wraps the message in instructions for the desktop UI; keep only the error itself.
		msg = msg:gsub("^Error:%s*", ""):gsub("\n[^\n]*Press Enter/Escape.*$", ""):gsub("\nv[%w%.]+[^\n]*$", "")
		return (msg:gsub("^%s+", ""):gsub("%s+$", ""))
	end
	return nil
end

-- True when PoB must be started again before the next build (after a PoB error).
function M.needsRestart()
	return not loaded
end

function M.newBuild()
	M.init()
	newBuild()
	return pendingError()
end

-- Load an XML export (already decoded). Returns loadError or nil.
function M.load(xml)
	M.init()
	local ok, err = pcall(loadBuildFromXML, xml)
	if ok then
		-- A second frame settles anything queued by the first (same as interacting once in the UI).
		ok, err = pcall(runCallback, "OnFrame")
	end
	if not ok then
		loaded = false
		return M.strip(tostring(err))
	end
	local e = pendingError()
	if e then
		return e
	end
	if not (build.calcsTab and build.calcsTab.mainOutput) then
		return "no calc output after load"
	end
	return nil
end

-- JSON-safe scalar: numbers stay numbers unless non-finite (then "inf"/"-inf"/"nan"); strings and booleans as is.
local function scalar(v)
	local t = type(v)
	if t == "number" then
		if v ~= v then
			return "nan"
		elseif v == math.huge then
			return "inf"
		elseif v == -math.huge then
			return "-inf"
		end
		return v
	elseif t == "string" or t == "boolean" then
		return v
	end
	return nil
end

-- Values PoB writes with tostring(); read them back as numbers where they are numbers.
local function parsed(s)
	local n = tonumber(s)
	if n then
		return scalar(n)
	end
	return s
end

-- Hidden granted effects (Staggering Palm's "Projectile", Charged Staff's "Charged Shockwave") reach Full DPS under
-- their bare name. name -> the visible active skill of the socket group that grants it, from the Full DPS skills of the
-- main env; a name that two groups grant with different parents is left bare (the rows carry no skill reference).
local function hiddenParents()
	local env = build and build.calcsTab and build.calcsTab.mainEnv
	local map, clash = {}, {}
	for _, s in ipairs(env and env.player and env.player.activeSkillList or {}) do
		local ge = s.activeEffect and s.activeEffect.grantedEffect
		local sg = s.socketGroup
		if ge and ge.hidden and sg then
			local parent
			for _, d in ipairs(sg.displaySkillList or {}) do
				local dge = d.activeEffect and d.activeEffect.grantedEffect
				if dge and not dge.hidden then parent = dge.name break end
			end
			if parent then
				if map[ge.name] and map[ge.name] ~= parent then clash[ge.name] = true end
				map[ge.name] = parent
			end
		end
	end
	for k in pairs(clash) do map[k] = nil end
	return map
end

-- name stays PoB's own (what export.FullDPSSkill and anything keyed on it use); label is for display:
-- "<parent skill> › <name>" for a hidden granted effect, else the name.
local function fullDpsRows(skillDps)
	local rows = array()
	local parents = hiddenParents()
	for _, s in ipairs(skillDps or {}) do
		local count = s.count or 1
		local parent = s.name and parents[s.name]
		rows[#rows + 1] = {
			name = s.name,
			label = parent and (parent .. " › " .. s.name) or s.name,
			parent = parent,
			count = count,
			dps = scalar(s.dps),
			value = scalar(s.dps * count),
			skillPart = s.skillPart or "",
			source = s.source or s.trigger or "",
		}
	end
	return rows
end

-- What PoB would write into an export right now: PlayerStat / MinionStat / FullDPSSkill from build:SaveDB.
local function exported()
	local xmlText = build:SaveDB("x")
	local out = { PlayerStat = object(), MinionStat = object(), FullDPSSkill = array() }
	if not xmlText then
		return out
	end
	local dbXML = common.xml.ParseXML(xmlText)
	for _, node in ipairs(dbXML[1]) do
		if type(node) == "table" and node.elem == "Build" then
			for _, child in ipairs(node) do
				if type(child) == "table" then
					local a = child.attrib or {}
					if child.elem == "PlayerStat" or child.elem == "MinionStat" then
						out[child.elem][a.stat] = parsed(a.value)
					elseif child.elem == "FullDPSSkill" then
						out.FullDPSSkill[#out.FullDPSSkill + 1] = {
							stat = a.stat,
							value = parsed(a.value),
							skillPart = a.skillPart or "",
							source = a.source or "",
						}
					end
				end
			end
		end
	end
	return out
end

-- Snapshot of the loaded build. Every displayStats / extraSaveStats key present in mainOutput (childStat keys
-- dotted, e.g. MainHand.Accuracy), regardless of the skill-flag filter PoB applies when saving.
function M.snapshot(loadError)
	local snap = {
		pobVersion = launch and launch.versionNumber or nil,
		pinCommit = M.pinCommit,
		loadError = loadError or require("dkjson").null,
	}
	if loadError then
		return snap
	end
	local output = build.calcsTab.mainOutput
	local stats = object()
	for _, d in ipairs(build.displayStats) do
		if d.stat and d.stat ~= "SkillDPS" then
			local v = output[d.stat]
			local key = d.stat
			if d.childStat then
				v = type(v) == "table" and v[d.childStat] or nil
				key = d.stat .. "." .. d.childStat
			end
			v = scalar(v)
			if v ~= nil then
				stats[key] = v
			end
		end
	end
	for _, stat in ipairs(build.extraSaveStats) do
		local v = scalar(output[stat])
		if v ~= nil then
			stats[stat] = v
		end
	end
	if output.Minion then
		for _, d in ipairs(build.minionDisplayStats) do
			if d.stat then
				local v = scalar(output.Minion[d.stat])
				if v ~= nil then
					stats["Minion." .. d.stat] = v
				end
			end
		end
	end
	snap.stats = stats
	-- Exact max resistances (PoB keeps no output.<Elem>ResistMax; Missing<Elem>Resist = max - final, so their sum is the
	-- max). Kept out of `stats`/`export` so those stay byte-for-byte what PoB itself writes (oracle parity).
	local resistMax = object()
	for _, el in ipairs({ "Fire", "Cold", "Lightning", "Chaos" }) do
		local final, missing = output[el .. "Resist"], output["Missing" .. el .. "Resist"]
		if type(final) == "number" and type(missing) == "number" then
			resistMax[el .. "ResistMax"] = final + missing
		end
	end
	snap.resistMax = resistMax
	snap.fullDpsSkills = fullDpsRows(output.SkillDPS)
	snap.export = exported()
	return snap
end

M.object = object
M.array = array

-- dkjson with every key in sorted order, so output is deterministic. `compact` drops the indent.
function M.encode(value, compact)
	local keys, seen = {}, {}
	local function collect(t)
		for k, v in pairs(t) do
			if type(k) == "string" and not seen[k] then
				seen[k] = true
				keys[#keys + 1] = k
			end
			if type(v) == "table" then
				collect(v)
			end
		end
	end
	collect(value)
	table.sort(keys)
	return require("dkjson").encode(value, { indent = not compact, keyorder = keys })
end

return M
