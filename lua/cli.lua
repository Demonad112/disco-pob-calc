-- Native CLI for development and the native-vs-wasm check:
--   build/native/pobcalc lua/cli.lua <code-or-xml-file> [--groups]      (run from the repo root)
-- Prints the init line and the calc JSON (calc.lua's shapes) on stdout; PoB's console goes to stderr.
local here = (debug.getinfo(1, "S").source:sub(2)):match("^(.*)[/\\]") or "."
local root = pobhost.getcwd()
local file, flag = ...
if not file and arg then file, flag = arg[1], arg[2] end
assert(file, "usage: pobcalc lua/cli.lua <code-or-xml-file> [--groups]")
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
io.stdout:write(calc.calc(text, flag == "--groups"), "\n")
