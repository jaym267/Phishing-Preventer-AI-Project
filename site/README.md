# ScamShield Mail — landing page

The public site for the project. Static [Astro](https://astro.build): two pages,
no client JavaScript, no analytics, no external requests.

## Work on it

```bash
cd site
npm install        # once
npm run dev        # http://localhost:4321/Phishing-Preventer-AI-Project/
```

The dev server reloads on save. `npm run build` writes the finished site to
`dist/`; `npm run preview` serves that build the way GitHub Pages will.

Open this `site/` folder in VS Code and accept the recommended
**Astro** extension for syntax highlighting and completions in `.astro` files.

## Where things are

| Path | What it is |
|---|---|
| `src/styles/global.css` | **All the styling.** Design tokens (colors, both themes) at the top; everything else below. Start here for design work. |
| `src/layouts/Base.astro` | The page shell: header, nav, footer, `<head>`. Wraps every page. |
| `src/pages/index.astro` | The About page (home). |
| `src/pages/install.astro` | The Install page. |
| `astro.config.mjs` | `site` and `base` for GitHub Pages — the site is served under `/Phishing-Preventer-AI-Project/`. |

## Design notes

- **Tokens, not literals.** Colors come from the `--surface`, `--ink`, `--accent`
  variables in `global.css`. The dark theme redefines only those; if you add a
  color, add it to both blocks.
- **Type is deliberately large** — 18px base. The audience includes people
  setting this up for a parent, and the parent.
- **Links inside the site must include the base path.** Use
  `import.meta.env.BASE_URL` (see `Base.astro`) rather than hard-coding `/`.
- **Keep it static.** No client `<script>`, no third-party embeds. The page's
  credibility depends on not itself being something to distrust.

## Deploying

Pushing changes under `site/` to `main` runs `.github/workflows/deploy-site.yml`
and publishes to GitHub Pages. One-time repository setting: Settings → Pages →
Source: **GitHub Actions**.
