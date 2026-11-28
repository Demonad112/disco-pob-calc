-- Native CLI for development and the native-vs-wasm check:
--   build/native/pobcalc lua/cli.lua <code-or-xml-file> [--groups] [--auto-config[=suggest]]   (run from the repo root)
-- Prints the init line and the calc JSON (calc.lua's shapes) on stdout; PoB's console goes to stderr.
local here = (debug.getinfo(1, "S").source:sub(2)):match("^(.*)[/\\]") or "."
local root = pobhost.getcwd()
local file = ...
local flags = {}
if arg then
	file = file or arg[1]
	for i = 2, #arg do flags[arg[i]] = true end
end
assert(file, "usage: pobcalc lua/cli.lua <code-or-xml-file> [--groups] [--auto-config[=suggest]] [--set=key=value]... [--then=key=value]... [--measure=key[:v1,v2]]...")
local f = assert(io.open(file, "rb"))
local text = f:read("*a")
f:close()
local calc = dofile(here .. "/calc.lua")
io.stdout:write(calc.init({ vendor = root .. "/vendor/pob2", pinCommit = os.getenv("POB_PIN") }), "\n")
if not text:find("^%s*<") then
	-- A PoB code: base64url, then zlib (PoB's own decoding, with runtime/lua/base64.lua).
	local compact = text:gsub("%s", ""):gsub("^%?+", ""):gsub("%?+$", "")
	local raw = require("base64").decode((compact:gsub("-", "+"):gsub("_", "/")))
	text = assert(pobhost.inflate(raw))
end
local overrides
for _, a in ipairs(arg or {}) do
	local k, v = a:match("^%-%-set=([%w_]+)=(.*)$")
	if k then
		overrides = overrides or {}
		if v == "true" then overrides[k] = true elseif v == "false" then overrides[k] = false else overrides[k] = tonumber(v) or v end
	end
end
local auto = flags["--auto-config=suggest"] and "suggest" or (flags["--auto-config"] and "apply") or nil
io.stdout:write(calc.calc(text, flags["--groups"] == true, { autoConfig = auto, overrides = overrides }), "\n")
-- --then=key=value: calc.setConfig on the loaded build with these overrides (one more JSON line).
local after, measures
for _, a in ipairs(arg or {}) do
	local k, v = a:match("^%-%-then=([%w_]+)=(.*)$")
	if k then
		after = after or {}
		if v == "true" then after[k] = true elseif v == "false" then after[k] = false else after[k] = tonumber(v) or v end
	end
	local mk, mv = a:match("^%-%-measure=([%w_]+):?(.*)$")
	if mk then
		local values
		if mv ~= "" then values = {}; for n in mv:gmatch("[^,]+") do values[#values + 1] = tonumber(n) end end
		measures = measures or {}
		measures[#measures + 1] = { key = mk, values = values }
	end
end
if after then io.stdout:write(calc.setConfig({ autoConfig = auto, overrides = after, catalog = false, trials = 0 }), "\n") end
if measures then io.stdout:write(calc.measure(measures), "\n") end
