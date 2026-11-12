import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { strFromU8, strToU8, unzipSync, zipSync, Zip, ZipPassThrough, Unzip, UnzipInflate } from "fflate";

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
  const clips = [];
  for (let index = 0; index < project.clips.length; index += 1) {
    const rawClip = project.clips[index];
    const clip = rawClip as T & { id?: string; name?: string; src?: string; file?: File; opfsMedia?: string };
    if (clip.opfsMedia && !(clip.file instanceof File) && !clip.src?.startsWith("blob:")) {
      retainedMedia.add(clip.opfsMedia);
      clips.push({ ...clip, src: "", file: undefined });
      continue;
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
      if (clip.opfsMedia) retainedMedia.add(clip.opfsMedia);
      clips.push({ ...clip, src: "", file: undefined, mediaMissing: true });
      continue;
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
      await writable.write(file);
      await writable.close();
    }
    clips.push({ ...clip, src: "", file: undefined, opfsMedia: mediaName });
  }
  const stored = { ...project, clips };
  await writeOpfsText(projectsDirectory, `${project.id}.json`, JSON.stringify(stored));
  // Only remove stale media after the new manifest is safely written. If saving
  // the manifest fails, keep the old media so the previous project remains recoverable.
  for await (const entry of mediaDirectory.values()) {
    if (entry.kind === "file" && !retainedMedia.has(entry.name)) {
      await mediaDirectory.removeEntry(entry.name);
    }
  }
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


type BrowserSavePicker = (options: {
  suggestedName: string;
  types: Array<{ description: string; accept: Record<string, string[]> }>;
}) => Promise<{ createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void>; abort?(): Promise<void> }> }>;

async function streamBrowserProjectArchive<T>(project: StoredProject<T>, safeName: string): Promise<boolean | null> {
  const picker = (window as Window & { showSaveFilePicker?: BrowserSavePicker }).showSaveFilePicker;
  if (!picker) return null;

  let handle: Awaited<ReturnType<BrowserSavePicker>>;
  try {
    handle = await picker({
      suggestedName: `${safeName}.ghcut`,
      types: [{ description: "Ghous Cut Project", accept: { "application/vnd.ghouscut.project+zip": [".ghcut"] } }]
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return false;
    throw error;
  }

  const writer = await handle.createWritable();
  let writeQueue = Promise.resolve();
  let writeError: unknown = null;
  let finishOutput!: () => void;
  let failOutput!: (error: unknown) => void;
  const outputFinished = new Promise<void>((resolve, reject) => {
    finishOutput = resolve;
    failOutput = reject;
  });
  const zip = new Zip();
  zip.ondata = (error, chunk, final) => {
    if (error) {
      failOutput(error);
      return;
    }
    if (chunk?.length) {
      writeQueue = writeQueue.then(() => writer.write(chunk)).catch(error => {
        writeError = error;
        failOutput(error);
      });
    }
    if (final) finishOutput();
  };

  const mediaEntries: Array<{ path: string; blob: Blob }> = [];
  const portableClips = [];
  for (let index = 0; index < project.clips.length; index += 1) {
    const rawClip = project.clips[index];
    const item = rawClip as T & PortableClip & { kind?: string };
    const mediaPath = `media/${String(index).padStart(4, "0")}-${safeProjectName(item.name || `asset-${index}`)}`;
    let blob: Blob | null = item.file instanceof Blob ? item.file : null;
    if (!blob && item.src) {
      try {
        const response = await fetch(item.src);
        if (response.ok) blob = await response.blob();
      } catch { /* Relinked media is required when its source cannot be read. */ }
    }
    if (item.kind && ["video", "image", "audio"].includes(item.kind) && (!blob || !blob.size)) {
      await writer.abort?.();
      throw new Error(`Media "${item.name || "unnamed"}" is unavailable. Relink the original file before exporting this project.`);
    }
    if (blob) mediaEntries.push({ path: mediaPath, blob });
    const { file: _file, src: _src, ...metadata } = item;
    portableClips.push({ ...metadata, src: "", ...(blob ? { packageMedia: mediaPath } : {}) });
  }

  const manifest = {
    format: "ghous-cut-project",
    version: 2,
    exportedAt: new Date().toISOString(),
    project: { ...project, clips: portableClips }
  };

  try {
    const manifestEntry = new ZipPassThrough("manifest.json");
    zip.add(manifestEntry);
    manifestEntry.push(strToU8(JSON.stringify(manifest, null, 2)), true);

    for (const entry of mediaEntries) {
      const zipEntry = new ZipPassThrough(entry.path);
      zip.add(zipEntry);
      const reader = entry.blob.stream().getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value?.length) zipEntry.push(value);
        }
        zipEntry.push(new Uint8Array(0), true);
      } finally {
        reader.releaseLock();
      }
    }

    zip.end();
    await outputFinished;
    await writeQueue;
    if (writeError) throw writeError;
    await writer.close();
    return true;
  } catch (error) {
    try { await writer.abort?.(); } catch { /* Preserve the original export error. */ }
    throw error;
  }
}

export async function exportProjectFile<T>(project: StoredProject<T>): Promise<boolean> {
  const safeName = safeProjectName(project.name);
  if (isDesktop()) {
    const path = await saveDialog({
      defaultPath: `${safeName}.ghcut`,
      filters: [{ name: "Ghous Cut Project", extensions: ["ghcut"] }]
    });
    if (!path) return false;
    const portableProject = {
      ...project,
      clips: project.clips.map(rawClip => {
        const clip = rawClip as T & PortableClip;
        const { file: _file, src: _src, ...metadata } = clip;
        return { ...metadata, src: "" };
      })
    };
    await invoke("export_project_archive", { project: portableProject, outputPath: path });
    return true;
  }
  const streamed = await streamBrowserProjectArchive(project, safeName);
  if (streamed !== null) return streamed;

  // Compatibility fallback for browsers without the File System Access API.
  // This path still buffers the archive in memory; streaming is used wherever
  // the browser provides a writable save-file handle.
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

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeName}.ghcut`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}

export async function importProjectArchivePath(archivePath: string, ownerId: string): Promise<StoredProject> {
  if (!isDesktop()) throw new Error("Native archive import is only available in the Windows app.");
  return await invoke<StoredProject>("import_project_archive", {
    archivePath,
    ownerId: safeOwnerId(ownerId)
  });
}


async function importBrowserProjectArchive(file: File, ownerId: string): Promise<StoredProject> {
  const root = await browserRoot(ownerId);
  if (!root) throw new Error("Persistent local storage is unavailable in this browser.");
  const projectId = crypto.randomUUID();
  const mediaDirectory = await (await root.getDirectoryHandle("media", { create: true }))
    .getDirectoryHandle(projectId, { create: true });
  const mediaNames = new Map<string, string>();
  const manifestChunks: Uint8Array[] = [];
  let manifestSeen = false;
  let pendingWrites = Promise.resolve();
  const fileTasks: Promise<void>[] = [];
  let streamError: unknown = null;
  let mediaIndex = 0;

  const unzipper = new Unzip();
  unzipper.register(UnzipInflate);
  unzipper.onfile = entry => {
    if (entry.name === "manifest.json") {
      manifestSeen = true;
      let resolveEntry!: () => void;
      let rejectEntry!: (error: unknown) => void;
      const done = new Promise<void>((resolve, reject) => {
        resolveEntry = resolve;
        rejectEntry = reject;
      });
      fileTasks.push(done);
      entry.ondata = (error, chunk, final) => {
        if (error) {
          streamError = error;
          rejectEntry(error);
          return;
        }
        if (chunk?.length) manifestChunks.push(chunk);
        if (final) resolveEntry();
      };
      entry.start();
      return;
    }

    if (entry.name.startsWith("media/") && !entry.name.endsWith("/")) {
      const leaf = entry.name.split("/").pop() || "media.bin";
      const storageName = `${String(mediaIndex++).padStart(4, "0")}-${safeProjectName(leaf)}`;
      mediaNames.set(entry.name, storageName);
      const writerReady = mediaDirectory.getFileHandle(storageName, { create: true })
        .then(handle => handle.createWritable());
      let resolveEntry!: () => void;
      let rejectEntry!: (error: unknown) => void;
      const done = new Promise<void>((resolve, reject) => {
        resolveEntry = resolve;
        rejectEntry = reject;
      });
      fileTasks.push(done);
      entry.ondata = (error, chunk, final) => {
        if (error) {
          streamError = error;
          rejectEntry(error);
          return;
        }
        pendingWrites = pendingWrites.then(async () => {
          const writer = await writerReady;
          if (chunk?.length) await writer.write(chunk);
          if (final) await writer.close();
        }).then(() => {
          if (final) resolveEntry();
        }).catch(rejectEntry);
      };
      entry.start();
      return;
    }

    // Ignore unexpected archive entries without retaining their contents.
    entry.ondata = error => { if (error) streamError = error; };
    entry.start();
  };

  try {
    const reader = file.stream().getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) unzipper.push(value);
        // Backpressure: do not feed more compressed data until OPFS writes
        // triggered by the previous chunk have completed.
        await pendingWrites;
        if (streamError) throw streamError;
      }
      unzipper.push(new Uint8Array(0), true);
    } finally {
      reader.releaseLock();
    }
    await Promise.all(fileTasks);
    await pendingWrites;
    if (streamError) throw streamError;
    if (!manifestSeen || !manifestChunks.length) throw new Error("Manifest proyek tidak ditemukan.");

    const manifestText = await new Blob(manifestChunks).text();
    const parsed = JSON.parse(manifestText) as {
      format?: string; version?: number; project?: StoredProject;
    };
    if (parsed.format !== "ghous-cut-project" || ![1, 2].includes(parsed.version ?? 0) ||
        !parsed.project || typeof parsed.project.name !== "string" || !Array.isArray(parsed.project.clips)) {
      throw new Error("File bukan proyek Ghous Cut yang valid.");
    }

    const clips = parsed.project.clips.map(rawClip => {
      const item = rawClip as PortableClip & { packageMedia?: string };
      const storageName = item.packageMedia ? mediaNames.get(item.packageMedia) : undefined;
      if (!storageName) {
        return { ...item, src: "", file: undefined, mediaMissing: true, packageMedia: undefined };
      }
      return {
        ...item,
        src: "",
        file: undefined,
        opfsMedia: storageName,
        mediaMissing: false,
        packageMedia: undefined
      };
    });
    const now = Date.now();
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
  } catch (error) {
    try {
      await (await root.getDirectoryHandle("media")).removeEntry(projectId, { recursive: true });
    } catch { /* Remove partial extraction if possible. */ }
    throw error;
  }
}

export async function importProjectFile(file: File, ownerId: string): Promise<StoredProject> {
  if (!isDesktop()) {
    const header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    const isZip = header[0] === 0x50 && header[1] === 0x4b &&
      (header[2] === 0x03 || header[2] === 0x05 || header[2] === 0x07);
    if (isZip) return await importBrowserProjectArchive(file, safeOwnerId(ownerId));

    // Backward compatibility with v1 JSON-based .ghcut projects.
    let parsed: { format?: string; version?: number; project?: StoredProject };
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      throw new Error("File bukan arsip proyek Ghous Cut yang valid.");
    }
    if (parsed.format !== "ghous-cut-project" || ![1, 2].includes(parsed.version ?? 0) ||
        !parsed.project || typeof parsed.project.name !== "string" || !Array.isArray(parsed.project.clips)) {
      throw new Error("File bukan proyek Ghous Cut yang valid.");
    }
    const now = Date.now();
    const project: StoredProject = {
      ...parsed.project,
      id: crypto.randomUUID(),
      clips: parsed.project.clips.map(rawClip => ({
        ...(rawClip as PortableClip),
        src: "",
        file: undefined,
        mediaMissing: true
      })),
      createdAt: now,
      updatedAt: now
    };
    await createProject(project, ownerId);
    return project;
  }

  let parsed: { format?: string; version?: number; project?: StoredProject };
  let archivedMedia: Record<string, Uint8Array> = {};
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const archive = unzipSync(bytes);
    const manifest = archive["manifest.json"];
    if (!manifest) throw new Error("Manifest proyek tidak ditemukan.");
    parsed = JSON.parse(strFromU8(manifest));
    archivedMedia = archive;
  } catch {
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
  const clips = [];
  for (let index = 0; index < parsed.project.clips.length; index += 1) {
    const item = parsed.project.clips[index] as PortableClip & { packageMedia?: string };
    const mediaBytes = item.packageMedia ? archivedMedia[item.packageMedia] : undefined;
    if (!mediaBytes) {
      clips.push({ ...item, src: "", file: undefined, mediaMissing: true, packageMedia: undefined });
      continue;
    }
    const mediaName = item.name || "media.bin";
    const path = await invoke<string>("save_project_media", {
      ownerId: safeOwnerId(ownerId),
      projectId,
      filename: `${String(index).padStart(4, "0")}-${safeProjectName(mediaName)}`,
      content: Array.from(mediaBytes)
    });
    clips.push({ ...item, path, src: "", file: undefined, packageMedia: undefined });
    if (item.packageMedia) delete archivedMedia[item.packageMedia];
  }
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
