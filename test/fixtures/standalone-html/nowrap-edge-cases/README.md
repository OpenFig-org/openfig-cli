# noWrap edge cases

Synthetic standalone-HTML fixture covering the failure modes that surfaced
during the 2026-04-24 visual QA pass. Each slide reproduces a specific
pattern that previously slipped through the existing test fixtures.

## Slides

- **A. Bullet span (margin-right) + bare text body** — `<span style="margin-right:8px">•</span>Body text`. Pre-fix this collapsed both into one richText with adjacent runs and dropped the 8 px gap, so the bullet rendered glued to the body. Verifies commit `5c99f21`.
- **B. Bullet span + body span** — `<span ...>•</span><span>Body text</span>`. Already worked before the fix; included here as a regression check so the per-margin handling doesn't break what already worked.
- **C. Large right-anchored numeral** — `font-size:420px; right:56px; "11"`. Triggers the Slides implicit wrap boundary at `(slide_right − x)`. Verifies the narrow x-shift heuristic in commit `ce4f679`.
- **D. Long noWrap body bullets near right edge** — bullet rows whose Chromium width is close to the slide right boundary. Pre-fix the global 1.3× width-predictor incorrectly fired here and shifted the body text leftward, hiding the bullet marker behind the body. Verifies the fontSize ≥ 96 / no-whitespace gates introduced in `ce4f679`.

## Diagnostic harness

Running `convert-html` on this fixture writes
`nowrap-diagnostics.json` next to the manifest (in the
`*-html-build/` scratch dir). Each entry records every noWrap text
node's gate evaluation, predicted shift, and post-shift x. To find
heuristic firings:

```sh
jq '.[] | select(.fired)' .../nowrap-diagnostics.json
```

Expected on this fixture: exactly one fired entry (slide 3's "11"
with `shift ≈ 28 px`).

## Regenerating

```sh
node build-fixture.mjs
```

Edits the generated HTML in place. Commit both the `build-fixture.mjs`
and the regenerated `nowrap-edge-cases.html`.
