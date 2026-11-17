#!/usr/bin/env julia
#
# Run script for the DICE sandbox image.
#
# guides/DICE.markdown only documents running the Jupyter notebooks in
# https://github.com/possibleplanets/DICE.jl-notebooks interactively -- there
# is no headless/scriptable entry point there. This script instead calls the
# underlying https://github.com/possibleplanets/DICE.jl package directly
# (confirmed by reading its source: `solve(scenario, version)` needs no GAMS
# files or other external data -- the notebook's `GAMS_Compare` cells are only
# used there to cross-check against reference output, not to run the model),
# following the same pattern as sandboxes/hector/run.py and
# sandboxes/fair/run.py: params read at run time (env var), native result
# returned untouched.
using DICE
using JSON

# IMPORTANT (confirmed by testing a real run against a Daytona sandbox, after
# a user hit this as a real failure): DICE.jl's own Scenarios2016.jl only
# implements BasePrice/OptimalPrice for v2016R/v2016R2 (the version this
# script hardcodes below) -- every other scenario (Limit2Degrees, Stern,
# SternCalibrated, Copenhagen) errors with "<scenario> is not a valid
# scenario for v2016R2". Those are only implemented for the older v2013R
# RockyRoad variant (see ScenariosRockyRoad.jl), which also uses a different
# Results struct/field set -- not wired up here. Only list scenarios that
# are actually confirmed working against the version actually in use, rather
# than ones that look plausible from DICE.jl's exported Scenarios.jl list.
const SCENARIO_MAP = Dict(
    "base" => BasePrice,
    "optimal" => OptimalPrice,
)

function load_params()
    raw = get(ENV, "SCENARIO_PARAMS", "")
    if !isempty(raw)
        return JSON.parse(raw)
    end
    input_path = "/input/params.json"
    if isfile(input_path)
        return JSON.parsefile(input_path)
    end
    return Dict("scenario" => "optimal")
end

function main()
    params = load_params()
    scenario_name = get(params, "scenario", "optimal")

    if !haskey(SCENARIO_MAP, scenario_name)
        println(JSON.json(Dict(
            "status" => "failed",
            "error" => "unsupported scenario '$scenario_name'. supported: $(collect(keys(SCENARIO_MAP)))",
        )))
        exit(1)
    end

    scenario = SCENARIO_MAP[scenario_name]
    # v2016R2 is the most recent version in DICE.jl, confirmed 1:1 with GAMS
    # per DICE.jl-notebooks' README -- used as the fixed default here, same
    # "pick one sensible default" approach as the other sandboxes' scenario
    # handling (no version selector exposed yet).
    version = v2016R2()

    result = solve(scenario, version)
    r = result.results

    out = Dict(
        "status" => "succeeded",
        "model" => "dice",
        "scenario" => scenario_name,
        "result" => Dict(
            "years" => r.years,
            # Atmospheric temperature increase, degrees C from ~1900 (see
            # DICE.jl's BaseTypes.jl Results struct docstring) -- DICE's own
            # baseline, not normalized to match HECTOR/FAIR/OSCAR's baselines
            # (see PLATFORM.md's decision against cross-model normalization).
            "T_atmos" => r.Tₐₜ,
            "scc" => r.scc,
            "forcing" => r.FORC,
            "utility" => r.UTILITY,
        ),
    )

    # See sandboxes/hector/run.py for why this is wrapped: /output is expected
    # to be a mounted volume in the sandbox and isn't writable when running
    # this script directly on a host outside the container.
    try
        mkpath("/output")
        open("/output/result.json", "w") do f
            write(f, JSON.json(out))
        end
    catch e
        if !(e isa Base.IOError)
            rethrow(e)
        end
    end

    println(JSON.json(out))
end

main()
