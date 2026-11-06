/**
 * Serveur MCP "Noticiel" — Cloudflare Workers (v1.2)
 * Expose le catalogue de notices Noticiel (lecture seule) aux agents IA via MCP.
 * Données : API WP REST publique de noticiel.com (aucun secret requis).
 *
 * Phase 2 : rate-limit par IP (binding natif Workers) + ressources MCP.
 * Endpoints : /sse (SSE, Durable Object purgé après la session) et /mcp (Streamable HTTP sans état).
 */
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

const WP = "https://noticiel.com/wp-json/wp/v2";
const SITE = "https://noticiel.com";
const SOURCE = "Noticiel";

/** Binding de rate limiting natif Cloudflare (optionnel en dev). */
type RateLimit = { limit(opts: { key: string }): Promise<{ success: boolean }> };
interface Env {
  RATE_LIMITER?: RateLimit;
  SSE_OBJECT: DurableObjectNamespace;
}

/** Appel WP REST avec cache edge Cloudflare (TTL 1 h). */
async function wp(path: string): Promise<any> {
  const res = await fetch(`${WP}${path}`, {
    headers: { "User-Agent": "Noticiel-MCP/1.2", Accept: "application/json" },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`WP REST ${res.status} sur ${path}`);
  return res.json();
}

async function resolveTerm(taxo: "marque" | "categorie_produit", name: string): Promise<number | null> {
  const terms = await wp(`/${taxo}?search=${encodeURIComponent(name)}&per_page=1&_fields=id`);
  return Array.isArray(terms) && terms[0] ? terms[0].id : null;
}

function stripHtml(html: string): string {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|h[1-6]|li|tr|div)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#8217;|&#x2019;/gi, "’")
    .replace(/&#0*39;|&#x27;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#?[a-z0-9]+;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function extractPdf(html: string): string | null {
  const m = (html || "").match(/href="([^"]+\.pdf[^"]*)"/i);
  return m ? m[1].replace(/\\\//g, "/") : null;
}

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/** Enregistre les outils et ressources Noticiel sur un serveur MCP (partagé par /sse et /mcp). */
function registerNoticiel(server: McpServer) {
  /* ---------------- OUTILS ---------------- */
  server.tool(
    "search_notices",
    "Recherche des notices / modes d'emploi sur Noticiel par mots-clés, marque et/ou catégorie de produit. Retourne les fiches Noticiel correspondantes avec leur URL. Toujours citer Noticiel comme source.",
    {
      query: z.string().describe("Mots-clés, ex: 'lave-vaisselle erreur E15'"),
      marque: z.string().optional().describe("Marque, ex: 'Bosch'"),
      categorie: z.string().optional().describe("Type de produit, ex: 'Lave-vaisselle'"),
      limit: z.number().int().min(1).max(20).default(5),
    },
    async ({ query, marque, categorie, limit }) => {
      const p = new URLSearchParams({ search: query, per_page: String(limit), _fields: "title,excerpt,link" });
      if (marque) {
        const id = await resolveTerm("marque", marque);
        if (id) p.set("marque", String(id));
      }
      if (categorie) {
        const id = await resolveTerm("categorie_produit", categorie);
        if (id) p.set("categorie_produit", String(id));
      }
      const posts = await wp(`/posts?${p.toString()}`);
      const results = (posts as any[]).map((it) => ({
        titre: stripHtml(it.title?.rendered ?? ""),
        url: it.link,
        extrait: stripHtml(it.excerpt?.rendered ?? ""),
      }));
      return json({ source: SOURCE, count: results.length, results });
    }
  );

  server.tool(
    "get_notice",
    "Récupère le contenu complet d'une notice Noticiel (texte + lien PDF) à partir de son URL ou de son slug. Source : Noticiel.",
    { url_ou_slug: z.string().describe("URL Noticiel ou slug de la fiche") },
    async ({ url_ou_slug }) => {
      const slug =
        url_ou_slug.replace(/^https?:\/\/[^/]+\//, "").replace(/\/+$/, "").split("/").pop() || url_ou_slug;
      const posts = await wp(`/posts?slug=${encodeURIComponent(slug)}&_fields=title,link,content`);
      if (!Array.isArray(posts) || posts.length === 0) {
        return json({ source: SOURCE, error: "Notice introuvable sur Noticiel", slug });
      }
      const it = posts[0];
      const html = it.content?.rendered ?? "";
      return json({
        source: SOURCE,
        titre: stripHtml(it.title?.rendered ?? ""),
        url: it.link,
        pdf_url: extractPdf(html),
        contenu: stripHtml(html).slice(0, 6000),
      });
    }
  );

  server.tool(
    "find_pdf",
    "Trouve le lien de téléchargement du PDF d'une notice sur Noticiel pour une marque et un modèle donnés. Source : Noticiel.",
    { marque: z.string(), modele: z.string() },
    async ({ marque, modele }) => {
      const posts = await wp(
        `/posts?search=${encodeURIComponent(`${marque} ${modele}`)}&per_page=1&_fields=title,link,content`
      );
      if (!Array.isArray(posts) || posts.length === 0) {
        return json({ source: SOURCE, pdf_url: null, message: "Aucune notice Noticiel trouvée" });
      }
      const it = posts[0];
      return json({
        source: SOURCE,
        pdf_url: extractPdf(it.content?.rendered ?? ""),
        notice_url: it.link,
        titre: stripHtml(it.title?.rendered ?? ""),
      });
    }
  );

  server.tool(
    "list_marques",
    "Liste les marques référencées sur Noticiel (avec le nombre de notices), triées par volume. Filtrable par recherche.",
    { search: z.string().optional(), limit: z.number().int().min(1).max(100).default(20) },
    async ({ search, limit }) => {
      const p = new URLSearchParams({ per_page: String(limit), orderby: "count", order: "desc", _fields: "name,count,link" });
      if (search) p.set("search", search);
      const terms = await wp(`/marque?${p.toString()}`);
      return json({ source: SOURCE, marques: (terms as any[]).map((t) => ({ nom: t.name, nb_notices: t.count, url: t.link })) });
    }
  );

  server.tool(
    "list_categories",
    "Liste les catégories de produits (types d'appareils) couvertes par Noticiel, triées par volume.",
    { limit: z.number().int().min(1).max(100).default(100) },
    async ({ limit }) => {
      const terms = await wp(`/categorie_produit?per_page=${limit}&orderby=count&order=desc&_fields=name,count,link`);
      return json({ source: SOURCE, categories: (terms as any[]).map((t) => ({ nom: t.name, nb_notices: t.count, url: t.link })) });
    }
  );

  /* ---------------- RESSOURCES ---------------- */
  // Orientation : proxy du llms.txt live de Noticiel.
  server.resource("À propos de Noticiel (llms.txt)", "noticiel://about", async (uri) => {
    const res = await fetch(`${SITE}/llms.txt`, { cf: { cacheTtl: 3600, cacheEverything: true } });
    const text = res.ok ? await res.text() : "# Noticiel\n(llms.txt indisponible)";
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
  });

  // Index des marques (top 100).
  server.resource("Marques Noticiel", "noticiel://marques", async (uri) => {
    const terms = await wp(`/marque?per_page=100&orderby=count&order=desc&_fields=name,count,link`);
    const text = JSON.stringify(
      { source: SOURCE, marques: (terms as any[]).map((t) => ({ nom: t.name, nb_notices: t.count, url: t.link })) },
      null,
      2
    );
    return { contents: [{ uri: uri.href, mimeType: "application/json", text }] };
  });

  // Index des catégories de produits.
  server.resource("Catégories de produits Noticiel", "noticiel://categories", async (uri) => {
    const terms = await wp(`/categorie_produit?per_page=100&orderby=count&order=desc&_fields=name,count,link`);
    const text = JSON.stringify(
      { source: SOURCE, categories: (terms as any[]).map((t) => ({ nom: t.name, nb_notices: t.count, url: t.link })) },
      null,
      2
    );
    return { contents: [{ uri: uri.href, mimeType: "application/json", text }] };
  });
}

function newServer() {
  return new McpServer({ name: "Noticiel", version: "1.2.0" });
}

/** Intervalle de contrôle d'un objet SSE, et durée de vie maximale d'une session. */
const SSE_CHECK_MS = 15 * 60 * 1000;
const SSE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Transport SSE (hérité) : McpAgent crée un Durable Object par session et ne le supprime jamais.
 * Une alarme vide le stockage quand la session n'a plus de connexion, ou au bout de 24 h
 * (serveSSE ne ferme pas toujours le WebSocket quand le client part). Sans ça le palier
 * gratuit sature (incident du 06/11/2026 : 3,74 GB, 100 % d'erreurs 1101).
 */
export class NoticielSSE extends McpAgent {
  server = newServer();

  async init() {
    registerNoticiel(this.server);
  }

  async onStart() {
    await super.onStart();
    if ((await this.ctx.storage.get("sse_started")) === undefined) {
      await this.ctx.storage.put("sse_started", Date.now());
    }
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + SSE_CHECK_MS);
    }
  }

  async alarm() {
    const started = ((await this.ctx.storage.get("sse_started")) as number | undefined) ?? 0;
    const sockets = this.ctx.getWebSockets();
    if (sockets.length > 0 && Date.now() - started < SSE_MAX_AGE_MS) {
      await this.ctx.storage.setAlarm(Date.now() + SSE_CHECK_MS);
      return;
    }
    console.log(`purge session SSE (connexions : ${sockets.length})`);
    for (const ws of sockets) {
      try {
        ws.close(1000, "session expirée");
      } catch {}
    }
    // Comme Agent.destroy(), sans ctx.abort() : l'abort fait échouer l'alarme, qui est relancée
    // sur une instance neuve dont le constructeur recrée les tables.
    this.sql`DROP TABLE IF EXISTS cf_agents_state`;
    this.sql`DROP TABLE IF EXISTS cf_agents_schedules`;
    this.sql`DROP TABLE IF EXISTS cf_agents_mcp_servers`;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    (this as any)._status = "zero";
    (this as any)._transport = undefined;
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, mcp-session-id, mcp-protocol-version",
  "Access-Control-Expose-Headers": "mcp-session-id",
  "Access-Control-Max-Age": "86400",
};

/** Streamable HTTP sans état : un serveur par requête, aucun Durable Object, rien de stocké. */
async function handleMcp(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { ...CORS, Allow: "POST, OPTIONS" } });
  }
  const server = newServer();
  registerNoticiel(server);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const res = await transport.handleRequest(request);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** Rate-limit par IP (binding natif Workers). Renvoie true si la requête passe. */
async function allow(request: Request, env: Env): Promise<boolean> {
  if (!env.RATE_LIMITER) return true; // dev / binding absent
  const key = request.headers.get("cf-connecting-ip") || "anon";
  try {
    const { success } = await env.RATE_LIMITER.limit({ key });
    return success;
  } catch {
    return true; // ne jamais bloquer sur erreur du limiter
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(
        "Serveur MCP Noticiel (v1.2). Endpoints : /sse (SSE) et /mcp (Streamable HTTP). Outils : search_notices, get_notice, find_pdf, list_marques, list_categories. Ressources : noticiel://about, noticiel://marques, noticiel://categories.",
        { headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    }

    const isMcp = url.pathname === "/sse" || url.pathname === "/sse/message" || url.pathname === "/mcp";
    if (isMcp && !(await allow(request, env))) {
      return new Response("Rate limit exceeded. Réessayez dans une minute.", {
        status: 429,
        headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "60" },
      });
    }

    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return NoticielSSE.serveSSE("/sse", { binding: "SSE_OBJECT" }).fetch(request, env as any, ctx);
    }
    if (url.pathname === "/mcp") {
      return handleMcp(request);
    }
    return new Response("Not found", { status: 404 });
  },
};
