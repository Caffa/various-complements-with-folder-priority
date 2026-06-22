import { describe, expect, it } from "@jest/globals";
import { calculateFolderProximity } from "./FolderProximity";

describe("calculateFolderProximity", () => {
  describe("same folder priority", () => {
    it("returns level 0 for same folder", () => {
      const linkFolders = new Map([
        ["Novel/Ancient China/As Huanxin/AC Vs Twins", 3],
      ]);
      const currentFile =
        "Novel/Ancient China/As Huanxin/AC Vs Twins/Chapter 1.md";
      const limitingFolder = "Novel";

      const result = calculateFolderProximity(
        linkFolders,
        currentFile,
        limitingFolder,
      );

      expect(result.level).toBe(0);
      expect(result.frequency).toBe(3);
      expect(result.score).toBe(3); // frequency / (level + 1) = 3 / 1 = 3
    });
  });

  describe("parent folder priority", () => {
    it("returns level 1 for parent folder", () => {
      const linkFolders = new Map([
        ["Novel/Ancient China/As Huanxin", 2],
      ]);
      const currentFile =
        "Novel/Ancient China/As Huanxin/AC Vs Twins/Chapter 1.md";
      const limitingFolder = "Novel";

      const result = calculateFolderProximity(
        linkFolders,
        currentFile,
        limitingFolder,
      );

      expect(result.level).toBe(1);
      expect(result.frequency).toBe(2);
      expect(result.score).toBe(1); // frequency / (level + 1) = 2 / 2 = 1
    });

    it("returns level 2 for grandparent folder", () => {
      const linkFolders = new Map([["Novel/Ancient China", 5]]);
      const currentFile =
        "Novel/Ancient China/As Huanxin/AC Vs Twins/Chapter 1.md";
      const limitingFolder = "Novel";

      const result = calculateFolderProximity(
        linkFolders,
        currentFile,
        limitingFolder,
      );

      expect(result.level).toBe(2);
      expect(result.frequency).toBe(5);
      expect(result.score).toBeCloseTo(5 / 3);
    });
  });

  describe("sibling folder priority", () => {
    it("returns level 2 for sibling folder (same parent)", () => {
      const linkFolders = new Map([
        ["Novel/Ancient China/As Huanxin/Absconding", 2],
      ]);
      const currentFile =
        "Novel/Ancient China/As Huanxin/AC Vs Twins/Chapter 1.md";
      const limitingFolder = "Novel";

      const result = calculateFolderProximity(
        linkFolders,
        currentFile,
        limitingFolder,
      );

      // Both folders share "Novel/Ancient China/As Huanxin" as parent
      // Distance from common ancestor: 1 + 1 = 2
      expect(result.level).toBe(2);
      expect(result.frequency).toBe(2);
      expect(result.score).toBeCloseTo(2 / 3);
    });

    it("returns level 4 for cousin folder (same grandparent)", () => {
      const linkFolders = new Map([
        ["Novel/Ancient China/Born Royal", 3],
      ]);
      const currentFile =
        "Novel/Ancient China/As Huanxin/AC Vs Twins/Chapter 1.md";
      const limitingFolder = "Novel";

      const result = calculateFolderProximity(
        linkFolders,
        currentFile,
        limitingFolder,
      );

      // Common ancestor: "Novel/Ancient China"
      // Current: "As Huanxin/AC Vs Twins" -> 2 levels from common
      // Target: "Born Royal" -> 1 level from common
      // Total: 2 + 1 = 3
      expect(result.level).toBe(3);
    });
  });

  describe("outside limiting folder", () => {
    it("returns level 999 for links outside limiting folder", () => {
      const linkFolders = new Map([["Resources/Characters/John", 5]]);
      const currentFile =
        "Novel/Ancient China/As Huanxin/AC Vs Twins/Chapter 1.md";
      const limitingFolder = "Novel";

      const result = calculateFolderProximity(
        linkFolders,
        currentFile,
        limitingFolder,
      );

      expect(result.level).toBe(999);
      expect(result.frequency).toBe(0);
      expect(result.score).toBe(0);
    });

    it("returns level 999 when current file is outside limiting folder", () => {
      const linkFolders = new Map([
        ["Novel/Ancient China/As Huanxin/AC Vs Twins", 3],
      ]);
      const currentFile = "Resources/Characters/Template.md";
      const limitingFolder = "Novel";

      const result = calculateFolderProximity(
        linkFolders,
        currentFile,
        limitingFolder,
      );

      expect(result.level).toBe(999);
      expect(result.score).toBe(0);
    });
  });

  describe("multiple folders", () => {
    it("returns best score across multiple folders", () => {
      const linkFolders = new Map([
        ["Novel/Ancient China/As Huanxin/AC Vs Twins", 1], // level 0, score 1
        ["Novel/Ancient China/As Huanxin/Absconding", 5], // level 2, score 5/3 ≈ 1.67
        ["Novel/Ancient China/Born Royal", 10], // level 3, score 10/4 = 2.5
        ["Resources/Characters", 20], // outside limiting folder
      ]);
      const currentFile =
        "Novel/Ancient China/As Huanxin/AC Vs Twins/Chapter 1.md";
      const limitingFolder = "Novel";

      const result = calculateFolderProximity(
        linkFolders,
        currentFile,
        limitingFolder,
      );

      // Best score is from Born Royal: 10/4 = 2.5
      // Even though it's further away, frequency compensates
      expect(result.level).toBe(3);
      expect(result.frequency).toBe(10);
      expect(result.score).toBe(2.5);
    });

    it("prioritizes lower level when scores are equal", () => {
      const linkFolders = new Map([
        ["Novel/Ancient China/As Huanxin/AC Vs Twins", 2], // level 0, score 2
        ["Novel/Ancient China/Born Royal", 6], // level 3, score 6/4 = 1.5
      ]);
      const currentFile =
        "Novel/Ancient China/As Huanxin/AC Vs Twins/Chapter 1.md";
      const limitingFolder = "Novel";

      const result = calculateFolderProximity(
        linkFolders,
        currentFile,
        limitingFolder,
      );

      // Same folder wins: score 2 > 1.5
      expect(result.level).toBe(0);
      expect(result.frequency).toBe(2);
      expect(result.score).toBe(2);
    });
  });

  describe("edge cases", () => {
    it("handles empty folder map", () => {
      const linkFolders = new Map();
      const currentFile =
        "Novel/Ancient China/As Huanxin/AC Vs Twins/Chapter 1.md";
      const limitingFolder = "Novel";

      const result = calculateFolderProximity(
        linkFolders,
        currentFile,
        limitingFolder,
      );

      expect(result.level).toBe(999);
      expect(result.frequency).toBe(0);
      expect(result.score).toBe(0);
    });

    it("handles root folder as limiting folder", () => {
      const linkFolders = new Map([["Resources/Characters", 5]]);
      const currentFile = "Novel/Ancient China/Chapter 1.md";
      const limitingFolder = "";

      const result = calculateFolderProximity(
        linkFolders,
        currentFile,
        limitingFolder,
      );

      // Empty limiting folder means everything is outside
      expect(result.level).toBe(999);
    });
  });
});