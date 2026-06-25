# Kør nu? v3 — Deploy guide

## Det tager ~15 minutter. Du får live AIS-data fra Molslinjens færger.

---

## Trin 1 — Gratis AIS API-nøgle (5 min)

1. Gå til **aisstream.io** og opret en gratis konto
2. Gå til "API Keys" i dit dashboard → "Create new key"
3. Kopiér nøglen — den ser sådan ud: `sk_live_abc123...`
4. Det er det. Gratis tier giver ubegrænset kald til de 3 færger.

---

## Trin 2 — Deploy på Netlify (5 min)

1. Gå til **netlify.com** → Sign up (gratis, ingen kreditkort)
2. Dashboard → **"Add new site"** → **"Deploy manually"**
3. Zip denne mappe (`gniben-v3/`) og træk den ind
4. Netlify giver dig en URL, fx `https://gniben-faerge.netlify.app`

---

## Trin 3 — Tilføj AIS-nøglen som miljøvariabel (2 min)

I Netlify dashboard for dit site:
1. **Site configuration** → **Environment variables**
2. Klik **"Add a variable"**
3. Key: `AISSTREAM_API_KEY`
4. Value: din nøgle fra trin 1
5. Klik **Save** → **Trigger deploy** (eller den re-deployer automatisk)

Nu viser appen "Live AIS + Molslinjen" i stedet for "Estimeret skema".

---

## Trin 4 — Installer på iPhone (1 min)

1. Åbn din Netlify-URL i **Safari** (ikke Chrome)
2. Tryk **Del-knappen** (firkant med pil op)
3. Vælg **"Føj til hjemmeskærm"**
4. Appen ligger nu som et ikon på startskærmen

---

## Hvad AIS-integrationen giver dig

| Uden AIS | Med AIS |
|---|---|
| "Ankommer kl. 14.30" (planlagt) | "Ankommer kl. 14.27" (live GPS) |
| Fast lossetid: 20 min | Dynamisk: 15-28 min baseret på biler ombord |
| Ingen forsinkelsesinfo | Viser "+3m" hvis forsinket |
| Ingen skibsidentifikation | Express 2 / 3 / 4 med AIS-badge |

---

## Juster estimaterne

I `public/index.html`, find `const C = {` øverst:
```js
const C = {
  sailAR: 90,       // Sejltid Aarhus→Odden
  sailER: 75,       // Sejltid Ebeltoft→Odden
  defaultUnload: 20, // Base lossetid — øges automatisk med bilantal
  defaultDrive: 3,   // Standard køretid til Oddenvej
  version: '3.0',
  lastUpdated: '2026-06-25',
};
```
Bump version + dato når du justerer — vises i app'ens "Grundlag"-panel.

---

## Eget domæne (valgfrit)

I Netlify: **Domain management** → **Add custom domain**
Fx `koernuodden.dk` (tjek ledighed på navneprovider.dk)

---

## Feedback-link

Tilføj dit kontaktlink i `index.html` i disclaimer-teksten.
