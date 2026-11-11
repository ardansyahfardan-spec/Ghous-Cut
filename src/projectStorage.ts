export type StoredProject<T = any> = {
  id: string;
  name: string;
  clips: T[];
  createdAt: number;
  updatedAt: number;
  aspectRatio?: "16:9" | "9:16" | "1:1";
};

const DB_NAME = "ghous-cut-local";
const STORE = "projects";
const LEGACY_KEY = "autosave";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function listProjects(): Promise<StoredProject[]> {
  const db = await openDb();
  const projects = await new Promise<StoredProject[]>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const allRequest = store.getAll();
    const legacyRequest = store.get(LEGACY_KEY);
    let all: StoredProject[] = [];
    let legacy: { clips?: unknown[]; updatedAt?: number } | undefined;
    allRequest.onsuccess = () => { all = (allRequest.result as StoredProject[]).filter(p => p && typeof p.id === "string"); };
    legacyRequest.onsuccess = () => { legacy = legacyRequest.result as typeof legacy; };
    tx.oncomplete = () => {
      if (legacy?.clips?.length) {
        const now = legacy.updatedAt || Date.now();
        const recovered: StoredProject = { id: "recovered-" + now, name: "Proyek Sebelumnya", clips: legacy.clips, createdAt: now, updatedAt: now };
        if (!all.some(p => p.id === recovered.id)) {
          const write = db.transaction(STORE, "readwrite");
          write.objectStore(STORE).put(recovered, recovered.id);
          write.oncomplete = () => resolve([...all, recovered].sort((a,b) => b.updatedAt-a.updatedAt));
          write.onerror = () => reject(write.error);
          return;
        }
      }
      resolve(all.sort((a,b) => b.updatedAt-a.updatedAt));
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  db.close();
  return projects;
}

export async function loadProject<T>(id: string): Promise<StoredProject<T> | null> {
  const db = await openDb();
  const value = await new Promise<StoredProject<T> | undefined>((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
    request.onsuccess = () => resolve(request.result as StoredProject<T> | undefined);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return value ?? null;
}

export async function saveProject<T>(id: string, name: string, clips: T[]): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const request = store.get(id);
    request.onsuccess = () => {
      const current = request.result as StoredProject<T> | undefined;
      store.put({ ...current, id, name, clips, createdAt: current?.createdAt ?? Date.now(), updatedAt: Date.now() } satisfies StoredProject<T>, id);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  db.close();
}

export async function createProject<T>(project: StoredProject<T>): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(project, project.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  db.close();
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  db.close();
}
