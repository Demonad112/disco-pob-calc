-- Spec for native/patches: compound assignment (01), 5.1 gsub replacement rule (02), LuaJIT integer format (03),
-- _ENV as an ordinary name (04),
-- plus the host modules. Run: build/native/pobcalc test/lua/compound_spec.lua  (exits non-zero on failure)
local passed, failed = 0, 0
local function check(name, cond)
	if cond then passed = passed + 1 else failed = failed + 1; io.stderr:write("FAIL: ", name, "\n") end
end
local function compiles(src) return (loadstring(src)) ~= nil end

-- 01 compound assignment
do local a = 1; a += 2; check("local +=", a == 3) end
do local a = 10; a -= 4; check("local -=", a == 6) end
do local a = 3; a *= 4; check("local *=", a == 12) end
do local a = 12; a /= 8; check("local /=", a == 1.5) end
do local a = 7; a %= 4; check("local %=", a == 3) end
do local a = 3; a ^= 2; check("local ^=", a == 9) end
do local s = "a"; s ..= "b" .. "c"; check("local ..=", s == "abc") end
do local a = 2; a += 3 * 4; check("rhs precedence", a == 14) end
do local a = 10; a -= 2 - 1; check("rhs is one expression", a == 9) end
do G_COMPOUND = 5; G_COMPOUND += 1; check("global +=", G_COMPOUND == 6); G_COMPOUND = nil end
do local u = 1; (function() u += 10 end)(); check("upvalue +=", u == 11) end
do local t = { n = 1 }; t.n += 1; check("field +=", t.n == 2) end
do local t = { a = { b = { c = 1 } } }; t.a.b.c += 5; check("nested field +=", t.a.b.c == 6) end
do
	local t, calls = { 0, 0 }, 0
	local function k() calls = calls + 1; return 2 end
	t[k()] += 7
	check("index evaluated once", t[2] == 7 and calls == 1)
end
do
	local calls = 0
	local t = { v = 1 }
	local function get() calls = calls + 1; return t end
	get().v += 1
	check("prefix evaluated once", t.v == 2 and calls == 1)
end
do
	local mt = { __index = function() return 100 end, __newindex = function(t, k, v) rawset(t, k, v + 1) end }
	local t = setmetatable({}, mt)
	t.x += 1
	check("metamethods apply", rawget(t, "x") == 102)
end
do local a, b = 1, 2; a += b; b += a; check("sequential", a == 3 and b == 5) end
do local t = { 1, 2, 3 }; for i = 1, #t do t[i] *= 2 end; check("in loop", t[1] == 2 and t[3] == 6) end
check("multiple targets rejected", not compiles("local a, b = 1, 2; a, b += 1"))
check("call target rejected", not compiles("f() += 1"))
check("comment after minus still parses", compiles("local a = 2--[[c]]-1"))
check("minus minus comment", (loadstring("return 2 - -1"))() == 3)
check("not equal still parses", (loadstring("return 1 ~= 2"))() == true)
check("concat still parses", (loadstring("return 'a'..'b'"))() == "ab")
check("varargs still parse", (loadstring("return select('#', ...)"))(1, 2) == 2)

-- 02 gsub replacement follows 5.1/LuaJIT
check("gsub %x in replacement adds x", ("a"):gsub("a", "%-") == "-")
check("gsub %% still works", ("a"):gsub("a", "%%") == "%")
check("gsub captures still work", ("ab"):gsub("(a)(b)", "%2%1") == "ba")

-- 03 integer formats follow LuaJIT x86-64
check("%d truncates", string.format("%d", 3.9) == "3" and string.format("%d", -2.7) == "-2")
check("%d nan", string.format("%d", 0 / 0) == "-9223372036854775808")
check("%d inf", string.format("%d", 1 / 0) == "-9223372036854775808")
check("%x negative", string.format("%x", -1) == "ffffffffffffffff")

-- 04 _ENV is an ordinary name, as in LuaJIT
check("local _ENV = nil keeps globals", (loadstring("local _ENV = nil; return table.concat({ 'a', 'b' })"))() == "ab")
check("_ENV is a plain global (nil)", (loadstring("return _ENV"))() == nil)
check("load(..., env) still sets globals", (load("return x", "t", "t", { x = 7 }))() == 7)
check("undefined global named in errors", select(2, pcall(loadstring("undefined_fn_04()"))):find("global 'undefined_fn_04'") ~= nil)

-- Lua 5.2 features PoB needs, and host modules
check("goto", compiles("for i = 1, 2 do if i == 1 then goto continue end ::continue:: end"))
check("\\z escape", "a\z
       b" == "ab")
check("xpcall passes args", select(2, xpcall(function(x) return x * 2 end, debug.traceback, 21)) == 42)
check("bit is global and signed", bit.tobit(0xffffffff) == -1 and bit.lshift(1, 31) == -2147483648)
check("bit.band", bit.band(0xff, 0x0f) == 15)
check("lua-utf8", require("lua-utf8").len("héllo") == 5)
local z = pobhost.deflate(("abc"):rep(100))
check("zlib round trip", pobhost.inflate(z) == ("abc"):rep(100))
check("gzip round trip", pobhost.inflate(pobhost.deflate("hello", true)) == "hello")
check("bad inflate returns nil, err", select(2, pobhost.inflate("not zlib")) ~= nil)

print(string.format("compound_spec: %d passed, %d failed", passed, failed))
if failed > 0 then os.exit(1) end
