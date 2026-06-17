# Fiche de soumission — Serveur MCP Noticiel

## Informations générales

| Champ | Valeur |
|---|---|
| **Nom** | noticiel |
| **Nom affiché** | Noticiel |
| **Version** | 1.1.0 |
| **Langue principale** | Français |
| **Licence** | MIT |
| **Repo GitHub** | https://github.com/waddou/mcp-noticiel |
| **Endpoint SSE** | `https://noticiel-mcp.wadie.workers.dev/sse` |
| **Endpoint HTTP** | `https://noticiel-mcp.wadie.workers.dev/mcp` |

---

## Description courte (< 150 caractères)

> Accès aux notices et modes d'emploi de noticiel.com : recherche, contenu complet et PDF, sans authentification.

## Description longue

Le serveur MCP Noticiel expose le catalogue de **noticiel.com** — le site français de référence pour les notices et modes d'emploi d'appareils électroménagers et grand public — aux agents IA via le Model Context Protocol.

Il fonctionne en **lecture seule** sur l'API WP REST publique de noticiel.com, sans aucun secret ni identifiant requis. Déployé sur **Cloudflare Workers** avec cache edge 1 heure et rate-limit natif (100 req/60 s par IP).

Chaque réponse inclut `source: "Noticiel"` et l'URL de la notice pour permettre aux agents de **citer leurs sources**.

---

## Outils exposés (5)

### `search_notices`
Recherche de notices par mots-clés, avec filtres optionnels par marque et par catégorie de produit.

**Paramètres :**
- `query` (string, requis) — ex : `"lave-vaisselle erreur E15"`
- `marque` (string, optionnel) — ex : `"Bosch"`
- `categorie` (string, optionnel) — ex : `"Lave-vaisselle"`
- `limit` (integer, 1–20, défaut 5)

**Retourne :** liste de fiches `{ titre, url, extrait }`.

---

### `get_notice`
Contenu complet d'une notice (texte nettoyé, jusqu'à 6 000 caractères) et lien vers le PDF.

**Paramètres :**
- `url_ou_slug` (string) — URL Noticiel ou slug de la fiche

**Retourne :** `{ titre, url, pdf_url, contenu }`.

---

### `find_pdf`
Lien direct vers le PDF d'une notice pour une marque et un modèle précis.

**Paramètres :**
- `marque` (string) — ex : `"Bosch"`
- `modele` (string) — ex : `"SMS46KI01E"`

**Retourne :** `{ pdf_url, notice_url, titre }`.

---

### `list_marques`
Liste des marques référencées, triées par nombre de notices décroissant.

**Paramètres :**
- `search` (string, optionnel) — filtre par nom
- `limit` (integer, 1–100, défaut 20)

---

### `list_categories`
Liste des catégories de produits (types d'appareils) couverts.

**Paramètres :**
- `limit` (integer, 1–200, défaut 100)

---

## Ressources MCP (3)

| URI | Contenu | Format |
|---|---|---|
| `noticiel://about` | Proxy live du `llms.txt` de noticiel.com | `text/markdown` |
| `noticiel://marques` | Top 100 marques (nom, nb notices, URL) | `application/json` |
| `noticiel://categories` | Toutes les catégories (nom, nb notices, URL) | `application/json` |

---

## Exemple d'usage

**Prompt utilisateur :**
> « Trouve la notice du lave-vaisselle Bosch Silence Plus et donne-moi le lien PDF. »

**Appels agent :**
1. `search_notices({ query: "lave-vaisselle Silence Plus", marque: "Bosch" })`
2. `get_notice({ url_ou_slug: "<url retournée>" })` → retourne `pdf_url`

---

## Caractéristiques techniques

| Aspect | Détail |
|---|---|
| **Plateforme** | Cloudflare Workers + Durable Objects |
| **Transports** | SSE (`/sse`) et Streamable HTTP (`/mcp`) |
| **Auth requise** | Non |
| **Secrets** | Aucun |
| **Cache** | Edge Cloudflare, TTL 1 h |
| **Rate-limit** | 100 req / 60 s par IP (Workers Rate Limiting natif) |
| **Source de données** | WordPress REST API v2 — noticiel.com |
| **Readonly** | Oui — uniquement GET sur `/wp/v2/posts`, `/marque`, `/categorie_produit` |

---

## Installation rapide (client stdio)

```json
{
  "mcpServers": {
    "noticiel": {
      "command": "npx",
      "args": ["mcp-remote", "https://noticiel-mcp.wadie.workers.dev/sse"]
    }
  }
}
```

---

## Catégories suggérées

`knowledge` · `search` · `documents` · `french` · `electromenager`
