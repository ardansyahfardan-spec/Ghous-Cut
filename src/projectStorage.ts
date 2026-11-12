import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

export type StoredProject<T = any> = {
  id: string;
  name: string;
  clips: T[];
  createdAt: number;
  updatedAt: number;
  aspectRatio?: "16:9" | "9:16" | "1:1";
};

const browserProjects = new Map<string, StoredProject>();
const projectKey = (ownerId: string, id: string) => `${ownerId}:${id}`;
const safeOwnerId = (ownerId: string) => {
  const value = ownerId.trim();
  if (!value || !/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Invalid account ID for local storage.");
  return value;
};
const projectSaveQueues = new Map<string, Promise<void>>();
const isDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function browserPersistenceAvailable(): boolean {
  if (typeof navigator === "undefined") return false;
  const storage = (navigator as Navigator & { storage?: { getDirectory?: () => Promise<unknown> } }).storage;
  return typeof storage?.getDirectory === "function";
}

type OpfsWritable = { write(data: string | Blob | ArrayBuffer | Uint8Array): Promise<void>; close(): Promise<void> };
type OpfsFileHandle = { name: string; kind: "file"; getFile(): Promise<File>; createWritable(): Promise<OpfsWritable> };
type OpfsDirectoryHandle = {
  name: string;
  kind: "directory";
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  values(): AsyncIterable<OpfsFileHandle | OpfsDirectoryHandle>;
};

const browserRoot = async (ownerId: string): Promise<OpfsDirectoryHandle | null> => {
  if (typeof navigator === "undefined") return null;
  const storage = (navigator as Navigator & {
    storage?: { getDirectory?: () => Promise<OpfsDirectoryHandle> };
  }).storage;
  if (!storage?.getDirectory) return null;
  const root = await storage.getDirectory();
  const appRoot = await root.getDirectoryHandle("ghouscut", { create: true });
  const users = await appRoot.getDirectoryHandle("users", { create: true });
  return await users.getDirectoryHandle(safeOwnerId(ownerId), { create: true }) as unknown as OpfsDirectoryHandle;
};

const writeOpfsText = async (directory: OpfsDirectoryHandle, name: string, content: string) => {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
};

async function persistBrowserProject<T>(project: StoredProject<T>, ownerId: string): Promise<void> {
  const root = await browserRoot(ownerId);
  if (!root) throw new Error("Persistent local storage is unavailable. Use a supported browser or the Windows app.");
  const projectsDirectory = await root.getDirectoryHandle("projects", { create: true });
  const mediaDirectory = await (await root.getDirectoryHandle("media", { create: true }))
    .getDirectoryHandle(project.id, { create: true });
  const retainedMedia = new Set<string>();
  const clips = await Promise.all(project.clips.map(async (rawClip, index) => {
    const clip = rawClip as T & { id?: string; name?: string; src?: string; file?: File; opfsMedia?: string };
    if (clip.opfsMedia && !(clip.file instanceof File) && !clip.src?.startsWith("blob:")) {
      retainedMedia.add(clip.opfsMedia);
      return { ...clip, src: "", file: undefined };
    }
    let file = clip.file instanceof File ? clip.file : undefined;
    if (!file && clip.src?.startsWith("blob:")) {
      const response = await fetch(clip.src);
      if (response.ok) {
        const blob = await response.blob();
        file = new File([blob], clip.name || `media-${index}`, { type: blob.type });
      }
    }
    if (!file) {
      if (clip.opfsMedia) {
        retainedMedia.add(clip.opfsMedia);
        return { ...clip, src: "", file: undefined, mediaMissing: true };
      }
      return { ...clip, src: "", file: undefined, mediaMissing: true };
    }
    const mediaName = `${clip.id || index}-${safeProjectName(clip.name || `asset-${index}`)}`;
    retainedMedia.add(mediaName);
    const handle = await mediaDirectory.getFileHandle(mediaName, { create: true });
    let alreadySaved = false;
    try {
      const existing = await handle.getFile();
      alreadySaved = existing.size === file.size && existing.lastModified === file.lastModified;
    } catch { /* New OPFS media file. */ }
    if (!alreadySaved) {
      const writable = await handle.createWritable();
      await writable.write(await file.arrayBuffer());
      await writable.close();
    }
    return { ...clip, src: "", file: undefined, opfsMedia: mediaName };
  }));
  for await (const entry of mediaDirectory.values()) {
    if (entry.kind === "file" && !retainedMedia.has(entry.name)) {
      await mediaDirectory.removeEntry(entry.name);
    }
  }
  const stored = { ...project, clips };
  await writeOpfsText(projectsDirectory, `${project.id}.json`, JSON.stringify(stored));
  browserProjects.set(projectKey(ownerId, project.id), project);
}

async function restoreBrowserProject<T>(project: StoredProject<T>, ownerId: string, previewOnly = false): Promise<StoredProject<T>> {
  const root = await browserRoot(ownerId);
  if (!root) return project;
  let mediaDirectory: OpfsDirectoryHandle;
  try {
    mediaDirectory = await (await root.getDirectoryHandle("media"))
      .getDirectoryHandle(project.id);
  } catch {
    return project;
  }
  let previewRestored = false;
  const clips = await Promise.all(project.clips.map(async rawClip => {
    const clip = rawClip as T & { opfsMedia?: string; name?: string; kind?: string };
    if (!clip.opfsMedia || (previewOnly && (previewRestored || clip.kind === "audio"))) return clip;
    try {
      const handle = await mediaDirectory.getFileHandle(clip.opfsMedia);
      const file = await handle.getFile();
      if (previewOnly) previewRestored = true;
      return { ...clip, file, src: URL.createObjectURL(file), mediaMissing: false };
    } catch {
      return { ...clip, mediaMissing: true };
    }
  }));
  return { ...project, clips };
}

async function readStoredProject<T>(file: File, ownerId: string, previewOnly = false): Promise<StoredProject<T> | null> {
  try {
    const project = JSON.parse(await file.text()) as StoredProject<T>;
    if (!project?.id || !Array.isArray(project.clips)) return null;
    return await restoreBrowserProject(project, ownerId, previewOnly);
  } catch {
    return null;
  }
}

const sortRecent = (projects: StoredProject[]) => projects.sort((a, b) => b.updatedAt - a.updatedAt);

export async function listProjects(ownerId: string): Promise<StoredProject[]> {
  const accountId = safeOwnerId(ownerId);
  if (isDesktop()) return sortRecent(await invoke<StoredProject[]>("list_projects", { ownerId: accountId }));
  const root = await browserRoot(accountId);
  if (!root) throw new Error("Persistent local storage is unavailable in this browser.");
  const directory = await root.getDirectoryHandle("projects", { create: true });
  const projects: StoredProject[] = [];
  for await (const entry of directory.values()) {
    if (entry.kind !== "file" || !entry.name.endsWith(".json")) continue;
    const project = await readStoredProject(await (entry as OpfsFileHandle).getFile(), accountId, true);
    if (project) projects.push(project);
  }
  return sortRecent(projects);
}

export async function loadProject<T>(id: string, ownerId: string): Promise<StoredProject<T> | null> {
  const accountId = safeOwnerId(ownerId);
  if (isDesktop()) return await invoke<StoredProject<T> | null>("load_project", { id, ownerId: accountId });
  const root = await browserRoot(accountId);
  if (!root) throw new Error("Persistent local storage is unavailable in this browser.");
  try {
    const directory = await root.getDirectoryHandle("projects");
    const handle = await directory.getFileHandle(`${id}.json`);
    const project = await readStoredProject<T>(await handle.getFile(), accountId);
    if (project) browserProjects.set(projectKey(accountId, id), project);
    return project;
  } catch {
    return null;
  }
}

async function withProjectQueue(id: string, operation: () => Promise<void>): Promise<void> {
  const previous = projectSaveQueues.get(id) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  projectSaveQueues.set(id, next);
  try { await next; } finally { if (projectSaveQueues.get(id) === next) projectSaveQueues.delete(id); }
}

export async function saveProject<T>(id: string, name: string, clips: T[], ownerId: string, aspectRatio?: StoredProject<T>["aspectRatio"]): Promise<void> {
  const accountId = safeOwnerId(ownerId);
  await withProjectQueue(projectKey(accountId, id), async () => {
    const current = isDesktop()
      ? await loadProject<T>(id, accountId)
      : (browserProjects.get(projectKey(accountId, id)) as StoredProject<T> | undefined) ?? await loadProject<T>(id, accountId);
    const project: StoredProject<T> = {
      ...current, id, name, clips,
      ...(aspectRatio ? { aspectRatio } : {}),
      createdAt: current?.createdAt ?? Date.now(),
      updatedAt: Date.now()
    };
    if (isDesktop()) await invoke<void>("save_project", { project, ownerId: accountId });
    else await persistBrowserProject(project, accountId);
  });
}

export async function createProject<T>(project: StoredProject<T>, ownerId: string): Promise<void> {
  const accountId = safeOwnerId(ownerId);
  await withProjectQueue(projectKey(accountId, project.id), async () => {
    if (isDesktop()) await invoke("save_project", { project, ownerId: accountId });
    else await persistBrowserProject(project, accountId);
  });
}

export async function deleteProject(id: string, ownerId: string): Promise<void> {
  const accountId = safeOwnerId(ownerId);
  await withProjectQueue(projectKey(accountId, id), async () => {
    if (isDesktop()) {
      await invoke("delete_project", { id, ownerId: accountId });
      return;
    }
    browserProjects.delete(projectKey(accountId, id));
    const root = await browserRoot(accountId);
    if (!root) return;
    try {
      const projects = await root.getDirectoryHandle("projects");
      await projects.removeEntry(`${id}.json`);
    } catch { /* Project file may already be absent. */ }
    try {
      const media = await root.getDirectoryHandle("media");
      await media.removeEntry(id, { recursive: true });
    } catch { /* Media directory may already be absent. */ }
  });
}
type PortableClip = { id?: string; name?: string; src?: string; file?: File; [key: string]: unknown };
const safeProjectName = (name: string) =>
  name.replace(/[\\/:*?"<>|]/g, "-").trim() || "Ghous-Cut-Project";

const mediaMimeType = (name = "") => {
  const extension = name.split(".").pop()?.toLowerCase() || "";
  const types: Record<string, string> = {
    mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm",
    mkv: "video/x-matroska", avi: "video/x-msvideo",
    mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac",
    flac: "audio/flac", ogg: "audio/ogg",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
    gif: "image/gif", bmp: "image/bmp"
  };
  return types[extension] || "application/octet-stream";
};

async function browserMediaBytes(clip: PortableClip): Promise<Uint8Array | null> {
  if (clip.file instanceof File) return new Uint8Array(await clip.file.arrayBuffer());
  if (isDesktop() && clip.path) {
    try {
      const bytes = await invoke<number[]>("read_project_media", { path: clip.path });
      return new Uint8Array(bytes);
    } catch { return null; }
  }
  if (clip.src) {
    try {
      const response = await fetch(clip.src);
      if (response.ok) return new Uint8Array(await response.arrayBuffer());
    } catch { /* The source may need relinking before export. */ }
  }
  return null;
}

export async function exportProjectFile<T>(project: StoredProject<T>): Promise<boolean> {
  const safeName = safeProjectName(project.name);
  const media: Record<string, Uint8Array> = {};
  const portableClips = await Promise.all(project.clips.map(async (clip, index) => {
    const item = clip as T & PortableClip;
    const mediaPath = `media/${String(index).padStart(4, "0")}-${safeProjectName(item.name || `asset-${index}`)}`;
    const bytes = await browserMediaBytes(item);
    const kind = (item as PortableClip & { kind?: string }).kind;
    if (kind && ["video", "image", "audio"].includes(kind) && (!bytes || bytes.byteLength === 0)) {
      throw new Error(`Media "${item.name || "unnamed"}" is unavailable. Relink the original file before exporting this project.`);
    }
    if (bytes) media[mediaPath] = bytes;
    const { file: _file, src: _src, ...metadata } = item;
    return { ...metadata, src: "", ...(bytes ? { packageMedia: mediaPath } : {}) };
  }));

  const manifest = {
    format: "ghous-cut-project",
    version: 2,
    exportedAt: new Date().toISOString(),
    project: { ...project, clips: portableClips }
  };
  const archive = zipSync({
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
    ...media
  }, { level: 1 });
  const blob = new Blob([archive], { type: "application/vnd.ghouscut.project+zip" });

  if (isDesktop()) {
    const path = await saveDialog({
      defaultPath: `${safeName}.ghcut`,
      filters: [{ name: "Ghous Cut Project", extensions: ["ghcut"] }]
    });
    if (!path) return false;
    await invoke("write_project_file", { path, content: Array.from(archive) });
    return true;
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeName}.ghcut`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}

export async function importProjectFile(file: File, ownerId: string): Promise<StoredProject> {
  let parsed: {
    format?: string; version?: number; project?: StoredProject;
  };
  let archivedMedia: Record<string, Uint8Array> = {};

  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const archive = unzipSync(bytes);
    const manifest = archive["manifest.json"];
    if (!manifest) throw new Error("Manifest proyek tidak ditemukan.");
    parsed = JSON.parse(strFromU8(manifest));
    archivedMedia = archive;
  } catch (archiveError) {
    // Backward compatibility with v1 JSON-based .ghcut projects.
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("File bukan arsip proyek Ghous Cut yang valid.");
    }
  }

  if (parsed.format !== "ghous-cut-project" || ![1, 2].includes(parsed.version ?? 0) ||
      !parsed.project || typeof parsed.project.name !== "string" || !Array.isArray(parsed.project.clips)) {
    throw new Error("File bukan proyek Ghous Cut yang valid.");
  }

  const now = Date.now();
  const projectId = crypto.randomUUID();
  const clips = await Promise.all(parsed.project.clips.map(async (clip, index) => {
    const item = clip as PortableClip & { packageMedia?: string };
    const mediaBytes = item.packageMedia ? archivedMedia[item.packageMedia] : undefined;
    if (!mediaBytes) return { ...item, path: "", src: "", file: undefined, mediaMissing: true, packageMedia: undefined };
    const extension = item.name?.split(".").pop()?.toLowerCase() || "bin";
    const mediaBuffer = new ArrayBuffer(mediaBytes.byteLength);
    new Uint8Array(mediaBuffer).set(mediaBytes);
    const mediaName = item.name || `media.${extension}`;
    const mediaFile = new File([mediaBuffer], mediaName, { type: mediaMimeType(mediaName) });
    if (isDesktop()) {
      const path = await invoke<string>("save_project_media", {
        ownerId: safeOwnerId(ownerId),
        projectId,
        filename: `${String(index).padStart(4, "0")}-${safeProjectName(mediaName)}`,
        content: Array.from(mediaBytes)
      });
      return { ...item, path, src: "", file: undefined, packageMedia: undefined };
    }
    return { ...item, src: URL.createObjectURL(mediaFile), file: mediaFile, packageMedia: undefined };
  }));
  const project: StoredProject = {
    ...parsed.project,
    id: projectId,
    name: parsed.project.name,
    clips,
    createdAt: now,
    updatedAt: now
  };
  await createProject(project, ownerId);
  return project;
}
