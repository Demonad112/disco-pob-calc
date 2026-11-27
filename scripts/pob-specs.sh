#!/usr/bin/env bash
# Run PoB2's own spec suite (vendor/pob2/spec/System/*_spec.lua) on the native PUC Lua 5.2 host, one process per
# file with CI set, as PoB's own CI runs it under LuaJIT. Needs build/native/pobcalc and vendor/pob2 with spec/
# (scripts/checkout-pob2.sh --specs). Logs go to build/specs/; exits non-zero if any file fails.
#   scripts/pob-specs.sh [spec files...]
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT=build/specs
rm -rf "$OUT"; mkdir -p "$OUT"
if [ $# -gt 0 ]; then files=("$@"); else mapfile -t files < <(ls vendor/pob2/spec/System/*_spec.lua | sort); fi
[ ${#files[@]} -gt 0 ] || { echo "no spec files (run scripts/checkout-pob2.sh --specs)" >&2; exit 2; }
export CI=true
printf '%s\n' "${files[@]}" | xargs -P "$(nproc)" -I{} sh -c '
  n=$(basename "$1" .lua)
  build/native/pobcalc lua/spec_runner.lua "$1" > "'"$OUT"'/$n.out" 2> "'"$OUT"'/$n.err"
  echo $? > "'"$OUT"'/$n.rc"' _ {}
status=0; pass=0; fail=0; err=0; pend=0
for f in "${files[@]}"; do
  n=$(basename "$f" .lua)
  line=$(cat "$OUT/$n.out" 2>/dev/null)
  if [ "$(cat "$OUT/$n.rc")" != 0 ]; then
    status=1
    echo "FAILED ${line:-$n.lua: crashed}"
    grep -E '^(FAIL|ERROR)' -A1 "$OUT/$n.err" | sed 's/^/  /'
  else
    echo "$line"
  fi
  read -r p f2 e pe < <(echo "$line" | awk '{for(i=1;i<=NF;i++){if($(i+1)~/^passed/)p=$i; if($(i+1)~/^failed/)f=$i; if($(i+1)~/^errors/)e=$i; if($(i+1)~/^pending/)q=$i}} END{print p+0, f+0, e+0, q+0}')
  pass=$((pass + p)); fail=$((fail + f2)); err=$((err + e)); pend=$((pend + pe))
done
echo "PoB2 specs: ${#files[@]} files, $pass passed, $fail failed, $err errors, $pend pending"
exit $status
