import { initializeApp, getApps } from "firebase/app";
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User
} from "firebase/auth";

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

export const googleAuthConfigured = Object.values(config).every(value => typeof value === "string" && value.length > 0);

const app = googleAuthConfigured
  ? (getApps()[0] ?? initializeApp(config))
  : null;
const auth = app ? getAuth(app) : null;

export type GhousUser = Pick<User, "uid" | "displayName" | "email" | "photoURL">;

export function observeUser(callback: (user: GhousUser | null) => void, onError: (error: Error) => void) {
  if (!auth) {
    callback(null);
    return () => undefined;
  }
  return onAuthStateChanged(auth, callback, error => onError(error));
}

export async function signInWithGoogle(): Promise<void> {
  if (!auth) throw new Error("Google Login belum dikonfigurasi. Admin perlu mengisi variabel Firebase di pengaturan deployment.");
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  await signInWithPopup(auth, provider);
}

export async function signOutGhous(): Promise<void> {
  if (auth) await signOut(auth);
}
