/* Guff — Firebase config.
 * Paste your Firebase web app config below (Firebase console → Project settings → Your apps).
 * Get it by following README.md ("Connect Firebase" section). */
const FIREBASE_CONFIG = {
  apiKey: "PASTE_YOUR_API_KEY",
  authDomain: "PASTE_YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "PASTE_YOUR_PROJECT_ID",
  storageBucket: "PASTE_YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "PASTE_YOUR_SENDER_ID",
  appId: "PASTE_YOUR_APP_ID"
};
const FIREBASE_READY = FIREBASE_CONFIG.apiKey.indexOf("PASTE") !== 0;
