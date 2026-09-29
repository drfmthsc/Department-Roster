/* ===========================================================
   Roster runtime: Google sign-in, Firestore, live updates.
   Everything the page needs from the server goes through RT.
   =========================================================== */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, doc, collection, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, writeBatch, query, orderBy, limit, serverTimestamp }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

import { FIREBASE_CONFIG } from './config.js';

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

const META = doc(db, 'meta', 'roster');
const OFFICE = doc(db, 'config', 'office');
const SESSIONS = collection(db, 'sessions');
const SWAPS = collection(db, 'swaps');

/* what the page last saw, so only real changes are written */
let shadow = { meta: '', sessions: new Map() };
let stop = [];
let user = null;

const el = (id) => document.getElementById(id);
const screen = (html) => { el('app').innerHTML = html; };

function signInScreen(msg) {
  screen(`<div class="panel" style="max-width:520px;margin:12vh auto">
    <h2>Department Teaching Roster</h2>
    <p class="lead">Sign in with the Google account the department knows you by. Workspace addresses and personal Gmail both work.</p>
    ${msg ? `<p class="help" style="color:var(--bad)">${msg}</p>` : ''}
    <div class="row-actions"><button class="btn primary" id="signin">Sign in with Google</button></div>
  </div>`);
  el('signin').onclick = () => signInWithPopup(auth, new GoogleAuthProvider()).catch(e => signInScreen(e.message));
}

/* ---------- reading ---------- */

async function loadAll() {
  const [metaSnap, officeSnap, sessSnap, swapSnap] = await Promise.all([
    getDoc(META), getDoc(OFFICE), getDocs(SESSIONS), getDocs(query(SWAPS, orderBy('loggedOn', 'desc'), limit(300)))
  ]);
  const meta = metaSnap.exists() ? metaSnap.data() : {};
  const officeEmails = (officeSnap.exists() ? officeSnap.data().emails : []) || [];
  const sessions = [];
  sessSnap.forEach(d => sessions.push({ ...d.data(), id: d.id }));
  const swaps = [];
  swapSnap.forEach(d => swaps.push({ ...d.data(), id: d.id }));

  const data = { ...(meta.roster ? JSON.parse(meta.roster) : {}), sessions, swaps };
  const email = (user.email || '').toLowerCase();
  const mine = (data.faculty || []).find(f => (f.email || '').toLowerCase() === email);
  const me = {
    email, name: mine ? mine.name : (user.displayName || email),
    facultyId: mine ? mine.id : '',
    isOffice: officeEmails.map(x => String(x).toLowerCase()).includes(email) || !!(mine && mine.office),
    prefs: { weekly: true, daily: true, swaps: true }
  };
  /* each person keeps their own email settings */
  try {
    const p = await getDoc(doc(db, 'prefs', email));
    if (p.exists()) me.prefs = { ...me.prefs, ...p.data() };
  } catch (e) { /* not fatal */ }
  /* phone numbers are visible to the office only */
  if (me.isOffice) {
    try {
      const cs = await getDocs(collection(db, 'contacts'));
      const byId = {};
      cs.forEach(d => byId[d.id] = d.data());
      (data.faculty || []).forEach(f => { const c = byId[f.id]; if (c) { f.phone = c.phone || ''; } });
    } catch (e) { /* not fatal */ }
  }
  remember(data);
  return { data, me };
}

function remember(data) {
  shadow.meta = JSON.stringify(metaPart(data));
  shadow.sessions = new Map((data.sessions || []).map(s => [s.id, JSON.stringify(s)]));
}

/** everything except the classes and the swaps, which have their own documents */
function metaPart(S) {
  const { sessions, swaps, meta, ...rest } = S;
  const faculty = (rest.faculty || []).map(f => { const g = { ...f }; delete g.phone; return g; });
  return { ...rest, faculty };
}

/* ---------- writing ---------- */

async function save(S) {
  const metaJson = JSON.stringify(metaPart(S));
  let writes = 0;
  const batches = [];
  let batch = writeBatch(db), n = 0;
  const push = (fn) => { fn(batch); n++; writes++; if (n >= 400) { batches.push(batch); batch = writeBatch(db); n = 0; } };

  if (metaJson !== shadow.meta) {
    /* the rules need to know which faculty id belongs to which signed-in address,
       so that map is stored as a field of its own rather than inside the JSON */
    const facultyByEmail = {};
    (S.faculty || []).forEach(f => { if (f.email) facultyByEmail[String(f.email).toLowerCase()] = f.id; });
    push(b => b.set(META, { roster: metaJson, facultyByEmail, savedAt: serverTimestamp(), savedBy: user.email }));
  }
  const seen = new Set();
  for (const s of S.sessions) {
    seen.add(s.id);
    const json = JSON.stringify(s);
    if (shadow.sessions.get(s.id) !== json) {
      const { id, ...rest } = s;
      push(b => b.set(doc(SESSIONS, s.id), rest));
    }
  }
  for (const id of shadow.sessions.keys()) if (!seen.has(id)) push(b => b.delete(doc(SESSIONS, id)));
  /* swaps the office added or changed by hand */
  for (const sw of (S.swaps || [])) {
    const { id, ...rest } = sw;
    if (!id) continue;
    push(b => b.set(doc(SWAPS, id), rest, { merge: true }));
  }
  if (!writes) return 0;
  batches.push(batch);
  for (const b of batches) await b.commit();
  /* phone numbers go to their own documents, which teachers cannot read */
  for (const f of (S.faculty || [])) {
    if (f.phone !== undefined) await setDoc(doc(db, 'contacts', f.id), { phone: f.phone || '' }, { merge: true });
  }
  remember(S);
  return writes;
}

async function offerSwap(req) {
  const rec = {
    ...req, loggedOn: new Date().toISOString().slice(0, 10),
    status: 'Requested', decidedOn: '', byEmail: user.email, at: serverTimestamp()
  };
  await addDoc(SWAPS, rec);
}

async function respondSwap(sw, accept) {
  const now = new Date().toISOString().slice(0, 10);
  await updateDoc(doc(SWAPS, sw.id), { status: accept ? 'Accepted' : 'Declined', decidedOn: now });
  if (!accept) return;
  const batch = writeBatch(db);
  batch.update(doc(SESSIONS, sw.sessionId), { facultyId: sw.toId, locked: true });
  if (sw.exchangeId) batch.update(doc(SESSIONS, sw.exchangeId), { facultyId: sw.fromId, locked: true });
  await batch.commit();
}

async function setPrefs(prefs) {
  await setDoc(doc(db, 'prefs', (user.email || '').toLowerCase()), prefs, { merge: true });
}

/* ---------- live updates from other people ---------- */

function watch() {
  stop.forEach(f => f()); stop = [];
  const refresh = (snap) => {
    if (snap.metadata.hasPendingWrites) return;   // our own write coming back
    loadAll().then(r => window.remoteUpdate(r.data)).catch(() => {});
  };
  stop.push(onSnapshot(META, refresh));
  stop.push(onSnapshot(SESSIONS, refresh));
  stop.push(onSnapshot(SWAPS, refresh));
}

window.RT = {
  save,
  offerSwap,
  respondSwap,
  setPrefs,
  reload: () => loadAll().then(r => window.boot(r)),
  signOut: () => signOut(auth)
};

onAuthStateChanged(auth, async (u) => {
  if (!u) { stop.forEach(f => f()); stop = []; signInScreen(''); return; }
  user = u;
  screen('<div class="panel"><h2>Opening the roster</h2><p class="lead">One moment.</p></div>');
  try {
    const r = await loadAll();
    window.boot(r);
    watch();
  } catch (e) {
    screen(`<div class="panel"><h2>Could not open the roster</h2><p class="lead">${e.message}</p>
      <p class="help">If this mentions permissions, ask the office to add your address, or check the Firestore rules.</p>
      <div class="row-actions"><button class="btn" onclick="RT.signOut()">Sign out</button></div></div>`);
  }
});
