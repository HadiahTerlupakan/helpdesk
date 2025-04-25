import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

// Konfigurasi Firebase
const firebaseConfig = {
  apiKey: "AIzaSyBevIUqPN8unXMMWXz5d9wS_2CAgcR6VOU",
  authDomain: "helpdesk-86c7e.firebaseapp.com",
  databaseURL: "https://helpdesk-86c7e-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "helpdesk-86c7e",
  storageBucket: "helpdesk-86c7e.appspot.com", // Perbaiki URL storage bucket
  messagingSenderId: "854355922056",
  appId: "1:854355922056:web:9f6d781649f94f1f21a33d",
  measurementId: "G-HKKGXC3695"
};

// Inisialisasi Firebase
export const app = initializeApp(firebaseConfig);

// Validasi koneksi ke Firebase Database
export const database = getDatabase(app);
console.log("Firebase berhasil diinisialisasi.");