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
  - image / photo slots: upload a JPG or PNG (choose **File**, double-click the box, or drop a file onto it), or use a project photo
  - photo fields: set an image's source to **Field** and pick from the deck's field list. Import the list under **Manage fields…** by pasting names (one per line, optional `key, Label`) or uploading a `.csv`, `.txt` or `.json` file. The list is saved with the deck. Each field can be placed on only one image slot in the deck; fields already used elsewhere are greyed out. A field fills from a URL in the project data with that name, or else from the project photo whose label, tag or zone matches it.
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

## Importing PowerPoint / Google Slides

In Google Slides choose **File → Download → Microsoft PowerPoint (.pptx)**, then drag the file onto the **Import** box in CloudSlides (or drop it anywhere on the app, or click the box to choose it). Everything comes in as normal, editable items:

| In the .pptx | Becomes |
|---|---|
| Text boxes and text inside shapes | Text boxes (text, size, bold/italic, color, alignment, line breaks) |
| Rectangles, rounded rectangles, ellipses | Boxes with the same fill, border and corner rounding |
| Lines and connectors | Lines, with arrowheads and dash style |
| Pictures (PNG, JPG, GIF, SVG) | Image boxes you can replace |
| `[Photo: Front of home]` placeholder boxes | Photo field slots (the field is added to the deck's field list) |
| Tables | A grid of cell boxes plus one editable text box per cell |
| Groups | Their individual items |
| Slide background color | Template background |

Widescreen slides are fitted onto the 11 × 8.5 in page (keep proportions, or stretch). A text box holds one style, so mixed formatting inside one box takes the first run's style; fonts switch to San Francisco; charts and SmartArt are listed in the import report as not imported. The file is read entirely in the browser (no upload, works offline).

## Where templates are saved

- **Shared library (Supabase).** Click the green **Save** button (or Ctrl/⌘ S); it asks you to sign in with a crew account the first time. The button always shows the state: **Save deck** (not in the library yet), **Save changes** (unsaved edits) or **✓ Saved**. Open other decks from **Library**. Everyone signed in sees the same decks on any computer and can open, edit, copy or delete them. If two people edit the same deck, the second person to save is asked whether to replace the other version or keep both. Decks are stored in the `slide_decks` table; JPG/PNG images placed in templates are uploaded to the public `template-assets` storage bucket. The schema is in `supabase/migrations/`.
- **This browser.** Every change is also saved automatically in the browser (IndexedDB), so work survives reloads and opens offline. The **Library** button shows whether the open deck has changes that aren't in the library yet.
- **Files.** **Export → Template deck (.json)** and **Import** still work for backups or moving a deck by hand.

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
js/pptx.js          PowerPoint (.pptx) importer: ZIP + slide XML -> editable elements
js/app.js           editor: canvas, snap grid, inspector, deck, history, autosave
```

