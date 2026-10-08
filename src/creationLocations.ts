import type { CreateLocation } from "./taskOperations";

export type CreationDirectory = { cwd: string; locations: CreateLocation[] };

// The API supplies canonical cwd values. Preserve their exact paths and the
// native location IDs; labels and basenames do not identify a directory.
export function creationDirectories(locations: readonly CreateLocation[]): CreationDirectory[] {
  const directories = new Map<string, CreationDirectory>();
  for (const location of locations) {
    let directory = directories.get(location.cwd);
    if (!directory) {
      directory = { cwd: location.cwd, locations: [] };
      directories.set(location.cwd, directory);
    }
    if (!directory.locations.some(existing => existing.id === location.id)) directory.locations.push(location);
  }
  return [...directories.values()];
}

export function creationDirectoryChoices(directories: readonly CreationDirectory[]) {
  const paths = directories.map(directory => {
    const parts = directory.cwd.split("/").filter(Boolean);
    return { directory, basename: parts.at(-1) || "/", parents: parts.slice(0, -1) };
  });
  const choices = paths.map(path => {
    const peers = paths.filter(other => other.basename === path.basename);
    if (peers.length === 1) return { directory: path.directory, label: path.basename };
    const maxDepth = Math.max(...peers.map(peer => peer.parents.length));
    for (let depth = 1; depth <= maxDepth; depth++) {
      const parent = path.parents.slice(-depth).join("/") || "/";
      if (peers.every(peer => peer === path || (peer.parents.slice(-depth).join("/") || "/") !== parent))
        return { directory: path.directory, label: `${path.basename} · ${parent}` };
    }
    return { directory: path.directory, label: `${path.basename} · ${path.directory.cwd}` };
  });
  const counts = new Map<string, number>();
  for (const choice of choices) counts.set(choice.label, (counts.get(choice.label) ?? 0) + 1);
  // A real directory name can itself contain the separator used above.
  return choices.map((choice, index) => counts.get(choice.label)! > 1
    ? { ...choice, label: `${paths[index].basename} · ${choice.directory.cwd}` } : choice);
}

export function searchCreationDirectories(choices: ReturnType<typeof creationDirectoryChoices>, query: string) {
  const terms = query.normalize("NFKC").toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return choices;
  return choices.filter(choice => {
    const text = `${choice.label} ${choice.directory.cwd}`.normalize("NFKC").toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  });
}

export function initialCreationDirectory(directories: readonly CreationDirectory[], preferredCwd?: string) {
  return directories.find(directory => directory.cwd === preferredCwd)?.cwd || (directories.length === 1 ? directories[0].cwd : "");
}

export function creationLocation(directories: readonly CreationDirectory[], cwd: string, projectLocationId: string): CreateLocation | null {
  const directory = directories.find(item => item.cwd === cwd);
  if (!directory) return null;
  if (directory.locations.length === 1) return directory.locations[0];
  return directory.locations.find(location => location.id === projectLocationId) ?? null;
}

export function creationProjectChoices(directory: CreationDirectory) {
  const choices = directory.locations.map(location => ({ location, label: location.projectId
    ? location.projectName?.trim() || location.label.trim() || "未命名项目" : "不归入项目" }));
  const counts = new Map<string, number>();
  for (const choice of choices) counts.set(choice.label, (counts.get(choice.label) ?? 0) + 1);
  const named = choices.map(choice => ({ ...choice, label: counts.get(choice.label)! > 1
    ? `${choice.label}（${choice.location.projectId || choice.location.id}）` : choice.label }));
  const names = new Map<string, number>();
  for (const choice of named) names.set(choice.label, (names.get(choice.label) ?? 0) + 1);
  return named.map(choice => names.get(choice.label)! > 1 ? { ...choice, label: `${choice.label} · ${choice.location.id}` } : choice);
}
