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
  const altPath =
    chapterPaths.find(
      (p) => p.substring(0, p.lastIndexOf("/")) !== currentFolder,
    ) ??
    chapterPaths[1] ??
    currentPath;

  const novelIndex = new LinkRankIndex(app);
  const emptyIndex = new LinkRankIndex(app);

  const novelColdRuns = () => {
    const idx = new LinkRankIndex(app);
    const t = performance.now();
    const data = idx.getRankData(currentPath, "Novel");
    return {
      ms: performance.now() - t,
      candidates: data.targetToSourceFolders.size,
    };
  };

  return [
    { name: "linkrank cold (Novel)", run: novelColdRuns },
    {
      name: "linkrank warm hit (Novel)",
      run: () => {
        const t = performance.now();
        const data = novelIndex.getRankData(currentPath, "Novel");
        return {
          ms: performance.now() - t,
          candidates: data.targetToSourceFolders.size,
        };
      },
    },
    {
      name: "linkrank markSourceStale+get (Novel)",
      run: () => {
        const t = performance.now();
        novelIndex.markSourceStale(altPath);
        const data = novelIndex.getRankData(currentPath, "Novel");
        return {
          ms: performance.now() - t,
          candidates: data.targetToSourceFolders.size,
        };
      },
    },
    {
      name: "linkrank rebuild full (Novel)",
      run: () => {
        novelIndex.invalidate();
        const t = performance.now();
        const data = novelIndex.getRankData(currentPath, "Novel");
        return {
          ms: performance.now() - t,
          candidates: data.targetToSourceFolders.size,
        };
      },
    },
    {
      name: "linkrank cold ()",
      run: () => {
        const idx = new LinkRankIndex(app);
        const t = performance.now();
        const data = idx.getRankData(currentPath, "");
        return {
          ms: performance.now() - t,
          candidates: data.targetToSourceFolders.size,
        };
      },
    },
    {
      name: "linkrank warm hit ()",
      run: () => {
        const t = performance.now();
        const data = emptyIndex.getRankData(currentPath, "");
        return {
          ms: performance.now() - t,
          candidates: data.targetToSourceFolders.size,
        };
      },
    },
  ];
}
