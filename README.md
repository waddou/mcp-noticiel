# Serveur MCP Noticiel — Cloudflare Workers

Expose le catalogue de notices **Noticiel** aux agents IA (Claude & co.) via le **Model Context Protocol**, en lecture seule, depuis l'API WP REST publique de noticiel.com. **Aucun secret/identifiant requis.**

## Outils exposés
| Outil | Rôle |
|---|---|
| `search_notices(query, marque?, categorie?, limit?)` | Recherche de notices |
| `get_notice(url_ou_slug)` | Contenu complet + lien PDF |
| `find_pdf(marque, modele)` | Lien PDF direct |
| `list_marques(search?, limit?)` | Marques + nb de notices |
| `list_categories(limit?)` | Catégories de produits |

Chaque réponse porte `source: "Noticiel"` et l'URL Noticiel → l'agent **cite la marque**.

## Prérequis
- Node.js 18+ et un compte **Cloudflare** (gratuit).

## Installation & test local
```bash
cd mcp-noticiel
npm install
npm run dev            # serveur local sur http://localhost:8787
```
Test rapide du endpoint :
```bash
curl http://localhost:8787/            # message d'accueil
```
Test avec l'inspecteur MCP officiel :
```bash
npx @modelcontextprotocol/inspector
# Transport: SSE  →  URL: http://localhost:8787/sse
```

## Déploiement (production)
```bash
npx wrangler login      # ouvre le navigateur, autorise Cloudflare
npm run deploy          # déploie -> https://noticiel-mcp.<ton-sous-domaine>.workers.dev
```
URL publique : `https://noticiel-mcp.<compte>.workers.dev/sse`

### Domaine personnalisé `mcp.noticiel.com` (optionnel)
1. Ajoute `noticiel.com` à Cloudflare (DNS), si ce n'est pas déjà le cas.
2. Décommente le bloc `routes` dans `wrangler.jsonc`.
3. `npm run deploy`.
→ endpoint : `https://mcp.noticiel.com/sse`

## Connecter un client

### Claude Desktop / Claude.ai (connecteurs)
Ajoute un connecteur MCP distant avec l'URL `…/sse`. Pour les clients qui ne gèrent
que le stdio, utiliser le pont `mcp-remote` :
```json
{
  "mcpServers": {
    "noticiel": {
      "command": "npx",
      "args": ["mcp-remote", "https://mcp.noticiel.com/sse"]
    }
  }
}
```

### Vérifier que ça marche
Demander à l'agent : *« Avec l'outil Noticiel, trouve la notice du lave-vaisselle Bosch Silence Plus. »*
→ il doit appeler `search_notices` puis `get_notice` et répondre en citant **Noticiel** + l'URL + le PDF.

## Notes techniques
- Transport : `/sse` (SSE) et `/mcp` (Streamable HTTP). `McpAgent` (paquet `agents`) utilise un Durable Object (`MCP_OBJECT`).
- Cache edge 1 h sur les appels WP (`cf.cacheTtl`) → protège le WordPress et réduit la latence.
- Read-only : seuls les GET de `/wp/v2/posts|marque|categorie_produit` sont appelés. Les endpoints d'ingestion `noticiel/v1` ne sont jamais touchés.
- Évolutions possibles : rate-limit (Workers Rate Limiting), ressources MCP (llms.txt, sitemaps), specs structurées dans `get_notice`.
