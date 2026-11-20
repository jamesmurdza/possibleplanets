"""
Run script for the GCAM sandbox image.

Unlike every other model in this project, GCAM isn't a library called from
Python -- it's a standalone compiled executable (`gcam.exe`) invoked as a
subprocess, reading/writing plain files. This script follows the same
overall contract as sandboxes/hector/run.py et al. (params via
SCENARIO_PARAMS env var or /input/params.json, native result to stdout and
/output/result.json, progress via /tmp/progress.json), just adapted to
"shell out to a binary and read its output files" instead of "call a
Python function".

SCENARIO: "Reference" plus "SSP1".."SSP5" (see docs/gcam/ssp-scenarios.md
for the full writeup). Each SSP has its own configuration_sspN.xml --
NOT upstream's configuration_ssp.xml/batch_SSP_*.xml BatchMode mechanism,
which was tried first and found to double-parse the shared component
list under this sandbox's 8GB ceiling (OOM'd even serialized, at
max-parallelism=1 -- a different failure mode than the solver-thread
duplication max-parallelism otherwise fixes). Each configuration_sspN.xml
is instead a flat, BatchMode=0 file: upstream's batch_SSP_REF.xml's own
"base" FileSet (NOT configuration_ref.xml's own ScenarioComponents list
-- an earlier attempt reused that instead and live-tested as a real
bug: SSP3/SSP4 failed with a land-allocation consistency error, because
configuration_ref.xml's list includes two Reference-only files
upstream's own SSP base deliberately omits) plus that SSP's own overlay,
pre-merged once instead of re-parsed by GCAM's BatchRunner at run time,
so parsing cost and memory profile match the already-validated
Reference run. GCAM's own BaseX XML-output database is still disabled
the same way as Reference (write-output="0" on xmldb-location) --
unrelated to BatchMode, see docs/gcam/known-gaps.md.
configuration_policy.xml and configuration_usa.xml are still not
exposed.

PARAMETERS: "config_overrides" -- an arbitrary {name: value} map applied
to configuration_ref.xml's own <Value name="...">...</Value> tags before
gcam.exe ever runs (see apply_config_overrides below). This is the
general answer to "GCAM has no equivalent of hector's config-dict
overrides": rather than guessing which values are safe to expose ahead
of time, this lets ANY existing Value in ANY section (Files,
ScenarioComponents, Strings, Bools, Ints, Doubles) be overridden per
run, with zero snapshot rebuild needed for a new knob -- only a new
`run.py`/snapshot deploy was ever needed for the OVERRIDE MECHANISM
itself, not for each individual value someone wants to try. Deliberately
permissive, not an allowlisted subset: this project's own dashboard
already shows a run's full error/log on failure, so a bad override
(wrong type, a nonexistent file path for a ScenarioComponents entry,
etc.) is visible and diagnosable the same way any other gcam.exe failure
already is, rather than needing to be pre-validated here. The one thing
enforced is that the override targets a Value that actually EXISTS in
the file (see apply_config_overrides's unmatched-key handling) -- a typo
in the name fails loudly with a clear error instead of silently doing
nothing, which would otherwise look identical to "ran with the default".

RUNTIME: confirmed by direct testing (docs/gcam/trial-log.md) that a full
21-period run (1975-2100) takes ~30-31 minutes on cpu:4 -- two to three
orders of magnitude longer than every other model here. exec_timeout_seconds
in apps/web/lib/models.ts is set well above that with a buffer.

PROGRESS: gcam.exe logs a line of the form "Period N: YYYY" at the start
of each of its 21 periods to stdout (observed directly during this
project's own validation runs -- see docs/gcam/trial-log.md's mention of
period-by-period log matching between the GPU-sandbox run and the
production-snapshot verification run, e.g. "Period 6: 2025"). This script
tees stdout the same way sandboxes/oscar/run.py does for its own
"year = N" lines: pass everything through unchanged, and also advance a
real step counter (out of the fixed 21 periods configuration_ref.xml
always runs) whenever a period-start line is seen. If gcam.exe's exact
log wording ever changes upstream, worst case this regex just stops
matching and progress silently stays at 0 until completion (status 100%
is still set unconditionally on success below) -- it never breaks the
run itself.
"""
import json
import os
import re
import subprocess
import sys

DEFAULT_PARAMS = {"scenario": "Reference"}

# "Reference" plus SSP1-5 -- see module docstring and
# docs/gcam/ssp-scenarios.md for how the SSP configs were built
# (upstream batch_SSP_REF.xml's own base file list plus each SSP's
# overlay, pre-merged into a flat, non-BatchMode file instead of
# reusing GCAM's own BatchRunner -- that was tried first and found to
# double-parse the shared component list, OOMing even at
# max-parallelism=1). configuration_policy.xml and configuration_usa.xml
# are still not exposed; see the module docstring.
SUPPORTED_SCENARIOS = {
    "Reference": "configuration_ref.xml",
    "SSP1": "configuration_ssp1.xml",
    "SSP2": "configuration_ssp2.xml",
    "SSP3": "configuration_ssp3.xml",
    "SSP4": "configuration_ssp4.xml",
    "SSP5": "configuration_ssp5.xml",
}

# Every SUPPORTED_SCENARIOS config shares configuration_ref.xml's own
# Ints section (stop-period/stop-year both -1, i.e. unset) -- all of them
# run the full 1975-2100 horizon in 5-year steps, a fixed, known total,
# not something to compute from the config at run time.
TOTAL_PERIODS = 21

GCAM_DIR = "/app/gcam-core/exe"
OUTPUT_CSV = "/app/gcam-core/output/gcam-hector-outputstream.csv"
PROGRESS_FILE = "/tmp/progress.json"

PERIOD_RE = re.compile(r"Period (\d+):\s*\d{4}")


def load_params():
    raw = os.environ.get("SCENARIO_PARAMS")
    if raw:
        return json.loads(raw)
    input_path = "/input/params.json"
    if os.path.exists(input_path):
        with open(input_path) as f:
            return json.load(f)
    return DEFAULT_PARAMS


def _write_progress(percent):
    # Same mechanism as sandboxes/oscar/run.py and sandboxes/fair/run.py --
    # a direct file write, read back by the gateway via the sandbox
    # filesystem API, since Daytona's session log APIs buffer stdout until
    # the command finishes (confirmed by testing for FAIR) and can't be
    # used to observe progress mid-run.
    try:
        with open(PROGRESS_FILE, "w") as f:
            json.dump({"percent": percent}, f)
            f.flush()
            os.fsync(f.fileno())
    except Exception:
        pass


def _read_output_csv(path):
    """
    gcam-hector-outputstream.csv is Hector's own standard long-format
    output (GCAM runs Hector internally as its climate component) --
    columns year,run_name,spinup,component,variable,value,units (read
    from Hector v3.2.0's own src/csv_outputstream_visitor.cpp), preceded
    by a "# Output from hector version ..." comment line. Returned as
    the raw file text, completely untouched -- same "native result, no
    cross-model normalization" decision PLATFORM.md already made for
    every other model here, taken literally: this script has no business
    reinterpreting Hector's own file format (e.g. guessing which lines
    are comments) when every consumer of "result" already has to parse
    *some* model-specific shape anyway. Whoever wants structured rows
    (currently: CHART_ADAPTERS.gcam in apps/web/lib/clientApi.ts) parses
    this text themselves. This also avoids the bug the old row-dict
    version of this function had: csv.DictReader doesn't know about
    Hector's leading comment line, so it silently used that comment as
    the header row and put every real field under csv.DictReader's
    `restkey`, leaving every row's "variable" effectively missing. Raw
    text has no such interpretation step to get wrong, and as plain text
    it's also more compact than a JSON array of per-row dicts (which
    repeats every column name on every row). Returns None if the file
    doesn't exist (e.g. gcam.exe failed before Hector ever ran) rather
    than raising -- the caller decides how to report that against the
    process's own exit code.
    """
    if not os.path.exists(path):
        return None
    with open(path, newline="") as f:
        return f.read()


def _read_cgroup_memory():
    """
    Best-effort snapshot of this sandbox's own cgroup memory numbers --
    peak usage, the limit, and the kernel OOM-killer's own count -- read
    AFTER gcam.exe exits, so a failure can say whether it was OOM-killed
    instead of leaving "exited with code N" as the whole story. This is
    exactly the observation docs/gcam/known-gaps.md flags as never having
    been made during the gcam.exe phase ("memory.current/memory.peak
    actually checked ... has never been done on either sandbox so far").
    cgroup v2 paths first (that's what these sandboxes use -- see
    trial-log.md's /sys/fs/cgroup/memory.swap.max observation), with v1
    fallbacks just in case. Returns None when nothing is readable at all
    (e.g. a non-Linux dev machine running this script), so callers just
    lose the diagnostics rather than failing.
    """

    def read(path):
        try:
            with open(path) as f:
                return f.read().strip()
        except OSError:
            return None

    peak = read("/sys/fs/cgroup/memory.peak") or read(
        "/sys/fs/cgroup/memory.max_usage_in_bytes"
    )
    maximum = read("/sys/fs/cgroup/memory.max") or read(
        "/sys/fs/cgroup/memory.limit_in_bytes"
    )
    if peak is None and maximum is None:
        return None

    oom_kills = None
    events = read("/sys/fs/cgroup/memory.events")
    if events:
        for line in events.splitlines():
            if line.startswith("oom_kill "):
                try:
                    oom_kills = int(line.split()[1])
                except (IndexError, ValueError):
                    pass
    return {"peak": peak, "max": maximum, "oom_kills": oom_kills}


def apply_config_overrides(xml_text, overrides):
    """
    Applies an arbitrary {name: value} map to configuration_ref.xml's own
    <Value ...name="X"...>OLD</Value> tags, replacing OLD with the new
    value as plain text -- the tag's other attributes (write-output=,
    append-scenario-name=, ...) and its section (<Files>, <Ints>, ...)
    are left completely alone, so gcam.exe's own Configuration class
    still parses it with the same type it always did (getInt/getBool/
    getString/getDouble all key off which SECTION a Value is in, not its
    text, so a pure text swap can't accidentally change that). See this
    module's docstring for why this is deliberately unrestricted rather
    than an allowlisted subset of "safe" keys.

    A name with more than one matching tag (a handful of real sections
    repeat the same name more than once, e.g. "nonco2_energy" appears
    twice in <ScenarioComponents> for the MAC-adjusted variant) gets the
    override applied to EVERY match -- there's no way to disambiguate
    which one a caller meant from the name alone, and leaving one
    unmatched silently would be worse than over-applying.

    Returns (patched_text, errors) -- errors is a list of override keys
    that matched nothing at all, which the caller treats as a hard
    failure (see main()): a key that doesn't exist in the file at all is
    almost certainly a typo, and failing loudly here is much more useful
    than gcam.exe silently running with its untouched default while the
    caller believes their override took effect.
    """
    errors = []
    for name, value in overrides.items():
        pattern = re.compile(
            r'(<Value\b[^>]*\bname\s*=\s*"' + re.escape(str(name)) + r'"[^>]*>)([^<]*)(</Value>)'
        )
        matches = pattern.findall(xml_text)
        if not matches:
            errors.append(name)
            continue
        xml_text = pattern.sub(lambda m: m.group(1) + str(value) + m.group(3), xml_text)
    return xml_text, errors


def _fmt_bytes(value):
    if value is None:
        return "unknown"
    if value == "max":  # cgroup v2 spells "unlimited" as "max"
        return "unlimited"
    try:
        return f"{int(value) / (1024 ** 3):.1f}GiB"
    except (TypeError, ValueError):
        return str(value)


def main():
    params = load_params()
    scenario_name = params.get("scenario", DEFAULT_PARAMS["scenario"])
    config_file = SUPPORTED_SCENARIOS.get(scenario_name)
    if config_file is None:
        print(
            json.dumps(
                {
                    "status": "failed",
                    "error": f"unsupported scenario '{scenario_name}'. "
                    f"supported: {sorted(SUPPORTED_SCENARIOS)}",
                }
            )
        )
        sys.exit(1)

    overrides = params.get("config_overrides")
    config_path = os.path.join(GCAM_DIR, config_file)
    if overrides:
        if not isinstance(overrides, dict):
            print(
                json.dumps(
                    {
                        "status": "failed",
                        "error": "config_overrides must be an object of {name: value}",
                    }
                )
            )
            sys.exit(1)
        with open(config_path) as f:
            patched_xml, errors = apply_config_overrides(f.read(), overrides)
        if errors:
            # Fail BEFORE ever launching gcam.exe -- a typo'd override key
            # should be visible as its own clear error, not disguised as
            # "ran with defaults" or as some unrelated gcam.exe failure
            # further downstream. See apply_config_overrides's docstring.
            print(
                json.dumps(
                    {
                        "status": "failed",
                        "error": f"config_overrides: no matching <Value> found for: {', '.join(errors)}",
                    }
                )
            )
            sys.exit(1)
        # Written to a per-run path, NOT overwriting configuration_ref.xml
        # itself -- keeps the canonical file on disk untouched/reusable if
        # this run has no overrides for some future scenario, and makes it
        # trivially obvious (by filename) when a run used overrides at all
        # if anyone ever inspects the sandbox mid-run.
        config_path = "/tmp/configuration_run.xml"
        with open(config_path, "w") as f:
            f.write(patched_xml)

    proc = subprocess.Popen(
        ["./gcam.exe", "-C", config_path],
        cwd=GCAM_DIR,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    periods_seen = 0
    log_lines = []
    for line in proc.stdout:
        sys.stdout.write(line)
        log_lines.append(line)
        match = PERIOD_RE.search(line)
        if match:
            periods_seen = max(periods_seen, int(match.group(1)))
            _write_progress(int(100 * min(periods_seen, TOTAL_PERIODS) / TOTAL_PERIODS))

    returncode = proc.wait()

    if returncode != 0:
        # Attach the cgroup memory evidence while the sandbox is still
        # alive (this runs before any cleanup can tear it down) -- an OOM
        # kill leaves no error message in gcam's own output (the kernel
        # SIGKILLs it mid-write, exactly at the final period in observed
        # runs), so without these numbers a silent "exited with code
        # 137" is indistinguishable from a solver failure. The enriched
        # `error` string is what apps/web/lib/runs.ts surfaces as the
        # run's error message in the dashboard (see finalizeOutcomeInner
        # -- it prefers the model's own failure report over its generic
        # "exit_code=N").
        mem = _read_cgroup_memory()
        error = f"gcam.exe exited with code {returncode}"
        if mem is not None:
            error += (
                f" -- cgroup memory peak {_fmt_bytes(mem['peak'])}"
                f" of {_fmt_bytes(mem['max'])}"
            )
            if mem.get("oom_kills") is not None:
                error += f", oom_kills {mem['oom_kills']}"
                if mem["oom_kills"] > 0:
                    error += " (killed by the kernel OOM killer -- this sandbox needs more memory)"
        result = {
            "status": "failed",
            "model": "gcam",
            "scenario": scenario_name,
            "error": error,
            # Tail only -- gcam.exe's full log can be large, and this is
            # meant for diagnosing a failure, not as the run's real output.
            "log_tail": "".join(log_lines[-200:]),
            "cgroup_memory": mem,
            # Echoed back whenever present so a failure caused by a bad
            # override is unambiguous about what was actually applied --
            # see apply_config_overrides's docstring on why this is
            # deliberately unrestricted and relies on visible failures
            # like this one instead of pre-validation.
            "config_overrides": overrides or None,
        }
        print(json.dumps(result))
        sys.exit(1)

    _write_progress(100)

    output_csv = _read_output_csv(OUTPUT_CSV)
    result = {
        "status": "succeeded",
        "model": "gcam",
        "scenario": scenario_name,
        # Hector's own native long-format CSV, as GCAM's internal climate
        # component wrote it -- the raw file text, untouched, per the
        # minimal output-shape decision in PLATFORM.md. See
        # _read_output_csv's docstring for the column shape and why this
        # is text rather than parsed rows.
        "result": {"csv": output_csv},
        "config_overrides": overrides or None,
    }

    try:
        os.makedirs("/output", exist_ok=True)
        with open("/output/result.json", "w") as f:
            json.dump(result, f)
    except PermissionError:
        pass

    print(json.dumps(result))


if __name__ == "__main__":
    main()
