# Color Variables (Light Slides theme)

Figma Slides ships a built-in `VARIABLE_SET "Light slides"` in every deck.
These variables are referenced by `colorVar.value.alias.guid` in `fillPaints`.

When using raw RGB, `colorVar` can be **omitted entirely**.
When binding to a theme color, reference the variable by GUID.

Variable GUIDs are consistent within a deck (always `sessionID: 1`).

## Color Palette

| Name | GUID | Hex | r | g | b |
|------|------|-----|---|---|---|
| Pale Purple | 1:11 | #7F699B | 0.498 | 0.412 | 0.608 |
| Violet | 1:12 | #3D38F5 | 0.239 | 0.220 | 0.961 |
| Pale Blue | 1:13 | #667799 | 0.400 | 0.467 | 0.600 |
| Blue | 1:14 | #0C8CE9 | 0.047 | 0.549 | 0.914 |
| Pale Teal | 1:15 | #518394 | 0.318 | 0.514 | 0.580 |
| Teal | 1:16 | #0887A0 | 0.031 | 0.529 | 0.627 |
| Pale Green | 1:17 | #678E79 | 0.404 | 0.557 | 0.475 |
| Green | 1:18 | #198F51 | 0.098 | 0.561 | 0.318 |
| Pale Yellow | 1:19 | #AD7F00 | 0.678 | 0.498 | 0.000 |
| Pale Persimmon | 1:20 | #D4693B | 0.831 | 0.412 | 0.231 |
| Persimmon | 1:21 | #F65009 | 0.965 | 0.314 | 0.035 |
| Red | 1:22 | #E03E1A | 0.878 | 0.243 | 0.102 |
| Pale Pink | 1:23 | #AB5998 | 0.671 | 0.349 | 0.596 |
| Pale Red | 1:24 | #D4583B | 0.831 | 0.345 | 0.231 |
| Pink | 1:25 | #F316B0 | 0.953 | 0.086 | 0.690 |
| Grey | 1:26 | #CFCFCF | 0.813 | 0.813 | 0.813 |
| White | 1:27 | #FFFFFF | 1.000 | 1.000 | 1.000 |
| Color 3 | 1:28 | #000000 | 0.000 | 0.000 | 0.000 |
| Orange | 1:29 | #DE7D02 | 0.871 | 0.490 | 0.008 |
| Pale Violet | 1:30 | #6A699B | 0.416 | 0.412 | 0.608 |
| Yellow | 1:31 | #F3C11B | 0.953 | 0.757 | 0.106 |
| Purple | 1:32 | #8A38F5 | 0.541 | 0.220 | 0.961 |
| Black | 1:33 | #000000 | 0.000 | 0.000 | 0.000 |

> Note: `Color 3` and `Black` both resolve to `#000000`.
> GUIDs above are from the "Light slides" variable set and are consistent across decks
> that use this theme. A second duplicate set exists at higher localIDs (1:48–1:81) —
> these appear to be a copy; the first set (1:11–1:33) is the canonical one.

## Usage in fillPaints

```javascript
fillPaints: [{
  type: 'SOLID',
  color: { r: 0.047, g: 0.549, b: 0.914, a: 1 },  // actual RGB values
  opacity: 1,
  visible: true,
  blendMode: 'NORMAL',
  colorVar: {
    value: { alias: { guid: { sessionID: 1, localID: 14 } } },  // "Blue"
    dataType: 'ALIAS',
    resolvedDataType: 'COLOR'
  }
}]
```

When `colorVar` is present, the `color` field still holds the resolved RGB values.
Omitting `colorVar` and providing only `color` works for raw RGB fills.
