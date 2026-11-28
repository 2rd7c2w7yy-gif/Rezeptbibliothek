'use strict';

/* =====================================================================
   RezeptBibliothek – Web-App (GitHub Pages, statisch, nur GitHub)
   - Bibliothek liegt in einem ÖFFENTLICHEN GitHub-Repo → LESEN ohne Login.
   - Nur der Besitzer loggt sich ein (GitHub classic Token, Scope "repo")
     und kann Rezepte per KI erstellen/bearbeiten/löschen + Gruppen anlegen.
   - Token nur lokal im Browser (localStorage), nur an api.github.com.
   - Cookidoo-URL: öffentliche raw.githubusercontent.com-URL aus dem Library-Repo.
   ===================================================================== */

const GH = 'https://api.github.com';
const MISTRAL = 'https://api.mistral.ai';
const GH_API_VERSION = '2022-11-28';
const APP_REPO = '2rd7c2w7yy-gif/Rezeptbibliothek';
const LIBRARY_REPO = 'rezeptbibliothek-bibliothek'; // öffentlich!

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
  user: null,
  isOwner: false,
  owner: '',
  libraryFull: '',
  libraryReady: false,
  mistralKey: localStorage.getItem('mistral_key') || '',
  recipes: [],
  groups: [],
  route: parseRoute(),
  filter: { q: '', category: 'Alle', device: 'Alle' },
  device: localStorage.getItem('rb_device') || 'thermomix',
  favorites: new Set(JSON.parse(localStorage.getItem('rb_favs') || '[]')),
  fallbackSkill: '',
  aiBusy: false,
};

/* ---------------- Helfer ---------------- */
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
const nowISO = () => new Date().toISOString();
const b64enc = s => btoa(unescape(encodeURIComponent(s)));
const b64dec = s => decodeURIComponent(escape(atob(String(s).replace(/\n/g, ''))));
const fmtDate = iso => { try { return new Date(iso).toLocaleString('de-DE'); } catch { return ''; } };

function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h.split('/').filter(Boolean);
  return { name: parts[0] || 'bibliothek', a: parts[1], b: parts[2] };
}

/* ---------------- GitHub API (lesen anonym, schreiben mit Token) ---------------- */
async function gh(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': GH_API_VERSION,
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  };
  if (auth && state.token) headers['Authorization'] = `Bearer ${state.token}`;
  const res = await fetch(GH + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401 && auth) { App.logout(); throw new Error('Token ungültig – bitte neu anmelden.'); }
  if (!res.ok) {
    let msg = res.status + ' ' + res.statusText;
    try { const e = await res.json(); if (e.message) msg = e.message; } catch {}
    throw new Error('GitHub: ' + msg);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/* ---------------- Mistral API (nur Besitzer) ---------------- */
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
    'device: ' + yamlVal(deviceById(r.device).label), 'group: ' + yamlVal(r.group || ''),
    'created: ' + yamlVal(r.created), 'updated: ' + yamlVal(r.updated), '---'];
  return fm.join('\n') + '\n\n' + r.markdown + '\n';
}
function parseRecipeFile(content) {
  const m = String(content).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta = {};
  if (m) for (const line of m[1].split('\n')) { const [k, v] = yamlKey(line); if (k) meta[k] = yamlUnq(v); }
  return {
    id: meta.id || uid(), title: meta.title || 'Ohne Titel', category: meta.category || 'Allgemein',
    device: (DEVICES.find(d => d.label === meta.device) || DEVICES[1]).id,
    group: meta.group || '', favorite: false,
    created: meta.created || nowISO(), updated: meta.updated || nowISO(),
    markdown: m ? m[2].trim() : String(content),
  };
}

/* ---------------- Repo-Dateien ---------------- */
async function listRecipes(full) {
  const list = await gh(`/repos/${full}/contents/recipes`, { auth: false });
  const out = [];
  for (const f of (list || [])) {
    if (!f.name.endsWith('.md')) continue;
    const file = await gh(`/repos/${full}/contents/recipes/${f.name}`, { auth: false });
    out.push(parseRecipeFile(b64dec(file.content)));
  }
  return out;
}
async function putFile(full, path, content, message) {
  if (!state.isOwner) throw new Error('Nur der Besitzer darf schreiben.');
  let sha;
  try { sha = (await gh(`/repos/${full}/contents/${path}`)).sha; } catch {}
  await gh(`/repos/${full}/contents/${path}`, { method: 'PUT', body: { message, content: b64enc(content), ...(sha ? { sha } : {}) } });
}
async function deleteFile(full, path, message) {
  if (!state.isOwner) throw new Error('Nur der Besitzer darf löschen.');
  const f = await gh(`/repos/${full}/contents/${path}`);
  await gh(`/repos/${full}/contents/${path}`, { method: 'DELETE', body: { message, sha: f.sha } });
}

/* ---------------- Bibliothek (öffentliches Repo) ---------------- */
async function ensureLibrary() {
  const appRepo = await gh('/repos/' + APP_REPO, { auth: false });
  state.owner = appRepo.owner.login;
  state.libraryFull = state.owner + '/' + LIBRARY_REPO;
  if (state.user) state.isOwner = state.user.login.toLowerCase() === state.owner.toLowerCase();
  let exists = true;
  try { await gh('/repos/' + state.libraryFull, { auth: false }); } catch { exists = false; }
  if (!exists && state.isOwner) {
    await gh('/user/repos', { method: 'POST', body: { name: LIBRARY_REPO, public: true, auto_init: true, description: 'RezeptBibliothek – öffentliche Bibliothek (nur Besitzer schreibt)' } });
    await putFile(state.libraryFull, 'recipes/.gitkeep', '', 'init');
    await putFile(state.libraryFull, 'groups.json', '[]', 'init');
    await putFile(state.libraryFull, 'cookidoo/.gitkeep', '', 'init');
    exists = true;
  }
  if (exists) {
    try {
      state.recipes = await listRecipes(state.libraryFull);
      state.libraryReady = true;
      try {
        const g = await gh(`/repos/${state.libraryFull}/contents/groups.json`, { auth: false });
        state.groups = JSON.parse(b64dec(g.content));
      } catch { state.groups = []; }
    } catch { state.libraryReady = false; }
  } else {
    state.libraryReady = false;
  }
  for (const r of state.recipes) r.favorite = state.favorites.has(r.id);
}

/* ---------------- Cookidoo (öffentliche raw-URL im Library-Repo) ---------------- */
function mdToSchema(r) {
  const lines = (r.markdown || '').split('\n');
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
  if (!state.isOwner) throw new Error('Nur der Besitzer kann eine Cookidoo-URL erzeugen.');
  const path = `cookidoo/${r.id}.html`;
  await putFile(state.libraryFull, path, cookidooHTML(r), 'Cookidoo-Export: ' + r.title);
  return `https://raw.githubusercontent.com/${state.libraryFull}/HEAD/${path}`;
}

/* ---------------- KI ---------------- */
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

/* ---------------- App ---------------- */
window.App = {

  async boot() {
    try {
      if (state.token) {
        state.user = await gh('/user');
      }
      await ensureLibrary();
    } catch (e) {
      console.warn('Init:', e.message);
      localStorage.removeItem('gh_token');
      state.token = ''; state.user = null; state.isOwner = false;
      try { await ensureLibrary(); } catch {}
    }
    App.render();
  },

  openOwnerLogin() {
    App.openModal(`
      <h3>🔑 Besitzer-Login (GitHub-Token)</h3>
      <div class="field">
        <label>GitHub Personal Access Token</label>
        <input id="login-token" type="password" placeholder="ghp_…" autocomplete="off">
        <div class="hint">Nur du brauchst einen Token. Erstellen: <a href="https://github.com/settings/tokens" target="_blank" rel="noopener">github.com/settings/tokens</a> → „Tokens (classic)“ → Scope <b>☑ repo</b> → „Generate token“. Alternativ im Terminal: <code>gh auth login</code> + <code>gh auth token</code>.<br>
        Der Token bleibt lokal in diesem Browser (localStorage) und wird nur an api.github.com gesendet.</div>
      </div>
      <div id="login-status" class="status"></div>
      <div id="login-error" class="error"></div>
      <div class="actions">
        <button class="btn" onclick="App.closeModal()">Abbrechen</button>
        <button class="btn primary" onclick="App.login()">Anmelden</button>
      </div>
    `);
    $('#login-token').focus();
  },

  async login() {
    const token = $('#login-token').value.trim();
    if (!token) { $('#login-error').textContent = 'Bitte Token eingeben.'; return; }
    $('#login-status').innerHTML = '<span class="spinner"></span>Anmeldung …';
    $('#login-error').textContent = '';
    const prev = state.token;
    state.token = token;
    try {
      state.user = await gh('/user');
      localStorage.setItem('gh_token', token);
      await ensureLibrary();
      if (!state.isOwner) {
        await App.logout();
        $('#login-error').textContent = 'Nur der Besitzer (@' + state.owner + ') darf sich anmelden.';
        $('#login-status').textContent = '';
        return;
      }
      App.closeModal();
      App.render();
    } catch (e) {
      state.token = prev;
      $('#login-status').textContent = '';
      $('#login-error').textContent = e.message;
    }
  },

  async logout() {
    localStorage.removeItem('gh_token');
    state.token = ''; state.user = null; state.isOwner = false;
    await ensureLibrary();
    App.render();
  },

  nav(name) { location.hash = '#/' + name; },
  setFilter(key, value) { state.filter[key] = value; App.renderList(); },
  setDevice(id) { state.device = id; localStorage.setItem('rb_device', id); App.render(); },

  renderList() {
    const listEl = $('#recipe-list');
    if (!listEl) return;
    const { q, category, device } = state.filter;
    let items = state.route.name === 'gruppe'
      ? state.recipes.filter(r => r.group === state.route.a)
      : state.recipes.filter(r => !r.group);
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
    const base = state.route.name === 'gruppe' ? `#/gruppe/${state.route.a}` : '#/bibliothek';
    location.hash = base + '/' + id;
  },

  showRecipeDetail(id) {
    const r = state.recipes.find(x => x.id === id);
    const main = $('#main');
    if (!r) { main.innerHTML = '<div class="empty">Rezept nicht gefunden.</div>'; return; }
    const base = state.route.name === 'gruppe' ? `#/gruppe/${state.route.a}` : '#/bibliothek';
    const ownerButtons = state.isOwner ? `
        <button class="btn small" id="btn-ai-revise" ${state.aiBusy ? 'disabled' : ''} onclick="App.openAI('${esc(r.id)}')">Mit KI überarbeiten</button>
        <button class="btn small danger" onclick="App.deleteRecipe('${esc(r.id)}')">Löschen</button>` : '';
    const cookidooBtn = state.isOwner
      ? `<button class="btn small" onclick="App.openShareURL('${esc(r.id)}')">🔗 Rezept-URL teilen</button>` : '';
    main.innerHTML = `
      <div class="no-print detail-head">
        <button class="btn small" onclick="location.hash='${base}'">← Zurück</button>
        <h2>${r.favorite ? '★ ' : ''}${esc(r.title)}</h2>
        <button class="btn small" onclick="App.toggleFav('${esc(r.id)}')">${r.favorite ? '★ Favorit' : '☆ Favorit'}</button>
        <button class="btn small" onclick="App.printRecipe()">Als PDF drucken</button>
        <button class="btn small" onclick="App.copyText('${esc(r.id)}')">📋 Text kopieren</button>
        ${cookidooBtn}
        ${ownerButtons}
      </div>
      <div class="meta" style="margin-bottom:10px">
        <span class="badge">${esc(r.category)}</span>
        <span class="badge device">${esc(deviceById(r.device).label)}</span>
        <span class="badge">${esc(fmtDate(r.updated))}</span>
        ${state.isOwner ? '' : '<span class="badge">öffentlich · nur Lesen</span>'}
      </div>
      <div id="print-area" class="article">${renderMarkdown(r.markdown)}</div>
    `;
  },

  async saveRecipe(recipe) {
    if (!state.isOwner) { alert('Nur der Besitzer kann Rezepte erstellen/bearbeiten.'); return; }
    recipe.updated = nowISO();
    if (!recipe.created) recipe.created = nowISO();
    if (!recipe.id) recipe.id = uid();
    await putFile(state.libraryFull, `recipes/${recipe.id}.md`, encodeRecipeFile(recipe), 'Rezept speichern: ' + recipe.title);
    await ensureLibrary();
    App.render();
  },

  async deleteRecipe(id) {
    if (!state.isOwner) { alert('Nur der Besitzer kann löschen.'); return; }
    if (!confirm('Rezept wirklich löschen?')) return;
    await deleteFile(state.libraryFull, `recipes/${id}.md`, 'Rezept löschen');
    await ensureLibrary();
    history.back();
    App.render();
  },

  async toggleFav(id) {
    if (state.favorites.has(id)) state.favorites.delete(id); else state.favorites.add(id);
    localStorage.setItem('rb_favs', JSON.stringify([...state.favorites]));
    for (const r of state.recipes) r.favorite = state.favorites.has(r.id);
    App.render();
  },

  openGroupModal() {
    if (!state.isOwner) { alert('Nur der Besitzer kann Gruppen erstellen.'); return; }
    App.openModal(`
      <h3>Neue Gruppe</h3>
      <div class="field"><label>Gruppenname</label><input id="group-name" placeholder="z. B. Familie"></div>
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
    const g = { id: uid(), name, created: nowISO() };
    state.groups.push(g);
    await putFile(state.libraryFull, 'groups.json', JSON.stringify(state.groups, null, 1), 'Gruppe: ' + name);
    App.closeModal();
    location.hash = '#/gruppe/' + g.id;
    App.render();
  },

  setBusy(b) {
    state.aiBusy = b;
    for (const id of ['btn-ai-go', 'btn-ai-revise', 'btn-ai-new']) {
      const el = document.getElementById(id);
      if (el) el.disabled = b;
    }
  },

  openAI(existingId) {
    if (!state.isOwner) { alert('Nur der Besitzer kann Rezepte mit der KI erstellen/überarbeiten.'); return; }
    if (state.aiBusy) return;
    const existing = existingId ? state.recipes.find(r => r.id === existingId) : null;
    const dev = DEVICES.map(d => `<button type="button" class="${state.device === d.id ? 'active' : ''}" onclick="App.setDevice('${d.id}')">${esc(d.short)}</button>`).join('');
    const groupOptions = ['<option value="">Bibliothek</option>']
      .concat(state.groups.map(g => `<option value="${g.id}" ${existing && existing.group === g.id ? 'selected' : ''}>${esc(g.name)}</option>`)).join('');
    App.openModal(`
      <h3>${existing ? 'Rezept mit KI überarbeiten' : 'Neues Rezept mit KI'}</h3>
      <div class="seg">${dev}</div>
      <div class="field">
        <label>${existing ? 'Änderungswunsch an die KI' : 'Dein Wunsch an die KI'}</label>
        <textarea id="ai-wish" rows="4" placeholder="${existing ? 'z. B. „weniger scharf, mehr Knoblauch“' : 'z. B. „Eine vegane Linsensuppe für 4 Personen, scharf, in 30 Minuten“'}"></textarea>
      </div>
      <div class="field"><label>Kategorie</label>
        <select id="ai-category">${CATEGORIES.filter(c => c !== 'Alle').map(c => `<option ${existing && existing.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div class="field"><label>Ziel</label><select id="ai-group">${groupOptions}</select></div>
      <div id="ai-status" class="status"></div>
      <div id="ai-error" class="error"></div>
      <div class="actions">
        <button class="btn" onclick="App.closeModal()">Abbrechen</button>
        <button class="btn primary" id="btn-ai-go" onclick="App.runAI(${existing ? `'${existing.id}'` : 'null'})">${existing ? 'Überarbeiten (KI)' : 'Rezept generieren'}</button>
      </div>
      <div id="ai-preview"></div>
    `);
  },

  async runAI(existingId) {
    const wish = $('#ai-wish').value.trim();
    if (!wish) { $('#ai-error').textContent = 'Bitte Wunsch eingeben.'; return; }
    const category = $('#ai-category').value;
    const group = $('#ai-group').value || '';
    const device = deviceById(state.device);
    $('#ai-error').textContent = '';
    $('#ai-status').innerHTML = '<span class="spinner"></span>Skill wird geladen …';
    App.setBusy(true);
    try {
      const skill = await getSkillBody();
      const systemPrompt = buildSystemPrompt(skill.body, device);
      let markdown;
      if (existingId) {
        const existing = state.recipes.find(r => r.id === existingId);
        $('#ai-status').textContent = 'KI überarbeitet das Rezept … (' + skill.source + ')';
        markdown = await aiChat(systemPrompt,
          'Überarbeite das folgende Rezept strikt gemäß diesem Änderungswunsch. Antworte ausschließlich mit dem vollständigen, überarbeiteten Rezept als Markdown.\n\nÄnderungswunsch:\n' + wish + '\n\nAktuelles Rezept:\n' + existing.markdown);
      } else {
        $('#ai-status').textContent = 'Rezept wird erstellt … (' + skill.source + ')';
        markdown = await aiChat(systemPrompt, wish);
      }
      const recipe = {
        id: existingId || null, title: extractTitle(markdown), category, device: device.id,
        group, created: existingId ? state.recipes.find(r => r.id === existingId).created : nowISO(),
        markdown,
      };
      $('#ai-status').textContent = 'Wird automatisch gespeichert …';
      App.setBusy(false);
      await App.saveRecipe(recipe);   // automatisch speichern, kein Confirm
      App.closeModal();
    } catch (e) {
      $('#ai-error').textContent = e.message;
      $('#ai-status').textContent = '';
      App.setBusy(false);
    }
  },

  async openShareURL(id) {
    const r = state.recipes.find(x => x.id === id);
    if (!r) return;
    if (!confirm('Rezept-URL erzeugen (öffentlich im Library-Repo, schema.org JSON-LD). Fortfahren?')) return;
    App.openModal(`<h3>Rezept-URL teilen (JSON-LD)</h3><div id="cookidoo-status" class="status"><span class="spinner"></span>URL wird erzeugt …</div><div id="cookidoo-result"></div>`);
    try {
      const url = await cookidooURL(r);
      $('#cookidoo-status').textContent = '';
      $('#cookidoo-result').innerHTML = `
        <div class="field"><label>Rezept-URL (schema.org JSON-LD, öffentlich)</label>
        <input id="cookidoo-url" readonly value="${esc(url)}" onclick="this.select()"></div>
        <div class="hint">Die URL enthält das Rezept als schema.org JSON-LD und funktioniert mit offenen Tools/Apps, die URLs importieren – z. B. <b>MCS Recipe Importer</b> (mcsrecipe.com) für den <b>Lidl Monsieur Cuisine</b>, AnyList, Paprika, Crouton. <b>Cookidoo</b> akzeptiert nur Whitelist-URLs – dafür „📋 Text kopieren“ nutzen und in Cookidoo manuell/KI eintragen. Der Monsieur Cuisine selbst importiert keine URLs direkt.</div>
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
        <label>Mistral API-Key (lokal im Browser; nur der Besitzer nutzt die KI)</label>
        <input id="mistral-key" type="password" value="${esc(state.mistralKey)}" placeholder="sk-…">
        <div class="hint">Key erstellen: <a href="https://console.mistral.ai" target="_blank" rel="noopener">console.mistral.ai</a> → API Keys. Wird nur an api.mistral.ai gesendet.</div>
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

  async copyText(id) {
    const r = state.recipes.find(x => x.id === id);
    if (!r) return;
    try {
      await navigator.clipboard.writeText(r.markdown);
      alert('Rezepttext kopiert – in Cookidoo („Meine Kreationen“ → „+“ → „Neues Rezept“) einfügen.');
    } catch (e) {
      alert('Kopieren nicht möglich: ' + e.message);
    }
  },
  openModal(html) { $('#modal-root').innerHTML = `<div class="modal-backdrop" onclick="if(event.target===this)App.closeModal()"><div class="modal">${html}</div></div>`; },
  closeModal() { $('#modal-root').innerHTML = ''; },

  render() {
    state.route = parseRoute();
    $('#app').innerHTML = viewShell();
    const r = state.route;
    if (r.name === 'gruppe' && r.a) {
      if (r.b) App.showRecipeDetail(r.b);
      else App.renderList();
    } else if (r.name === 'bibliothek' && r.a) {
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
function viewShell() {
  const r = state.route;
  const groupsNav = state.groups.map(g => `
    <button class="nav-item ${r.name === 'gruppe' && r.a === g.id ? 'active' : ''}" onclick="location.hash='#/gruppe/${g.id}'">
      👥 ${esc(g.name)}
    </button>`).join('');
  const newGroupBtn = state.isOwner ? `<button class="btn small" style="margin-top:8px" onclick="App.openGroupModal()">+ Neue Gruppe</button>` : '';
  return `
  <div class="topbar no-print">
    <span class="logo">🍲 RezeptBibliothek</span>
    ${state.isOwner ? '<span class="badge">Besitzer</span>' : '<span class="badge">öffentlich · nur Lesen</span>'}
    <span class="spacer"></span>
    ${state.user
      ? `<span class="user">${esc(state.user.login)}</span>
         <button class="btn small" onclick="App.openSettings()">⚙️</button>
         <button class="btn small" onclick="App.logout()">Abmelden</button>`
      : `<button class="btn small" onclick="App.openOwnerLogin()">🔑 Besitzer-Login</button>`}
  </div>
  <div class="layout">
    <div class="sidebar no-print">
      <h3>Bibliothek</h3>
      <button class="nav-item ${r.name === 'bibliothek' ? 'active' : ''}" onclick="App.nav('bibliothek')">📖 Bibliothek (${state.recipes.filter(x => !x.group).length})</button>
      <h3>Gruppen</h3>
      ${groupsNav || '<div class="hint">Keine Gruppen.</div>'}
      ${newGroupBtn}
    </div>
    <div class="main" id="main">${viewMain()}</div>
  </div>`;
}

function viewMain() {
  const r = state.route;
  if (!state.libraryReady) {
    return `<div class="empty">Die Bibliothek ist noch nicht erreichbar.<br>
      Entweder legt der Besitzer sie gerade an (erstes Besitzer-Login) – oder das Repo
      <code>${esc(LIBRARY_REPO)}</code> von @${esc(state.owner || '?')} ist noch <b>privat</b>
      (github.com/${esc(state.owner || '?')}/${esc(LIBRARY_REPO)} → Settings → Danger Zone → „Change visibility" → public).</div>`;
  }
  if (r.name === 'gruppen') {
    if (!state.groups.length) return '<div class="empty">Keine Gruppen.</div>';
    return `<h2>Gruppen</h2><div class="recipe-list">` + state.groups.map(g => `
      <div class="card" onclick="location.hash='#/gruppe/${g.id}'">
        <div class="title">👥 ${esc(g.name)}</div>
      </div>`).join('') + '</div>';
  }
  if (r.name === 'gruppe') {
    const g = state.groups.find(x => x.id === r.a);
    const aiBtn = state.isOwner ? `<button class="btn primary small" id="btn-ai-new" ${state.aiBusy ? 'disabled' : ''} onclick="App.openAI(null)">✨ Neues Rezept mit KI</button>` : '';
    return `
      <div class="toolbar no-print">
        <h2 style="margin:0;flex:1">Gruppe: ${esc(g ? g.name : '')}</h2>
        ${aiBtn}
      </div>
      ${toolbarHtml()}
      <div class="recipe-list" id="recipe-list"></div>`;
  }
  const aiBtn = state.isOwner ? `<button class="btn primary small" id="btn-ai-new" ${state.aiBusy ? 'disabled' : ''} onclick="App.openAI(null)">✨ Neues Rezept mit KI</button>` : '';
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
