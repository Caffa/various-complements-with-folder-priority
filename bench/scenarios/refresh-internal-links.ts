import { InternalLinkWordProvider } from "../../src/provider/InternalLinkWordProvider";
import { createFixture } from "../fixtures";
import { makeApp } from "../harness";
import { BASE_INTERNAL_LINK_OPTION, buildProviderSet } from "../internal-link";

export type Scenario = {
  name: string;
  run: () => { ms: number; candidates?: number; pool?: number };
};

export function scenarios(fixture = createFixture()): Scenario[] {
  const { app, appHelper } = makeApp(fixture);

  const warmProvider = new InternalLinkWordProvider(app, appHelper);
  warmProvider.refreshWords({ ...BASE_INTERNAL_LINK_OPTION });

  const out: Scenario[] = [
    {
      name: "refresh-internal-links cold",
      run: () => {
        const p = new InternalLinkWordProvider(app, appHelper);
        const t = performance.now();
        p.refreshWords({ ...BASE_INTERNAL_LINK_OPTION });
        return { ms: performance.now() - t, candidates: p.wordCount };
      },
    },
    {
      name: "refresh-internal-links warm",
      run: () => {
        const t = performance.now();
        warmProvider.refreshWords({ ...BASE_INTERNAL_LINK_OPTION });
        return {
          ms: performance.now() - t,
          candidates: warmProvider.wordCount,
        };
      },
    },
  ];

  // Optional `ignorePrefixes` variant: skipping the prefix regex work on every
  // file is the point of the feature, so its refresh cost is worth tracking.
  const providerSet = buildProviderSet(app, appHelper, [["Char", "Chapter"]]);
  const filtered = providerSet.variants.find((v) => v.label !== "");
  if (filtered) {
    const warmFiltered = filtered.provider;
    out.push({
      name: "refresh-internal-links warm (ignore Char/Chapter)",
      run: () => {
        const t = performance.now();
        warmFiltered.refreshWords({
          ...BASE_INTERNAL_LINK_OPTION,
          ignorePrefixes: ["Char", "Chapter"],
        } as any);
        return {
          ms: performance.now() - t,
          candidates: warmFiltered.wordCount,
        };
      },
    });
  } else {
    console.log(
      "[bench] note: skipping refresh-internal-links ignore-prefix variant",
    );
  }

  return out;
}
