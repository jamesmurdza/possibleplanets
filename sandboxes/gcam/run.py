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

SCENARIO: only "Reference" is supported right now, not a full SSP
taxonomy. This is deliberate, not an oversight -- see
docs/gcam/known-gaps.md ("Only configuration_ref.xml was actually
run-tested"): `configuration_ref.xml` is the one config file that was
actually verified end-to-end (all 21 periods, exit 0). The other shipped
configs (configuration_ssp.xml, _policy.xml, _usa.xml) reference
additional input files not confirmed present in this image's runtime/
directory and still have GCAM's own BaseX XML-output database enabled
(the JVM-segfault problem configuration_ref.xml's write-output="0" patch
works around) -- using them here without the same validation would risk
a run that looks successful but silently fails or returns garbage. See
docs/gcam/architecture.md for why adding real SSP scenario support later
is cheap (it's just swapping in configuration_ssp.xml plus its own
batch_SSP_*.xml file once that config is validated the same way ref was),
not a re-run of the expensive gcamdata step.

PARAMETERS: none exposed yet. GCAM has no equivalent of hector's
config-dict overrides reachable from this script without either (a)
regenerating gcamdata's XML database per request (reopens the exact
memory problem docs/gcam/architecture.md says to avoid) or (b) editing
configuration_ref.xml's own values, which hasn't been tested against any
value other than what's already shipped. Left empty rather than guessed.

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

# Only "Reference" -- see module docstring for why the other shipped
# configuration_*.xml files aren't exposed yet.
SUPPORTED_SCENARIOS = {
    "Reference": "configuration_ref.xml",
}

# configuration_ref.xml always runs the full 1975-2100 reference scenario
# in 5-year steps -- a fixed, known total, not something to compute from
# the config at run time (it doesn't vary by anything this script exposes).
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

    proc = subprocess.Popen(
        ["./gcam.exe", "-C", config_file],
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
        result = {
            "status": "failed",
            "model": "gcam",
            "scenario": scenario_name,
            "error": f"gcam.exe exited with code {returncode}",
            # Tail only -- gcam.exe's full log can be large, and this is
            # meant for diagnosing a failure, not as the run's real output.
            "log_tail": "".join(log_lines[-200:]),
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
