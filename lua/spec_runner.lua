-- Runs PoB2's own busted specs (vendor/pob2/spec/System/*_spec.lua) on this runtime, one file per process, as PoB's
-- CI does (busted --lua=luajit ../spec/System/X_spec.lua with CI set). Their expected values were written against
-- LuaJIT, so a pass here is parity for that scenario.
--   CI=true build/native/pobcalc lua/spec_runner.lua vendor/pob2/spec/System/TestDefence_spec.lua   (from the repo root)
-- Prints one line per failing test and a summary line "<file>: N passed, N failed, N errors"; exits 1 on any failure.
--
-- Only the busted/luassert surface the specs use is implemented: describe/it/setup/teardown/before_each/after_each
-- and assert's equals, same, near, matches, truthy/falsy, True/False, nil, table/string, error/errors, with the
-- is/are/has/not/no modifiers. Semantics follow luassert: equals is ==, same is a deep compare ignoring metatables.
local here = (debug.getinfo(1, "S").source:sub(2)):match("^(.*)[/\\]") or "."
local root = pobhost.getcwd()
local specFile = ...
if not specFile and arg then specFile = arg[1] end
assert(specFile, "usage: pobcalc lua/spec_runner.lua <spec file>")
if specFile:sub(1, 1) ~= "/" then specFile = root .. "/" .. specFile end
local label = specFile:match("[^/]+$")
local stderr = io.stderr

---------------------------------------------------------------------------------------------------- assertions

local function deepcompare(a, b, seen)
	if a == b then return true end
	if type(a) ~= "table" or type(b) ~= "table" then return false end
	seen = seen or {}
	if seen[a] == b then return true end
	seen[a] = b
	for k, v in next, a do
		local w = rawget(b, k)
		if w == nil or not deepcompare(v, w, seen) then return false end
	end
	for k in next, b do
		if rawget(a, k) == nil then return false end
	end
	return true
end

local function show(v)
	if type(v) == "string" then return string.format("%q", v) end
	if type(v) == "number" then return string.format("%.17g", v) end
	if type(v) == "table" then
		local parts, n = {}, 0
		for k, x in pairs(v) do
			n = n + 1
			if n > 8 then parts[#parts + 1] = "…"; break end
			parts[#parts + 1] = tostring(k) .. "=" .. (type(x) == "table" and "{…}" or show(x))
		end
		return "{" .. table.concat(parts, ", ") .. "}"
	end
	return tostring(v)
end

-- err without a leading "file:line: " when the expected message has none (luassert does the same).
local function errorMatches(err, expected)
	if expected == nil then return true end
	if err == expected then return true end
	if type(err) == "string" and type(expected) == "string" then
		return err:gsub("^.-:%d+: ", "", 1) == expected
	end
	return false
end

-- name -> function(args) returning ok, description
local checks = {
	equals = function(a) return a[1] == a[2], "equal to " .. show(a[1]) .. ", got " .. show(a[2]) end,
	same = function(a)
		local ok
		if type(a[1]) == "table" and type(a[2]) == "table" then ok = deepcompare(a[1], a[2]) else ok = a[1] == a[2] end
		return ok, "same as " .. show(a[1]) .. ", got " .. show(a[2])
	end,
	near = function(a)
		local e, v, tol = a[1], a[2], a[3]
		return type(v) == "number" and v >= e - tol and v <= e + tol, "within " .. show(tol) .. " of " .. show(e) .. ", got " .. show(v)
	end,
	matches = function(a)
		return type(a[2]) == "string" and a[2]:find(a[1], a[3], a[4]) ~= nil, "matching " .. show(a[1]) .. ", got " .. show(a[2])
	end,
	truthy = function(a) return a[1] ~= nil and a[1] ~= false, "truthy, got " .. show(a[1]) end,
	falsy = function(a) return a[1] == nil or a[1] == false, "falsy, got " .. show(a[1]) end,
	["true"] = function(a) return a[1] == true, "true, got " .. show(a[1]) end,
	["false"] = function(a) return a[1] == false, "false, got " .. show(a[1]) end,
	["nil"] = function(a) return a[1] == nil, "nil, got " .. show(a[1]) end,
	table = function(a) return type(a[1]) == "table", "a table, got " .. type(a[1]) end,
	string = function(a) return type(a[1]) == "string", "a string, got " .. type(a[1]) end,
	error = function(a)
		local ok, err = pcall(a[1])
		return (not ok) and errorMatches(err, a[2]), "an error" .. (a[2] and " " .. show(a[2]) or "") .. (ok and ", got none" or ", got " .. show(err))
	end,
}
checks.equal = checks.equals
checks.errors = checks.error
local modifiers = { is = true, are = true, has = true, was = true, does = true, has_no = true }

local function makeAssert(tokens)
	return setmetatable({}, {
		__index = function(_, key)
			local t = { unpack(tokens) }
			for part in key:gmatch("[^_]+") do t[#t + 1] = part:lower() end
			return makeAssert(t)
		end,
		__call = function(_, ...)
			local negate, name = false, nil
			for _, tok in ipairs(tokens) do
				if tok == "not" or tok == "no" then negate = not negate
				elseif checks[tok] then name = tok
				elseif not modifiers[tok] then error("spec_runner: unsupported assertion word '" .. tok .. "'", 2) end
			end
			if not name then
				-- plain assert(v, msg)
				local v, msg = ...
				if not v then error(msg or "assertion failed!", 2) end
				return ...
			end
			local args = table.pack(...)
			local ok, desc = checks[name](args)
			if negate then ok = not ok end
			if not ok then
				local msg = args[name == "near" and 4 or (name == "error" and 3) or 3]
				error({ assertion = true, message = "expected " .. (negate and "not " or "") .. desc .. (type(msg) == "string" and " (" .. msg .. ")" or "") }, 2)
			end
			return ...
		end,
	})
end
-- The spec file's environment, as busted gives each file: reads fall through to _G, writes stay here (so a spec's
-- `launch = mock` doesn't replace PoB's own global), and the DSL and luassert's assert live only here.
local env = setmetatable({}, { __index = _G })
env.assert = makeAssert({})
-- LuaJIT's getfenv, which TestCompareBuySimilar uses on a PoB closure. PoB's own code never calls getfenv/setfenv,
-- so this lives in the harness, not the runtime. A function's environment is its "(ENV)" upvalue (patch 04's name).
function env.getfenv(f)
	if f == nil then f = 1 end
	if type(f) == "number" then
		if f == 0 then return _G end
		local info = debug.getinfo(f + 1, "f")
		if not info then error("bad argument #1 to 'getfenv' (invalid level)", 2) end
		f = info.func
	end
	for i = 1, math.huge do
		local name, value = debug.getupvalue(f, i)
		if name == nil then break end
		if name == "(ENV)" then return value end
	end
	return _G
end

---------------------------------------------------------------------------------------------------- busted DSL

local function newBlock(name, parent)
	return { name = name, parent = parent, children = {}, setup = {}, teardown = {}, before = {}, after = {} }
end
local rootBlock = newBlock(nil, nil)
local current = rootBlock

function env.describe(name, fn)
	local block = newBlock(name, current)
	table.insert(current.children, { kind = "describe", block = block })
	local saved = current
	current = block
	fn()
	current = saved
end
env.context = env.describe
-- it(name) with no function is pending in busted (TestSocketables runs its checks while defining the tests).
function env.it(name, fn) table.insert(current.children, { kind = fn and "it" or "pending", name = name, fn = fn }) end
function env.pending(name) table.insert(current.children, { kind = "pending", name = name }) end
function env.setup(fn) table.insert(current.setup, fn) end
function env.teardown(fn) table.insert(current.teardown, fn) end
env.lazy_setup, env.strict_setup, env.lazy_teardown, env.strict_teardown = env.setup, env.setup, env.teardown, env.teardown
function env.before_each(fn) table.insert(current.before, fn) end
function env.after_each(fn) table.insert(current.after, fn) end

local passed, failed, errored, skipped = 0, 0, 0, 0

local function fullName(block, leaf)
	local parts = { leaf }
	while block and block.name do table.insert(parts, 1, block.name); block = block.parent end
	return table.concat(parts, " ")
end

local function failure(err)
	if type(err) == "table" and err.assertion then return "FAIL", err.message end
	return "ERROR", debug.traceback(tostring(err), 2)
end

local function runHooks(block, field, outerFirst)
	local blocks = {}
	local b = block
	while b do table.insert(blocks, outerFirst and 1 or #blocks + 1, b); b = b.parent end
	for _, x in ipairs(blocks) do
		for _, fn in ipairs(x[field]) do fn() end
	end
end

local function runBlock(block)
	local ok, err = xpcall(function() for _, fn in ipairs(block.setup) do fn() end end, function(e) return select(2, failure(e)) end)
	if not ok then
		errored = errored + 1
		stderr:write("ERROR setup: ", fullName(block, ""), "\n  ", tostring(err), "\n")
		return
	end
	for _, child in ipairs(block.children) do
		if child.kind == "describe" then
			runBlock(child.block)
		elseif child.kind == "pending" then
			skipped = skipped + 1
		else
			local kind, msg
			local okRun = xpcall(function()
				runHooks(block, "before", true)
				child.fn()
			end, function(e) kind, msg = failure(e) end)
			local okAfter = xpcall(function() runHooks(block, "after", false) end, function(e) if okRun then kind, msg = failure(e) end end)
			if okRun and okAfter then
				passed = passed + 1
			else
				if kind == "FAIL" then failed = failed + 1 else errored = errored + 1 end
				stderr:write(kind, ": ", fullName(block, child.name), "\n  ", tostring(msg), "\n")
			end
		end
	end
	xpcall(function() for _, fn in ipairs(block.teardown) do fn() end end, function(e)
		errored = errored + 1
		stderr:write("ERROR teardown: ", fullName(block, ""), "\n  ", tostring(e), "\n")
	end)
end

---------------------------------------------------------------------------------------------------- run

local headless = dofile(here .. "/headless.lua")
headless.init({ vendor = root .. "/vendor/pob2", keepCI = true })
-- headless sends print to stderr; specs print little, keep it there.
local chunk, loadErr = loadfile(specFile, "t", env)
if not chunk then
	stderr:write("ERROR loading ", label, ": ", loadErr, "\n")
	os.exit(1)
end
local okLoad, errLoad = xpcall(chunk, debug.traceback)
if not okLoad then
	stderr:write("ERROR running ", label, ": ", tostring(errLoad), "\n")
	os.exit(1)
end
local t0 = os.clock()
runBlock(rootBlock)
io.stdout:write(string.format("%s: %d passed, %d failed, %d errors%s (%.1f s)\n", label, passed, failed, errored,
	skipped > 0 and (", " .. skipped .. " pending") or "", os.clock() - t0))
os.exit((failed + errored) == 0 and 0 or 1)
