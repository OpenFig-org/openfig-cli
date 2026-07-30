<!-- OPENSPEC:START -->
# OpenSpec Instructions

These instructions are for AI assistants working in this project.

Always open `@/openspec/AGENTS.md` when the request:
- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/openspec/AGENTS.md` to learn:
- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

Keep this managed block so 'openspec update' can refresh the instructions.

<!-- OPENSPEC:END -->
## Before you measure anything

Read `docs/figma-behaviour.md`. It records what Figma actually does with a
`.deck`, measured rather than inferred, with the method beside each claim so it
can be re-checked instead of trusted. Most surprises in this codebase are already
in there, and several of its entries exist because an earlier assumption was
wrong in a way nothing reported.

Two rules from it that are easy to get wrong twice:

**Match the instrument to the quantity.** Mean luminance calibrated exposure and
read as noise for contrast, because contrast moves a histogram's spread and barely
touches its mean. Pixel difference (MAE) finds a photo that lost its filter and is
nearly blind to line breaking, because it mostly ranks how much text a slide has —
a paragraph wrapping one word early was fixed with the slide's MAE unchanged at
10.0. For wrapping and placement, compare wrap points and text extents.

**A green test is not evidence the fix did anything.** Two fixes here passed new
tests while changing nothing real: a tag list widened behind a guard that
restated it by hand, and an encoder change that made the two hosts disagree.
Both were caught by converting a real export and comparing before and after — node
counts, byte sizes, emitted values. Do that before believing a green run.
