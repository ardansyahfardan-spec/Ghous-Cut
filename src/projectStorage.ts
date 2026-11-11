import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";

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
    ...current,
    id,
    name,
    clips,
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
  if (isDesktop()) {
    await invoke("save_project", { project });
  } else {
    browserProjects.set(project.id, project);
  }
}

export async function deleteProject(id: string): Promise<void> {
  if (isDesktop()) {
    await invoke("delete_project", { id });
  } else {
    browserProjects.delete(id);
  }
}

export async function exportProjectFile<T>(project: StoredProject<T>): Promise<boolean> {
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
  const content = JSON.stringify(portable, null, 2);
  const safeName = project.name.replace(/[\\/:*?"<>|]/g, "-").trim() || "Ghous-Cut-Project";

  if (isDesktop()) {
    const path = await saveDialog({
      defaultPath: `${safeName}.ghcut`,
      filters: [{ name: "Ghous Cut Project", extensions: ["ghcut"] }]
    });
    if (!path) return false;
    await invoke("write_project_file", { path, content });
    return true;
  }

  const blob = new Blob([content], { type: "application/vnd.ghouscut.project+json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeName}.ghcut`;
  anchor.click();
  URL.revokeObjectURL(url);
  return true;
}

export async function importProjectFile(file: File): Promise<StoredProject> {
  const parsed = JSON.parse(await file.text()) as {
    format?: string;
    version?: number;
    project?: StoredProject;
  };
  if (parsed.format !== "ghous-cut-project" || parsed.version !== 1 || !parsed.project ||
      typeof parsed.project.name !== "string" || !Array.isArray(parsed.project.clips)) {
    throw new Error("File bukan proyek Ghous Cut yang valid.");
  }

  const now = Date.now();
  const project: StoredProject = {
    ...parsed.project,
    id: crypto.randomUUID(),
    name: parsed.project.name,
    clips: parsed.project.clips.map(clip => {
      const item = clip as { src?: string; file?: unknown };
      return { ...item, src: "", file: undefined };
    }),
    createdAt: now,
    updatedAt: now
  };
  await createProject(project);
  return project;
}
