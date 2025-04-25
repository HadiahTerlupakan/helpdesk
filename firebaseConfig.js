// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyBevIUqPN8unXMMWXz5d9wS_2CAgcR6VOU",
  authDomain: "helpdesk-86c7e.firebaseapp.com",
  databaseURL: "https://helpdesk-86c7e-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "helpdesk-86c7e",
  storageBucket: "helpdesk-86c7e.firebasestorage.app",
  messagingSenderId: "854355922056",
  appId: "1:854355922056:web:9f6d781649f94f1f21a33d",
  measurementId: "G-HKKGXC3695"
};

// Initialize Firebase
export const app = initializeApp(firebaseConfig);
let analytics = null;
if (typeof window !== 'undefined') {
  analytics = getAnalytics(app);
}