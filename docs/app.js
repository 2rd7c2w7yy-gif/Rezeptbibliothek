'use strict';

/* =====================================================================
   RezeptBibliothek – Web-App (GitHub Pages, statisch)
   - Anmeldung: GitHub Personal Access Token (nur im sessionStorage)
   - Eigene Rezepte: privates (secret) Gist
   - Gruppen: private GitHub-Repos "rezeptbibliothek-gruppe-*" mit Collaborators
   - KI: Mistral API direkt aus dem Browser (Key nur im sessionStorage)
   ===================================================================== */

const GH = 'https://api.github.com';
const MISTRAL = 'https://api.mistral.ai';
const GH_API_VERSION = '2022-11-28';
const GIST_MARKER = 'RezeptBibliothek|data';
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
  token: sessionStorage.getItem('gh_token') || '',
  mistralKey: sessionStorage.getItem('mistral_key') || '',
  user: null,
  gistId: localStorage.getItem('rb_gist') || '',
  recipes: [],            // persönliche Rezepte
  groups: [],             // Gruppen (repos)
  groupRecipes: [],       // Rezepte der aktuell geöffneten Gruppe
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
  return { name: parts[0] || 'rezepte', a: parts[1], b: parts[2], c: parts[3] };
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
    try { const e = await res.json(); if (e.message) msg = e.message + (e.errors ? ' ' + JSON.stringify(e.errors) : ''); } catch {}
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
    headers: {
      'Authorization': `Bearer ${state.mistralKey}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Mistral: ' + (data?.error?.message || res.status + ' ' + res.statusText));
  return data;
}

/* ---------------- Rezept-Dateiformat (Front Matter) ---------------- */
function yamlVal(v) { return '"' + String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }
function yamlKey(line) { const i = line.indexOf(':'); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; }
function yamlUnq(v) { v = v.trim(); if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\'); return v; }

function encodeRecipeFile(r) {
  const fm = [
    '---',
    'id: ' + yamlVal(r.id),
    'title: ' + yamlVal(r.title),
    'category: ' + yamlVal(r.category),
    'device: ' + yamlVal(deviceById(r.device).label),
    'favorite: ' + (r.favorite ? 'true' : 'false'),
    'created: ' + yamlVal(r.created),
    'updated: ' + yamlVal(r.updated),
    '---',
  ].join('\n');
  return fm + '\n\n' + r.markdown + '\n';
}

function parseRecipeFile(content) {
  const m = String(content).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta = {};
  if (m) for (const line of m[1].split('\n')) { const [k, v] = yamlKey(line); if (k) meta[k] = yamlUnq(v); }
  return {
    id: meta.id || uid(),
    title: meta.title || 'Ohne Titel',
    category: meta.category || 'Allgemein',
    device: (DEVICES.find(d => d.label === meta.device) || DEVICES[1]).id,
    favorite: meta.favorite === 'true',
    created: meta.created || nowISO(),
    updated: meta.updated || nowISO(),
    markdown: m ? m[2].trim() : String(content),
  };
}

/* ---------------- Persönliche Daten (privates Gist) ---------------- */
async function getGist() {
  if (state.gistId) {
    try { return await gh('/gists/' + state.gistId); } catch { state.gistId = ''; localStorage.removeItem('rb_gist'); }
  }
  const list = await gh('/gists?per_page=100');
  const found = (list || []).find(g => g.description === GIST_MARKER);
  if (found) { state.gistId = found.id; localStorage.setItem('rb_gist', found.id); return found; }
  const created = await gh('/gists', {
    method: 'POST',
    body: { description: GIST_MARKER, public: false, files: { 'data.json': { content: JSON.stringify({ recipes: [] }) } } },
  });
  state.gistId = created.id;
  localStorage.setItem('rb_gist', created.id);
  return created;
}

async function loadPersonal() {
  const gist = await getGist();
  const file = gist.files && gist.files['data.json'];
  const data = file ? JSON.parse(file.content) : { recipes: [] };
  state.recipes = (data.recipes || []).map(r => ({ ...r }));
}

async function savePersonal() {
  const gist = await getGist();
  await gh('/gists/' + state.gistId, {
    method: 'PATCH',
    body: { files: { 'data.json': { content: JSON.stringify({ recipes: state.recipes }, null, 1) } } },
  });
}

/* ---------------- Gruppen (private Repos) ---------------- */
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
    groups.push({ repo: repo.full_name, owner: repo.owner.login, name: repo.name, ...meta, permissions: repo.permissions });
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
  await gh(`/repos/${repo.full_name}/contents/group.json`, {
    method: 'PUT',
    body: { message: 'Gruppe anlegen', content: b64enc(JSON.stringify(meta, null, 1)) },
  });
  await gh(`/repos/${repo.full_name}/contents/recipes/.gitkeep`, {
    method: 'PUT',
    body: { message: 'recipes/', content: b64enc('') },
  });
  return repo.full_name;
}

async function inviteMember(fullName, username) {
  await gh(`/repos/${fullName}/collaborators/${encodeURIComponent(username)}`, { method: 'PUT', body: { permission: 'push' } });
  // auch in group.json vermerken
  try {
    const f = await gh(`/repos/${fullName}/contents/group.json`);
    const meta = JSON.parse(b64dec(f.content));
    if (!meta.members.includes(username)) meta.members.push(username);
    await gh(`/repos/${fullName}/contents/group.json`, {
      method: 'PUT',
      body: { message: 'Mitglied einladen', content: b64enc(JSON.stringify(meta, null, 1)), sha: f.sha },
    });
  } catch (e) { console.warn('group.json update failed', e); }
}

async function listGroupRecipes(fullName) {
  const list = await gh(`/repos/${fullName}/contents/recipes`);
  const recipes = [];
  for (const f of (list || [])) {
    if (!f.name.endsWith('.md')) continue;
    const file = await gh(`/repos/${fullName}/contents/recipes/${f.name}`);
    recipes.push(parseRecipeFile(b64dec(file.content)));
  }
  state.groupRecipes = recipes;
}

async function writeGroupRecipe(fullName, recipe) {
  const path = `recipes/${recipe.id}.md`;
  let sha;
  try { sha = (await gh(`/repos/${fullName}/contents/${path}`)).sha; } catch {}
  await gh(`/repos/${fullName}/contents/${path}`, {
    method: 'PUT',
    body: { message: 'Rezept speichern: ' + recipe.title, content: b64enc(encodeRecipeFile(recipe)), ...(sha ? { sha } : {}) },
  });
}

async function deleteGroupRecipe(fullName, recipe) {
  const path = `recipes/${recipe.id}.md`;
  const f = await gh(`/repos/${fullName}/contents/${path}`);
  await gh(`/repos/${fullName}/contents/${path}`, { method: 'DELETE', body: { message: 'Rezept löschen: ' + recipe.title, sha: f.sha } });
}

/* ---------------- KI (Mistral) ---------------- */
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
  if (content.startsWith('```')) { content = content.replace(/^```[a-z]*\n/i, '').replace(/```$/, '').trim(); }
  return content;
}

function extractTitle(markdown) {
  for (const line of markdown.split('\n')) {
    const t = line.trim();
    if (t.startsWith('# ')) return t.slice(2).trim();
  }
  return 'Neues Rezept';
}

/* ---------------- App-Objekt (von Inline-Handlern genutzt) ---------------- */
window.App = {

  async boot() {
    if (state.token) {
      try {
        state.user = await gh('/user');
        await loadPersonal();
        await loadGroups();
        App.render();
        return;
      } catch (e) { console.warn('Session ungültig:', e.message); }
    }
    sessionStorage.removeItem('gh_token');
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
      sessionStorage.setItem('gh_token', token);
      await loadPersonal();
      await loadGroups();
      location.hash = '#/rezepte';
      App.render();
    } catch (e) {
      state.token = '';
      App.showError(e.message);
      $('#login-status').textContent = '';
    }
  },

  logout() {
    sessionStorage.removeItem('gh_token');
    sessionStorage.removeItem('mistral_key');
    state.token = ''; state.mistralKey = ''; state.user = null;
    location.hash = '';
    App.render();
  },

  showError(msg) { const el = $('#login-error'); if (el) el.textContent = msg; },

  nav(name) { location.hash = '#/' + name; },

  setFilter(key, value) { state.filter[key] = value; App.renderList(); },
  setDevice(id) { state.device = id; localStorage.setItem('rb_device', id); App.render(); },

  /* ----- Listen ----- */
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
    const items = inGroup ? state.groupRecipes : state.recipes;
    const r = items.find(x => x.id === id);
    if (!r) return;
    const base = inGroup ? `#/gruppe/${state.route.a}/${state.route.b}` : '#/rezepte';
    location.hash = base + '/' + id;
  },

  /* ----- CRUD ----- */
  async saveRecipe(recipe) {
    const inGroup = state.route.name === 'gruppe' || state.route.name === 'gruppen-detail';
    if (inGroup) {
      const full = state.route.a + '/' + state.route.b;
      recipe.updated = nowISO();
      await writeGroupRecipe(full, recipe);
      await listGroupRecipes(full);
    } else {
      const i = state.recipes.findIndex(x => x.id === recipe.id);
      recipe.updated = nowISO();
      if (i >= 0) state.recipes[i] = recipe; else state.recipes.unshift(recipe);
      await savePersonal();
    }
    App.render();
  },

  async deleteRecipe(id) {
    if (!confirm('Rezept wirklich löschen?')) return;
    const inGroup = state.route.name === 'gruppe';
    if (inGroup) {
      const full = state.route.a + '/' + state.route.b;
      const r = state.groupRecipes.find(x => x.id === id);
      await deleteGroupRecipe(full, r);
      await listGroupRecipes(full);
    } else {
      state.recipes = state.recipes.filter(x => x.id !== id);
      await savePersonal();
    }
    history.back();
    App.render();
  },

  async toggleFav(id) {
    const items = state.route.name === 'gruppe' ? state.groupRecipes : state.recipes;
    const r = items.find(x => x.id === id);
    if (r) { r.favorite = !r.favorite; await App.saveRecipe(r); }
  },

  /* ----- Gruppen ----- */
  async openGroup(full) {
    const [owner, repo] = full.split('/');
    location.hash = '#/gruppe/' + owner + '/' + repo;
  },

  async openGroupFromRoute() {
    const full = state.route.a + '/' + state.route.b;
    $('#group-title').textContent = 'Gruppe: ' + full.replace(GROUP_PREFIX, '');
    await listGroupRecipes(full);
    App.renderList();
  },

  /* ----- Modals ----- */
  openModal(html) { $('#modal-root').innerHTML = `<div class="modal-backdrop" onclick="if(event.target===this)App.closeModal()"><div class="modal">${html}</div></div>`; },
  closeModal() { $('#modal-root').innerHTML = ''; },

  openAI(scope, existingId) {
    const existing = existingId ? (state.route.name === 'gruppe' ? state.groupRecipes : state.recipes).find(r => r.id === existingId) : null;
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
        <button class="btn primary" onclick="App.runAI('${scope}', ${existing ? `'${existing.id}'` : 'null'})">${existing ? 'Überarbeiten (KI)' : 'Rezept generieren'}</button>
      </div>
      <div id="ai-preview"></div>
    `);
    if (existing) $('#ai-wish').value = '';
  },

  async runAI(scope, existingId) {
    const wish = $('#ai-wish').value.trim();
    if (!wish) { $('#ai-error').textContent = 'Bitte Wunsch eingeben.'; return; }
    const category = $('#ai-category').value;
    const device = deviceById(state.device);
    $('#ai-error').textContent = '';
    $('#ai-status').innerHTML = '<span class="spinner"></span>Skill wird geladen …';
    try {
      const skill = await getSkillBody();
      const systemPrompt = buildSystemPrompt(skill.body, device);
      let markdown;
      if (existingId) {
        const items = state.route.name === 'gruppe' ? state.groupRecipes : state.recipes;
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
        created: existingId ? (items => items.created)(null) || nowISO() : nowISO(),
        updated: nowISO(),
        markdown,
      };
      if (existingId) {
        const items = state.route.name === 'gruppe' ? state.groupRecipes : state.recipes;
        const old = items.find(r => r.id === existingId);
        if (old) { recipe.created = old.created; recipe.favorite = old.favorite; }
      }
      $('#ai-status').textContent = 'Fertig – speichern?';
      $('#ai-preview').innerHTML = `<div class="article">${renderMarkdown(markdown)}</div>
        <div class="actions">
          <button class="btn" onclick="App.closeModal()">Verwerfen</button>
          <button class="btn primary" onclick="App.saveAI('${recipe.id}','${esc(recipe.title)}','${esc(recipe.category)}','${recipe.device}', ${existingId ? 'true' : 'false'})">${existingId ? 'Rezept aktualisieren' : 'In Bibliothek speichern'}</button>
        </div>`;
      window.__pendingAI = recipe;
    } catch (e) {
      $('#ai-error').textContent = e.message;
      $('#ai-status').textContent = '';
    }
  },

  async saveAI(id, title, category, deviceId, isUpdate) {
    const recipe = window.__pendingAI;
    recipe.id = id; recipe.title = title; recipe.category = category; recipe.device = deviceId; recipe.updated = nowISO();
    App.closeModal();
    await App.saveRecipe(recipe);
    if (state.route.name === 'rezept') history.back();
    App.render();
  },

  openGroupModal() {
    App.openModal(`
      <h3>Neue Gruppe erstellen</h3>
      <div class="field"><label>Gruppenname</label><input id="group-name" placeholder="z. B. Familie Müller"></div>
      <div class="hint">Es wird ein <b>privates GitHub-Repo</b> <code>${GROUP_PREFIX}…</code> angelegt. Mitglieder lädst du danach per GitHub-Benutzername ein (sie bekommen eine E-Mail-Einladung).</div>
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
    const g = state.groups.find(x => x.repo === state.route.a + '/' + state.route.b) || { repo: state.route.a + '/' + state.route.b, name: '' };
    App.openModal(`
      <h3>Mitglied einladen – ${esc(g.name || g.repo)}</h3>
      <div class="field"><label>GitHub-Benutzername</label><input id="invite-user" placeholder="z. B. maxmustermann"></div>
      <div class="hint">Der eingeladene Anwender bekommt eine GitHub-Einladung per E-Mail. Nach dem Annehmen sieht er die Gruppe und kann Rezepte lesen & bearbeiten.</div>
      <div id="invite-status" class="status"></div>
      <div class="actions">
        <button class="btn" onclick="App.closeModal()">Schließen</button>
        <button class="btn primary" onclick="App.invite('${g.repo}')">Einladen</button>
      </div>
    `);
  },

  async invite(repo) {
    const username = $('#invite-user').value.trim();
    if (!username) return;
    $('#invite-status').innerHTML = '<span class="spinner"></span>Einladung wird gesendet …';
    try {
      await inviteMember(repo, username);
      $('#invite-status').textContent = 'Einladung an @' + username + ' gesendet (E-Mail von GitHub).';
    } catch (e) { $('#invite-status').textContent = 'Fehler: ' + e.message; }
  },

  openSettings() {
    App.openModal(`
      <h3>Einstellungen</h3>
      <div class="field">
        <label>Mistral API-Key (nur in dieser Browser-Session, wird nur an api.mistral.ai gesendet)</label>
        <input id="mistral-key" type="password" value="${esc(state.mistralKey)}" placeholder="sk-…">
        <div class="hint">Key erstellen: <a href="https://console.mistral.ai" target="_blank" rel="noopener">console.mistral.ai</a> → API Keys. Ohne Key nutzt die App die eingebettete Skill-Kopie.</div>
      </div>
      <div class="actions">
        <button class="btn" onclick="App.closeModal()">Abbrechen</button>
        <button class="btn primary" onclick="App.saveSettings()">Speichern</button>
      </div>
    `);
  },

  saveSettings() {
    state.mistralKey = $('#mistral-key').value.trim();
    sessionStorage.setItem('mistral_key', state.mistralKey);
    App.closeModal();
  },

  printRecipe() { window.print(); },

  /* ----- Render ----- */
  render() {
    state.route = parseRoute();
    const app = $('#app');
    if (!state.user) { app.innerHTML = viewLogin(); $('#login-token').focus(); return; }
    app.innerHTML = viewShell();
    if (state.route.name === 'gruppe' && state.route.a && state.route.b) {
      App.openGroupFromRoute().then(() => { if (state.route.c) App.showRecipeDetail(state.route.c); });
    } else if (state.route.name === 'rezept') {
      App.showRecipeDetail(state.route.a);
    } else if (state.route.name === 'rezepte' && state.route.a) {
      App.showRecipeDetail(state.route.a);
    } else {
      App.renderList();
    }
  },

  async showRecipeDetail(id) {
    const inGroup = state.route.name === 'gruppe';
    const items = inGroup ? state.groupRecipes : state.recipes;
    const r = items.find(x => x.id === id);
    const main = $('#main');
    if (!r) { main.innerHTML = '<div class="empty">Rezept nicht gefunden.</div>'; return; }
    const base = inGroup ? `#/gruppe/${state.route.a}/${state.route.b}` : '#/rezepte';
    main.innerHTML = `
      <div class="no-print detail-head">
        <button class="btn small" onclick="location.hash='${base}'">← Zurück</button>
        <h2>${r.favorite ? '★ ' : ''}${esc(r.title)}</h2>
        <button class="btn small" onclick="App.toggleFav('${esc(r.id)}')">${r.favorite ? '★ Favorit' : '☆ Favorit'}</button>
        <button class="btn small" onclick="App.openAI('${inGroup ? 'group' : 'personal'}','${esc(r.id)}')">Mit KI überarbeiten</button>
        <button class="btn small" onclick="App.printRecipe()">Als PDF drucken</button>
        <button class="btn small danger" onclick="App.deleteRecipe('${esc(r.id)}')">Löschen</button>
      </div>
      <div class="meta" style="margin-bottom:10px">
        <span class="badge">${esc(r.category)}</span>
        <span class="badge device">${esc(deviceById(r.device).label)}</span>
        <span class="badge">${esc(fmtDate(r.updated))}</span>
      </div>
      <div id="print-area" class="article">${renderMarkdown(r.markdown)}</div>
    `;
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
      <input id="login-token" type="password" placeholder="github_pat_…" autocomplete="off">
      <div class="hint">
        Token erstellen: <a href="https://github.com/settings/tokens" target="_blank" rel="noopener">github.com/settings/tokens</a>
        → „Fine-grained tokens“ → „Generate new token“ → Repository access: <b>All repositories</b>,
        Permissions: <b>Contents: Read and write</b>, <b>Metadata: Read-only</b>, <b>Administration: Read and write</b> (für Gruppeneinladungen).
        Der Token bleibt nur in diesem Browser-Tab (sessionStorage) und wird nur an api.github.com gesendet.
      </div>
    </div>
    <button class="btn primary" style="width:100%" onclick="App.login()">Anmelden</button>
    <div id="login-status" class="status"></div>
    <div id="login-error" class="error"></div>
  </div>`;
}

function viewShell() {
  const r = state.route;
  const groupsNav = state.groups.map(g => `
    <button class="nav-item ${r.name === 'gruppe' && r.a + '/' + r.b === g.repo ? 'active' : ''}" onclick="App.openGroup('${esc(g.repo)}')">
      👥 ${esc(g.name || g.repo.replace(GROUP_PREFIX, ''))}
    </button>`).join('');
  return `
  <div class="topbar no-print">
    <span class="logo">🍲 RezeptBibliothek</span>
    <span class="spacer"></span>
    <span class="user">angemeldet als <b>@${esc(state.user.login)}</b></span>
    <button class="btn small" onclick="App.openSettings()">⚙️</button>
    <button class="btn small" onclick="App.logout()">Abmelden</button>
  </div>
  <div class="layout">
    <div class="sidebar no-print">
      <h3>Bibliothek</h3>
      <button class="nav-item ${r.name === 'rezepte' || r.name === 'rezept' ? 'active' : ''}" onclick="App.nav('rezepte')">📖 Meine Rezepte (${state.recipes.length})</button>
      <button class="nav-item ${r.name === 'gruppen' ? 'active' : ''}" onclick="App.nav('gruppen')">👥 Gruppen (${state.groups.length})</button>
      <h3>Gruppen</h3>
      ${groupsNav || '<div class="hint">Noch keine Gruppen.</div>'}
      <button class="btn small" style="margin-top:8px" onclick="App.openGroupModal()">+ Neue Gruppe</button>
    </div>
    <div class="main" id="main">${viewMain()}</div>
  </div>`;
}

function viewMain() {
  const r = state.route;
  if (r.name === 'gruppen') {
    if (!state.groups.length) return '<div class="empty">Noch keine Gruppen. Erstelle eine Gruppe und lade andere per GitHub-Name ein.</div>';
    return `<h2>Gruppen</h2><div class="recipe-list">` + state.groups.map(g => `
      <div class="card" onclick="App.openGroup('${esc(g.repo)}')">
        <div class="title">👥 ${esc(g.name || g.repo.replace(GROUP_PREFIX, ''))}</div>
        <div class="meta"><span class="badge">${esc(g.repo)}</span><span class="badge">${(g.members || []).length} Mitglieder</span></div>
      </div>`).join('') + '</div>';
  }
  if (r.name === 'gruppe') {
    return `
      <div class="toolbar no-print">
        <h2 id="group-title" style="margin:0;flex:1">Gruppe</h2>
        <button class="btn primary small" onclick="App.openAI('group', null)">✨ Neues Rezept mit KI</button>
        <button class="btn small" onclick="App.openInviteModal()">+ Mitglied einladen</button>
      </div>
      ${toolbarHtml()}
      <div class="recipe-list" id="recipe-list"></div>`;
  }
  // rezepte
  return `
    <div class="toolbar no-print">
      <h2 style="margin:0;flex:1">Meine Rezepte</h2>
      <button class="btn primary small" onclick="App.openAI('personal', null)">✨ Neues Rezept mit KI</button>
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
