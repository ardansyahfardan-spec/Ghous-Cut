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
const projectSaveQueues = new Map<string, Promise<void>>();
const isDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const sortRecent = (projects: StoredProject[]) => projects.sort((a, b) => b.updatedAt - a.updatedAt);

export async function listProjects(): Promise<StoredProject[]> {
  if (isDesktop()) return sortRecent(await invoke<StoredProject[]>("list_projects"));
  return sortRecent(Array.from(browserProjects.values()));
}

export async function loadProject<T>(id: string): Promise<StoredProject<T> | null> {
  if (isDesktop()) return await invoke<StoredProject<T> | null>("load_project", { id });
  return (browserProjects.get(id) as StoredProject<T> | undefined) ?? null;
}

export async function saveProject<T>(id: string, name: string, clips: T[]): Promise<void> {
  const current = await loadProject<T>(id);
  const project: StoredProject<T> = {
    ...current, id, name, clips,
    createdAt: current?.createdAt ?? Date.now(),
    updatedAt: Date.now()
  };
  if (isDesktop()) {
    const previous = projectSaveQueues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => invoke<void>("save_project", { project }));
    projectSaveQueues.set(id, next);
    try { await next; } finally { if (projectSaveQueues.get(id) === next) projectSaveQueues.delete(id); }
  } else {
    browserProjects.set(id, project);
  }
}

export async function createProject<T>(project: StoredProject<T>): Promise<void> {
  if (isDesktop()) await invoke("save_project", { project });
  else browserProjects.set(project.id, project);
}

export async function deleteProject(id: string): Promise<void> {
  if (isDesktop()) await invoke("delete_project", { id });
  else browserProjects.delete(id);
}

type PortableClip = { id?: string; name?: string; src?: string; file?: File; [key: string]: unknown };
const safeProjectName = (name: string) =>
  name.replace(/[\\/:*?"<>|]/g, "-").trim() || "Ghous-Cut-Project";

async function browserMediaBytes(clip: PortableClip): Promise<Uint8Array | null> {
  if (clip.file instanceof File) return new Uint8Array(await clip.file.arrayBuffer());
  if (clip.src?.startsWith("blob:")) {
    const response = await fetch(clip.src);
    if (response.ok) return new Uint8Array(await response.arrayBuffer());
  }
  return null;
}

export async function exportProjectFile<T>(project: StoredProject<T>): Promise<boolean> {
  const safeName = safeProjectName(project.name);

  if (isDesktop()) {
    const portable = {
      format: "ghous-cut-project",
      version: 1,
      exportedAt: new Date().toISOString(),
      project: {
        ...project,
        clips: project.clips.map(clip => {
          const item = clip as T & { src?: string; file?: File };
          return { ...item, src: "", file: undefined };
        })
      }
    };
    const path = await saveDialog({
      defaultPath: `${safeName}.ghcut`,
      filters: [{ name: "Ghous Cut Project", extensions: ["ghcut"] }]
    });
    if (!path) return false;
    await invoke("write_project_file", { path, content: JSON.stringify(portable, null, 2) });
    return true;
  }

  const media: Record<string, Uint8Array> = {};
  const portableClips = await Promise.all(project.clips.map(async (clip, index) => {
    const item = clip as T & PortableClip;
    const mediaPath = `media/${String(index).padStart(4, "0")}-${safeProjectName(item.name || `asset-${index}`)}`;
    const bytes = await browserMediaBytes(item);
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

export async function importProjectFile(file: File): Promise<StoredProject> {
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
  const project: StoredProject = {
    ...parsed.project,
    id: crypto.randomUUID(),
    name: parsed.project.name,
    clips: parsed.project.clips.map(clip => {
      const item = clip as PortableClip & { packageMedia?: string };
      const mediaBytes = item.packageMedia ? archivedMedia[item.packageMedia] : undefined;
      if (mediaBytes) {
        const extension = item.name?.split(".").pop()?.toLowerCase() || "bin";
        const mediaFile = new File([mediaBytes], item.name || `media.${extension}`);
        return { ...item, src: URL.createObjectURL(mediaFile), file: mediaFile, packageMedia: undefined };
      }
      return { ...item, src: "", file: undefined };
    }),
    createdAt: now,
    updatedAt: now
  };
  await createProject(project);
  return project;
}
