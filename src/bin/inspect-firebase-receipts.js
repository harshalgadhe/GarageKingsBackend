import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, limit, query } from 'firebase/firestore';
import dotenv from 'dotenv';

dotenv.config();

const firebaseConfig = {
  apiKey: process.env.VITE_FIREBASE_API_KEY,
  authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.VITE_FIREBASE_APP_ID
};

async function inspectReceipts() {
  console.log("Connecting to Firebase...");
  const fbApp = initializeApp(firebaseConfig);
  const fbDb = getFirestore(fbApp);

  console.log("Fetching first 3 receipts from Firestore...");
  const fbQuery = query(collection(fbDb, 'receipts'), limit(3));
  const snapshot = await getDocs(fbQuery);

  if (snapshot.empty) {
    console.log("No receipts found in Firestore.");
    return;
  }

  snapshot.forEach(doc => {
    console.log("==========================================");
    console.log(`Document ID: ${doc.id}`);
    console.log(JSON.stringify(doc.data(), null, 2));
  });
}

inspectReceipts().catch(console.error);
