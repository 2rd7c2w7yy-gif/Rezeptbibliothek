'use strict';

/* =====================================================================
   RezeptBibliothek – Web-App (GitHub Pages, statisch)
   Konzept: gemeinsame Bibliothek in einem privaten GitHub-Repo.
   - Nur der Besitzer (Owner des Repos) kann Rezepte erstellen/bearbeiten/löschen
     und Mitglieder einladen (Collaborator mit "pull" = nur Lesen).
   - Alle anderen eingeladenen Benutzer nutzen die Bibliothek schreibgeschützt
     (ansehen, suchen, filtern, lokal favorisieren, als PDF drucken).
   - Anmeldung: GitHub PAT (classic, scope "repo") – lokal im Browser (localStorage).
   - KI (Mistral) nur für den Besitzer; Key lokal im Browser (localStorage).
   ===================================================================== */

const GH = 'https://api.github.com';
const MISTRAL = 'https://api.mistral.ai';
const GH_API_VERSION = '2022-11-28';
const APP_REPO = '2rd7c2w7yy-gif/Rezeptbibliothek';
const LIBRARY_REPO = 'rezeptbibliothek-bibliothek';
const GROUP_PREFIX = 'rezeptbibliothek-gruppe-';

const CATEGORIES = ['Alle', 'Allgemein', 'Suppen', 'Hauptgerichte', 'Desserts', 'Backen', 'Getränke'];
const DEVICES = [
  { id: 'free', label: 'Freies Kochen', short: 'Frei',
    prompt: 'Gerät: Freies Kochen (Herd, Topf, Pfanne – kein elektrisches Küchengerät). Formuliere alle Zubereitungsschritte als normale Herd-/Topf-Schritte ohne Gerät.' },
  { id: 'thermomix', label: 'Thermomix (TM6/TM7)', short: 'TM6/TM7',
    prompt: 'Gerät: Thermomix TM6/TM7. Formuliere die Zubereitung als TM-Schritte mit Temperatur (°C), Stufe und Zeit (z. B. „3 Min. | 120 °C | Stufe 1“).' },
  { id: 'monsieur', label: 'Lidl Monsieur Cuisine', short: 'MC',
    prompt: 'Gerät: Lidl Monsieur Cuisine (Connect). Formuliere die Zubereitung als Monsieur-Cuisine-Schritte (z. B. „Rühren“, „Dämpfen“, „Kneten“, „Garen“ mit Temperatur, Stufe und Zeit).' },
];
const deviceById = id => DEVICES.find(d => d.id === id) || DEVICES[1];

/* ---------------- State ---------------- */
const state = {
  token: localStorage.getItem('gh_token') || '',
  mistralKey: localStorage.getItem('mistral_key') || '',
  user: null,
  isOwner: false,
  libraryFull: '',
  libraryReady: false,
  recipes: [],            // Bibliothek (geteilt)
  groups: [],
  groupRecipes: [],
  route: parseRoute(),
  filter: { q: '', category: 'Alle', device: 'Alle' },
  device: localStorage.getItem('rb_device') || 'thermomix',
  fallbackSkill: '',
};

/* ---------------- Helfer ---------------- */
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
const nowISO = () => new Date().toISOString();
const b64enc = s => btoa(unescape(encodeURIComponent(s)));
const b64dec = s => decodeURIComponent(escape(atob(String(s).replace(/\n/g, ''))));
const fmtDate = iso => { try { return new Date(iso).toLocaleDateString('de-DE'); } catch { return ''; } };

function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h.split('/').filter(Boolean);
  return { name: parts[0] || 'bibliothek', a: parts[1], b: parts[2], c: parts[3] };
}

/* Favoriten lokal pro Benutzer (nicht ins Repo geschrieben) */
function favKey() { return 'rb_favs_' + (state.user ? state.user.login : 'anon'); }
function loadFavs() { try { return JSON.parse(localStorage.getItem(favKey()) || '[]'); } catch { return []; } }
function applyFavs() {
  const favs = new Set(loadFavs());
  for (const r of [...state.recipes, ...state.groupRecipes]) r.favorite = favs.has(r.id);
}

/* ---------------- GitHub API ---------------- */
async function gh(path, { method = 'GET', body } = {}) {
  const res = await fetch(GH + path, {
    method,
    headers: {
      'Authorization': `Bearer ${state.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': GH_API_VERSION,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { App.logout(); throw new Error('GitHub-Token ungültig oder abgelaufen – bitte neu anmelden.'); }
  if (!res.ok) {
    let msg = res.status + ' ' + res.statusText;
    try { const e = await res.json(); if (e.message) msg = e.message; } catch {}
    throw new Error('GitHub: ' + msg);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/* ---------------- Mistral API ---------------- */
async function mistral(path, { method = 'GET', body } = {}) {
  if (!state.mistralKey) throw new Error('Kein Mistral-API-Key hinterlegt (Einstellungen).');
  const res = await fetch(MISTRAL + path, {
    method,
    headers: { 'Authorization': `Bearer ${state.mistralKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Mistral: ' + (data?.error?.message || res.status + ' ' + res.statusText));
  return data;
}

/* ---------------- Rezept-Dateiformat ---------------- */
function yamlVal(v) { return '"' + String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }
function yamlKey(line) { const i = line.indexOf(':'); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; }
function yamlUnq(v) { v = v.trim(); if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\'); return v; }

function encodeRecipeFile(r) {
  const fm = ['---', 'id: ' + yamlVal(r.id), 'title: ' + yamlVal(r.title), 'category: ' + yamlVal(r.category),
    'device: ' + yamlVal(deviceById(r.device).label), 'created: ' + yamlVal(r.created), 'updated: ' + yamlVal(r.updated)];
  if (r.cookidoo_gist) fm.push('cookidoo_gist: ' + yamlVal(r.cookidoo_gist));
  fm.push('---');
  return fm.join('\n') + '\n\n' + r.markdown + '\n';
}
function parseRecipeFile(content) {
  const m = String(content).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta = {};
  if (m) for (const line of m[1].split('\n')) { const [k, v] = yamlKey(line); if (k) meta[k] = yamlUnq(v); }
  return {
    id: meta.id || uid(), title: meta.title || 'Ohne Titel', category: meta.category || 'Allgemein',
    device: (DEVICES.find(d => d.label === meta.device) || DEVICES[1]).id,
    favorite: false, created: meta.created || nowISO(), updated: meta.updated || nowISO(),
    cookidoo_gist: meta.cookidoo_gist || '',
    markdown: m ? m[2].trim() : String(content),
  };
}

/* ---------------- Rezepte im Repo (Library/Gruppen) ---------------- */
async function listRecipes(full) {
  const list = await gh(`/repos/${full}/contents/recipes`);
  const out = [];
  for (const f of (list || [])) {
    if (!f.name.endsWith('.md')) continue;
    const file = await gh(`/repos/${full}/contents/recipes/${f.name}`);
    out.push(parseRecipeFile(b64dec(file.content)));
  }
  return out;
}
async function putFile(full, path, content, message) {
  let sha;
  try { sha = (await gh(`/repos/${full}/contents/${path}`)).sha; } catch {}
  await gh(`/repos/${full}/contents/${path}`, { method: 'PUT', body: { message, content: b64enc(content), ...(sha ? { sha } : {}) } });
}
async function deleteFile(full, path, message) {
  const f = await gh(`/repos/${full}/contents/${path}`);
  await gh(`/repos/${full}/contents/${path}`, { method: 'DELETE', body: { message, sha: f.sha } });
}
async function saveRecipeFile(full, recipe) {
  recipe.updated = nowISO();
  await putFile(full, `recipes/${recipe.id}.md`, encodeRecipeFile(recipe), 'Rezept speichern: ' + recipe.title);
}
async function deleteRecipeFile(full, recipe) {
  await deleteFile(full, `recipes/${recipe.id}.md`, 'Rezept löschen: ' + recipe.title);
}

/* ---------------- Bibliothek (gemeinsam, Owner verwaltet) ---------------- */
async function ensureLibrary() {
  const appRepo = await gh('/repos/' + APP_REPO);
  const owner = appRepo.owner.login;
  state.isOwner = state.user.login.toLowerCase() === owner.toLowerCase();
  state.libraryFull = owner + '/' + LIBRARY_REPO;
  let exists = true;
  try { await gh('/repos/' + state.libraryFull); } catch { exists = false; }
  if (!exists && state.isOwner) {
    await gh('/user/repos', { method: 'POST', body: { name: LIBRARY_REPO, private: true, auto_init: true, description: 'RezeptBibliothek – gemeinsame Bibliothek (nur Besitzer erstellt Rezepte)' } });
    await putFile(state.libraryFull, 'recipes/.gitkeep', '', 'init');
    exists = true;
  }
  if (exists) {
    try { state.recipes = await listRecipes(state.libraryFull); state.libraryReady = true; }
    catch { state.libraryReady = false; }
  } else {
    state.libraryReady = false;
  }
  applyFavs();
}

/* ---------------- Gruppen ---------------- */
async function loadGroups() {
  const repos = await gh('/user/repos?type=all&per_page=100&sort=updated');
  const groups = [];
  for (const repo of (repos || [])) {
    if (!repo.name.startsWith(GROUP_PREFIX)) continue;
    let meta = { name: repo.name.replace(GROUP_PREFIX, ''), owner: repo.owner.login, members: [] };
    try {
      const f = await gh(`/repos/${repo.full_name}/contents/group.json`);
      meta = { ...meta, ...JSON.parse(b64dec(f.content)) };
    } catch {}
    groups.push({ repo: repo.full_name, owner: repo.owner.login, name: repo.name, ...meta });
  }
  state.groups = groups;
}

async function createGroup(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'gruppe';
  const repoName = GROUP_PREFIX + slug + '-' + uid().slice(0, 8);
  const repo = await gh('/user/repos', {
    method: 'POST',
    body: { name: repoName, private: true, auto_init: true, description: 'RezeptBibliothek-Gruppe: ' + name },
  });
  const meta = { name, owner: state.user.login, created: nowISO(), members: [state.user.login] };
  await putFile(repo.full_name, 'group.json', JSON.stringify(meta, null, 1), 'Gruppe anlegen');
  await putFile(repo.full_name, 'recipes/.gitkeep', '', 'recipes/');
  return repo.full_name;
}

/* Einladung mit NUR Lesezugriff (pull) – Mitglieder dürfen nicht bearbeiten */
async function inviteMember(fullName, username) {
  await gh(`/repos/${fullName}/collaborators/${encodeURIComponent(username)}`, { method: 'PUT', body: { permission: 'pull' } });
  try {
    const f = await gh(`/repos/${fullName}/contents/group.json`);
    const meta = JSON.parse(b64dec(f.content));
    if (!meta.members.includes(username)) meta.members.push(username);
    await putFile(fullName, 'group.json', JSON.stringify(meta, null, 1), 'Mitglied einladen');
  } catch {}
  try {
    const f = await gh(`/repos/${fullName}/contents/library.json`);
    const meta = JSON.parse(b64dec(f.content));
    if (!meta.members.includes(username)) meta.members.push(username);
    await putFile(fullName, 'library.json', JSON.stringify(meta, null, 1), 'Mitglied einladen');
  } catch {}
}

/* ---------------- KI (nur Besitzer) ---------------- */
async function getSkillBody() {
  if (state.mistralKey) {
    try {
      const skill = await mistral('/v2/skills/skill:rezepte-thermomix?alias=main');
      if (skill?.definition?.body) return { body: skill.definition.body, source: 'Mistral Studio (Skill rezepte-thermomix)' };
    } catch (e) { console.warn('Skill nicht erreichbar, Fallback:', e.message); }
  }
  if (!state.fallbackSkill) {
    try { state.fallbackSkill = await (await fetch('fallback-skill.md')).text(); } catch { state.fallbackSkill = ''; }
  }
  return { body: state.fallbackSkill, source: 'Eingebettete Skill-Kopie' };
}
function buildSystemPrompt(skillBody, device) {
  return skillBody + '\n\n# Zusatz für die API-Nutzung\nGib ausschließlich das fertige Rezept als Markdown-Dokument zurück (Rezepttitel als H1). Keine Einleitung, keine Erklärung.\n\n# Gerät\n' + device.prompt;
}
async function aiChat(systemPrompt, userMessage) {
  const res = await mistral('/v1/chat/completions', {
    method: 'POST',
    body: { model: 'mistral-large-latest', messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }], temperature: 0.4, max_tokens: 4096 },
  });
  let content = res?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) content = content.map(p => p.text || '').join('');
  if (!content) throw new Error('KI hat keine Antwort geliefert.');
  content = content.trim();
  if (content.startsWith('```')) content = content.replace(/^```[a-z]*\n/i, '').replace(/```$/, '').trim();
  return content;
}
function extractTitle(markdown) {
  for (const line of markdown.split('\n')) {
    const t = line.trim();
    if (t.startsWith('# ')) return t.slice(2).trim();
  }
  return 'Neues Rezept';
}

/* ---------------- Cookidoo-Export (URL-Import) ---------------- */
function mdToSchema(r) {
  const lines = r.markdown.split('\n');
  let name = r.title, yield_ = '', section = '';
  const ingredients = [], steps = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line === '---') continue;
    if (line.startsWith('# ')) { name = line.slice(2).trim(); continue; }
    if (line.startsWith('## ')) { section = line.slice(3).trim().toLowerCase(); continue; }
    if (/portionen/i.test(line)) { const m = line.match(/Portionen:?\*\*\s*([^|]+)/i); if (m) yield_ = m[1].trim(); continue; }
    if (/^(zutaten|ingredients)/.test(section) && (line.startsWith('- ') || line.startsWith('* '))) {
      ingredients.push(line.replace(/^[-*]\s*/, '').replace(/\*\*/g, '').trim());
    } else if (/^(zubereitung|preparation|steps|schritte)/.test(section)) {
      const t = line.replace(/^\d+[.)]\s*/, '').replace(/^\*\*Schritt \d+\*\*\s*/i, '').replace(/\*\*/g, '').trim();
      if (t) steps.push(t);
    }
  }
  return { name, yield: yield_, ingredients, steps };
}

function cookidooHTML(r) {
  const s = mdToSchema(r);
  const schema = {
    '@context': 'https://schema.org', '@type': 'Recipe', name: s.name,
    recipeIngredient: s.ingredients,
    recipeInstructions: s.steps.map((t, i) => ({ '@type': 'HowToStep', position: i + 1, text: t })),
    datePublished: r.created,
  };
  if (s.yield) schema.recipeYield = s.yield;
  const ing = s.ingredients.map(i => `<li>${esc(i)}</li>`).join('\n');
  const steps = s.steps.map((t, i) => `<li><b>Schritt ${i + 1}:</b> ${esc(t)}</li>`).join('\n');
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${esc(s.name)}</title>
<script type="application/ld+json">${JSON.stringify(schema)}</script>
<style>body{font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;line-height:1.5}h1{font-size:24px}h2{font-size:18px;margin-top:24px;border-bottom:1px solid #ddd;padding-bottom:4px}</style>
</head><body>
<h1>${esc(s.name)}</h1>
${s.yield ? `<p><b>Portionen:</b> ${esc(s.yield)}</p>` : ''}
<h2>Zutaten</h2><ul>${ing}</ul>
<h2>Zubereitung</h2><ol>${steps}</ol>
<p><small>Erstellt mit RezeptBibliothek</small></p>
</body></html>`;
}

async function cookidooURL(r) {
  let gistId = localStorage.getItem('rb_cookidoo_' + r.id) || r.cookidoo_gist || '';
  const files = { 'index.html': { content: cookidooHTML(r) } };
  if (gistId) {
    await gh('/gists/' + gistId, { method: 'PATCH', body: { description: 'RezeptBibliothek: ' + r.title, public: true, files } });
  } else {
    const g = await gh('/gists', { method: 'POST', body: { description: 'RezeptBibliothek: ' + r.title, public: true, files } });
    gistId = g.id;
  }
  localStorage.setItem('rb_cookidoo_' + r.id, gistId);
  if (state.isOwner) {
    r.cookidoo_gist = gistId;
    const inGroup = state.route.name === 'gruppe';
    const full = inGroup ? state.route.a + '/' + state.route.b : state.libraryFull;
    await saveRecipeFile(full, r);
    if (inGroup) state.groupRecipes = await listRecipes(full); else state.recipes = await listRecipes(full);
  }
  return `https://gist.githubusercontent.com/${state.user.login}/${gistId}/raw/index.html`;
}

/* ---------------- App ---------------- */
window.App = {

  async boot() {
    if (state.token) {
      try {
        state.user = await gh('/user');
        await ensureLibrary();
        await loadGroups();
        App.render();
        return;
      } catch (e) { console.warn('Session ungültig:', e.message); }
    }
    localStorage.removeItem('gh_token');
    state.token = '';
    App.render();
  },

  async login() {
    const token = $('#login-token').value.trim();
    if (!token) { App.showError('Bitte Token eingeben.'); return; }
    state.token = token;
    $('#login-status').innerHTML = '<span class="spinner"></span>Anmeldung läuft …';
    try {
      state.user = await gh('/user');
      localStorage.setItem('gh_token', token);
      await ensureLibrary();
      await loadGroups();
      location.hash = '#/bibliothek';
      App.render();
    } catch (e) {
      state.token = '';
      App.showError(e.message);
      $('#login-status').textContent = '';
    }
  },

  logout() {
    localStorage.removeItem('gh_token');
    localStorage.removeItem('mistral_key');
    state.token = ''; state.mistralKey = ''; state.user = null;
    location.hash = '';
    App.render();
  },

  showError(msg) { const el = $('#login-error'); if (el) el.textContent = msg; },
  nav(name) { location.hash = '#/' + name; },
  setFilter(key, value) { state.filter[key] = value; App.renderList(); },
  setDevice(id) { state.device = id; localStorage.setItem('rb_device', id); App.render(); },

  renderList() {
    const listEl = $('#recipe-list');
    if (!listEl) return;
    const { q, category, device } = state.filter;
    let items = state.route.name === 'gruppe' ? state.groupRecipes : state.recipes;
    if (q) items = items.filter(r => (r.title + ' ' + r.markdown).toLowerCase().includes(q.toLowerCase()));
    if (category !== 'Alle') items = items.filter(r => r.category === category);
    if (device !== 'Alle') items = items.filter(r => r.device === device);
    items = [...items].sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
    if (!items.length) { listEl.innerHTML = '<div class="empty">Keine Rezepte gefunden.</div>'; return; }
    listEl.innerHTML = items.map(r => `
      <div class="card" onclick="App.openRecipe('${esc(r.id)}')">
        <div class="title">${r.favorite ? '★ ' : ''}${esc(r.title)}</div>
        <div class="meta">
          <span class="badge">${esc(r.category)}</span>
          <span class="badge device">${esc(deviceById(r.device).short)}</span>
          <span>${esc(fmtDate(r.updated))}</span>
        </div>
      </div>`).join('');
  },

  openRecipe(id) {
    const inGroup = state.route.name === 'gruppe';
    const base = inGroup ? `#/gruppe/${state.route.a}/${state.route.b}` : '#/bibliothek';
    location.hash = base + '/' + id;
  },

  async showRecipeDetail(id) {
    const inGroup = state.route.name === 'gruppe';
    const items = inGroup ? state.groupRecipes : state.recipes;
    const r = items.find(x => x.id === id);
    const main = $('#main');
    if (!r) { main.innerHTML = '<div class="empty">Rezept nicht gefunden.</div>'; return; }
    const base = inGroup ? `#/gruppe/${state.route.a}/${state.route.b}` : '#/bibliothek';
    const ownerButtons = state.isOwner ? `
        <button class="btn small" onclick="App.openAI('${inGroup ? 'group' : 'library'}','${esc(r.id)}')">Mit KI überarbeiten</button>
        <button class="btn small danger" onclick="App.deleteRecipe('${esc(r.id)}')">Löschen</button>` : '';
    main.innerHTML = `
      <div class="no-print detail-head">
        <button class="btn small" onclick="location.hash='${base}'">← Zurück</button>
        <h2>${r.favorite ? '★ ' : ''}${esc(r.title)}</h2>
        <button class="btn small" onclick="App.toggleFav('${esc(r.id)}')">${r.favorite ? '★ Favorit' : '☆ Favorit'}</button>
        <button class="btn small" onclick="App.printRecipe()">Als PDF drucken</button>
        <button class="btn small" onclick="App.openCookidoo('${esc(r.id)}')">🔗 Cookidoo-URL</button>
        ${ownerButtons}
      </div>
      <div class="meta" style="margin-bottom:10px">
        <span class="badge">${esc(r.category)}</span>
        <span class="badge device">${esc(deviceById(r.device).label)}</span>
        <span class="badge">${esc(fmtDate(r.updated))}</span>
        ${state.isOwner ? '' : '<span class="badge">schreibgeschützt</span>'}
      </div>
      <div id="print-area" class="article">${renderMarkdown(r.markdown)}</div>
    `;
  },

  async saveRecipe(recipe) {
    if (!state.isOwner) { alert('Nur der Besitzer der Bibliothek kann Rezepte erstellen oder bearbeiten.'); return; }
    const inGroup = state.route.name === 'gruppe';
    const full = inGroup ? state.route.a + '/' + state.route.b : state.libraryFull;
    await saveRecipeFile(full, recipe);
    if (inGroup) state.groupRecipes = await listRecipes(full); else state.recipes = await listRecipes(full);
    applyFavs();
    App.render();
  },

  async deleteRecipe(id) {
    if (!state.isOwner) { alert('Nur der Besitzer kann Rezepte löschen.'); return; }
    if (!confirm('Rezept wirklich löschen?')) return;
    const inGroup = state.route.name === 'gruppe';
    const full = inGroup ? state.route.a + '/' + state.route.b : state.libraryFull;
    const items = inGroup ? state.groupRecipes : state.recipes;
    const r = items.find(x => x.id === id);
    if (r) await deleteRecipeFile(full, r);
    if (inGroup) state.groupRecipes = await listRecipes(full); else state.recipes = await listRecipes(full);
    applyFavs();
    history.back();
    App.render();
  },

  async toggleFav(id) {
    const favs = loadFavs();
    const i = favs.indexOf(id);
    if (i >= 0) favs.splice(i, 1); else favs.push(id);
    localStorage.setItem(favKey(), JSON.stringify(favs));
    applyFavs();
    App.render();
  },

  async openGroup(full) {
    const [owner, repo] = full.split('/');
    location.hash = '#/gruppe/' + owner + '/' + repo;
  },

  async openGroupFromRoute() {
    const full = state.route.a + '/' + state.route.b;
    $('#group-title').textContent = 'Gruppe: ' + full.replace(GROUP_PREFIX, '');
    state.groupRecipes = await listRecipes(full);
    applyFavs();
    App.renderList();
  },

  /* ----- Modals ----- */
  openModal(html) { $('#modal-root').innerHTML = `<div class="modal-backdrop" onclick="if(event.target===this)App.closeModal()"><div class="modal">${html}</div></div>`; },
  closeModal() { $('#modal-root').innerHTML = ''; },

  openAI(scope, existingId) {
    if (!state.isOwner) { alert('Nur der Besitzer kann Rezepte mit der KI erstellen/überarbeiten.'); return; }
    const items = state.route.name === 'gruppe' ? state.groupRecipes : state.recipes;
    const existing = existingId ? items.find(r => r.id === existingId) : null;
    const dev = DEVICES.map(d => `<button type="button" class="${state.device === d.id ? 'active' : ''}" onclick="App.setDevice('${d.id}')">${esc(d.short)}</button>`).join('');
    App.openModal(`
      <h3>${existing ? 'Rezept mit KI überarbeiten' : 'Neues Rezept mit KI'}</h3>
      <div class="seg">${dev}</div>
      <div class="field">
        <label>${existing ? 'Änderungswunsch an die KI' : 'Dein Wunsch an die KI'}</label>
        <textarea id="ai-wish" rows="4" placeholder="${existing ? 'z. B. „weniger scharf, mehr Knoblauch“' : 'z. B. „Eine vegane Linsensuppe für 4 Personen, scharf, in 30 Minuten“'}"></textarea>
      </div>
      <div class="field">
        <label>Kategorie</label>
        <select id="ai-category">${CATEGORIES.filter(c => c !== 'Alle').map(c => `<option>${c}</option>`).join('')}</select>
      </div>
      <div id="ai-status" class="status"></div>
      <div id="ai-error" class="error"></div>
      <div class="actions">
        <button class="btn" onclick="App.closeModal()">Abbrechen</button>
        <button class="btn primary" onclick="App.runAI(${existing ? `'${existing.id}'` : 'null'})">${existing ? 'Überarbeiten (KI)' : 'Rezept generieren'}</button>
      </div>
      <div id="ai-preview"></div>
    `);
  },

  async runAI(existingId) {
    const wish = $('#ai-wish').value.trim();
    if (!wish) { $('#ai-error').textContent = 'Bitte Wunsch eingeben.'; return; }
    const category = $('#ai-category').value;
    const device = deviceById(state.device);
    $('#ai-error').textContent = '';
    $('#ai-status').innerHTML = '<span class="spinner"></span>Skill wird geladen …';
    try {
      const skill = await getSkillBody();
      const systemPrompt = buildSystemPrompt(skill.body, device);
      const items = state.route.name === 'gruppe' ? state.groupRecipes : state.recipes;
      let markdown;
      if (existingId) {
        const existing = items.find(r => r.id === existingId);
        $('#ai-status').textContent = 'KI überarbeitet das Rezept … (' + skill.source + ')';
        markdown = await aiChat(systemPrompt,
          'Überarbeite das folgende Rezept strikt gemäß diesem Änderungswunsch. Antworte ausschließlich mit dem vollständigen, überarbeiteten Rezept als Markdown.\n\nÄnderungswunsch:\n' + wish + '\n\nAktuelles Rezept:\n' + existing.markdown);
      } else {
        $('#ai-status').textContent = 'Rezept wird erstellt … (' + skill.source + ')';
        markdown = await aiChat(systemPrompt, wish);
      }
      const recipe = {
        id: existingId || uid(),
        title: extractTitle(markdown),
        category,
        device: device.id,
        favorite: false,
        created: nowISO(),
        updated: nowISO(),
        markdown,
      };
      if (existingId) {
        const old = items.find(r => r.id === existingId);
        if (old) { recipe.created = old.created; recipe.favorite = old.favorite; }
      }
      $('#ai-status').textContent = 'Fertig – speichern?';
      $('#ai-preview').innerHTML = `<div class="article">${renderMarkdown(markdown)}</div>
        <div class="actions">
          <button class="btn" onclick="App.closeModal()">Verwerfen</button>
          <button class="btn primary" onclick="App.saveAI()">${existingId ? 'Rezept aktualisieren' : 'In Bibliothek speichern'}</button>
        </div>`;
      window.__pendingAI = recipe;
    } catch (e) {
      $('#ai-error').textContent = e.message;
      $('#ai-status').textContent = '';
    }
  },

  async saveAI() {
    const recipe = window.__pendingAI;
    if (!recipe) return;
    App.closeModal();
    await App.saveRecipe(recipe);
  },

  openGroupModal() {
    if (!state.isOwner) { alert('Nur der Besitzer kann Gruppen erstellen.'); return; }
    App.openModal(`
      <h3>Neue Gruppe erstellen</h3>
      <div class="field"><label>Gruppenname</label><input id="group-name" placeholder="z. B. Familie Müller"></div>
      <div class="hint">Privates GitHub-Repo <code>${GROUP_PREFIX}…</code>. Mitglieder werden mit <b>nur Lesezugriff</b> eingeladen.</div>
      <div id="group-error" class="error"></div>
      <div class="actions">
        <button class="btn" onclick="App.closeModal()">Abbrechen</button>
        <button class="btn primary" onclick="App.createGroup()">Gruppe erstellen</button>
      </div>
    `);
  },

  async createGroup() {
    const name = $('#group-name').value.trim();
    if (!name) { $('#group-error').textContent = 'Name eingeben.'; return; }
    try {
      const full = await createGroup(name);
      App.closeModal();
      await loadGroups();
      App.openGroup(full);
    } catch (e) { $('#group-error').textContent = e.message; }
  },

  openInviteModal() {
    if (!state.isOwner) { alert('Nur der Besitzer kann Mitglieder einladen.'); return; }
    const inGroup = state.route.name === 'gruppe';
    const target = inGroup ? state.route.a + '/' + state.route.b : state.libraryFull;
    const label = inGroup ? 'Gruppe' : 'Bibliothek';
    App.openModal(`
      <h3>Mitglied einladen – ${esc(label)}</h3>
      <div class="field"><label>GitHub-Benutzername</label><input id="invite-user" placeholder="z. B. maxmustermann"></div>
      <div class="hint">Der Eingeladene bekommt eine GitHub-Einladung per E-Mail mit <b>nur Lesezugriff</b> (pull). Er kann die ${esc(label)} ansehen, suchen, favorisieren und als PDF drucken – aber keine Rezepte erstellen oder bearbeiten.</div>
      <div id="invite-status" class="status"></div>
      <div class="actions">
        <button class="btn" onclick="App.closeModal()">Schließen</button>
        <button class="btn primary" onclick="App.invite('${target}')">Einladen</button>
      </div>
    `);
  },

  async invite(repo) {
    const username = $('#invite-user').value.trim();
    if (!username) return;
    $('#invite-status').innerHTML = '<span class="spinner"></span>Einladung wird gesendet …';
    try {
      await inviteMember(repo, username);
      $('#invite-status').textContent = 'Einladung an @' + username + ' gesendet (E-Mail von GitHub, nur Lesezugriff).';
    } catch (e) { $('#invite-status').textContent = 'Fehler: ' + e.message; }
  },

  async openCookidoo(id) {
    const items = state.route.name === 'gruppe' ? state.groupRecipes : state.recipes;
    const r = items.find(x => x.id === id);
    if (!r) return;
    if (!confirm('Cookidoo-Import erzeugt eine ÖFFENTLICHE URL (public Gist) für dieses eine Rezept. Fortfahren?')) return;
    App.openModal(`<h3>Cookidoo-Import</h3><div id="cookidoo-status" class="status"><span class="spinner"></span>URL wird erzeugt …</div><div id="cookidoo-result"></div>`);
    try {
      const url = await cookidooURL(r);
      $('#cookidoo-status').textContent = '';
      $('#cookidoo-result').innerHTML = `
        <div class="field"><label>Import-URL (in Cookidoo einfügen)</label>
        <input id="cookidoo-url" readonly value="${esc(url)}" onclick="this.select()"></div>
        <div class="hint">Ablauf: <a href="https://cookidoo.de" target="_blank" rel="noopener">cookidoo.de</a> → „Meine Kreationen“ → grüner „+“ → „Rezept importieren“ → diese URL einfügen → „Importieren“. Danach die TM6/TM7-Einstellungen (Temperatur/Stufe/Zeit) manuell an den Schritten ergänzen.<br>
        Hinweis: Die URL ist öffentlich (public Gist) und bleibt bestehen, bis du das Gist unter gist.github.com löschst. Dafür braucht dein Token den Scope <b>gist</b>.</div>
        <div class="actions">
          <button class="btn primary" onclick="navigator.clipboard.writeText($('#cookidoo-url').value);this.textContent='Kopiert!'">URL kopieren</button>
          <button class="btn" onclick="App.closeModal()">Schließen</button>
        </div>`;
    } catch (e) {
      $('#cookidoo-status').textContent = '';
      $('#cookidoo-result').innerHTML = `<div class="error">${esc(e.message)}</div>
        <div class="actions"><button class="btn" onclick="App.closeModal()">Schließen</button></div>`;
    }
  },

  openSettings() {
    App.openModal(`
      <h3>Einstellungen</h3>
      <div class="field">
        <label>Mistral API-Key (lokal in diesem Browser gespeichert; nur der Besitzer kann KI-Rezepte erstellen)</label>
        <input id="mistral-key" type="password" value="${esc(state.mistralKey)}" placeholder="sk-…">
        <div class="hint">Key erstellen: <a href="https://console.mistral.ai" target="_blank" rel="noopener">console.mistral.ai</a> → API Keys.</div>
      </div>
      <div class="actions">
        <button class="btn" onclick="App.closeModal()">Abbrechen</button>
        <button class="btn primary" onclick="App.saveSettings()">Speichern</button>
      </div>
    `);
  },

  saveSettings() {
    state.mistralKey = $('#mistral-key').value.trim();
    localStorage.setItem('mistral_key', state.mistralKey);
    App.closeModal();
  },

  printRecipe() { window.print(); },

  /* ----- Render ----- */
  render() {
    state.route = parseRoute();
    const app = $('#app');
    if (!state.user) { app.innerHTML = viewLogin(); $('#login-token').focus(); return; }
    app.innerHTML = viewShell();
    const r = state.route;
    if (r.name === 'gruppe' && r.a && r.b) {
      App.openGroupFromRoute().then(() => { if (r.c) App.showRecipeDetail(r.c); });
    } else if ((r.name === 'bibliothek' || r.name === 'rezept') && r.a) {
      App.showRecipeDetail(r.a);
    } else if (r.name === 'gruppen') {
      App.renderList();
    } else {
      App.renderList();
    }
  },
};

/* ---------------- Markdown ---------------- */
function renderMarkdown(md) {
  try {
    if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(md));
    if (window.marked) return marked.parse(md);
  } catch (e) { console.warn(e); }
  return '<pre>' + esc(md) + '</pre>';
}

/* ---------------- Views ---------------- */
function viewLogin() {
  return `
  <div class="login-wrap">
    <h1>🍲 RezeptBibliothek</h1>
    <div class="sub">Web-Version – Anmeldung mit GitHub</div>
    <div class="field">
      <label>GitHub Personal Access Token</label>
      <input id="login-token" type="password" placeholder="ghp_…" autocomplete="off">
      <div class="hint">
        Token erstellen: <a href="https://github.com/settings/tokens" target="_blank" rel="noopener">github.com/settings/tokens</a>
        → „Tokens (classic)“ → „Generate new token (classic)“ → Scopes: <b>☑ repo</b> (Bibliothek) und <b>☑ gist</b> (nur für Cookidoo-Export) → „Generate token“.
        Der Token bleibt lokal in diesem Browser (localStorage) gespeichert, bis du dich abmeldest oder den Token bei GitHub löschst – und wird nur an api.github.com gesendet.
        <br>Du siehst die Bibliothek nur, wenn dich der Besitzer eingeladen hat (nur Lesezugriff).
      </div>
    </div>
    <button class="btn primary" style="width:100%" onclick="App.login()">Anmelden</button>
    <div id="login-status" class="status"></div>
    <div id="login-error" class="error"></div>
  </div>`;
}

function viewShell() {
  const r = state.route;
  const ownerExtras = state.isOwner ? `
      <button class="btn small" style="margin-top:8px" onclick="App.openInviteModal()">+ Mitglied einladen (nur Lesen)</button>` : '';
  const groupsNav = state.groups.map(g => `
    <button class="nav-item ${r.name === 'gruppe' && r.a + '/' + r.b === g.repo ? 'active' : ''}" onclick="App.openGroup('${esc(g.repo)}')">
      👥 ${esc(g.name || g.repo.replace(GROUP_PREFIX, ''))}
    </button>`).join('');
  const newGroupBtn = state.isOwner ? `<button class="btn small" style="margin-top:8px" onclick="App.openGroupModal()">+ Neue Gruppe</button>` : '';
  return `
  <div class="topbar no-print">
    <span class="logo">🍲 RezeptBibliothek</span>
    ${state.isOwner ? '<span class="badge">Besitzer</span>' : '<span class="badge">nur Lesen</span>'}
    <span class="spacer"></span>
    <span class="user">angemeldet als <b>@${esc(state.user.login)}</b></span>
    <button class="btn small" onclick="App.openSettings()">⚙️</button>
    <button class="btn small" onclick="App.logout()">Abmelden</button>
  </div>
  <div class="layout">
    <div class="sidebar no-print">
      <h3>Bibliothek</h3>
      <button class="nav-item ${r.name === 'bibliothek' || r.name === 'rezept' ? 'active' : ''}" onclick="App.nav('bibliothek')">📖 Bibliothek (${state.recipes.length})</button>
      ${ownerExtras}
      <h3>Gruppen</h3>
      ${groupsNav || '<div class="hint">Keine Gruppen.</div>'}
      ${newGroupBtn}
    </div>
    <div class="main" id="main">${viewMain()}</div>
  </div>`;
}

function viewMain() {
  const r = state.route;
  if (!state.libraryReady && (r.name === 'bibliothek' || !r.name)) {
    return `<div class="empty">Du wurdest noch nicht zur Bibliothek eingeladen.<br>
      Bitte den Besitzer (@${esc((state.libraryFull || '').split('/')[0] || '')}) um eine Einladung (GitHub-Collaborator, „pull“).</div>`;
  }
  if (r.name === 'gruppen') {
    if (!state.groups.length) return '<div class="empty">Keine Gruppen.</div>';
    return `<h2>Gruppen</h2><div class="recipe-list">` + state.groups.map(g => `
      <div class="card" onclick="App.openGroup('${esc(g.repo)}')">
        <div class="title">👥 ${esc(g.name || g.repo.replace(GROUP_PREFIX, ''))}</div>
        <div class="meta"><span class="badge">${esc(g.repo)}</span><span class="badge">${(g.members || []).length} Mitglieder</span></div>
      </div>`).join('') + '</div>';
  }
  if (r.name === 'gruppe') {
    const aiBtn = state.isOwner ? `<button class="btn primary small" onclick="App.openAI('group', null)">✨ Neues Rezept mit KI</button>` : '';
    const inviteBtn = state.isOwner ? `<button class="btn small" onclick="App.openInviteModal()">+ Mitglied einladen</button>` : '';
    return `
      <div class="toolbar no-print">
        <h2 id="group-title" style="margin:0;flex:1">Gruppe</h2>
        ${aiBtn}${inviteBtn}
      </div>
      ${toolbarHtml()}
      <div class="recipe-list" id="recipe-list"></div>`;
  }
  const aiBtn = state.isOwner ? `<button class="btn primary small" onclick="App.openAI('library', null)">✨ Neues Rezept mit KI</button>` : '';
  return `
    <div class="toolbar no-print">
      <h2 style="margin:0;flex:1">Bibliothek</h2>
      ${aiBtn}
    </div>
    ${toolbarHtml()}
    <div class="recipe-list" id="recipe-list"></div>`;
}

function toolbarHtml() {
  const f = state.filter;
  return `
  <div class="toolbar no-print">
    <input type="search" placeholder="Suchen …" value="${esc(f.q)}" oninput="App.setFilter('q', this.value)">
    <select onchange="App.setFilter('category', this.value)">
      ${CATEGORIES.map(c => `<option ${f.category === c ? 'selected' : ''}>${c}</option>`).join('')}
    </select>
    <select onchange="App.setFilter('device', this.value)">
      <option value="Alle" ${f.device === 'Alle' ? 'selected' : ''}>Alle Geräte</option>
      ${DEVICES.map(d => `<option value="${d.id}" ${f.device === d.id ? 'selected' : ''}>${esc(d.label)}</option>`).join('')}
    </select>
  </div>`;
}

/* ---------------- Router ---------------- */
window.addEventListener('hashchange', () => App.render());
App.boot();
