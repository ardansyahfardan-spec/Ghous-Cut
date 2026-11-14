import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyBIbsBWQn4ZcOomxbwzqJWOA17VRuYSRBY",
  authDomain: "ghoustory.firebaseapp.com",
  projectId: "ghoustory",
  messagingSenderId: "474433462871",
  appId: "1:474433462871:web:bc5244135ae99f0321b912"
};

const app = initializeApp(firebaseConfig);
export const firebaseAuth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });
