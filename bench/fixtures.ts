import { TFile } from "./obsidian-stub";

export const WORLDS = [
  "Ancient China",
  "Modern Era",
  "Space Opera",
  "Mythic West",
  "Crystal Realm",
];
export const STORIES = Array.from({ length: 18 }, (_v, i) => `Story ${i + 1}`);
export const CURRENT_FILE_PATH = `Novel/${WORLDS[0]}/${STORIES[0]}/Chapter - T1.md`;
export const LIMITING_FOLDER = "Novel";

const GIVEN = [
  "Huanxin",
  "Lian",
  "Yun",
  "Mei",
  "Zhao",
  "Xiao",
  "Wei",
  "Fan",
  "Ru",
  "An",
  "Bai",
  "Chen",
  "Dai",
  "Feng",
  "Gao",
  "Han",
  "Jia",
  "Kai",
  "Lan",
  "Ming",
  "Ning",
  "Qi",
  "Rui",
  "Shen",
  "Tao",
  "Wen",
  "Xi",
  "Yan",
  "Zhen",
  "Bo",
];
const FAMILY = [
  "Shi",
  "Wang",
  "Lin",
  "Xu",
  "Guo",
  "Huang",
  "Song",
  "Tang",
  "Lu",
  "Cao",
];

export function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Fixture = {
  files: any[];
  resolvedLinks: Record<string, Record<string, number>>;
  unresolvedLinks: Record<string, Record<string, number>>;
  unresolvedNames: string[];
};

export function createFixture(scale: number = 14000): Fixture {
  const rnd = mulberry32(20261028);
  const factor = scale / 14000;
  const chapterPerStory = Math.max(1, Math.round(100 * factor));
  const charsPerWorld = Math.max(1, Math.round(800 * factor));
  const otherCount = Math.max(
    0,
    scale -
      WORLDS.length * STORIES.length * chapterPerStory -
      WORLDS.length * charsPerWorld,
  );

  const paths: string[] = [];
  const characterPathsByWorld = new Map<string, string[]>();
  const characterPaths: string[] = [];
  for (const world of WORLDS) {
    const arr: string[] = [];
    for (let i = 0; i < charsPerWorld; i++) {
      const g = GIVEN[Math.floor(rnd() * GIVEN.length)];
      const f = FAMILY[Math.floor(rnd() * FAMILY.length)];
      const p = `Novel/${world}/Characters/Char - ${f} ${g} ${i}.md`;
      arr.push(p);
      characterPaths.push(p);
    }
    characterPathsByWorld.set(world, arr);
  }

  const chapterPaths: string[] = [];
  const chapterPathsByWorld = new Map<string, string[]>();
  const chapterPathsByWorldStory = new Map<string, string[]>();
  for (const world of WORLDS) {
    const wArr: string[] = [];
    for (const story of STORIES) {
      const arr: string[] = [];
      for (let c = 1; c <= chapterPerStory; c++) {
        if (
          chapterPaths.length >=
          WORLDS.length * STORIES.length * chapterPerStory
        )
          break;
        const p = `Novel/${world}/${story}/Chapter - T${c}.md`;
        arr.push(p);
        chapterPaths.push(p);
        wArr.push(p);
      }
      chapterPathsByWorldStory.set(`${world}/${story}`, arr);
    }
    chapterPathsByWorld.set(world, wArr);
    if (chapterPaths.length >= WORLDS.length * STORIES.length * chapterPerStory)
      break;
  }

  // other notes
  const otherPaths: string[] = [];
  for (const world of WORLDS)
    otherPaths.push(`Novel/${world}/World - ${world}.md`);
  const refFolders = Math.max(1, Math.round(50 * factor));
  const refPer = Math.max(1, Math.round(10 * factor));
  for (let d = 0; d < refFolders; d++)
    for (let i = 0; i < refPer; i++)
      otherPaths.push(`Reference/Topic ${d}/Note ${i}.md`);
  const journalPer = Math.max(1, Math.round(50 * factor));
  for (let d = 0; d < 7; d++)
    for (let i = 0; i < journalPer; i++)
      otherPaths.push(`Journal/Year ${2000 + (d % 7)}/Day ${i}.md`);
  const tplCount = Math.max(0, Math.round(100 * factor));
  for (let i = 0; i < tplCount; i++)
    otherPaths.push(`Templates/Template ${i}.md`);
  while (otherPaths.length > otherCount && otherPaths.length > 0)
    otherPaths.pop();
  while (otherPaths.length < otherCount)
    otherPaths.push(`Other/Note ${otherPaths.length}.md`);

  const allPaths = [...characterPaths, ...chapterPaths, ...otherPaths];

  const files = allPaths.map((p) => {
    const name = p.split("/").pop()!;
    const base = name.replace(/\.md$/, "");
    const f = new TFile();
    f.path = p;
    f.basename = base;
    f.name = name;
    f.extension = "md";
    return f;
  });

  const resolvedLinks: Record<string, Record<string, number>> = {};
  const unresolvedLinks: Record<string, Record<string, number>> = {};

  const getWorld = (p: string) =>
    p.startsWith("Novel/") ? p.split("/")[1] : WORLDS[0];

  // chapters -> chars + siblings
  for (const cp of chapterPaths) {
    const world = getWorld(cp);
    const charPool = characterPathsByWorld.get(world)!;
    const targets: Record<string, number> = {};
    const charCount = 4 + Math.floor(rnd() * 5);
    for (let i = 0; i < charCount; i++) {
      const t = charPool[Math.floor(rnd() * charPool.length)];
      if (t && t !== cp) targets[t] = (targets[t] ?? 0) + 1;
    }
    const chapCount = 1 + Math.floor(rnd() * 3);
    const storyFolder = cp.split("/").slice(0, 3).join("/");
    const key = `${world}/${cp.split("/")[2]}`;
    const siblings = (chapterPathsByWorldStory.get(key) ?? []).filter(
      (x) => x !== cp,
    );
    for (let i = 0; i < chapCount; i++) {
      if (siblings.length === 0) break;
      const t = siblings[Math.floor(rnd() * siblings.length)];
      if (t !== cp) targets[t] = (targets[t] ?? 0) + 1;
    }
    if (Object.keys(targets).length) resolvedLinks[cp] = targets;
  }

  // characters -> chapters backlinks
  for (const cp of characterPaths) {
    const world = getWorld(cp);
    const worldChapters = chapterPathsByWorld.get(world) ?? [];
    if (worldChapters.length === 0) continue;
    const targets: Record<string, number> = {};
    const n = 2 + Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) {
      const t = worldChapters[Math.floor(rnd() * worldChapters.length)];
      if (t && t !== cp) targets[t] = (targets[t] ?? 0) + 1;
    }
    if (Object.keys(targets).length) resolvedLinks[cp] = targets;
  }

  // other notes occasional
  for (const op of otherPaths) {
    if (rnd() < 0.35) {
      const targets: Record<string, number> = {};
      const world = WORLDS[Math.floor(rnd() * WORLDS.length)];
      const pool = characterPathsByWorld.get(world)!;
      if (pool && pool.length) {
        const t = pool[Math.floor(rnd() * pool.length)];
        targets[t] = (targets[t] ?? 0) + 1;
      }
      if (Object.keys(targets).length) resolvedLinks[op] = targets;
    }
  }

  // unresolved: 400 unique names
  const unresolvedNames: string[] = [];
  for (let i = 0; i < 400; i++) unresolvedNames.push(`Unresolved Note ${i}`);
  const nonTemplateSources = allPaths.filter(
    (p) => !p.startsWith("Templates/"),
  );
  for (let i = 0; i < 400; i++) {
    const f = nonTemplateSources[Math.floor(rnd() * nonTemplateSources.length)];
    const name = unresolvedNames[i];
    const entry = unresolvedLinks[f] ?? {};
    entry[name] = (entry[name] ?? 0) + 1;
    unresolvedLinks[f] = entry;
  }

  return {
    files,
    resolvedLinks,
    unresolvedLinks,
    unresolvedNames,
  };
}
