# CloudSlides

A small, PowerPoint-style editor for building **proposal template decks** that fill themselves with data and photos from a project, and print one slide per **US Letter landscape page (11 × 8.5 in)**.

**Plain HTML, CSS and vanilla JavaScript.** No framework, no TypeScript, no Tailwind, no npm, no build step. Files are served exactly as written, so it works offline and deploys to Vercel (or any static host) as-is.

## Run it

Open `index.html` in a browser, or serve the folder:

```sh
npx http-server .     # or: python3 -m http.server
```

On Vercel, import the repo with framework preset **Other**, leave the build command empty, and set the output directory to `.`.

## What it does

- **Template slides.** Each slide is an 11 × 8.5 in page with a snap grid (1/8, 1/4, 1/2 or 1 in). You can place:
  - text boxes, using the San Francisco system font stack (`SF Pro` / `SF Hello` / `-apple-system`, falling back to Helvetica or Arial on other systems)
  - square-corner boxes
  - rounded boxes (25 px default radius, adjustable)
  - image / photo slots (JPG or PNG upload, a project photo, or an image URL field)
  - lines and arrows: press **L** or click **Line**, then drag on the slide. Hold Shift for straight or 45° lines. Choose solid, dashed or dotted, and add an arrow at one end or both.
  - simple vertical bar charts: press **G** or click **Chart**. Type a label and value for each bar; a value can be a number or a project field like `{{payload.blower_door_cfm50}}`. You can add a prefix/suffix (`$`, `%`, `CFM`), and turn value labels, gridlines and the value axis on or off.
- **Brand palette.** The color pickers offer white, black, dark gray (`#4a4a4a`), light gray (`#d9d9d9`) and four greens (`#1b4d2b`, `#2f7d45`, `#5fae6e`, `#cfe8d4`), plus any custom hex. The swatch list lives in `PALETTE` in `js/templates.js`.
- **Layers.** Items stack front-to-back, so text can sit on top of a box or a photo. Use the **Layers** list in the right panel, the Bring forward / Send backward buttons, or Ctrl/⌘ `]` and `[` (add Shift to go all the way to the front or back). Alt/Option-click selects the item underneath.
- **A color picker on every item** for fill, border, text color and slide background: a native color wheel, a hex field, the brand swatches, and "none".
- **Resolution-independent.** Positions are stored in inches and images at their original resolution. Slides are drawn at physical size and only scaled on screen, so resizing never blurs anything.
- **Master deck.** Put templates in any order, and use the same template as many times as you like. A template can **repeat** to make one slide per photo zone or per group of N photos.
- **Project data.** Text can hold placeholders like `{{customer_name}}`, `{{address}}`, `{{appointment_date_long}}`, `{{payload.summary}}`, `{{zone}}`, `{{page}}` / `{{pages}}` and `{{today}}`. Photo slots take the project's photos in order, optionally filtered by zone or tag.
- **Present.** A full-screen stage that keeps the 11:8.5 shape, with ← / → / Space keys, dots, and Prev/Next buttons.
- **Export / Print PDF.** Uses `@page { size: letter landscape; margin: 0 }`. Every slide is exactly 11 × 8.5 in on its own page, with no app chrome, exact print colors, and no trailing blank page.

## Project data sources

| Source | How |
|---|---|
| Supabase audits | **Project data → Sign in** with a crew account. Reads `audits` + `audit_photos`. Photos come from the public `audit-photos` storage bucket. Tables, bucket and URL can be changed under *Connection settings*. |
| JSON file | `{ "fields": { ... }, "photos": [{ "url", "zone", "label", "tag" }] }`, or a raw audit row with a `photos` array |
| Sample | Built-in demo project that works offline |

The Supabase key in `js/data.js` is the project's *publishable* key, which is meant for browsers. Access to rows is still controlled by row-level security, so only signed-in crew can read audits.

## Export formats

| Export | Use |
|---|---|
| **Template deck (.json)** | The master template: page size, grid, templates, elements, bindings and deck order (`schema: "cloudslides.deck"`). Re-importable. |
| **Template viewer (.html)** | A self-contained page with the renderer built in. Host apps supply data via `?data=<url-to-project.json>`, `postMessage({ type: 'cloudslides:project', project })`, or `window.CloudSlides.setProject(project)`. |
| **Filled proposal (.html)** | Self-contained page with the current project baked in. It has the same viewer and print button. |
| **Filled slides (.json)** | Every expanded slide with its text filled in and image URLs resolved (`schema: "cloudslides.rendered"`), for apps that draw slides themselves. |
| **PDF** | Browser print dialog, then *Save as PDF*. |

## Files

```
index.html          editor shell
css/app.css         editor styles
js/render.js        shared slide renderer + viewer + print CSS (also embedded in HTML exports)
js/data.js          Supabase / JSON / sample project loading
js/export.js        JSON + HTML export, deck import
js/templates.js     element defaults and the starter deck
js/app.js           editor: canvas, snap grid, inspector, deck, history, autosave
```

Work is saved automatically in the browser (IndexedDB), so it survives reloads and offline use.
