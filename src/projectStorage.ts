type StoredProject = { clips: any[]; updatedAt: number };

const DB_NAME = "ghous-cut-local";
const STORE = "projects";
const PROJECT_KEY = "autosave";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveLocalProject(clips: unknown[]): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ clips, updatedAt: Date.now() } satisfies StoredProject, PROJECT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  db.close();
}

export async function loadLocalProject<T>(): Promise<{ clips: T[]; updatedAt: number } | null> {
  const db = await openDb();
  const value = await new Promise<StoredProject | undefined>((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(PROJECT_KEY);
    request.onsuccess = () => resolve(request.result as StoredProject | undefined);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return value ? { clips: value.clips as T[], updatedAt: value.updatedAt } : null;
}
