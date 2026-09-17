# Skylark Weather 🌤️

A cute, animated, installable weather app. City search or GPS location, huge current temp + feels-like, live animated sky background, 24-hour graphs for every metric, and practical guidance (what to wear, umbrella or not, good day for a walk/trek/car wash). No backend, no API keys — just static files.

## Deploy to GitHub Pages

1. Create a new repository on GitHub (e.g. `skylark-weather`).
2. Push all the files in this folder to the repo's root (or to a `/docs` folder — your choice):
   ```bash
   cd skylark-weather
   git init
   git add .
   git commit -m "Skylark Weather"
   git branch -M main
   git remote add origin https://github.com/<your-username>/skylark-weather.git
   git push -u origin main
   ```
3. In the repo, go to **Settings → Pages**, set **Source** to your `main` branch (root, or `/docs` if you used that folder), and save.
4. GitHub will give you a URL like `https://<your-username>.github.io/skylark-weather/` — that's your live app.

**Important:** GitHub Pages serves over HTTPS automatically, which is required — geolocation and PWA install/service-worker features only work on HTTPS (or `localhost`), never on plain `http://`.

## Installing it as an app

- **Android/Chrome:** visit the site, tap the "Install app" banner (or the browser menu → *Install app* / *Add to Home screen*).
- **iOS/Safari:** visit the site, tap the Share icon → **Add to Home Screen**. iOS doesn't allow apps to trigger this automatically, so the app shows on-screen instructions the first time.

## Local testing before you deploy

Service workers and geolocation need a proper origin, so don't just double-click `index.html`. Serve it locally instead:

```bash
cd skylark-weather
python3 -m http.server 8000
# open http://localhost:8000
```

## What's inside

- `index.html` — page structure & inline SVG icon set
- `css/style.css` — all styling, theming, animations
- `js/app.js` — data fetching, unit conversions, guidance logic, UI wiring
- `js/weather-scene.js` — animated sky/mascot canvas engine
- `js/charts.js` — hand-rolled canvas charts for the 24-hour graphs
- `manifest.json` / `sw.js` — PWA installability + offline app-shell caching
- `icons/` — app icons (regular + maskable + favicons)

## Data sources (all free, no API key needed)

- Weather & hourly/daily forecast: [Open-Meteo](https://open-meteo.com/)
- Air quality: Open-Meteo Air Quality API
- City search: Open-Meteo Geocoding API
- GPS reverse geocoding (coordinates → place name): [BigDataCloud](https://www.bigdatacloud.com/) free client API

No sign-up, no keys, no rate-limit headaches for personal/small-scale use.
