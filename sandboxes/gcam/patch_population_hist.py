"""Patches gcamdata's Population_hist chunk -- see patches/README.md.

Fixes a block that chains two repeat_add_columns() calls onto a
dataframe that already has both the iso and year columns being added,
squaring the row count into the hundreds of millions instead of the
intended ~21,600-row grid. Replaced with the equivalent
tidyr::complete(iso, year). Live-tested fix, applied byte-for-byte.
"""

path = "/app/gcam-core/input/gcamdata/R/zsocio_L100.Population_hist.R"
with open(path) as f:
    content = f.read()

marker_start = (
    "    L100.Pop_thous_ctry_Yh %>%\n"
    "      repeat_add_columns(tibble::tibble(iso=unique(L100.Pop_thous_ctry_Yh$iso))) %>%"
)
marker_end = (
    "      rename(iso = iso.y,\n"
    "             year = year.y) ->\n"
    "      # This results in a df that has NAs, so we can interpolate / extrapolate\n"
    "      L100.Pop_thous_ctry_UNpopYh_NAs"
)

start_idx = content.find(marker_start)
end_idx = content.find(marker_end)
assert start_idx != -1, "start marker not found"
assert end_idx != -1, "end marker not found"
end_idx_full = end_idx + len(marker_end)

new_block = (
    "    L100.Pop_thous_ctry_Yh %>%\n"
    "      tidyr::complete(iso, year) ->\n"
    "      L100.Pop_thous_ctry_UNpopYh_NAs"
)

content = content[:start_idx] + new_block + content[end_idx_full:]
with open(path, "w") as f:
    f.write(content)
print("PATCHED Population_hist")
