---
name: find-images
description: >
  Find, search, and download images for use in presentations or projects.
  Use when the user asks to find an image, search for a photo, get a picture
  of something, or needs placeholder/filler images for slides.
metadata:
  version: "0.3.18"
---

# Find Images

Use this skill when the user needs images — for slides, placeholders, or any visual content.

## Workflow

1. **Search** — call `search_images` with a descriptive query. Show the full results list to the user so they can choose.
2. **Download** — call `download_image` for the chosen URL. Saved to `./images/` in the project folder.
3. **Review** — always tell the user the file path and confirm they're happy with it before doing anything else with it.
4. **Insert (optional)** — only if working on a `.deck` file, call `openfig_insert_image` after the user approves.

## Tips

- Use descriptive queries: `"modern office sustainability green"` beats `"office"`
- Search returns up to 20 results — ask for more if the first batch isn't right
- If a download fails (HTML trap, rate limit), try a different URL from the results list
- The `./images/` folder is created automatically in the current project directory
