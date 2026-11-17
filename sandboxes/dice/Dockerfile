# DICE sandbox image
#
# guides/DICE.markdown only documents the Jupyter-notebook-based workflow in
# https://github.com/possibleplanets/DICE.jl-notebooks (no headless entry
# point there). This image skips that repo entirely and installs the
# underlying https://github.com/possibleplanets/DICE.jl package directly --
# its own Project.toml (not the notebooks repo's heavier one, which also
# pulls in Plots/CSV/DataFrames/JLD2/NBInclude just for notebook plotting/
# comparison cells this image doesn't need) only depends on JuMP + Ipopt,
# both pinned to major version 1 via DICE.jl's own [compat] section, so a
# plain `Pkg.add` is enough -- no vendored Manifest.toml needed.
#
# DICE.jl falls back to the MUMPS linear solver (bundled with Julia's Ipopt_jll
# artifact) when the proprietary HSL solvers aren't installed (confirmed by
# reading DICE.jl's selectLinearSolver()) -- no commercial solver license
# needed to run this.
#
# IMPORTANT (confirmed by testing against a real Daytona sandbox): the latest
# Ipopt.jl resolved by a plain `Pkg.add("DICE")` segfaults (SIGSEGV, not a
# catchable Julia exception) inside DICE.jl's own selectLinearSolver(), which
# always runs a deliberately malformed dummy Ipopt problem to probe for HSL
# solver availability, regardless of which linear_solver is requested.
# DICE.jl-notebooks' own (separately vendored) Manifest.toml pins
# Ipopt.jl==1.0.2 / Ipopt_jll==300.1400.400+0 and that combination is known
# to work (its README reports 1:1 parity with GAMS). Pinning Ipopt.jl to that
# same version here (confirmed by testing: solves in ~2.3s, no crash) avoids
# vendoring that repo's much heavier full Manifest (Plots/CSV/DataFrames/
# JLD2/NBInclude, needed there only for notebook plotting/comparison cells).
#
# Build:  docker build -t dice-sandbox:v2024.1 .
# Run:    docker run --rm dice-sandbox:v2024.1 julia run.jl

FROM julia:1.10-bookworm

WORKDIR /app

# Pin DICE.jl to a specific commit once confirmed working, instead of
# floating to master on every image rebuild, to keep results reproducible
# across builds -- same reasoning as pinning pyhector/fair's versions.
RUN julia -e 'using Pkg; \
    Pkg.add(Pkg.PackageSpec(name="Ipopt", version="1.0.2")); \
    Pkg.add(url="https://github.com/possibleplanets/DICE.jl", rev="754e9ba250e549f3f385a9b5e9c7f39117d29b4d"); \
    Pkg.add("JSON"); \
    Pkg.pin(Pkg.PackageSpec(name="Ipopt", version="1.0.2")); \
    using DICE, JSON'

COPY run.jl .

ENTRYPOINT ["julia", "run.jl"]
