# Guff — chat with your people

A messaging web app that installs on phones like a native app (PWA).
Text, photos, files and voice messages. Login with Google **or** username + password.
Add friends by username, send/accept friend requests, set a profile photo.

**Live:** `https://daveyadav.github.io/Guff/` (after GitHub Pages is enabled)

## How it's built

- **Frontend:** static HTML/CSS/JS on GitHub Pages (this repo) + service worker, installable on Android/iOS.
- **Backend:** Firebase — Authentication (Google + email/password), Firestore (users, friends, chats, messages), Storage (photos, files, voice).

## Connect Firebase (one-time setup, ~10 min)

Do this in the [Firebase console](https://console.firebase.google.com) with your Google account:

1. **Create project** → "Add project" → name it `guff` → continue (Google Analytics optional).
2. **Add a web app:** Project overview → `</>` → nickname `guff-web` → register. Copy the `firebaseConfig` values.
3. **Paste config:** put those values into `js/config.js` (`FIREBASE_CONFIG`), commit & push. The login screen's warning banner disappears once this is done.
4. **Authentication → Sign-in method:** enable **Google** and **Email/Password**.
   - For Google sign-in on the live site: in the Google provider settings it just works; no extra OAuth client needed for Firebase's default.
5. **Firestore Database → Create database** → production mode → pick region `asia-south1` (Mumbai, closest).
   - Go to the **Rules** tab → replace everything with the contents of `firestore.rules` → Publish.
6. **Storage → Get started** → production mode → same region.
   - Go to the **Rules** tab → replace with `storage.rules` → Publish.
7. **Authorized domains:** Authentication → Settings → Authorized domains → add `daveyadav.github.io`.

## Enable GitHub Pages

Repo → Settings → Pages → Deploy from a branch → `main` / `/ (root)` → Save.
The app goes live at `https://daveyadav.github.io/Guff/`.

## Install on phone

Open the live URL in Chrome (Android) → ⋮ → "Add to Home screen" / "Install app".
On iPhone: Share → Add to Home Screen.

## How login works

- **New users:** tap "Continue with Google" → pick username, profile name, password → done.
  From then on they can log in with Google **or** username + password (both unlock the same account).
- **Username login:** the app looks up the username → finds the account email → signs in with the password.

## Project layout

| File | What |
|---|---|
| `index.html` | App shell: auth, onboarding, chats/friends/requests/profile tabs, chat view |
| `css/styles.css` | Mobile-first dark chat UI |
| `js/config.js` | Your Firebase config (paste here) |
| `js/app.js` | All app logic: auth, friends, requests, chats, voice, PWA |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installable PWA |
| `firestore.rules`, `storage.rules` | Backend security rules |

## Roadmap (v2 ideas)

Group chats · online/last-seen presence · push notifications · message replies · stories-style status
