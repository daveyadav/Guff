"use strict";
/* Guff — messaging app. Firebase (auth + firestore + storage) backend. */

const $ = id => document.getElementById(id);
const state = {
  user: null, profile: null,
  chatId: null, otherUid: null, otherProfile: null,
  unsubs: [], chatUnsubs: [], typingTimer: null, rec: null, recStart: 0, recTick: null,
};
let auth = null, db = null, storage = null;
const serverTS = () => firebase.firestore.FieldValue.serverTimestamp();
const inc = n => firebase.firestore.FieldValue.increment(n);

/* ---------- helpers ---------- */
function toast(msg, ms = 2400) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add("hidden"), ms);
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.toggle("active", s.id === id));
}
function showTab(id) {
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.id === id));
  document.querySelectorAll(".navbtn").forEach(b => b.classList.toggle("active", b.dataset.tab === id));
}
function avatarSVG(name) {
  const ch = ((name || "?").trim().charAt(0) || "?").toUpperCase();
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96'><rect width='96' height='96' rx='48' fill='#223029'/><text x='48' y='62' font-size='40' text-anchor='middle' fill='#00d9a3' font-family='sans-serif' font-weight='bold'>${ch}</text></svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}
function avatarURL(p) {
  return (p && p.photoURL) ? p.photoURL : avatarSVG(p && p.displayName);
}
function timeFmt(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function dayLabel(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const now = new Date();
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((today - day) / 864e5);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}
function fmtSize(b) {
  if (b == null) return "";
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
  return (b / 1048576).toFixed(1) + " MB";
}
function fmtDur(s) {
  s = Math.round(s || 0);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}
function tsMillis(v) {
  if (!v) return 0;
  return v.toMillis ? v.toMillis() : v;
}
/* Profile cache: lets a refresh restore the main screen instantly and
   keeps the user signed in visually even if the network is flaky. */
const PROFILE_CACHE_KEY = "guff_profile_v1";
function writeProfileCache(p) { try { localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(p)); } catch (e) {} }
function readProfileCache() { try { const s = localStorage.getItem(PROFILE_CACHE_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
function clearProfileCache() { try { localStorage.removeItem(PROFILE_CACHE_KEY); } catch (e) {} }
/* Safe single-doc read: returns the snapshot, or null when the doc is missing.
   Our rules deny reads of missing docs in some collections (accessing
   resource.data on a missing doc fails the rule), so a missing doc surfaces
   as an error — treat it as "not there" instead of failing the whole flow. */
async function getDocOrNull(ref) {
  try {
    const d = await ref.get();
    return d.exists ? d : null;
  } catch (e) {
    return null;
  }
}
function stopAll() {
  state.unsubs.forEach(u => { try { u(); } catch (e) {} });
  state.unsubs = [];
}

/* ---------- init ---------- */
window.addEventListener("DOMContentLoaded", init);

function init() {
  wireStatic();
  if (!FIREBASE_READY) {
    $("cfg-warning").classList.remove("hidden");
    $("btn-google").disabled = true;
    $("btn-google").style.opacity = 0.5;
    showScreen("screen-auth");
    registerSW();
    return;
  }
  firebase.initializeApp(FIREBASE_CONFIG);
  auth = firebase.auth();
  db = firebase.firestore();
  storage = firebase.storage();
  auth.onAuthStateChanged(onAuth);
  bindAuthButtons();
  registerSW();
}

function wireStatic() {
  document.querySelectorAll(".navbtn").forEach(b =>
    b.addEventListener("click", () => showTab(b.dataset.tab)));
  $("btn-chat-back").addEventListener("click", closeChat);
  $("msg-input").addEventListener("input", onComposerInput);
  $("msg-input").addEventListener("keydown", e => {
    if (e.key === "Enter") sendText();
  });
  $("btn-send").addEventListener("click", sendText);
  $("btn-attach").addEventListener("click", () => $("file-input").click());
  $("file-input").addEventListener("change", sendFiles);
  $("btn-mic").addEventListener("click", toggleRecording);
  $("btn-rec-cancel").addEventListener("click", cancelRecording);
  $("btn-retry-load").addEventListener("click", () => location.reload());
}

/* ---------- auth ---------- */
function onAuth(user) {
  state.user = user;
  if (!user) {
    // Genuinely signed out: this is the ONLY path that shows the login screen.
    stopAll();
    state.profile = null;
    clearProfileCache();
    showScreen("screen-auth");
    return;
  }
  // Signed in: enter immediately with the cached profile so a refresh never
  // drops back to the login screen, then refresh the profile in the background.
  const cached = readProfileCache();
  if (cached && cached.uid === user.uid && cached.username) {
    state.profile = cached;
    enterMain();
  }
  db.collection("users").doc(user.uid).get().then(doc => {
    if (doc.exists && doc.data().username) {
      state.profile = Object.assign({ uid: user.uid }, doc.data());
      writeProfileCache(state.profile);
      enterMain();
    } else if (!state.profile || state.profile.uid !== user.uid) {
      // needs onboarding (and we aren't already in main with a cached profile)
      $("ob-displayname").value = user.displayName || "";
      showScreen("screen-onboarding");
    }
  }).catch(err => {
    console.error(err);
    if (state.profile && state.profile.uid === user.uid) {
      toast("Couldn't refresh your profile — showing cached info.");
    } else {
      // Still signed in, just unreachable: stay on loading with a retry option.
      // Never bounce a signed-in user to the login screen.
      $("loading-msg").textContent = "Couldn't reach Guff. Check your connection.";
      $("btn-retry-load").classList.remove("hidden");
    }
  });
}

function bindAuthButtons() {
  $("btn-google").addEventListener("click", async () => {
    try {
      await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
    } catch (e) {
      console.error(e);
      toast(e.code === "auth/popup-closed-by-user" ? "Sign-in cancelled." : "Google sign-in failed: " + friendlyAuthError(e));
    }
  });

  $("form-login").addEventListener("submit", async e => {
    e.preventDefault();
    const errEl = $("login-error");
    errEl.classList.add("hidden");
    const username = $("login-username").value.trim().toLowerCase();
    const password = $("login-password").value;
    if (!username || !password) return;
    try {
      const unDoc = await db.collection("usernames").doc(username).get();
      if (!unDoc.exists) throw { code: "auth/user-not-found" };
      const uid = unDoc.data().uid;
      const uDoc = await db.collection("users").doc(uid).get();
      const email = uDoc.exists ? uDoc.data().email : null;
      if (!email) throw { code: "auth/user-not-found" };
      await auth.signInWithEmailAndPassword(email, password);
    } catch (e) {
      console.error(e);
      errEl.textContent = friendlyAuthError(e);
      errEl.classList.remove("hidden");
    }
  });

  // onboarding avatar preview
  $("ob-avatar").addEventListener("change", e => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      $("ob-avatar-preview").src = r.result;
      $("ob-avatar-preview").classList.remove("hidden");
      $("ob-avatar-plus").classList.add("hidden");
    };
    r.readAsDataURL(f);
  });

  $("form-onboarding").addEventListener("submit", finishOnboarding);
  $("btn-ob-logout").addEventListener("click", () => auth.signOut());
  $("btn-logout").addEventListener("click", () => auth.signOut());
  $("btn-logout-top").addEventListener("click", () => auth.signOut());
}

function friendlyAuthError(e) {
  const map = {
    "auth/user-not-found": "No account with that username.",
    "auth/wrong-password": "Wrong password. Try again.",
    "auth/invalid-credential": "Wrong username or password.",
    "auth/invalid-email": "That email looks invalid.",
    "auth/email-already-in-use": "That email is already registered.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/too-many-requests": "Too many tries — wait a bit and retry.",
    "auth/network-request-failed": "Network error. Check your connection.",
  };
  return map[e.code] || "Something went wrong. Try again.";
}

async function finishOnboarding(e) {
  e.preventDefault();
  const errEl = $("ob-error");
  errEl.classList.add("hidden");
  const fail = m => { errEl.textContent = m; errEl.classList.remove("hidden"); };

  const username = $("ob-username").value.trim().toLowerCase();
  const displayName = $("ob-displayname").value.trim();
  const pw = $("ob-password").value;
  const pw2 = $("ob-password2").value;

  if (!/^[a-z0-9_.]{3,20}$/.test(username))
    return fail("Username: 3–20 chars, letters, numbers, _ or .");
  if (!displayName) return fail("Please add a profile name.");
  if (pw.length < 6) return fail("Password must be at least 6 characters.");
  if (pw !== pw2) return fail("Passwords don't match.");

  const user = auth.currentUser;
  if (!user) return fail("Signed out — please log in again.");

  try {
    const unRef = db.collection("usernames").doc(username);
    const unDoc = await unRef.get();
    if (unDoc.exists) return fail("That username is taken. Try another.");

    // optional avatar upload (non-blocking: skipped if Storage isn't set up)
    let photoURL = user.photoURL || null;
    const f = $("ob-avatar").files[0];
    if (f) {
      try {
        const ref = storage.ref("profiles/" + user.uid + "/avatar.jpg");
        await ref.put(f);
        photoURL = await ref.getDownloadURL();
      } catch (upErr) {
        console.warn("avatar upload skipped:", upErr && upErr.code);
      }
    }

    // link password login to the Google account
    try {
      const cred = firebase.auth.EmailAuthProvider.credential(user.email, pw);
      await user.linkWithCredential(cred);
    } catch (linkErr) {
      // already linked / edge cases — profile creation still proceeds
      console.warn("link:", linkErr.code);
    }

    const batch = db.batch();
    batch.set(db.collection("users").doc(user.uid), {
      username, usernameLower: username, displayName,
      email: user.email, photoURL, createdAt: serverTS(),
    });
    batch.set(unRef, { uid: user.uid });
    await batch.commit();

    state.profile = { uid: user.uid, username, usernameLower: username, displayName, email: user.email, photoURL };
    writeProfileCache(state.profile);
    toast("Welcome to Guff, " + displayName + "!");
    enterMain();
  } catch (err) {
    console.error(err);
    fail("Couldn't finish setup: " + (err.message || "try again"));
  }
}

/* ---------- main ---------- */
function enterMain() {
  stopAll();
  showScreen("screen-main");
  showTab("tab-chats");
  renderProfileTab();
  subscribeChats();
  subscribeFriendships();
  subscribeRequests();
  $("btn-friend-search").onclick = searchFriend;
  $("friend-search").onkeydown = e => { if (e.key === "Enter") searchFriend(); };
  $("form-profile").onsubmit = saveProfileName;
  $("profile-avatar-input").onchange = uploadAvatar;
}

function chatIdFor(a, b) {
  return [a, b].sort().join("_");
}

/* ---------- friends ---------- */
async function searchFriend() {
  const q = $("friend-search").value.trim().toLowerCase().replace(/^@/, "");
  const box = $("friend-result");
  box.innerHTML = "";
  if (!q) return;
  if (!/^[a-z0-9_.]{3,20}$/.test(q)) {
    box.innerHTML = `<p class="muted">Type a valid username.</p>`;
    return;
  }
  box.innerHTML = `<p class="muted">Searching…</p>`;
  try {
    const unDoc = await db.collection("usernames").doc(q).get();
    if (!unDoc.exists) {
      box.innerHTML = `<p class="muted">No one found with username “${esc(q)}”.</p>`;
      return;
    }
    const uid = unDoc.data().uid;
    if (uid === state.user.uid) {
      box.innerHTML = `<p class="muted">That's you!</p>`;
      return;
    }
    const uDoc = await getDocOrNull(db.collection("users").doc(uid));
    const p = Object.assign({ uid: uid, displayName: q, username: q }, uDoc && uDoc.data());
    const alreadyFriend = await getDocOrNull(db.collection("friendships").doc(chatIdFor(state.user.uid, uid)));
    const reqId = state.user.uid + "_" + uid;
    const revId = uid + "_" + state.user.uid;
    const reqDoc = await getDocOrNull(db.collection("friendRequests").doc(reqId));
    const revDoc = await getDocOrNull(db.collection("friendRequests").doc(revId));
    let action;
    if (alreadyFriend) {
      action = `<button class="btn-accept" data-openchat="${uid}">Message</button>`;
    } else if (reqDoc && reqDoc.data().status === "pending") {
      action = `<span class="muted">Request sent</span>`;
    } else if (revDoc && revDoc.data().status === "pending") {
      action = `<span class="muted">They sent you a request — check Requests tab</span>`;
    } else {
      action = `<button class="btn-accept" data-add="${uid}" data-un="${esc(p.username)}" data-nm="${esc(p.displayName)}" data-ph="${esc(p.photoURL || "")}">Add friend</button>`;
    }
    box.innerHTML = `
      <div class="row" style="cursor:default">
        <img class="avatar" src="${esc(avatarURL(p))}" alt="">
        <div class="grow"><b>${esc(p.displayName)}</b><span>@${esc(p.username)}</span></div>
        <div class="req-actions">${action}</div>
      </div>`;
    box.querySelectorAll("[data-add]").forEach(b => b.addEventListener("click", () =>
      sendRequest(b.dataset.add, b.dataset.un, b.dataset.nm, b.dataset.ph)));
    box.querySelectorAll("[data-openchat]").forEach(b => b.addEventListener("click", () =>
      openChatWith(b.dataset.openchat)));
  } catch (e) {
    console.error(e);
    const code = e && e.code ? " (" + e.code + ")" : "";
    box.innerHTML = `<p class="muted">Search failed${esc(code)}. Try again.</p>`;
  }
}

async function sendRequest(toUid, toUsername, toName, toPhoto) {
  const from = state.user.uid;
  try {
    await db.collection("friendRequests").doc(from + "_" + toUid).set({
      from, fromUsername: state.profile.username, fromDisplayName: state.profile.displayName,
      fromPhoto: state.profile.photoURL || null,
      to: toUid, toUsername, status: "pending", createdAt: serverTS(),
    });
    toast("Friend request sent to @" + toUsername);
    $("friend-result").innerHTML = "";
    $("friend-search").value = "";
  } catch (e) {
    console.error(e);
    toast("Couldn't send request.");
  }
}

function subscribeRequests() {
  const me = state.user.uid;
  // single-field query (no composite index needed); pending filtered client-side
  const u1 = db.collection("friendRequests").where("to", "==", me)
    .onSnapshot(snap => {
      const docs = snap.docs.filter(d => (d.data().status || "pending") === "pending");
      const box = $("req-incoming");
      const empty = $("req-incoming-empty");
      const badge = $("badge-requests");
      if (docs.length === 0) {
        box.innerHTML = ""; empty.classList.remove("hidden"); badge.classList.add("hidden");
        return;
      }
      empty.classList.add("hidden");
      badge.textContent = docs.length > 9 ? "9+" : docs.length;
      badge.classList.remove("hidden");
      box.innerHTML = "";
      docs.forEach(d => {
        const r = d.data();
        const row = document.createElement("div");
        row.className = "row"; row.style.cursor = "default";
        row.innerHTML = `
          <img class="avatar" src="${esc(r.fromPhoto || avatarSVG(r.fromDisplayName))}" alt="">
          <div class="grow"><b>${esc(r.fromDisplayName)}</b><span>@${esc(r.fromUsername)}</span></div>
          <div class="req-actions">
            <button class="btn-accept">Accept</button>
            <button class="btn-decline">Decline</button>
          </div>`;
        row.querySelector(".btn-accept").addEventListener("click", () => acceptRequest(d.id, r));
        row.querySelector(".btn-decline").addEventListener("click", () => declineRequest(d.id));
        box.appendChild(row);
      });
    }, err => console.error(err));
  const u2 = db.collection("friendRequests").where("from", "==", me)
    .onSnapshot(snap => {
      const docs = snap.docs.filter(d => (d.data().status || "pending") === "pending");
      const box = $("req-outgoing");
      const empty = $("req-outgoing-empty");
      if (docs.length === 0) {
        box.innerHTML = ""; empty.classList.remove("hidden");
        return;
      }
      empty.classList.add("hidden");
      box.innerHTML = "";
      docs.forEach(d => {
        const r = d.data();
        const row = document.createElement("div");
        row.className = "row"; row.style.cursor = "default";
        row.innerHTML = `
          <img class="avatar" src="${esc(avatarSVG(r.toUsername))}" alt="">
          <div class="grow"><b>@${esc(r.toUsername)}</b><span>request sent</span></div>
          <div class="req-actions"><button class="btn-decline">Cancel</button></div>`;
        row.querySelector(".btn-decline").addEventListener("click", () => declineRequest(d.id));
        box.appendChild(row);
      });
    }, err => console.error(err));
  state.unsubs.push(u1, u2);
}

async function acceptRequest(reqId, r) {
  const me = state.user.uid;
  const other = r.from;
  const cid = chatIdFor(me, other);
  try {
    const batch = db.batch();
    batch.update(db.collection("friendRequests").doc(reqId), { status: "accepted" });
    batch.set(db.collection("friendships").doc(cid), { users: [me, other], createdAt: serverTS() });
    batch.set(db.collection("chats").doc(cid), {
      participants: [me, other], createdAt: serverTS(), lastMessageAt: 0,
      lastMessage: "", ["unread_" + me]: 0, ["unread_" + other]: 0,
    }, { merge: true });
    await batch.commit();
    toast("You're now friends with " + r.fromDisplayName);
  } catch (e) {
    console.error(e);
    toast("Couldn't accept request.");
  }
}

async function declineRequest(reqId) {
  try {
    await db.collection("friendRequests").doc(reqId).update({ status: "declined" });
  } catch (e) {
    console.error(e);
    toast("Couldn't update request.");
  }
}

function subscribeFriendships() {
  const me = state.user.uid;
  const u = db.collection("friendships").where("users", "array-contains", me)
    .onSnapshot(async snap => {
      const box = $("friend-list");
      const empty = $("friend-list-empty");
      if (snap.empty) {
        box.innerHTML = ""; empty.classList.remove("hidden");
        return;
      }
      empty.classList.add("hidden");
      box.innerHTML = "";
      for (const d of snap.docs) {
        const users = d.data().users || [];
        const other = users.find(x => x !== me);
        if (!other) continue;
        let p = { displayName: "…", username: "" };
        try {
          const ud = await db.collection("users").doc(other).get();
          if (ud.exists) p = Object.assign({ uid: other }, ud.data());
        } catch (e) {}
        const row = document.createElement("button");
        row.className = "row";
        row.innerHTML = `
          <img class="avatar" src="${esc(avatarURL(p))}" alt="">
          <div class="grow"><b>${esc(p.displayName)}</b><span>@${esc(p.username || "")}</span></div>`;
        row.addEventListener("click", () => openChatWith(other));
        box.appendChild(row);
      }
    }, err => console.error(err));
  state.unsubs.push(u);
}

/* ---------- profile ---------- */
function renderProfileTab() {
  const p = state.profile;
  $("profile-avatar").src = avatarURL(p);
  $("profile-name").textContent = p.displayName;
  $("profile-username").textContent = "@" + p.username;
  $("profile-displayname").value = p.displayName;
}

async function saveProfileName(e) {
  e.preventDefault();
  const msg = $("profile-msg");
  msg.classList.add("hidden");
  const name = $("profile-displayname").value.trim();
  if (!name) return;
  try {
    await db.collection("users").doc(state.user.uid).update({ displayName: name });
    state.profile.displayName = name;
    $("profile-name").textContent = name;
    msg.textContent = "Saved.";
    msg.classList.remove("hidden");
    setTimeout(() => msg.classList.add("hidden"), 2000);
  } catch (err) {
    console.error(err);
    toast("Couldn't save name.");
  }
}

async function uploadAvatar(e) {
  const f = e.target.files[0];
  if (!f) return;
  toast("Uploading photo…");
  try {
    const ref = storage.ref("profiles/" + state.user.uid + "/avatar.jpg");
    await ref.put(f);
    const url = await ref.getDownloadURL();
    await db.collection("users").doc(state.user.uid).update({ photoURL: url });
    state.profile.photoURL = url;
    $("profile-avatar").src = url;
    toast("Profile photo updated.");
  } catch (err) {
    console.error(err);
    toast("Upload failed.");
  }
  e.target.value = "";
}

/* ---------- chats ---------- */
function subscribeChats() {
  const me = state.user.uid;
  // single-field query (no composite index needed); newest-first sorted client-side
  const u = db.collection("chats").where("participants", "array-contains", me)
    .onSnapshot(async snap => {
      const docs = snap.docs.slice().sort((a, b) => tsMillis(b.data().lastMessageAt) - tsMillis(a.data().lastMessageAt));
      const box = $("chat-list");
      const empty = $("chat-list-empty");
      const badge = $("badge-chats");
      let totalUnread = 0;
      if (docs.length === 0) {
        box.innerHTML = ""; empty.classList.remove("hidden"); badge.classList.add("hidden");
        return;
      }
      empty.classList.add("hidden");
      box.innerHTML = "";
      for (const d of docs) {
        const c = d.data();
        const other = (c.participants || []).find(x => x !== me);
        if (!other) continue;
        let p = { displayName: "…", username: "" };
        try {
          const ud = await db.collection("users").doc(other).get();
          if (ud.exists) p = Object.assign({ uid: other }, ud.data());
        } catch (e) {}
        const unread = c["unread_" + me] || 0;
        totalUnread += unread;
        const row = document.createElement("button");
        row.className = "row";
        row.innerHTML = `
          <img class="avatar" src="${esc(avatarURL(p))}" alt="">
          <div class="grow"><b>${esc(p.displayName)}</b><span>${esc(c.lastMessage || "Say hi 👋")}</span></div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
            <span class="time">${esc(timeFmt(c.lastMessageAt))}</span>
            ${unread ? `<span class="unread">${unread > 9 ? "9+" : unread}</span>` : ""}
          </div>`;
        row.addEventListener("click", () => openChat(d.id, other, p));
        box.appendChild(row);
      }
      if (totalUnread > 0) {
        badge.textContent = totalUnread > 9 ? "9+" : totalUnread;
        badge.classList.remove("hidden");
      } else {
        badge.classList.add("hidden");
      }
    }, err => console.error(err));
  state.unsubs.push(u);
}

async function openChatWith(otherUid) {
  const cid = chatIdFor(state.user.uid, otherUid);
  let p = { displayName: "…", username: "" };
  try {
    const ud = await db.collection("users").doc(otherUid).get();
    if (ud.exists) p = Object.assign({ uid: otherUid }, ud.data());
  } catch (e) {}
  // make sure chat doc exists
  try {
    const cd = await getDocOrNull(db.collection("chats").doc(cid));
    if (!cd) {
      await db.collection("chats").doc(cid).set({
        participants: [state.user.uid, otherUid], createdAt: serverTS(),
        lastMessageAt: 0, lastMessage: "",
        ["unread_" + state.user.uid]: 0, ["unread_" + otherUid]: 0,
      });
    }
  } catch (e) { console.error(e); }
  openChat(cid, otherUid, p);
}

function openChat(cid, otherUid, otherProfile) {
  state.chatUnsubs.forEach(u => { try { u(); } catch (e) {} });
  state.chatUnsubs = [];
  state.chatId = cid;
  state.otherUid = otherUid;
  state.otherProfile = otherProfile;
  $("chat-avatar").src = avatarURL(otherProfile);
  $("chat-name").textContent = otherProfile.displayName;
  $("chat-status").textContent = "@" + (otherProfile.username || "");
  $("messages").innerHTML = "";
  showScreen("screen-chat");
  markRead();

  const u = db.collection("chats").doc(cid).collection("messages")
    .orderBy("createdAt", "asc").limitToLast(100)
    .onSnapshot(snap => {
      renderMessages(snap.docs);
      markRead();
    }, err => console.error(err));
  const u2 = db.collection("chats").doc(cid)
    .onSnapshot(doc => {
      if (!doc.exists || doc.id !== state.chatId) return;
      const c = doc.data();
      const t = c["typing_" + state.otherUid];
      const recent = t && (Date.now() - t.toDate().getTime() < 6000);
      $("chat-status").textContent = recent ? "typing…" : "@" + (state.otherProfile.username || "");
    }, () => {});
  state.unsubs.push(u, u2);
  state.chatUnsubs.push(u, u2);
}

function closeChat() {
  state.chatUnsubs.forEach(u => { try { u(); } catch (e) {} });
  state.chatUnsubs = [];
  state.chatId = null;
  state.otherUid = null;
  showScreen("screen-main");
}

function renderMessages(docs) {
  const box = $("messages");
  box.innerHTML = "";
  let lastDay = "";
  docs.forEach(d => {
    const m = d.data();
    const day = dayLabel(m.createdAt);
    if (day && day !== lastDay) {
      lastDay = day;
      const div = document.createElement("div");
      div.className = "day-divider";
      div.innerHTML = `<span>${esc(day)}</span>`;
      box.appendChild(div);
    }
    const me = m.sender === state.user.uid;
    const wrap = document.createElement("div");
    wrap.className = "msg " + (me ? "me" : "them");
    let body = "";
    if (m.type === "text") {
      body = esc(m.text);
    } else if (m.type === "image") {
      body = `<a href="${esc(m.fileURL)}" target="_blank" rel="noopener"><img src="${esc(m.fileURL)}" loading="lazy" alt=""></a>`;
      if (m.text) body += `<div>${esc(m.text)}</div>`;
    } else if (m.type === "audio") {
      body = `<audio controls src="${esc(m.fileURL)}"></audio><div class="fsize">${esc(fmtDur(m.duration))}</div>`;
    } else {
      body = `<a href="${esc(m.fileURL)}" target="_blank" rel="noopener" download>
        <span class="file-chip">📎<span><span class="fname">${esc(m.fileName || "file")}</span><br><span class="fsize">${esc(fmtSize(m.fileSize))}</span></span></span></a>`;
      if (m.text) body += `<div>${esc(m.text)}</div>`;
    }
    wrap.innerHTML = `<div class="bubble">${body}</div><div class="meta">${esc(timeFmt(m.createdAt))}</div>`;
    box.appendChild(wrap);
  });
  box.scrollTop = box.scrollHeight;
}

async function markRead() {
  if (!state.chatId) return;
  try {
    await db.collection("chats").doc(state.chatId).update({ ["unread_" + state.user.uid]: 0 });
  } catch (e) {}
}

function onComposerInput() {
  const has = $("msg-input").value.trim().length > 0;
  $("btn-send").classList.toggle("hidden", !has);
  $("btn-mic").classList.toggle("hidden", has);
  // typing indicator (throttled)
  const now = Date.now();
  if (state.chatId && (!state.typingTimer || now - state.typingTimer > 3000)) {
    state.typingTimer = now;
    db.collection("chats").doc(state.chatId).update({ ["typing_" + state.user.uid]: serverTS() }).catch(() => {});
  }
}

async function pushMessage(data) {
  const cid = state.chatId;
  const other = state.otherUid;
  const msgRef = db.collection("chats").doc(cid).collection("messages").doc();
  const preview = data.type === "text" ? data.text
    : data.type === "image" ? "📷 Photo"
    : data.type === "audio" ? "🎤 Voice message"
    : "📎 " + (data.fileName || "File");
  const batch = db.batch();
  batch.set(msgRef, Object.assign({ sender: state.user.uid, createdAt: serverTS() }, data));
  batch.update(db.collection("chats").doc(cid), {
    lastMessage: preview.slice(0, 80),
    lastMessageAt: serverTS(),
    ["unread_" + other]: inc(1),
  });
  await batch.commit();
}

async function sendText() {
  const inp = $("msg-input");
  const text = inp.value.trim();
  if (!text || !state.chatId) return;
  inp.value = "";
  onComposerInput();
  try {
    await pushMessage({ type: "text", text });
  } catch (e) {
    console.error(e);
    toast("Couldn't send. Try again.");
  }
}

async function sendFiles(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = "";
  if (!files.length || !state.chatId) return;
  for (const f of files) {
    if (f.size > 25 * 1024 * 1024) {
      toast("“" + f.name + "” is over 25 MB — skipped.");
      continue;
    }
    toast("Uploading " + f.name + "…");
    try {
      const msgId = db.collection("chats").doc(state.chatId).collection("messages").doc().id;
      const ref = storage.ref(`chats/${state.chatId}/${msgId}/${f.name}`);
      await ref.put(f);
      const url = await ref.getDownloadURL();
      const type = f.type.startsWith("image/") ? "image" : "file";
      await pushMessage({ type, fileURL: url, fileName: f.name, fileSize: f.size });
    } catch (err) {
      console.error(err);
      toast("Upload failed for " + f.name);
    }
  }
}

/* ---------- voice messages ---------- */
async function toggleRecording() {
  if (state.rec) return stopRecording(true);
  if (!state.chatId) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const rec = new MediaRecorder(stream);
    const chunks = [];
    rec.ondataavailable = ev => { if (ev.data.size) chunks.push(ev.data); };
    rec.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      $("rec-ui").classList.add("hidden");
      clearInterval(state.recTick);
      const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      state.rec = null;
      if (!state._recSend) return;
      const dur = (Date.now() - state.recStart) / 1000;
      if (dur < 1) { toast("Too short."); return; }
      toast("Sending voice message…");
      try {
        const msgId = db.collection("chats").doc(state.chatId).collection("messages").doc().id;
        const ref = storage.ref(`chats/${state.chatId}/${msgId}/voice.webm`);
        await ref.put(blob);
        const url = await ref.getDownloadURL();
        await pushMessage({ type: "audio", fileURL: url, duration: dur, fileSize: blob.size });
      } catch (err) {
        console.error(err);
        toast("Couldn't send voice message.");
      }
    };
    state.rec = rec;
    state._recSend = false;
    state.recStart = Date.now();
    rec.start();
    $("rec-ui").classList.remove("hidden");
    state.recTick = setInterval(() => {
      $("rec-time").textContent = fmtDur((Date.now() - state.recStart) / 1000);
    }, 500);
    toast("Recording… tap mic again to send", 1800);
  } catch (err) {
    console.error(err);
    toast("Microphone not available.");
  }
}

function stopRecording(send) {
  if (!state.rec) return;
  state._recSend = !!send;
  try { state.rec.stop(); } catch (e) { state.rec = null; }
}

function cancelRecording() {
  state._recSend = false;
  stopRecording(false);
}

/* ---------- PWA ---------- */
function registerSW() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}
