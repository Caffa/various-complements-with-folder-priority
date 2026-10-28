import { FolderRankCache } from "../../src/storage/FolderRankCache";
import { LinkRankIndex } from "../../src/storage/LinkRankIndex";
import { createFixture, CURRENT_FILE_PATH } from "../fixtures";
import { makeApp } from "../harness";

export type Scenario = {
  name: string;
  run: () => { ms: number; candidates?: number; pool?: number };
};

export function scenarios(fixture = createFixture()): Scenario[] {
  const { app } = makeApp(fixture);
  const chapterPaths = fixture.files
    .filter((f: any) => /Chapter - T\d+\.md$/.test(f.path))
    .map((f: any) => f.path as string);
  const currentPath = CURRENT_FILE_PATH;
  const currentFolder = currentPath.substring(0, currentPath.lastIndexOf("/"));
  const secondPath =
    chapterPaths.find(
      (p) => p.substring(0, p.lastIndexOf("/")) !== currentFolder,
    ) ??
    chapterPaths[1] ??
    currentPath;

  const index = new LinkRankIndex(app);
  const cache = new FolderRankCache(app, index);
  const rankData = () => index.getRankData(currentPath, "Novel");
  // warm index initially
  index.getRankData(currentPath, "Novel");

  const listSize = (list: any) =>
    list
      ? (list.resolvedScores?.size ?? 0) + (list.unresolvedScores?.size ?? 0)
      : 0;

  return [
    {
      name: "folderrank cold first folder",
      run: () => {
        const idx = new LinkRankIndex(app);
        const c = new FolderRankCache(app, idx);
        idx.getRankData(currentPath, "Novel");
        const rd = idx.getRankData(currentPath, "Novel");
        const t = performance.now();
        const list = c.getList(currentPath, "Novel", rd);
        return { ms: performance.now() - t, candidates: listSize(list) };
      },
    },
    {
      name: "folderrank second folder same version",
      run: () => {
        const rd = index.getRankData(secondPath, "Novel");
        const t = performance.now();
        const list = cache.getList(secondPath, "Novel", rd);
        return { ms: performance.now() - t, candidates: listSize(list) };
      },
    },
    {
      name: "folderrank warm hit",
      run: () => {
        const rd = rankData();
        const t = performance.now();
        const list = cache.getList(currentPath, "Novel", rd);
        return { ms: performance.now() - t, candidates: listSize(list) };
      },
    },
    {
      name: "folderrank structure bump",
      run: () => {
        cache.bumpStructure();
        const rd = rankData();
        const t = performance.now();
        const list = cache.getList(currentPath, "Novel", rd);
        return { ms: performance.now() - t, candidates: listSize(list) };
      },
    },
  ];
}
